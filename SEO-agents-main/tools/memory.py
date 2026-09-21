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

Usage:
    python tools/memory.py init example.com
    python tools/memory.py digest example.com
    python tools/memory.py fact example.com --key stack --value "Next.js" --source recon
    python tools/memory.py decide example.com --what "..." --why "..." --by seo-director
    python tools/memory.py baseline example.com --metric organic_clicks --value 4102 --source GSC
    python tools/memory.py change example.com --what "..." --agent onpage-optimizer
    python tools/memory.py learn example.com --what "..." --outcome worked|failed|unclear
    python tools/memory.py trend example.com --metric organic_clicks
    python tools/memory.py sites

Stdlib only — no install required.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("memory")
STORES = ("facts", "decisions", "baselines", "changes", "learnings")


def slug(domain: str) -> str:
    d = re.sub(r"^https?://", "", str(domain))
    d = re.sub(r"^www\.", "", d)
    return d.split("/")[0].lower()


def sdir(domain: str) -> Path:
    return ROOT / slug(domain)


def sfile(domain: str, store: str) -> Path:
    return sdir(domain) / f"{store}.json"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


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
    sdir(domain).mkdir(parents=True, exist_ok=True)
    sfile(domain, store).write_text(json.dumps(data, indent=2, ensure_ascii=False),
                                    encoding="utf-8")


def append(domain: str, store: str, entry: dict) -> int:
    items = load(domain, store)
    items.append({"id": f"{store[:3]}_{int(time.time()*1000):x}", "at": now(), **entry})
    save(domain, store, items)
    return len(items)


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
erase a prediction that turned out wrong.
""", encoding="utf-8")
    print(f"memory initialized: {sdir(domain)}")


def upsert_fact(domain: str, key: str, value: str, source: str | None) -> None:
    facts = load(domain, "facts")
    prior = facts.get(key)
    entry = {"value": value, "source": source or "unspecified", "updatedAt": now()}
    if prior:
        entry["previous"] = prior.get("value")
        entry["changedFrom"] = prior.get("updatedAt")
    facts[key] = entry
    save(domain, "facts", facts)
    if prior and prior.get("value") != value:
        print(f'fact updated: {key} — was "{prior.get("value")}", now "{value}"')
    else:
        print(f"fact set: {key} = {value}")


def digest(domain: str, limit: int = 8) -> str:
    if not sdir(domain).exists():
        return (f"No memory for {slug(domain)}. This is a first run — establish baselines "
                "and record decisions as you go.")

    facts = load(domain, "facts")
    decisions = load(domain, "decisions")
    baselines = load(domain, "baselines")
    changes = load(domain, "changes")
    learnings = load(domain, "learnings")

    L = [f"# Memory — {slug(domain)}", ""]

    if facts:
        L.append("## Established facts")
        for k, f in facts.items():
            line = f'- **{k}**: {f["value"]}  *({f["source"]}, {f["updatedAt"][:10]})*'
            if f.get("previous"):
                line += f' — changed from "{f["previous"]}"'
            L.append(line)
        L.append("")

    if decisions:
        L.append("## Decisions already made — do not re-litigate without new evidence")
        for d in decisions[-limit:]:
            L.append(f'- **{d.get("what")}** — {d.get("why")} '
                     f'*({d.get("by", "unknown")}, {d["at"][:10]})*')
            if d.get("ruledOut"):
                L.append(f'  - ruled out: {d["ruledOut"]}')
        L.append("")

    if baselines:
        by_metric: dict[str, list] = {}
        for b in baselines:
            by_metric.setdefault(b["metric"], []).append(b)
        L.append("## Metric baselines")
        for m, pts in by_metric.items():
            first, last = pts[0], pts[-1]
            delta = ""
            if len(pts) > 1 and isinstance(first["value"], (int, float)) and first["value"]:
                pct = (last["value"] - first["value"]) / first["value"] * 100
                delta = f' ({"+" if pct > 0 else ""}{pct:.1f}% since {first["at"][:10]})'
            L.append(f'- **{m}**: {last["value"]} *({last["source"]}, {last["at"][:10]})*{delta}')
        L.append("")

    if changes:
        L.append(f"## Recently shipped ({len(changes)} total)")
        for c in changes[-limit:]:
            L.append(f'- {c["at"][:10]} — {c.get("what")} *({c.get("agent", "unknown")})*')
        L.append("")

    if learnings:
        L.append("## Learnings")
        order = {"failed": 0, "unclear": 1, "worked": 2}
        for x in sorted(learnings, key=lambda e: order.get(e.get("outcome"), 3))[:limit]:
            why = f' — {x["why"]}' if x.get("why") else ""
            L.append(f'- [{(x.get("outcome") or "unclear").upper()}] {x.get("what")}{why}')
        L.append("")

    if len(L) == 2:
        return f"Memory exists for {slug(domain)} but is empty. Populate it as you work."

    L += ["---",
          "Treat the above as established context. Contradicting it requires new evidence — "
          "and if you find that evidence, record the correction rather than silently disagreeing."]
    return "\n".join(L)


def trend(domain: str, metric: str) -> None:
    pts = [b for b in load(domain, "baselines") if b["metric"] == metric]
    if not pts:
        print(f'no baselines recorded for "{metric}"')
        return
    print(f"# {metric} — {slug(domain)}\n")
    print("| date | value | source | note |")
    print("|---|---|---|---|")
    for p in pts:
        print(f'| {p["at"][:10]} | {p["value"]} | {p["source"]} | {p.get("note", "")} |')
    nums = [p["value"] for p in pts if isinstance(p["value"], (int, float))]
    if len(nums) > 1 and nums[0]:
        chg = (nums[-1] - nums[0]) / nums[0] * 100
        print(f'\nChange over {len(pts)} readings: {"+" if chg > 0 else ""}{chg:.1f}%')


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

def main() -> int:
    ap = argparse.ArgumentParser(prog="memory.py",
                                 description="Persistent per-site memory for the SEO agent team.")
    ap.add_argument("command", choices=["init", "digest", "trend", "sites",
                                        "fact", "decide", "baseline", "change", "learn"])
    ap.add_argument("domain", nargs="?")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--key"); ap.add_argument("--value"); ap.add_argument("--source")
    ap.add_argument("--what"); ap.add_argument("--why"); ap.add_argument("--by")
    ap.add_argument("--ruled-out", dest="ruled_out")
    ap.add_argument("--metric"); ap.add_argument("--note")
    ap.add_argument("--agent"); ap.add_argument("--urls")
    ap.add_argument("--outcome", choices=["worked", "failed", "unclear"])
    a = ap.parse_args()

    def need(v, msg):
        if not v:
            print(msg, file=sys.stderr)
            sys.exit(1)
        return v

    if a.command == "sites":
        list_sites(); return 0

    need(a.domain, f"usage: memory.py {a.command} <domain>")

    if a.command == "init":
        init(a.domain)
    elif a.command == "digest":
        print(digest(a.domain, a.limit))
    elif a.command == "trend":
        trend(a.domain, need(a.metric, "--metric required"))
    elif a.command == "fact":
        upsert_fact(a.domain, need(a.key, "--key required"),
                    need(a.value, "--value required"), a.source)
    elif a.command == "decide":
        n = append(a.domain, "decisions", {"what": need(a.what, "--what required"),
                                           "why": need(a.why, "--why required"),
                                           "by": a.by, "ruledOut": a.ruled_out})
        print(f"decision #{n} recorded")
    elif a.command == "baseline":
        raw = need(a.value, "--value required")
        try:
            val = float(raw) if "." in raw else int(raw)
        except ValueError:
            val = raw
        n = append(a.domain, "baselines", {
            "metric": need(a.metric, "--metric required"), "value": val,
            "source": need(a.source, "--source required — where did this number come from?"),
            "note": a.note})
        print(f"baseline #{n} recorded")
    elif a.command == "change":
        n = append(a.domain, "changes", {"what": need(a.what, "--what required"),
                                         "agent": a.agent, "urls": a.urls})
        print(f"change #{n} logged")
    elif a.command == "learn":
        n = append(a.domain, "learnings", {"what": need(a.what, "--what required"),
                                           "outcome": need(a.outcome, "--outcome required"),
                                           "why": a.why})
        print(f"learning #{n} recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
