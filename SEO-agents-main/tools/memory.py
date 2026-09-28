#!/usr/bin/env python3
"""memory.py — persistent per-site memory for the SEO agent team.

SEO is a long game measured in quarters. Without memory every run starts from
zero, re-derives the same conclusions, re-litigates settled decisions, and
cannot tell whether anything it did last month worked.

Five stores, each with a different write discipline:
    facts       verified, durable truths about the site      (upsert)
    decisions   choices made, with rationale + who decided   (append-only)
    baselines   metric snapshots over time                   (append-only)
    changes     what actually shipped, and when              (append-only)
    learnings   what worked, what did not, and why           (append-only)

Append-only matters: an agent that can rewrite history can quietly erase a
failed prediction. These logs are the evidence base for whether the programme is
working.

Corrections therefore travel forward, never backward. `--supersedes` stamps a
retired entry with a pointer to the one that replaced it; the retired entry
keeps its text, its author and its date, and simply stops being quoted as
current. Nothing is ever deleted or rewritten.

Usage:
    python tools/memory.py init example.com
    python tools/memory.py digest example.com [--full]
    python tools/memory.py fact example.com --key stack --value "Next.js" --source recon
    python tools/memory.py fact example.com --key urls --value 779 --source "sitemap walk" \\
           --supersedes sitemap_urls --observed 2026-09-18
    python tools/memory.py decide example.com --what "..." --why "..." --by seo-director
    python tools/memory.py baseline example.com --metric organic_clicks --value 4102 --source GSC
    python tools/memory.py change example.com --what "..." --agent onpage-optimizer
    python tools/memory.py learn example.com --what "..." --outcome worked|failed|unclear
    python tools/memory.py trend example.com --metric organic_clicks
    python tools/memory.py keys example.com        # near-duplicate key lint
    python tools/memory.py sites

Stdlib only — no install required.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("memory")
STORES = ("facts", "decisions", "baselines", "changes", "learnings")

# Every agent reads this digest before it does any work, so its size is a tax on
# all 52 of them. The old one was 22.6 KB and unbounded in its largest section —
# and it paid for that size by silently dropping 8 of 16 decisions, including
# "recommendations only, no repo writes". Budget it, and disclose the omission.
DEFAULT_BUDGET = 11000
VALUE_CLIP = 220
WHY_CLIP = 140

# Decisions that bind the whole engagement rather than one wave. These are never
# omitted, whatever the budget, because an agent that cannot see the standing
# constraint will violate it.
BINDING_RE = re.compile(
    r"\b(CRITICAL|CORRECTION|do not|never|must not|no repo writes|standing|binding)", re.I)

# Token-set Jaccard thresholds. 0.85 collapses two renderings of one decision;
# 0.6 is loose enough to catch `us_sitemap_url_count` next to
# `us-sitemap-url-count` and warn about it at write time.
DUP_SIMILARITY = 0.85
# A ratification is worded slightly differently from the decision it ratifies —
# the orchestrator dropped "or vice versa" and landed at 0.79 — so echo
# detection sits below the same-agent collapse threshold.
ECHO_SIMILARITY = 0.75
# Key-alias thresholds. The real aliases were one token apart — `us_tree_size`
# beside `us_tree_urls` is 0.5 — so the write-time warning has to reach lower
# than the digest's grouping, which errs the other way to avoid lumping
# unrelated facts into one cluster.
NEAR_KEY_SIMILARITY = 0.5
CLUSTER_SIMILARITY = 0.6

# Bounded by construction: this repo's guard hook blocks unbounded polling after
# a 42-minute zombie (commit cbe727b), and a JSON write has no business waiting
# longer than a couple of seconds anyway.
LOCK_ATTEMPTS = 40
LOCK_SLEEP = 0.05
STALE_LOCK_SECONDS = 30

DATE_IN_PROSE = re.compile(r"\b(20\d\d-\d\d-\d\d)\b")


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


def sdir(domain: str) -> Path:
    return ROOT / slug(domain)


def sfile(domain: str, store: str) -> Path:
    return sdir(domain) / f"{store}.json"


def now() -> str:
    """Write time, local, WITH its offset.

    The old stamp was UTC and unlabelled while the team works in IST, so the
    whole 2026-09-17 store is stamped a day before the work happened, and every
    agent that wrote the real date into --source disagreed with the tool that
    stamped the row. An offset-bearing local stamp is unambiguous either way.
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
    """When the thing was SEEN, as opposed to when it was typed.

    Preference order: the explicit --observed field; a date the agent wrote into
    its own prose (which is what agents did to work around the missing field —
    every one of the 44 existing facts carries its real date in `source`); and
    only then the write stamp, rendered local rather than UTC.

    Existing rows are read this way, never rewritten. Append-only means the
    stored data stays exactly as it was filed.
    """
    if entry.get("observedAt"):
        return str(entry["observedAt"])[:10]
    for field in ("source", "note", "why", "what"):
        m = DATE_IN_PROSE.search(str(entry.get(field) or ""))
        if m:
            return m.group(1)
    stamp = entry.get("updatedAt") or entry.get("at")
    d = parse_at(stamp)
    return d.astimezone().date().isoformat() if d else str(stamp or "")[:10]


def sort_key(entry: dict):
    """Chronological by OBSERVATION, not by insertion order.

    `pts[-1]` treated the last-appended baseline as the current one, so a
    backfilled older reading would become "current" and invert the delta.
    """
    return (observed_of(entry), str(entry.get("at") or ""))


@contextmanager
def file_lock(path: Path):
    """Cross-platform advisory lock: atomic O_EXCL create, bounded retry.

    The same unlocked load-modify-save that let six concurrent agents clobber
    each other's board claims on 2026-09-22 exists here: `append()` reads the
    whole store, mutates the list and writes it back. os.open(O_CREAT|O_EXCL) is
    atomic on both NTFS and POSIX, which fcntl and msvcrt locking are not
    portably.
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
                # The holder was killed. Agents get killed mid-run here, so a
                # lock file must never be able to wedge a store permanently.
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


def load(domain: str, store: str):
    p = sfile(domain, store)
    empty = {} if store == "facts" else []
    if not p.exists():
        return empty
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return empty


def save(domain: str, store: str, data) -> None:
    """Temp file + os.replace, so a concurrent reader never sees a half file."""
    sdir(domain).mkdir(parents=True, exist_ok=True)
    p = sfile(domain, store)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def new_id(store: str, taken=None) -> str:
    base = int(time.time() * 1000)
    for bump in range(64):
        candidate = f"{store[:3]}_{base + bump:x}"
        if not taken or candidate not in taken:
            return candidate
    # Two writes inside one millisecond used to produce the same id, and a
    # duplicate id breaks every --supersedes that points at it.
    raise RuntimeError(f"could not mint a unique {store} id")


def append(domain: str, store: str, entry: dict) -> int:
    with file_lock(sfile(domain, store)):
        items = load(domain, store)
        taken = {i.get("id") for i in items}
        items.append({"id": new_id(store, taken), "at": now(),
                      **{k: v for k, v in entry.items() if v is not None}})
        save(domain, store, items)
        return len(items)


# ------------------------------------------------------------------- utilities

def norm_key(key: str) -> str:
    """`us-sitemap-url-count` and `us_sitemap_url_count` are one key.

    Hyphen/underscore/case variants were distinct dict keys, so `upsert_fact`'s
    previous/changedFrom audit trail never fired and the /us/ page count ended
    up live under four keys at once with no conflict ever detected.
    """
    return re.sub(r"[^a-z0-9]+", "_", str(key or "").lower()).strip("_")


def tokens(text) -> set:
    return set(re.findall(r"[a-z0-9]+", str(text or "").lower()))


def similarity(a, b) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def resolve_key(facts: dict, key: str):
    """The existing key this one is really an alias of, if any."""
    if key in facts:
        return key
    n = norm_key(key)
    return next((k for k in facts if norm_key(k) == n), None)


def near_keys(facts: dict, key: str) -> list:
    n = norm_key(key)
    return [k for k in facts
            if norm_key(k) != n and similarity(norm_key(k), n) >= NEAR_KEY_SIMILARITY]


def is_retired(entry: dict) -> bool:
    return bool(entry.get("supersededBy") or entry.get("retiredAt"))


def clip(text, width: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= width else s[: width - 1].rstrip() + "…"


def collapse_duplicates(items: list, key=lambda e: e.get("what")) -> list:
    """Same author, near-identical text: one decision recorded twice.

    Observed 2026-09-17: international-seo-specialist and seo-orchestrator filed
    "keep both trees and differentiate" 32 seconds apart. Rendering both models
    a ratification as two independent authorities agreeing, and burns a slot
    that pushed a different decision off the bottom of the digest.
    """
    out: list = []
    for e in items:
        for kept in out:
            same_author = (kept.get("by") or kept.get("agent")) == (e.get("by") or e.get("agent"))
            if similarity(key(kept), key(e)) >= DUP_SIMILARITY and same_author:
                kept.setdefault("_dupes", []).append(e.get("id"))
                break
        else:
            out.append(dict(e))
    return out


def mark_echoes(items: list, key=lambda e: e.get("what")) -> list:
    """Two AGENTS filing the same ruling is a ratification, not a second ruling.

    collapse_duplicates only merges one agent repeating itself. When the
    orchestrator restated international-seo-specialist's "keep both trees"
    decision 32 seconds later, both entries were real and both deserved to
    survive — but rendering them as two independent authorities inflates the
    apparent weight of the conclusion. Keep both, say which is the echo.
    """
    for i, e in enumerate(items):
        for earlier in items[:i]:
            if similarity(key(earlier), key(e)) >= ECHO_SIMILARITY:
                e["_echoOf"] = earlier
                break
    return items


def echo_note(entry: dict) -> str:
    e = entry.get("_echoOf")
    if not e:
        return ""
    return (f' — restates the {e.get("by", "earlier")} decision above; '
            f'one decision ratified, not two')


def dupe_note(entry: dict) -> str:
    n = len(entry.get("_dupes") or [])
    return f" *(recorded {n + 1}×)*" if n else ""


# ------------------------------------------------------------------ operations

def init(domain: str) -> None:
    sdir(domain).mkdir(parents=True, exist_ok=True)
    for s in STORES:
        if not sfile(domain, s).exists():
            save(domain, s, {} if s == "facts" else [])
    readme = sdir(domain) / "README.md"
    if not readme.exists():
        readme.write_text(f"""# Memory — {slug(domain)}

Written and read by the SEO agent team via `tools/memory.py`. Edit the JSON by hand
only if you know what you are doing.

| Store | Discipline | Holds |
|---|---|---|
| `facts.json` | upsert | Verified durable truths: stack, market, constraints |
| `decisions.json` | append-only | Choices made, why, by whom, what they ruled out |
| `baselines.json` | append-only | Metric snapshots with source and date |
| `changes.json` | append-only | What shipped, when, by which agent |
| `learnings.json` | append-only | What worked, what failed, and the reasoning |

Append-only logs are deliberate. An agent that can rewrite history can quietly
erase a prediction that turned out wrong. Corrections go in with `--supersedes`,
which retires the old entry by pointing forward at the new one — the old text
stays exactly as it was filed.
""", encoding="utf-8")
    print(f"memory initialized: {sdir(domain)}")


def retire_fact(domain: str, key: str, successor: str, why=None) -> bool:
    """Stamp a forward pointer on a retired fact. The claim itself is untouched.

    This is the one write an append-only log should permit: it adds "this was
    replaced by X", it does not edit what the entry said. Without it,
    "Supersedes the earlier 683 figure" was prose the tool never parsed, so
    sitemap_urls=683 kept rendering next to the verified 779 with nothing in the
    data saying which was current.
    """
    with file_lock(sfile(domain, "facts")):
        facts = load(domain, "facts")
        target = resolve_key(facts, key)
        if not target:
            return False
        facts[target]["supersededBy"] = successor
        facts[target]["retiredAt"] = now()
        if why:
            facts[target]["retiredWhy"] = why
        save(domain, "facts", facts)
    return True


def retire_entry(domain: str, store: str, ref: str, successor: str, why=None) -> bool:
    """Same forward pointer, for the append-only stores. Matches id or metric."""
    with file_lock(sfile(domain, store)):
        items = load(domain, store)
        hits = [i for i in items
                if i.get("id") == ref or norm_key(i.get("metric") or "") == norm_key(ref)]
        hits = [h for h in hits if h.get("id") != successor]
        if not hits:
            return False
        for h in hits:
            h["supersededBy"] = successor
            h["retiredAt"] = now()
            if why:
                h["retiredWhy"] = why
        save(domain, store, items)
    return True


def upsert_fact(domain: str, key: str, value: str, source=None,
                observed=None, topic=None, supersedes=None, binding: bool = False) -> None:
    with file_lock(sfile(domain, "facts")):
        facts = load(domain, "facts")
        canonical = resolve_key(facts, key)
        aliased = bool(canonical and canonical != key)
        near = near_keys(facts, key) if not canonical else []
        target = canonical or key
        prior = facts.get(target)
        entry = {"value": value, "source": source or "unspecified", "updatedAt": now(),
                 "observedAt": observed or today()}
        if topic:
            entry["topic"] = topic
        if binding:
            entry["binding"] = True
        if prior:
            entry["previous"] = prior.get("value")
            entry["changedFrom"] = prior.get("updatedAt")
            for carry in ("topic", "aliases", "binding"):
                if prior.get(carry) and carry not in entry:
                    entry[carry] = prior[carry]
        if aliased:
            entry["aliases"] = sorted(set((entry.get("aliases") or []) + [key]))
        facts[target] = entry
        save(domain, "facts", facts)

    if aliased:
        print(f'fact "{key}" normalised onto existing key "{target}" — same key, '
              f"different punctuation")
    if prior and prior.get("value") != value:
        print(f'fact updated: {target} — was "{prior.get("value")}", now "{value}"')
    else:
        print(f"fact set: {target} = {value}")
    if near:
        # Warn, do not refuse: the writer may genuinely mean a new key. But the
        # /us/ page count lived under four keys at once because nothing ever
        # said a word about it at write time.
        print(f'NEAR-DUPLICATE KEY: "{key}" looks like {", ".join(near[:4])}. '
              f"If it is the same fact, write it under that key or pass "
              f"--supersedes <key>.", file=sys.stderr)
    if supersedes:
        if retire_fact(domain, supersedes, target):
            print(f'{supersedes} retired — superseded by "{target}"')
        elif retire_entry(domain, "baselines", supersedes, target):
            print(f'baseline {supersedes} retired — superseded by fact "{target}"')
        else:
            print(f'--supersedes "{supersedes}" matched no fact or baseline', file=sys.stderr)
    if not observed:
        print("note: no --observed given, so this is recorded as observed today. Pass "
              "--observed for anything measured earlier.", file=sys.stderr)


def cluster_facts(facts: dict) -> list:
    """Group keys that carry the same fact under different names.

    Four keys held the /us/ URL count and four more held the placeholder-zero
    scope; each rendered its own line, so the facts section grew monotonically
    and duplication was its main growth driver. Grouping renders the newest of
    each cluster and names the rest.
    """
    clusters: list = []
    for k in facts:
        for c in clusters:
            same_topic = (facts[k].get("topic")
                          and facts[k].get("topic") == facts[c[0]].get("topic"))
            if same_topic or similarity(norm_key(c[0]), norm_key(k)) >= CLUSTER_SIMILARITY:
                c.append(k)
                break
        else:
            clusters.append([k])
    return clusters


def digest(domain: str, limit: int = 8, full: bool = False,
           budget: int = DEFAULT_BUDGET) -> str:
    if not sdir(domain).exists():
        return (f"No memory for {slug(domain)}. This is a first run — establish baselines "
                "and record decisions as you go.")

    facts = load(domain, "facts")
    decisions = load(domain, "decisions")
    baselines = load(domain, "baselines")
    changes = load(domain, "changes")
    learnings = load(domain, "learnings")

    width = 10 ** 6 if full else VALUE_CLIP
    omitted: list = []

    L = [f"# Memory — {slug(domain)}", ""]

    def used() -> int:
        return len("\n".join(L))

    # Decisions first and in full. The old digest printed `decisions[-8:]` of 16
    # and said nothing about the other 8 — one of which was "recommendations
    # only, no repo writes", the single most consequential standing instruction
    # in the engagement. An agent reading a section headed "do not re-litigate"
    # had positive evidence it did not exist.
    if decisions:
        live = [d for d in decisions if not is_retired(d)]
        retired = [d for d in decisions if is_retired(d)]
        shown = mark_echoes(collapse_duplicates(live))
        collapsed = len(live) - len(shown)
        L.append("## Decisions already made — do not re-litigate without new evidence")
        printed = 0
        for d in sorted(shown, key=lambda d: not _binding_decision(d)):
            if not full and used() > budget and not _binding_decision(d):
                continue
            mark = " **[standing]**" if _binding_decision(d) else ""
            L.append(f'- **{clip(d.get("what"), width)}**{mark} — '
                     f'{clip(d.get("why"), width if full else WHY_CLIP)} '
                     f'*({d.get("by", "unknown")}, {observed_of(d)})*'
                     f'{dupe_note(d)}{echo_note(d)}')
            if d.get("ruledOut"):
                L.append(f'  - ruled out: {clip(d["ruledOut"], width)}')
            printed += 1
        if collapsed:
            L.append(f"- *{collapsed} near-duplicate decision(s) collapsed into the lines above.*")
        if len(shown) - printed > 0:
            omitted.append(f"{len(shown) - printed} decision(s)")
        if retired:
            if full:
                for d in retired:
                    L.append(f'- ~~{clip(d.get("what"), width)}~~ — RETIRED, superseded by '
                             f'{d.get("supersededBy")}')
            else:
                L.append(f"- *{len(retired)} retired decision(s) hidden — `--full` shows them "
                         f"with what superseded each.*")
        L.append("")

    if facts:
        live_keys = [k for k in facts if not is_retired(facts[k])]
        retired_keys = [k for k in facts if is_retired(facts[k])]
        L.append("## Established facts")
        hidden = 0
        clusters = cluster_facts({k: facts[k] for k in live_keys})
        # Freshest cluster first, so the budget cuts the stalest facts rather
        # than the newest — the old digest's recency-truncation dropped exactly
        # the corrections, and ordering by dict insertion would do it again.
        clusters.sort(key=lambda c: max(observed_of(facts[k]) for k in c), reverse=True)
        for cluster in clusters:
            ordered = sorted(cluster, key=lambda k: observed_of(facts[k]), reverse=True)
            head, rest = ordered[0], ordered[1:]
            f = facts[head]
            if not full and used() > budget and not f.get("binding"):
                hidden += len(ordered)
                continue
            line = (f'- **{head}**: {clip(f["value"], width)}  '
                    f'*({clip(f["source"], 90)}, observed {observed_of(f)})*')
            if f.get("previous"):
                line += f' — changed from "{clip(f["previous"], 60)}"'
            L.append(line)
            if rest and not full:
                L.append(f'  - *+{len(rest)} earlier observation(s) of the same fact under '
                         f'{", ".join("`" + k + "`" for k in rest[:4])} — `--full` to read them*')
            elif rest:
                for k in rest:
                    L.append(f'  - `{k}`: {clip(facts[k]["value"], width)} '
                             f'*(observed {observed_of(facts[k])})*')
        if hidden:
            omitted.append(f"{hidden} fact(s)")
        if retired_keys:
            if full:
                for k in retired_keys:
                    L.append(f'- ~~**{k}**: {clip(facts[k]["value"], width)}~~ — RETIRED, '
                             f'superseded by {facts[k].get("supersededBy")}')
            else:
                L.append(f"- *{len(retired_keys)} retired fact(s) hidden — they were superseded; "
                         f"`--full` shows each with its successor.*")
        L.append("")

    if baselines:
        by_metric: dict = {}
        for b in baselines:
            by_metric.setdefault(norm_key(b["metric"]), []).append(b)
        L.append("## Metric baselines")
        retired_n = 0
        for m, raw in by_metric.items():
            pts = sorted([p for p in raw if not is_retired(p)], key=sort_key)
            retired_n += len(raw) - len(pts)
            if not pts:
                # Every reading of this metric has been superseded; the headline
                # belongs to whatever replaced it, not here.
                if full:
                    last = sorted(raw, key=sort_key)[-1]
                    L.append(f'- ~~**{m}**: {last["value"]}~~ — RETIRED, superseded by '
                             f'{last.get("supersededBy")}')
                continue
            first, last = pts[0], pts[-1]
            delta = ""
            if len(pts) > 1 and isinstance(first["value"], (int, float)) and first["value"]:
                pct = (last["value"] - first["value"]) / first["value"] * 100
                delta = f' ({"+" if pct > 0 else ""}{pct:.1f}% since {observed_of(first)})'
            line = (f'- **{last["metric"]}**: {last["value"]} '
                    f'*({clip(last["source"], 90)}, observed {observed_of(last)})*{delta}')
            if last.get("note"):
                line += f' — {clip(last["note"], WHY_CLIP if not full else width)}'
            L.append(line)
            if full:
                for p in sorted(raw, key=sort_key):
                    if is_retired(p):
                        L.append(f'  - ~~{p["value"]} *(observed {observed_of(p)})*~~ — '
                                 f'RETIRED, superseded by {p.get("supersededBy")}')
        if retired_n and not full:
            L.append(f"- *{retired_n} superseded reading(s) hidden — `--full` shows them with "
                     f"what replaced each.*")
        L.append("")

    if changes:
        keep = changes if full else changes[-limit:]
        L.append(f"## Recently shipped ({len(changes)} total)")
        for c in sorted(keep, key=sort_key):
            L.append(f'- {observed_of(c)} — {clip(c.get("what"), width)} '
                     f'*({c.get("agent", "unknown")})*')
        if len(changes) - len(keep) > 0:
            omitted.append(f"{len(changes) - len(keep)} change(s)")
        L.append("")

    if learnings:
        order = {"failed": 0, "unclear": 1, "worked": 2}
        ranked = sorted(learnings, key=lambda e: order.get(e.get("outcome"), 3))
        keep = ranked if full else ranked[:limit]
        L.append("## Learnings")
        for x in keep:
            why = f' — {clip(x["why"], width if full else WHY_CLIP)}' if x.get("why") else ""
            L.append(f'- [{(x.get("outcome") or "unclear").upper()}] '
                     f'{clip(x.get("what"), width)}{why}')
        if len(ranked) - len(keep) > 0:
            omitted.append(f"{len(ranked) - len(keep)} learning(s)")
        L.append("")

    if len(L) == 2:
        return f"Memory exists for {slug(domain)} but is empty. Populate it as you work."

    if omitted and not full:
        L.append(f"## ⚠ Not shown above: {', '.join(omitted)}")
        L.append(f"Omitted to hold this digest near its ~{budget // 1000} KB budget (standing "
                 f"decisions are never dropped, so it can run over) — they are NOT absent "
                 f"from memory. Everything: `python tools/memory.py digest {slug(domain)} "
                 f"--full`. One metric's history: `memory.py trend {slug(domain)} --metric <m>`.")
        L.append("")

    L += ["---",
          "Dates above are observation dates in local time; where an entry predates the "
          "observedAt field, the date is the one its own source text records.",
          "Treat the above as established context. Contradicting it requires new evidence — "
          "and if you find that evidence, record the correction with `--supersedes` rather "
          "than filing a second, contradictory entry beside the first."]
    return "\n".join(L)


def _binding_decision(d: dict) -> bool:
    return bool(d.get("binding") or d.get("scope") == "standing"
                or BINDING_RE.search(f'{d.get("what") or ""} {d.get("why") or ""}'))


def trend(domain: str, metric: str) -> None:
    pts = [b for b in load(domain, "baselines") if norm_key(b["metric"]) == norm_key(metric)]
    if not pts:
        print(f'no baselines recorded for "{metric}"')
        return
    pts = sorted(pts, key=sort_key)
    print(f"# {metric} — {slug(domain)}\n")
    print("| observed | value | source | note | state |")
    print("|---|---|---|---|---|")
    for p in pts:
        state = f'RETIRED → {p.get("supersededBy")}' if is_retired(p) else "current"
        print(f'| {observed_of(p)} | {p["value"]} | {p["source"]} | {p.get("note", "")} '
              f'| {state} |')
    live = [p for p in pts if not is_retired(p)]
    nums = [p["value"] for p in live if isinstance(p["value"], (int, float))]
    if len(nums) > 1 and nums[0]:
        chg = (nums[-1] - nums[0]) / nums[0] * 100
        print(f'\nChange over {len(live)} live readings: {"+" if chg > 0 else ""}{chg:.1f}%')


def key_lint(domain: str) -> int:
    """Report fact keys that are near-duplicates of one another.

    The store reached four live keys for the /us/ URL count and four more for
    the placeholder-zero scope before anyone noticed, because nothing ever
    looked.
    """
    facts = load(domain, "facts")
    clusters = [c for c in cluster_facts(facts) if len(c) > 1]
    if not clusters:
        print("no near-duplicate fact keys")
        return 0
    print(f"{len(clusters)} cluster(s) of near-duplicate keys — consider "
          f"`fact --supersedes <old-key>`:\n")
    for c in clusters:
        print(f"  {' | '.join(c)}")
        for k in c:
            print(f'    {k:<40} {clip(facts[k]["value"], 60)}  ({observed_of(facts[k])})')
        print()
    return 0


def list_sites() -> None:
    if not ROOT.exists():
        print("no memory yet")
        return
    sites = [d.name for d in ROOT.iterdir() if d.is_dir()]
    if not sites:
        print("no memory yet")
        return
    for s in sites:
        print(f'{s:<32} {len(load(s, "decisions"))} decisions · '
              f'{len(load(s, "baselines"))} baselines · {len(load(s, "changes"))} changes')


# ------------------------------------------------------------------------- cli

def main(argv=None) -> int:
    utf8_stdout()
    ap = argparse.ArgumentParser(prog="memory.py",
                                 description="Persistent per-site memory for the SEO agent team.")
    ap.add_argument("command", choices=["init", "digest", "trend", "sites", "keys",
                                        "fact", "decide", "baseline", "change", "learn"])
    ap.add_argument("domain", nargs="?")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--key"); ap.add_argument("--value"); ap.add_argument("--source")
    ap.add_argument("--what"); ap.add_argument("--why"); ap.add_argument("--by")
    ap.add_argument("--ruled-out", dest="ruled_out")
    ap.add_argument("--metric"); ap.add_argument("--note")
    ap.add_argument("--agent"); ap.add_argument("--urls")
    ap.add_argument("--outcome", choices=["worked", "failed", "unclear"])
    ap.add_argument("--supersedes", help="id (or fact key, or metric name) this entry retires")
    ap.add_argument("--observed", help="date the thing was OBSERVED (YYYY-MM-DD), as distinct "
                                       "from now, which is when it is being written down")
    ap.add_argument("--topic", help="groups facts that describe the same thing")
    ap.add_argument("--binding", action="store_true",
                    help="standing constraint: never omit it from a budgeted digest")
    ap.add_argument("--full", action="store_true", help="digest: everything, no budget")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET)
    a = ap.parse_args(argv)

    def need(v, msg):
        if not v:
            print(msg, file=sys.stderr)
            sys.exit(1)
        return v

    if a.command == "sites":
        list_sites(); return 0

    need(a.domain, f"usage: memory.py {a.command} <domain>")

    def retire_for(store: str, successor_id: str) -> None:
        """Wire --supersedes for the append-only stores, warning if it matched nothing."""
        if not a.supersedes:
            return
        if retire_entry(a.domain, store, a.supersedes, successor_id, a.why):
            print(f"{a.supersedes} retired — superseded by {successor_id}")
        else:
            print(f'--supersedes "{a.supersedes}" matched no {store} entry — nothing retired',
                  file=sys.stderr)

    def last_id(store: str) -> str:
        items = load(a.domain, store)
        return items[-1]["id"] if items else ""

    if a.command == "init":
        init(a.domain)
    elif a.command == "digest":
        print(digest(a.domain, a.limit, full=a.full, budget=a.budget))
    elif a.command == "keys":
        return key_lint(a.domain)
    elif a.command == "trend":
        trend(a.domain, need(a.metric, "--metric required"))
    elif a.command == "fact":
        upsert_fact(a.domain, need(a.key, "--key required"), need(a.value, "--value required"),
                    a.source, observed=a.observed, topic=a.topic,
                    supersedes=a.supersedes, binding=a.binding)
    elif a.command == "decide":
        n = append(a.domain, "decisions", {"what": need(a.what, "--what required"),
                                           "why": need(a.why, "--why required"),
                                           "by": a.by, "ruledOut": a.ruled_out,
                                           "observedAt": a.observed or today(),
                                           "binding": a.binding or None})
        print(f"decision #{n} recorded")
        retire_for("decisions", last_id("decisions"))
    elif a.command == "baseline":
        raw = need(a.value, "--value required")
        try:
            val = float(raw) if "." in raw else int(raw)
        except ValueError:
            val = raw
        n = append(a.domain, "baselines", {
            "metric": need(a.metric, "--metric required"), "value": val,
            "source": need(a.source, "--source required — where did this number come from?"),
            "note": a.note, "observedAt": a.observed or today(),
            "binding": a.binding or None})
        print(f"baseline #{n} recorded")
        retire_for("baselines", last_id("baselines"))
        if not a.observed:
            print("note: no --observed given, so this is recorded as observed today. Pass "
                  "--observed for anything measured earlier.", file=sys.stderr)
    elif a.command == "change":
        n = append(a.domain, "changes", {"what": need(a.what, "--what required"),
                                         "agent": a.agent, "urls": a.urls,
                                         "observedAt": a.observed or today()})
        print(f"change #{n} logged")
    elif a.command == "learn":
        n = append(a.domain, "learnings", {"what": need(a.what, "--what required"),
                                           "outcome": need(a.outcome, "--outcome required"),
                                           "why": a.why,
                                           "observedAt": a.observed or today()})
        print(f"learning #{n} recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
