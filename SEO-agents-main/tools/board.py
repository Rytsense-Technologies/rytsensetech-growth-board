#!/usr/bin/env python3
"""board.py — the shared blackboard the agent team coordinates through.

Sibling subagents cannot message each other: they run concurrently, in isolated
contexts, and only their parent sees their output. So they coordinate the way
distributed systems have always coordinated without a message bus — through
shared state everyone reads and appends to.

Append-only, run-scoped, readable mid-run. Agent B can act on what Agent A found
while A is still working, which is the whole point. `memory.py` is the long-term
record across engagements; this is the working surface within one.

Six entry types, each earning its place:
    finding   a verified claim, with its evidence
    question  posed to a role, answerable by whoever holds it
    answer    resolves a question
    claim     "I am working on this" — stops two agents doing the same job
    conflict  "this contradicts entry X" — surfaces disagreement mechanically
    handoff   output another agent is waiting on

Append-only on purpose. An agent that can edit the board can quietly delete the
finding that contradicts it.

Usage:
    python tools/board.py open <domain> --run <slug> --goal "..."
    python tools/board.py digest <domain>
    python tools/board.py post <domain> --from serp-landscape-analyst \\
           --type finding --topic us-serps --body "..." --evidence "..."
    python tools/board.py ask <domain> --from x --to competitor-analyst --body "..."
    python tools/board.py answer <domain> --from y --re bd_12ab --body "..."
    python tools/board.py claim <domain> --from z --topic "cost-serp analysis"
    python tools/board.py conflict <domain> --from q --re bd_12ab --body "..."
    python tools/board.py pending <domain>

Stdlib only — no install required.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("memory")
TYPES = ("finding", "question", "answer", "claim", "conflict", "handoff")


def slug(domain: str) -> str:
    d = re.sub(r"^https?://", "", str(domain))
    d = re.sub(r"^www\.", "", d)
    return d.split("/")[0].lower()


def board_path(domain: str) -> Path:
    return ROOT / slug(domain) / "board.json"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load(domain: str) -> dict:
    p = board_path(domain)
    if not p.exists():
        return {"run": None, "goal": None, "openedAt": None, "entries": []}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"run": None, "goal": None, "openedAt": None, "entries": []}


def save(domain: str, board: dict) -> None:
    p = board_path(domain)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(board, indent=2, ensure_ascii=False), encoding="utf-8")


def new_id() -> str:
    rand = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=5))
    return f"bd_{rand}{int(time.time() * 1000) % 10000:04x}"


def append(domain: str, **entry) -> dict:
    board = load(domain)
    e = {"id": new_id(), "at": now(), **{k: v for k, v in entry.items() if v is not None}}
    board["entries"].append(e)
    save(domain, board)
    return e


# ------------------------------------------------------------------ operations

def open_run(domain: str, run: str, goal: str | None) -> None:
    board = load(domain)
    # Opening a new run archives the previous one rather than wiping it — the
    # trail of what was decided last time is the point.
    if board.get("run") and board["run"] != run:
        board["entries"].append({
            "id": new_id(), "at": now(), "type": "handoff", "from": "system",
            "topic": "run-closed",
            "body": f'Run "{board["run"]}" closed. {len(board["entries"])} entries retained.',
        })
    board["run"] = run
    board["goal"] = goal or board.get("goal")
    board["openedAt"] = now()
    save(domain, board)
    print(f'board open: {slug(domain)} · run "{run}"' + (f" · goal: {goal}" if goal else ""))


def digest(domain: str, limit: int = 40, topic: str | None = None) -> str:
    board = load(domain)
    entries = board["entries"]
    if not entries:
        return (f"# Board — {slug(domain)}\n\nEmpty. You are first. Post findings as you "
                "verify them, claim work before you start it, and ask rather than assume.")

    if topic:
        entries = [e for e in entries if topic in (e.get("topic") or "")]

    def by(t: str) -> list:
        return [e for e in entries if e.get("type") == t]

    answered = {a.get("re") for a in by("answer") if a.get("re")}
    open_q = [q for q in by("question") if q["id"] not in answered]
    open_c = [c for c in by("conflict") if c["id"] not in answered]

    L = [f"# Board — {slug(domain)}"]
    if board.get("run"):
        L.append(f'**Run:** {board["run"]}' + (f' · {board["goal"]}' if board.get("goal") else ""))
    L.append(f"{len(entries)} entries\n")

    if open_c:
        L.append("## ⚠ Unresolved conflicts — read before you write anything")
        for c in open_c:
            target = next((x for x in entries if x["id"] == c.get("re")), None)
            tail = ""
            if target:
                tail = f' ({target.get("from")}: "{str(target.get("body"))[:80]}…")'
            L.append(f'- **{c.get("from")}** disputes `{c.get("re")}`{tail}')
            L.append(f'  > {c.get("body")}')
        L.append("")

    if open_q:
        L.append("## Open questions")
        for q in open_q:
            L.append(f'- `{q["id"]}` **{q.get("from")} → {q.get("to", "anyone")}**: {q.get("body")}')
        L.append("")

    claims = by("claim")
    if claims:
        L.append("## Claimed work — do not duplicate")
        for c in claims[-12:]:
            L.append(f'- **{c.get("from")}**: {c.get("topic")}')
        L.append("")

    finds = by("finding")
    if finds:
        L.append("## Findings posted so far")
        for f in finds[-limit:]:
            L.append(f'- `{f["id"]}` **{f.get("from")}** — {f.get("body")}')
            if f.get("evidence"):
                L.append(f'  > evidence: {f["evidence"]}')
        L.append("")

    hand = [h for h in by("handoff") if h.get("from") != "system"]
    if hand:
        L.append("## Handoffs waiting")
        for h in hand[-10:]:
            L.append(f'- **{h.get("from")} → {h.get("to", "orchestrator")}**: {h.get("body")}')
        L.append("")

    L += ["---",
          "Findings here are other agents' work. Build on them, cite them by id, and post a "
          "`conflict` if you disagree rather than silently contradicting."]
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


# ------------------------------------------------------------------------- cli

def main() -> int:
    ap = argparse.ArgumentParser(prog="board.py", add_help=True,
                                 description="Shared blackboard for the SEO agent team.")
    ap.add_argument("command", choices=["open", "digest", "pending", "post", "ask",
                                        "answer", "claim", "conflict"])
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
    a = ap.parse_args()

    def need(v, msg):
        if not v:
            print(msg, file=sys.stderr)
            sys.exit(1)
        return v

    if a.command == "open":
        open_run(a.domain, need(a.run, "--run required"), a.goal)

    elif a.command == "digest":
        print(digest(a.domain, a.limit, a.topic))

    elif a.command == "pending":
        return pending(a.domain)

    elif a.command == "post":
        e = append(a.domain, type=need(a.etype, f"--type required ({'|'.join(TYPES)})"),
                   **{"from": need(a.sender, "--from required")},
                   topic=a.topic, body=need(a.body, "--body required"),
                   evidence=a.evidence, to=a.to, re=a.ref)
        print(f'{a.etype} posted as {e["id"]}')

    elif a.command == "ask":
        e = append(a.domain, type="question", **{"from": need(a.sender, "--from required")},
                   to=a.to or "anyone", topic=a.topic, body=need(a.body, "--body required"))
        print(f'question {e["id"]} posted to {a.to or "anyone"}')

    elif a.command == "answer":
        e = append(a.domain, type="answer", **{"from": need(a.sender, "--from required")},
                   re=need(a.ref, "--re <question id> required"),
                   body=need(a.body, "--body required"), evidence=a.evidence)
        print(f'answer {e["id"]} resolves {a.ref}')

    elif a.command == "claim":
        topic = need(a.topic, "--topic required")
        sender = need(a.sender, "--from required")
        existing = next((e for e in load(a.domain)["entries"]
                         if e.get("type") == "claim" and e.get("topic") == topic
                         and e.get("from") != sender), None)
        if existing:
            print(f'ALREADY CLAIMED by {existing["from"]} — pick different work or '
                  f'coordinate via board ask', file=sys.stderr)
            return 2
        e = append(a.domain, type="claim", **{"from": sender}, topic=topic, body=a.body or topic)
        print(f'claimed {e["id"]}: {topic}')

    elif a.command == "conflict":
        e = append(a.domain, type="conflict", **{"from": need(a.sender, "--from required")},
                   re=need(a.ref, "--re <entry id> required"),
                   body=need(a.body, "--body required"), evidence=a.evidence)
        print(f'conflict {e["id"]} raised against {a.ref} — orchestrator must adjudicate '
              f'before this ships')

    return 0


if __name__ == "__main__":
    sys.exit(main())
