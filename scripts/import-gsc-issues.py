#!/usr/bin/env python3
"""Import GSC Audit.xlsx (or CSV exports) into data/gsc-issues.json."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("Install openpyxl: pip install openpyxl", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_XLSX = ROOT / "GSC Audit.xlsx"
OUT = ROOT / "data" / "gsc-issues.json"
SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1YNN_2YHxG_3oTrKHrKmNuMDUD2Rn-7vDtgchTOIA500"
)

SHEET_MAP = {
    "us page": {
        "id": "us-page",
        "label": "US Pages",
        "market": "us",
        "priority": "high",
    },
    "global page": {
        "id": "global-page",
        "label": "Global Pages",
        "market": "global",
        "priority": "high",
    },
    "404": {
        "id": "404",
        "label": "404 Errors",
        "market": "all",
        "priority": "critical",
    },
    "not indexed": {
        "id": "not-indexed",
        "label": "Not Indexed",
        "market": "all",
        "priority": "high",
    },
    "fix": {
        "id": "fix",
        "label": "Canonical / Param Fixes",
        "market": "all",
        "priority": "high",
    },
    "403": {
        "id": "403",
        "label": "403 Forbidden",
        "market": "all",
        "priority": "critical",
    },
    "error": {
        "id": "error",
        "label": "Redirect Errors",
        "market": "all",
        "priority": "critical",
    },
}


def sid(*parts: object) -> str:
    raw = "|".join(str(p or "") for p in parts)
    return "gsc-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def meta_for(name: str) -> dict:
    key = re.sub(r"\s+", " ", name.strip().lower())
    if key in SHEET_MAP:
        return dict(SHEET_MAP[key])
    slug = re.sub(r"[^a-z0-9]+", "-", key).strip("-") or "other"
    return {
        "id": slug,
        "label": name.strip() or "Other",
        "market": "all",
        "priority": "medium",
    }


def infer_market(url: str, default: str) -> str:
    if default in ("us", "global"):
        return default
    return "us" if "/us/" in url else "global"


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        alt = Path(r"C:\Users\Arun K\Downloads\GSC Audit.xlsx")
        if alt.exists():
            xlsx = alt
        else:
            print(f"Missing workbook: {xlsx}", file=sys.stderr)
            sys.exit(1)

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    issues: list[dict] = []
    categories: list[dict] = []

    for name in wb.sheetnames:
        meta = meta_for(name)
        ws = wb[name]
        rows = list(ws.iter_rows(values_only=True))
        header = str(rows[0][0]).strip() if rows and rows[0] and rows[0][0] else name
        count = 0
        for row in rows[1:]:
            vals = [v for v in (row or ()) if v is not None and str(v).strip() != ""]
            if not vals:
                continue
            url = str(vals[0]).strip()
            action = str(vals[1]).strip() if len(vals) > 1 else ""
            extra = str(vals[2]).strip() if len(vals) > 2 else ""
            market = infer_market(url, meta["market"])
            issues.append(
                {
                    "id": sid(meta["id"], url, action),
                    "category": meta["id"],
                    "categoryLabel": meta["label"],
                    "sheetHeader": header,
                    "url": url,
                    "action": action,
                    "note": extra or None,
                    "market": market,
                    "priority": meta["priority"],
                    "status": "open",
                    "source": xlsx.name,
                }
            )
            count += 1
        categories.append(
            {
                "id": meta["id"],
                "label": meta["label"],
                "sheet": name,
                "sheetHeader": header,
                "marketDefault": meta["market"],
                "priority": meta["priority"],
                "count": count,
            }
        )

    payload = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": xlsx.name,
        "sourceSheet": SHEET_URL,
        "title": "GSC Issues to Fix",
        "categories": categories,
        "issues": issues,
        "totals": {
            "all": len(issues),
            "open": sum(1 for i in issues if i["status"] == "open"),
            "byCategory": {c["id"]: c["count"] for c in categories},
            "byMarket": {
                "us": sum(1 for i in issues if i["market"] == "us"),
                "global": sum(1 for i in issues if i["market"] == "global"),
            },
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(issues)} issues -> {OUT}")


if __name__ == "__main__":
    main()
