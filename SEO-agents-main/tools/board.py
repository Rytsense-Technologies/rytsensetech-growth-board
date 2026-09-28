#!/usr/bin/env python3
"""board.py — the shared blackboard the agent team coordinates through.

Sibling subagents cannot message each other: they run concurrently, in isolated
contexts, and only their parent sees their output. So they coordinate the way
distributed systems have always coordinated without a message bus — through
shared state everyone reads and appends to.

Append-only, run-scoped, readable mid-run. Agent B can act on what Agent A found
while A is still working, which is the whole point. `memory.py` is the long-term
record across engagements; this is the working surface within one.

Eight entry types, each earning its place:
    finding   a verified claim, with its evidence
    question  posed to a role, answerable by whoever holds it
    answer    resolves a question
    claim     "I am working on this" — stops two agents doing the same job
    conflict  "this contradicts entry X" — surfaces disagreement mechanically
    handoff   output another agent is waiting on
    withdrawn "entry X was wrong" — retires it in public, never deletes it
    supersede "entry X is replaced by entry Y" — the correction, as data

Append-only on purpose. An agent that can edit the board can quietly delete the
finding that contradicts it. Withdrawal and supersession are forward pointers:
they add a row, they never mutate the claim they retire.

Usage:
    python tools/board.py open <domain> --run <slug> --goal "..."
    python tools/board.py close <domain>            # end the run; free its claims
    python tools/board.py digest <domain> [--full]
    python tools/board.py post <domain> --from serp-landscape-analyst \\
           --type finding --topic us-serps --body "..." --evidence "..." \\
           [--supersedes bd_12ab] [--observed 2026-09-18] [--binding]
    python tools/board.py ask <domain> --from x --to competitor-analyst --body "..."
    python tools/board.py answer <domain> --from y --re bd_12ab --body "..."
    python tools/board.py claim <domain> --from z --topic "cost-serp analysis"
    python tools/board.py conflict <domain> --from q --re bd_12ab --body "..."
    python tools/board.py withdraw <domain> --from orch --re bd_12ab --body "why"
    python tools/board.py pending <domain>

Stdlib only — no install required.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path("memory")
TYPES = ("finding", "question", "answer", "claim", "conflict", "handoff",
         "withdrawn", "supersede")

# A digest is read into a subagent's context before it does any work. The old
# default was 40 KB of the 65-finding board — roughly 10k tokens an agent paid
# for whether or not it needed them, with the oldest 25 findings (the
# corrections) dropped silently. Budget it, and disclose every omission.
DEFAULT_BUDGET = 12000
BODY_CLIP = 240
EVIDENCE_CLIP = 140

# Entries that must never fall off the digest however old they are. The
# 2026-09-17 board lost exactly these to `finds[-40:]`: the "/us/ is 240 URLs,
# not 198" correction and the placeholder-zero escalation were the five OLDEST
# findings, so recency-truncation deleted precisely the entries that exist to
# correct the newer ones.
BINDING_RE = re.compile(
    r"\b(CRITICAL|CORRECTION|ESCALATION|WITHDRAW|RETRACT|SUPERSED|ADJUDICAT|BINDING)", re.I)

# Two entries from one agent 32 seconds apart are one entry recorded twice, not
# two independent claims. Collapse at this token-set Jaccard.
DUP_SIMILARITY = 0.85

# A claim from a run that is over is not work in progress, it is a corpse.
# Observed 2026-09-22: six agents were killed mid-run leaving 7 claims open on
# "daily-2026-09-22"; the next day's agents read them as taken and skipped the
# topics.
STALE_CLAIM_HOURS = 12

# Lock waits are bounded by construction — this repo's guard hook blocks
# unbounded polling for good reason (commit cbe727b, a 42-minute zombie), and a
# data tool has no business holding a slot open either. 40 tries at 50ms is
# ~2s, an eternity next to a JSON write.
LOCK_ATTEMPTS = 40
LOCK_SLEEP = 0.05
STALE_LOCK_SECONDS = 30


def utf8_stdout() -> None:
    """Windows consoles default to cp1252, which cannot encode the digest.

    The "WARNING" and section glyphs are outside cp1252, so a digest that hit
    the unresolved-conflicts header died with UnicodeEncodeError on Windows —
    the tool printed a traceback instead of the conflict it existed to surface.
    Agents read stdout, so stdout has to be UTF-8 wherever it runs.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


def slug(domain: str) -> str:
    d = re.sub(r"^https?://", "", str(domain))
    d = re.sub(r"^www\.", "", d)
    return d.split("/")[0].lower()


def board_path(domain: str) -> Path:
    return ROOT / slug(domain) / "board.json"


def now() -> str:
    """Write time, local, WITH its offset.

    The old stamp was UTC and unlabelled. The team works in IST, so every entry
    written after 18:30 local read as the previous day, and every agent that
    wrote the real date into its own prose disagreed with the tool that stamped
    it — the whole 2026-09-17 board is stamped a day before the work happened.
    An offset-bearing local stamp is unambiguous either way.
    """
    return datetime.now().astimezone().isoformat(timespec="seconds")


def today() -> str:
    return datetime.now().astimezone().date().isoformat()


def parse_at(value):
    """Read both stamp formats: the legacy `...Z` UTC ones and the new local ones."""
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def observed_of(entry: dict) -> str:
    """The date the thing was SEEN, not the date it was typed.

    Existing entries have no observedAt and are not rewritten — append-only
    means append-only — so they fall back to their write stamp, rendered in
    local time rather than UTC.
    """
    if entry.get("observedAt"):
        return str(entry["observedAt"])[:10]
    d = parse_at(entry.get("at"))
    return d.astimezone().date().isoformat() if d else str(entry.get("at", ""))[:10]


@contextmanager
def file_lock(path: Path):
    """Cross-platform advisory lock: atomic O_EXCL create, bounded retry.

    Observed 2026-09-22: six agent processes wrote 7 claims in 66 seconds
    through an unlocked load-modify-save and produced a duplicate claim —
    entity-grounding-specialist holds `daily-0922-entity-schema-new-pages`
    twice. Two processes read the same entry list and the second save clobbered
    the first. os.open(O_CREAT|O_EXCL) is atomic on both NTFS and POSIX, which
    fcntl and msvcrt locking are not portably.
    """
    lock = path.with_name(path.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = None
    for _attempt in range(LOCK_ATTEMPTS):
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                held = time.time() - lock.stat().st_mtime
            except OSError:
                continue  # holder released it between the open and the stat
            if held > STALE_LOCK_SECONDS:
                # The holder was killed. Mid-run agent kills are routine here —
                # seven of them on 2026-09-22 alone — so a lock file must not be
                # able to wedge the board permanently.
                try:
                    lock.unlink()
                except OSError:
                    pass
                continue
            time.sleep(LOCK_SLEEP)
    if fd is None:
        raise TimeoutError(f"could not acquire {lock} after {LOCK_ATTEMPTS} tries")
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


def load(domain: str) -> dict:
    p = board_path(domain)
    if not p.exists():
        return {"run": None, "goal": None, "openedAt": None, "entries": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"run": None, "goal": None, "openedAt": None, "entries": []}


def save(domain: str, board: dict) -> None:
    """Write via a temp file + os.replace so a reader never sees a half file."""
    p = board_path(domain)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(board, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def new_id(taken=None) -> str:
    for _ in range(12):
        rand = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=5))
        candidate = f"bd_{rand}{int(time.time() * 1000) % 10000:04x}"
        if not taken or candidate not in taken:
            return candidate
    # 5 random chars + 4 hex digits of the clock is not a lot of entropy, and a
    # duplicate id breaks every --re pointing at it. Fail loudly rather than mint one.
    raise RuntimeError("could not mint a unique board id")


def _append_locked(board: dict, **entry) -> dict:
    """Append into an already-loaded board. Caller holds the lock and saves."""
    taken = {e.get("id") for e in board["entries"]}
    e = {"id": new_id(taken), "at": now(),
         **{k: v for k, v in entry.items() if v is not None}}
    if board.get("run") and "run" not in e:
        e["run"] = board["run"]
    board["entries"].append(e)
    return e


def append(domain: str, **entry) -> dict:
    with file_lock(board_path(domain)):
        board = load(domain)
        e = _append_locked(board, **entry)
        save(domain, board)
    return e


def claim_topic(domain: str, sender: str, topic: str, body=None, observed=None):
    """Check-and-claim as ONE atomic operation.

    Checking outside the lock is the bug with a lock bolted on: six agents that
    all read "unclaimed" before any of them writes all claim it. On 2026-09-22
    six processes wrote 7 claims in 66 seconds and entity-grounding-specialist
    ended up holding the same topic twice. Returns
    ("yours"|"held"|"claimed", entry).
    """
    with file_lock(board_path(domain)):
        board = load(domain)
        active = [e for e in board["entries"] if e.get("type") == "claim"
                  and e.get("topic") == topic and claim_state(e, board) == "active"]
        mine = [e for e in active if e.get("from") == sender]
        if mine:
            # Idempotent by design: a retried or restarted agent re-claiming its
            # own topic gets its original claim id back, not a second row.
            return "yours", mine[-1]
        held = next((e for e in active if e.get("from") != sender), None)
        if held:
            return "held", held
        e = _append_locked(board, type="claim", **{"from": sender}, topic=topic,
                           body=body or topic, observedAt=observed)
        save(domain, board)
        return "claimed", e


# ------------------------------------------------------------------- utilities

def clip(text, width: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= width else s[: width - 1].rstrip() + "…"


def tokens(text) -> set:
    return set(re.findall(r"[a-z0-9]+", str(text or "").lower()))


def similarity(a, b) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def collapse_duplicates(items: list, key=lambda e: e.get("body")) -> list:
    """Same author, near-identical text: one entry recorded twice.

    Observed 2026-09-17: international-seo-specialist and seo-orchestrator filed
    "keep both trees and differentiate" 32 seconds apart and the digest rendered
    both, which inflates the apparent weight of the conclusion and burns two
    slots. Each survivor carries `_dupes`, the ids it now stands for.
    """
    out: list = []
    for e in items:
        for kept in out:
            if (kept.get("from") == e.get("from")
                    and similarity(key(kept), key(e)) >= DUP_SIMILARITY):
                kept.setdefault("_dupes", []).append(e.get("id"))
                break
        else:
            out.append(dict(e))
    return out


def dupe_note(entry: dict) -> str:
    n = len(entry.get("_dupes") or [])
    return f" *(recorded {n + 1}×: {', '.join(entry['_dupes'])})*" if n else ""


def claim_state(c: dict, board: dict, stale_hours: float = STALE_CLAIM_HOURS) -> str:
    current = board.get("run")
    if not current:
        return "stale"  # no run is open, so nothing is in progress
    if c.get("run") and c["run"] != current:
        return "stale"
    at = parse_at(c.get("at"))
    if at and datetime.now(timezone.utc) - at > timedelta(hours=stale_hours):
        return "stale"
    return "active"


# ------------------------------------------------------------------ operations

def open_run(domain: str, run: str, goal=None) -> None:
    with file_lock(board_path(domain)):
        board = load(domain)
        # Opening a new run archives the previous one rather than wiping it — the
        # trail of what was decided last time is the point.
        if board.get("run") and board["run"] != run:
            board["entries"].append({
                "id": new_id({e.get("id") for e in board["entries"]}), "at": now(),
                "type": "handoff", "from": "system", "topic": "run-closed",
                "run": board["run"],
                "body": f'Run "{board["run"]}" closed. {len(board["entries"])} entries retained.',
            })
            board.setdefault("closedRuns", []).append({"run": board["run"], "closedAt": now()})
        board["run"] = run
        board["goal"] = goal or board.get("goal")
        board["openedAt"] = now()
        save(domain, board)
    print(f'board open: {slug(domain)} · run "{run}"' + (f" · goal: {goal}" if goal else ""))


def close_run(domain: str, run=None) -> int:
    """End a run so its claims stop reading as work in progress.

    `open` used to be the only thing that ever closed a run, so a run whose
    agents were killed stayed open indefinitely — board.json sat open on
    "daily-2026-09-22" with 7 orphaned claims, and the next day's agents read
    those topics as taken.
    """
    with file_lock(board_path(domain)):
        board = load(domain)
        current = board.get("run")
        if not current:
            print("no run is open", file=sys.stderr)
            return 1
        if run and run != current:
            print(f'open run is "{current}", not "{run}"', file=sys.stderr)
            return 1
        held = [e for e in board["entries"] if e.get("type") == "claim"
                and (e.get("run") == current or not e.get("run"))]
        board["entries"].append({
            "id": new_id({e.get("id") for e in board["entries"]}), "at": now(),
            "type": "handoff", "from": "system", "topic": "run-closed", "run": current,
            "body": f'Run "{current}" closed. {len(held)} claim(s) released; '
                    f'{len(board["entries"])} entries retained.',
        })
        board.setdefault("closedRuns", []).append({"run": current, "closedAt": now()})
        board["run"] = None
        save(domain, board)
    print(f'run "{current}" closed · {len(held)} claim(s) released')
    return 0


def _index(entries: list) -> dict:
    """Pre-compute the retirement state every renderer needs."""
    withdrawn, superseded = {}, {}
    for e in entries:
        if e.get("type") == "withdrawn" and e.get("re"):
            withdrawn[e["re"]] = e
        elif e.get("type") == "supersede" and e.get("re"):
            superseded[e["re"]] = e
    return {"withdrawn": withdrawn, "superseded": superseded,
            "referenced": {e.get("re") for e in entries if e.get("re")}}


def digest(domain: str, limit: int = 40, topic=None,
           full: bool = False, budget: int = DEFAULT_BUDGET) -> str:
    board = load(domain)
    all_entries = board["entries"]
    if not all_entries:
        return (f"# Board — {slug(domain)}\n\nEmpty. You are first. Post findings as you "
                "verify them, claim work before you start it, and ask rather than assume.")

    entries = all_entries
    untagged = 0
    if topic:
        # Prefix, not substring: `--topic serp` also hid every untagged finding
        # without saying so, which reads as "nothing relevant was found" when in
        # fact most findings simply carry no --topic.
        t = topic.lower()
        untagged = sum(1 for e in all_entries if not e.get("topic"))
        entries = [e for e in all_entries if (e.get("topic") or "").lower().startswith(t)]

    idx = _index(all_entries)
    retired = dict(idx["withdrawn"])
    retired.update(idx["superseded"])

    def by(t: str) -> list:
        return [e for e in entries if e.get("type") == t]

    answered = {a.get("re") for a in by("answer") if a.get("re")}
    conflict_ids = {c["id"] for c in by("conflict")}
    open_q = [q for q in by("question") if q["id"] not in answered]
    open_c = [c for c in by("conflict") if c["id"] not in answered]
    adjudications = [a for a in by("answer") if a.get("re") in conflict_ids]

    width = 10 ** 6 if full else BODY_CLIP
    omitted: list = []

    L = [f"# Board — {slug(domain)}"]
    if board.get("run"):
        L.append(f'**Run:** {board["run"]}' + (f' · {board["goal"]}' if board.get("goal") else ""))
    else:
        L.append("**Run:** none open — every claim below is stale and its topic is free.")
    counts: dict = {}
    for e in entries:
        counts[e.get("type")] = counts.get(e.get("type"), 0) + 1
    L.append(f"{len(entries)} entries · "
             + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
    L.append("*Dates are observation dates, local time. Corrections, withdrawals, conflicts "
             "and adjudications are never omitted from this digest.*")
    if topic:
        L.append(f"*Filtered to topics starting `{topic}`; {untagged} untagged entries on this "
                 f"board are not reachable by --topic at all.*")
    L.append("")

    def used() -> int:
        return len("\n".join(L))

    # 1. Retirements first. An agent that read an earlier digest cached the wrong
    #    number; hiding the withdrawal leaves it believing it. Struck, with the
    #    reason, always, whatever the budget says.
    shown_retired = [(e, retired[e["id"]]) for e in entries if e["id"] in retired]
    if shown_retired:
        L.append("## ⛔ Withdrawn and superseded — do not cite these")
        for target, mark in shown_retired:
            verb = "WITHDRAWN" if mark.get("type") == "withdrawn" else "SUPERSEDED"
            tail = f' → see `{mark.get("by")}`' if mark.get("by") else ""
            L.append(f'- ~~`{target["id"]}` **{target.get("from")}** — '
                     f'{clip(target.get("body"), width)}~~')
            L.append(f'  > {verb} by {mark.get("from")}{tail}: {clip(mark.get("body"), width)}')
        L.append("")

    if open_c:
        L.append("## ⚠ Unresolved conflicts — read before you write anything")
        for c in open_c:
            target = next((x for x in all_entries if x["id"] == c.get("re")), None)
            tail = ""
            if target:
                tail = f' ({target.get("from")}: "{clip(target.get("body"), 80)}")'
            L.append(f'- **{c.get("from")}** disputes `{c.get("re")}`{tail}')
            L.append(f'  > {c.get("body")}')
        L.append("")

    # 2. Adjudications. These were written to the board and rendered to nobody:
    #    digest() had no answer section at all, so the ruling that retired the
    #    "55 of 115" figure was invisible to every agent that read the board.
    if adjudications:
        L.append("## ✅ Adjudicated — these rulings are binding")
        for a in adjudications:
            L.append(f'- `{a.get("re")}` resolved by **{a.get("from")}** '
                     f'({observed_of(a)}): {clip(a.get("body"), width)}')
        L.append("")

    if open_q:
        L.append("## Open questions")
        for q in open_q:
            L.append(f'- `{q["id"]}` **{q.get("from")} → {q.get("to", "anyone")}**: '
                     f'{clip(q.get("body"), width)}')
        L.append("")

    claims = collapse_duplicates(by("claim"), key=lambda e: e.get("topic"))
    if claims:
        active = [c for c in claims if claim_state(c, board) == "active"]
        stale = [c for c in claims if claim_state(c, board) != "active"]
        L.append("## Claimed work — do not duplicate")
        for c in active:
            L.append(f'- **{c.get("from")}**: {c.get("topic")}{dupe_note(c)}')
        if not active:
            L.append("- *none active.*")
        if stale:
            # Compressed on purpose: a stale claim is only worth one line of
            # "this topic is free", not a paragraph of who abandoned it.
            L.append(f"- *{len(stale)} stale claim(s) from a closed or timed-out run — these "
                     f"topics are FREE to claim:* "
                     + ", ".join(f'~~{c.get("topic")}~~ ({c.get("from")})' for c in stale[:8]))
            if len(stale) > 8:
                L.append(f"  - *+{len(stale) - 8} more stale, listed by `--full`*")
        L.append("")

    live_finds = [f for f in by("finding") if f["id"] not in retired]
    n_retired_finds = len(by("finding")) - len(live_finds)
    if live_finds:
        finds = collapse_duplicates(live_finds)
        referenced = idx["referenced"]

        def binding(f: dict) -> bool:
            return bool(f.get("binding") or f["id"] in referenced
                        or BINDING_RE.search(f.get("body") or ""))

        must = [f for f in finds if binding(f)]
        rest = [f for f in finds if not binding(f)]
        # Selection is by consequence FIRST and recency only afterwards, so a
        # correction from wave one outranks a routine finding from wave four.
        keep = {f["id"] for f in must}
        room = len(rest) if full else max(0, limit - len(must))
        if room:
            keep |= {f["id"] for f in rest[-room:]}

        L.append("## Findings posted so far")
        rendered = 0
        for f in finds:
            if f["id"] not in keep:
                continue
            if not full and used() > budget and not binding(f):
                continue
            mark = " **[binding]**" if binding(f) else ""
            L.append(f'- `{f["id"]}` **{f.get("from")}** ({observed_of(f)}){mark} — '
                     f'{clip(f.get("body"), width)}{dupe_note(f)}')
            if f.get("evidence") and (full or binding(f)):
                L.append(f'  > evidence: {clip(f["evidence"], width if full else EVIDENCE_CLIP)}')
            rendered += 1
        collapsed = len(live_finds) - len(finds)
        if collapsed:
            L.append(f"- *{collapsed} near-duplicate finding(s) collapsed into the lines above.*")
        if len(finds) - rendered > 0:
            omitted.append(f"{len(finds) - rendered} finding(s)")
        if n_retired_finds:
            L.append(f"- *{n_retired_finds} withdrawn or superseded finding(s) are listed "
                     f"struck at the top of this digest.*")
        L.append("")

    hand = [h for h in by("handoff") if h.get("from") != "system"]
    if hand:
        keep_h = hand if full else hand[-10:]
        L.append("## Handoffs waiting")
        for h in keep_h:
            L.append(f'- **{h.get("from")} → {h.get("to", "orchestrator")}**: '
                     f'{clip(h.get("body"), width)}')
        if len(hand) - len(keep_h) > 0:
            omitted.append(f"{len(hand) - len(keep_h)} handoff(s)")
        L.append("")

    if omitted and not full:
        # The old digest dropped 25 of 65 findings and said nothing at all, so an
        # agent reading it had positive evidence they did not exist. Never again:
        # say what was left out, how many, and the exact command that shows it.
        L.append(f"## ⚠ Not shown above: {', '.join(omitted)}")
        L.append(f"Omitted to hold this digest near its ~{budget // 1000} KB budget (binding "
                 f"entries are never dropped, so it can run over) — they are NOT absent "
                 f"from the board. Everything: `python tools/board.py digest {slug(domain)} "
                 f"--full`. One thread: `--topic <prefix>`.")
        L.append("")

    L += ["---",
          "Findings here are other agents' work. Build on them, cite them by id, and post a "
          "`conflict` if you disagree rather than silently contradicting. If you prove one "
          "wrong, `board.py withdraw --re <id>` it — never just stop mentioning it."]
    return "\n".join(L)


def pending(domain: str) -> int:
    board = load(domain)
    entries = board["entries"]
    answered = {a.get("re") for a in entries if a.get("type") == "answer"}
    open_q = [e for e in entries if e.get("type") == "question" and e["id"] not in answered]
    open_c = [e for e in entries if e.get("type") == "conflict" and e["id"] not in answered]

    if not open_q and not open_c:
        print("nothing pending — no open questions or conflicts")
        return 0

    if open_c:
        print(f"\n{len(open_c)} UNRESOLVED CONFLICT(S):")
        for c in open_c:
            print(f'  {c["id"]}  {c.get("from")} vs {c.get("re")}\n     {c.get("body")}')
    if open_q:
        print(f"\n{len(open_q)} OPEN QUESTION(S):")
        for q in open_q:
            print(f'  {q["id"]}  {q.get("from")} -> {q.get("to", "anyone")}\n     {q.get("body")}')
    return 1  # so a wave can gate on "board clean"


def find_entry(domain: str, entry_id: str):
    return next((e for e in load(domain)["entries"] if e.get("id") == entry_id), None)


def withdraw(domain: str, sender: str, ref: str, body: str) -> int:
    """Retire an entry in public.

    Observed 2026-09-17: internal-linking-engineer's "55 of 115 blog posts carry
    in-body service links" was adjudicated a measurement artifact and withdrawn —
    and afterwards the board showed neither the figure nor the withdrawal. The
    disputed number survived in a shipped report anyway. A withdrawal has to
    leave a louder trace than the claim did, which means a row, not a deletion.
    """
    if not find_entry(domain, ref):
        print(f"no entry {ref} on this board — --re must name a real entry", file=sys.stderr)
        return 1
    e = append(domain, type="withdrawn", **{"from": sender}, re=ref, body=body)
    print(f'{ref} withdrawn by {sender} as {e["id"]} — it now renders struck, with your reason')
    return 0


# ------------------------------------------------------------------------- cli

def main(argv=None) -> int:
    utf8_stdout()
    ap = argparse.ArgumentParser(prog="board.py", add_help=True,
                                 description="Shared blackboard for the SEO agent team.")
    ap.add_argument("command", choices=["open", "close", "digest", "pending", "post", "ask",
                                        "answer", "claim", "conflict", "withdraw"])
    ap.add_argument("domain")
    ap.add_argument("--run")
    ap.add_argument("--goal")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--topic")
    ap.add_argument("--type", dest="etype", choices=list(TYPES))
    ap.add_argument("--from", dest="sender")
    ap.add_argument("--to")
    ap.add_argument("--re", dest="ref")
    ap.add_argument("--body")
    ap.add_argument("--evidence")
    ap.add_argument("--supersedes", help="entry id this post replaces; retires it in the digest")
    ap.add_argument("--observed", help="date the thing was OBSERVED (YYYY-MM-DD), as distinct "
                                       "from now, which is when it is being written down")
    ap.add_argument("--binding", action="store_true",
                    help="never omit this entry from a budgeted digest")
    ap.add_argument("--full", action="store_true", help="digest: everything, no budget")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET)
    a = ap.parse_args(argv)

    def need(v, msg):
        if not v:
            print(msg, file=sys.stderr)
            sys.exit(1)
        return v

    if a.command == "open":
        open_run(a.domain, need(a.run, "--run required"), a.goal)

    elif a.command == "close":
        return close_run(a.domain, a.run)

    elif a.command == "digest":
        print(digest(a.domain, a.limit, a.topic, full=a.full, budget=a.budget))

    elif a.command == "pending":
        return pending(a.domain)

    elif a.command == "post":
        if a.supersedes and not find_entry(a.domain, a.supersedes):
            print(f"no entry {a.supersedes} on this board — --supersedes must name a real entry",
                  file=sys.stderr)
            return 1
        e = append(a.domain, type=need(a.etype, f"--type required ({'|'.join(TYPES)})"),
                   **{"from": need(a.sender, "--from required")},
                   topic=a.topic, body=need(a.body, "--body required"),
                   evidence=a.evidence, to=a.to, re=a.ref,
                   observedAt=a.observed, binding=a.binding or None)
        print(f'{a.etype} posted as {e["id"]}')
        if a.supersedes:
            append(a.domain, type="supersede", **{"from": a.sender}, re=a.supersedes,
                   by=e["id"], body=f'Superseded by {e["id"]}: {clip(a.body, 120)}')
            print(f'{a.supersedes} retired — it now renders struck, pointing at {e["id"]}')
        if not a.observed:
            print("note: no --observed given, so this is recorded as observed today. Pass "
                  "--observed for anything measured earlier.", file=sys.stderr)

    elif a.command == "ask":
        e = append(a.domain, type="question", **{"from": need(a.sender, "--from required")},
                   to=a.to or "anyone", topic=a.topic, body=need(a.body, "--body required"),
                   observedAt=a.observed)
        print(f'question {e["id"]} posted to {a.to or "anyone"}')

    elif a.command == "answer":
        e = append(a.domain, type="answer", **{"from": need(a.sender, "--from required")},
                   re=need(a.ref, "--re <question id> required"),
                   body=need(a.body, "--body required"), evidence=a.evidence,
                   observedAt=a.observed)
        print(f'answer {e["id"]} resolves {a.ref}')

    elif a.command == "claim":
        outcome, e = claim_topic(a.domain, need(a.sender, "--from required"),
                                 need(a.topic, "--topic required"), a.body, a.observed)
        if outcome == "yours":
            print(f'already yours: {e["id"]}: {e.get("topic")}')
            return 0
        if outcome == "held":
            print(f'ALREADY CLAIMED by {e["from"]} — pick different work or '
                  f'coordinate via board ask', file=sys.stderr)
            return 2
        print(f'claimed {e["id"]}: {e.get("topic")}')

    elif a.command == "conflict":
        e = append(a.domain, type="conflict", **{"from": need(a.sender, "--from required")},
                   re=need(a.ref, "--re <entry id> required"),
                   body=need(a.body, "--body required"), evidence=a.evidence,
                   observedAt=a.observed)
        print(f'conflict {e["id"]} raised against {a.ref} — orchestrator must adjudicate '
              f'before this ships')

    elif a.command == "withdraw":
        return withdraw(a.domain, need(a.sender, "--from required"),
                        need(a.ref, "--re <entry id> required"),
                        need(a.body, "--body required — say why it is wrong"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
