"""Tests for the eval harness itself.

An eval that scores the wrong corpus is worse than no eval, because it reports a
number that looks like a pass. That is not hypothetical here: on 2026-09-25
`node evals/run.mjs fixture` was found defaulting to walking `output/` — the real
client deliverables — and scoring them against a planted-defect spec for a
fixture site nobody had ever audited. It printed "94% recall" and one fabrication
violation against a correctly sourced ranking statement. Every test below pins a
property that failure taught us to want.

These shell out to `node evals/run.mjs` rather than unit-testing the JS, for the
same reason tests/test_tools.py is the suite that actually runs: the repo has one
test command (`pytest`), and a self-test with no trigger protects nothing — the
42-minute zombie (commit cbe727b) was guarded only by `guard.mjs selftest`, which
nothing ran.

Every golden fixture here probes a LOCAL JSON file, never the network. A test
suite that needs the client's origin to be up is a flaky test suite.

Run:  pytest tests/test_evals.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
RUN = REPO / "evals" / "run.mjs"


def node(*args, cwd: Path):
    """Invoke the harness. Returns (exit_code, stdout+stderr)."""
    p = subprocess.run(
        ["node", str(RUN), *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return p.returncode, (p.stdout or "") + (p.stderr or "")


@pytest.fixture(scope="module", autouse=True)
def _require_node():
    if shutil.which("node") is None:
        pytest.skip("node is not on PATH; the harness is Node 18+")


# ----------------------------------------------------------------- scaffolding

def write_serp(path: Path, rows: int):
    """A minimal serp-batch.json. Every row carries results, so `rowsMeasured`
    is deterministic and needs no network."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([
            {
                "query": f"q{i}",
                "provider": "serper",
                "organic": [{"position": 1, "domain": "rival.com", "title": "t"}] * 10,
                "aiOverview": None,
                "notChecked": ["aiOverview"],
            }
            for i in range(rows)
        ]),
        encoding="utf-8",
    )


def golden_spec(ws: Path, *, stored: int, probe_file: str, assertion_id: str = "rows"):
    """One assertion, one offline probe, graded against whatever the report says."""
    spec = {
        "domain": "example.test",
        "baselinedAt": "2026-09-18",
        "serpBatch": probe_file,
        "assertions": [{
            "id": assertion_id,
            "claim": "the batch carries N measured rows",
            "expect": {"value": stored, "tolerance": 0},
            "verify": {"kind": "serp-batch", "metric": "rowsMeasured", "file": probe_file},
            "reportPattern": r"(\d+) queries measured",
            "volatility": "structural",
            "cost": "cheap",
            "staleAfter": "2099-01-01",
            "memoryKey": "rows_measured",
        }],
        "mustNotClaim": [],
    }
    d = ws / "evals" / "golden"
    d.mkdir(parents=True, exist_ok=True)
    (d / "example.test.json").write_text(json.dumps(spec), encoding="utf-8")


def report(ws: Path, text: str) -> str:
    p = ws / "reports" / "r.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return str(p)


def tally(ws: Path):
    return json.loads((ws / "evals" / "results" / "golden-latest.json").read_text(encoding="utf-8"))["tally"]


# ============================================= fixture mode refuses real output

@pytest.mark.integration
def test_fixture_mode_refuses_to_default_to_output(tmp_path):
    """The original defect. `fixture` with no arguments walked output/ — the real client
    deliverables — and scored them against the fixture spec. It must now refuse
    and say what to do instead."""
    shutil.copytree(REPO / "evals" / "fixtures", tmp_path / "evals" / "fixtures")
    (tmp_path / "output").mkdir()
    (tmp_path / "output" / "US-AUDIT-REPORT.md").write_text(
        "# Audit\n\n- The sitemap is missing and returns a 404.\n"
        "- The pricing page carries a noindex and the canonical points to the homepage.\n",
        encoding="utf-8",
    )

    code, out = node("fixture", cwd=tmp_path)

    assert code == 1, "defaulting to output/ must be a refusal, not a score"
    assert "needs an explicit report path" in out
    # The refusal text mentions the historical 94% as context; what must never
    # appear is a fresh score line, which is what people copy into a status update.
    assert "Score " not in out, "it must not print a score it cannot justify"
    assert "FIXTURE EVAL" not in out


@pytest.mark.integration
def test_fixture_mode_refuses_a_path_outside_the_fixture_corpus(tmp_path):
    """Naming the client report explicitly is the same mistake with extra steps."""
    shutil.copytree(REPO / "evals" / "fixtures", tmp_path / "evals" / "fixtures")
    (tmp_path / "output").mkdir()
    real = tmp_path / "output" / "US-AUDIT-REPORT.md"
    real.write_text("# Audit\n\n- noindex on the pricing page.\n", encoding="utf-8")

    code, out = node("fixture", str(real), cwd=tmp_path)

    assert code == 1
    assert "refusing to score real client output" in out
    assert "output/fixture.example" in out, "the refusal must name the corpus it wanted"


@pytest.mark.integration
def test_fixture_mode_scores_a_report_inside_the_corpus(tmp_path):
    """The refusal must not be a blanket one — the legitimate path still works,
    and evidence has to sit in the same block as the claim."""
    shutil.copytree(REPO / "evals" / "fixtures", tmp_path / "evals" / "fixtures")
    corpus = tmp_path / "output" / "fixture.example"
    corpus.mkdir(parents=True)
    (corpus / "tech.md").write_text(
        "# Findings\n\n"
        "- `robots.txt` declares a sitemap that does not exist — the URL 404s.\n"
        "- `pricing.html` carries a noindex directive on a money page.\n",
        encoding="utf-8",
    )

    code, out = node("fixture", str(corpus / "tech.md"), cwd=tmp_path)

    assert "FIXTURE EVAL" in out
    assert "sitemap-missing" not in out.split("MISSED")[-1], "block-scoped match should find the sitemap defect"
    assert "noindex-money-page" not in out.split("MISSED")[-1]


@pytest.mark.integration
def test_keyword_hits_scattered_across_a_report_do_not_count_as_found(tmp_path):
    """The mechanism behind the bogus 94%: two keywords anywhere in 150 KB of
    prose was enough. They must now co-occur in one claim block WITH the file."""
    shutil.copytree(REPO / "evals" / "fixtures", tmp_path / "evals" / "fixtures")
    corpus = tmp_path / "output" / "fixture.example"
    corpus.mkdir(parents=True)
    (corpus / "scatter.md").write_text(
        "# Notes\n\n"
        "The sitemap strategy deserves attention this quarter.\n\n"
        "Separately, we saw a 404 on an unrelated legacy URL.\n\n"
        "In other news, canonical tags are broadly fine.\n",
        encoding="utf-8",
    )

    code, out = node("fixture", str(corpus / "scatter.md"), cwd=tmp_path)

    missed = out.split("MISSED")[-1]
    assert "sitemap-missing" in missed, "scattered keywords must not count as a finding"


# ================================================ golden: the four grading outcomes

@pytest.mark.integration
def test_a_fabricated_claim_fails(tmp_path):
    """The accuracy signal. Live says 3; the report says 9; nothing excuses it."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    r = report(tmp_path, "We ran the batch: **9 queries measured** across the US set.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    assert code == 1, "an accuracy failure must break the build"
    assert "FAIL" in out
    assert tally(tmp_path) == {"PASS": 0, "FAIL": 1, "DRIFT": 0, "UNMEASURED": 0, "SKIPPED": 0}


@pytest.mark.integration
def test_a_correct_claim_passes(tmp_path):
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    r = report(tmp_path, "We ran the batch: **3 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    assert code == 0
    assert tally(tmp_path)["PASS"] == 1


@pytest.mark.integration
def test_drift_is_reported_as_drift_and_not_as_a_failure(tmp_path):
    """The property that lets a golden set survive a client release.

    Stored tripwire says 5, live says 3, and the report says 5 — the agent was
    right when it measured and the SITE moved. Reported as DRIFT with a
    rebaseline command, exit 0. On 2026-09-25 this fired for real: the /us/
    sitemap had gone 240 → 249 since the audit, and three correct agents would
    have been failed by a frozen golden set."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=5, probe_file="data/serp.json")
    r = report(tmp_path, "The batch covered **5 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    t = tally(tmp_path)
    assert t["DRIFT"] == 1
    assert t["FAIL"] == 0, "the site changing is not the agent being wrong"
    assert code == 0, "DRIFT must not break the build, or people stop running the eval"
    assert "rebaseline" in out and "memory.py baseline" in out, "a drift that lands nowhere is lost"


@pytest.mark.integration
def test_drift_still_fails_a_claim_that_matches_neither_live_nor_stored(tmp_path):
    """Drift is not an amnesty. 5 was true once and 3 is true now; 42 was never
    true anywhere."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=5, probe_file="data/serp.json")
    r = report(tmp_path, "We saw **42 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    assert tally(tmp_path)["FAIL"] == 1
    assert code == 1


@pytest.mark.integration
def test_a_failed_probe_is_unmeasured_and_never_a_pass(tmp_path):
    """THE guarantee, inherited from serp.py: a provider failure must not read as
    a measured absence. §3.1 of the audit — a dropped query row turns
    'not measured' into 'not ranking'. A harness that graded its own failure as a
    pass would reproduce exactly the bug it exists to catch."""
    golden_spec(tmp_path, stored=3, probe_file="data/does-not-exist.json")
    r = report(tmp_path, "We ran **3 queries measured**.\n")  # would PASS if the probe were trusted

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    t = tally(tmp_path)
    assert t["UNMEASURED"] == 1
    assert t["PASS"] == 0, "an unmeasured assertion must never be counted as a pass"
    assert t["FAIL"] == 0, "nor as a failure — we did not measure the agent, we failed to measure the site"
    assert "UNMEASURED" in out


@pytest.mark.integration
def test_a_claim_no_report_makes_is_unmeasured_not_a_pass(tmp_path):
    """Silence is not agreement. If no deliverable states the fact, there is
    nothing to grade — and an empty reports directory must not produce a clean
    sweep of passes."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    r = report(tmp_path, "# Report\n\nNo numbers here.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    t = tally(tmp_path)
    assert t["UNMEASURED"] == 1
    assert t["PASS"] == 0
    assert code == 0


@pytest.mark.integration
def test_a_skipped_cost_tier_is_never_a_pass(tmp_path):
    """--deep assertions do not run by default. They must report SKIPPED, not
    quietly inflate the pass count."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    spec_path = tmp_path / "evals" / "golden" / "example.test.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    spec["assertions"][0]["cost"] = "deep"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    r = report(tmp_path, "We ran **3 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    t = tally(tmp_path)
    assert t["SKIPPED"] == 1 and t["PASS"] == 0
    assert "--deep" in out


# ==================================================== golden: retired figures

@pytest.mark.integration
def test_a_retired_figure_reappearing_fails_loudly(tmp_path):
    """`55 of 115` was adjudicated withdrawn on the board (bd_7t75z3nr) because
    it counted nav and footer links as editorial. A regression to it is a failure,
    not a near miss."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    spec_path = tmp_path / "evals" / "golden" / "example.test.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    spec["mustNotClaim"] = [{"id": "retired-55-of-115", "pattern": r"55\s*(?:of|/)\s*115", "why": "withdrawn"}]
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    r = report(tmp_path, "We found that 55 of 115 blog posts carry in-body service links. **3 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    assert code == 1
    assert "RETIRED FIGURES REAPPEARED" in out


@pytest.mark.integration
def test_narrating_a_retired_figure_as_retired_is_allowed(tmp_path):
    """US-AUDIT-REPORT.md documents the withdrawal in prose and must not be
    flagged for it. The rule targets a fresh claim, not the correction record."""
    write_serp(tmp_path / "data" / "serp.json", rows=3)
    golden_spec(tmp_path, stored=3, probe_file="data/serp.json")
    spec_path = tmp_path / "evals" / "golden" / "example.test.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    spec["mustNotClaim"] = [{"id": "retired-55-of-115", "pattern": r"55\s*(?:of|/)\s*115", "why": "withdrawn"}]
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    r = report(tmp_path, "The 55 of 115 figure is withdrawn — it counted nav chrome. **3 queries measured**.\n")

    code, out = node("golden", "example.test", r, cwd=tmp_path)

    assert "RETIRED FIGURES REAPPEARED" not in out
    assert code == 0


# ========================================================= static mode remains

@pytest.mark.integration
def test_static_mode_still_passes_the_real_agent_files():
    """The 52 static checks are the ones that already work. Refactoring them into
    a rule table must not have changed a single verdict."""
    code, out = node("static", cwd=REPO)
    assert code == 0, out
    assert "0 failing" in out


@pytest.mark.unit
def test_static_frontmatter_parser_survives_crlf(tmp_path):
    """Found 2026-09-25: 20 of 52 agent files had been rewritten with CRLF, and
    every frontmatter key parsed as absent because `(.*)$` cannot match a line
    ending in \\r. The suite reported 20 agents 'missing name' — failing loudly
    on the wrong thing while the real rules went unchecked. This repo is used on
    Windows and POSIX; line endings must be irrelevant."""
    agents = tmp_path / ".claude" / "agents"
    agents.mkdir(parents=True)
    (agents / "seo-recon.md").write_bytes(
        b"---\r\nname: seo-recon\r\ndescription: "
        + b"Baseline discovery agent that crawls the site and builds the shared fact base. " * 2
        + b"\r\ntools: Read, Write, Bash\r\n---\r\n\r\n"
        + b"## Output\r\n\r\n" + b"Body text that is long enough to clear the thinness warning. " * 20
    )

    code, out = node("static", cwd=tmp_path)

    assert "missing" not in out, out
    assert code == 0, out
