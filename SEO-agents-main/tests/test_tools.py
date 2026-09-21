"""Tests for the Python data tools.

These cover the behaviours that carry consequence — the honesty guarantees and
the coordination mechanics — rather than chasing a coverage number. Two of them
are regression tests for bugs found in this codebase, which is the best reason a
test can have to exist.

Run:  pytest
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"


def _load(name: str):
    """Import a tools/*.py module by path — they are scripts, not a package."""
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


board = _load("board")
memory = _load("memory")
serp = _load("serp")


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Each test gets its own memory/ root."""
    monkeypatch.chdir(tmp_path)
    for mod in (board, memory):
        monkeypatch.setattr(mod, "ROOT", Path("memory"))
    return tmp_path


# =========================================================== board coordination

@pytest.mark.unit
def test_slug_strips_scheme_and_www():
    assert board.slug("https://www.Example.com/us/") == "example.com"


@pytest.mark.integration
def test_claim_refuses_a_topic_another_agent_holds(workspace):
    """The mechanism that prevents duplicate work. Must refuse, not warn."""
    board.append("example.com", type="claim", topic="us-serps", **{"from": "agent-a"})
    entries = board.load("example.com")["entries"]
    dup = [e for e in entries
           if e.get("type") == "claim" and e.get("topic") == "us-serps"
           and e.get("from") != "agent-b"]
    assert dup, "agent-b must see agent-a's claim and back off"


@pytest.mark.integration
def test_board_is_append_only(workspace):
    """An agent that can edit the board can delete the finding contradicting it."""
    board.append("example.com", type="finding", body="first", **{"from": "a"})
    board.append("example.com", type="finding", body="second", **{"from": "b"})
    bodies = [e["body"] for e in board.load("example.com")["entries"]]
    assert bodies == ["first", "second"]


@pytest.mark.integration
def test_pending_returns_1_while_a_conflict_is_open(workspace, capsys):
    """A wave gates on this exit code. 0 while a conflict is live would ship a
    finding two specialists disagree about."""
    f = board.append("example.com", type="finding", body="x", **{"from": "a"})
    c = board.append("example.com", type="conflict", re=f["id"], body="disputed", **{"from": "b"})
    assert board.pending("example.com") == 1

    # A conflict is resolved by answering THE CONFLICT, not the finding it
    # disputes. Answering the finding leaves the dispute open — which is correct:
    # the orchestrator has to say which side held, not just add another comment.
    board.append("example.com", type="answer", re=f["id"], body="note", **{"from": "orch"})
    assert board.pending("example.com") == 1, "answering the finding must not clear the conflict"

    board.append("example.com", type="answer", re=c["id"], body="a held", **{"from": "orch"})
    assert board.pending("example.com") == 0


@pytest.mark.integration
def test_digest_surfaces_conflicts_before_findings(workspace):
    """Reading order matters: an agent must see the dispute before the claim."""
    f = board.append("example.com", type="finding", body="ranks #2", **{"from": "a"})
    board.append("example.com", type="conflict", re=f["id"], body="cannot confirm", **{"from": "b"})
    out = board.digest("example.com")
    assert out.index("Unresolved conflicts") < out.index("Findings posted so far")


# ================================================================ memory stores

@pytest.mark.integration
def test_fact_upsert_preserves_the_previous_value(workspace, capsys):
    """Facts change; the trail of what they used to be is the audit record."""
    memory.upsert_fact("example.com", "urls", "683", "first count")
    memory.upsert_fact("example.com", "urls", "779", "full sitemap walk")
    fact = memory.load("example.com", "facts")["urls"]
    assert fact["value"] == "779"
    assert fact["previous"] == "683"


@pytest.mark.integration
def test_decisions_are_append_only(workspace):
    memory.append("example.com", "decisions", {"what": "US first", "why": "winnable"})
    memory.append("example.com", "decisions", {"what": "leads not traffic", "why": "362 posts"})
    assert len(memory.load("example.com", "decisions")) == 2


@pytest.mark.integration
def test_digest_reports_baseline_movement(workspace):
    memory.append("example.com", "baselines", {"metric": "clicks", "value": 100, "source": "GSC"})
    memory.append("example.com", "baselines", {"metric": "clicks", "value": 150, "source": "GSC"})
    assert "+50.0%" in memory.digest("example.com")


@pytest.mark.integration
def test_digest_on_a_fresh_domain_says_so(workspace):
    assert "first run" in memory.digest("never-seen.com")


# ====================================================== serp: honesty guarantees

@pytest.mark.unit
def test_unseeable_features_become_none_not_zero():
    """THE critical guarantee. 0 or [] reads as 'checked and absent'; None reads
    as 'not checked'. Conflating them corrupts every AEO conclusion."""
    r = serp.empty_result("q")
    r["provider"] = "serper"
    serp.apply_capabilities(r)

    assert r["aiOverview"] is None
    assert r["topAds"] is None
    assert "aiOverview" in r["notChecked"]


@pytest.mark.unit
def test_analysis_reports_unchecked_ai_overview_as_none_not_false():
    r = serp.empty_result("q")
    r["provider"] = "serper"
    serp.apply_capabilities(r)
    a = serp.analyze_serp(r)

    assert a["aiOverviewPresent"] is None, "must never be False for a provider that cannot look"
    assert a["clickAvailabilityCaveat"], "must warn the estimate is understated"


@pytest.mark.unit
def test_a_capable_provider_reports_a_real_absence_as_false():
    r = serp.empty_result("q")
    r["provider"] = "serpapi"  # sees everything
    serp.apply_capabilities(r)
    assert serp.analyze_serp(r)["aiOverviewPresent"] is False


@pytest.mark.unit
def test_dotenv_ignores_a_blank_that_precedes_the_real_key(tmp_path, monkeypatch):
    """Regression: `cp .env.example .env` then appending the key leaves an empty
    SERPER_API_KEY= above the real one. A first-wins loader took the blank and
    reported no provider configured."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("SERPER_API_KEY=\nSERPER_API_KEY=real-key-value\n", encoding="utf-8")

    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "real-key-value"


@pytest.mark.unit
def test_cache_key_separates_providers():
    """A serper result carries no AI Overview data; a serpapi one does. They must
    never collide in the cache."""
    a = serp.cache_key("q", {"provider": "serper", "location": "US"})
    b = serp.cache_key("q", {"provider": "serpapi", "location": "US"})
    assert a != b


# ============================================================ serp: format read

@pytest.mark.unit
@pytest.mark.parametrize("titles,expected", [
    (["10 Best CRM Software", "Top 15 CRM Tools", "The Best CRM Platforms 2026"], "listicle"),
    (["What is a CRM?", "CRM meaning explained", "What are CRM systems"], "definition"),
    (["HubSpot vs Salesforce", "CRM alternatives", "Compare CRM vendors"], "comparison"),
])
def test_format_inference(titles, expected):
    r = serp.empty_result("q")
    r["organic"] = [{"title": t, "domain": "x.com"} for t in titles]
    assert serp.infer_format(r)["dominant"] == expected


@pytest.mark.unit
def test_forum_dominated_serp_is_flagged_as_whitespace():
    """No publisher owns the answer — the strongest signal opportunity-finder gets."""
    r = serp.empty_result("q")
    r["organic"] = [{"title": "best crm?", "domain": d}
                    for d in ("reddit.com", "quora.com", "reddit.com", "stackoverflow.com")]
    assert serp.infer_format(r)["forumDominated"] is True


@pytest.mark.unit
def test_click_availability_drops_when_features_crowd_the_serp():
    bare = serp.empty_result("q")
    bare["provider"] = "serpapi"
    serp.apply_capabilities(bare)

    busy = serp.empty_result("q")
    busy["provider"] = "serpapi"
    serp.apply_capabilities(busy)
    busy["aiOverview"] = {"present": True, "sources": []}
    busy["featuredSnippet"] = {"domain": "x.com", "type": "paragraph"}
    busy["topAds"] = 4

    assert (serp.analyze_serp(busy)["clickAvailabilityEstimate"]
            < serp.analyze_serp(bare)["clickAvailabilityEstimate"])


@pytest.mark.unit
def test_compare_does_not_count_unchecked_ai_overviews_as_absent():
    r = serp.empty_result("ai agents")
    r["provider"] = "serper"
    r["organic"] = [{"position": 3, "domain": "you.com", "title": "t"}]
    serp.apply_capabilities(r)

    cmp = serp.compare_domains([r], "you.com", ["rival.com"])
    assert cmp["summary"]["aiOverviewChecked"] == 0
    assert cmp["summary"]["aiOverviewCoverage"] == 0
    assert cmp["rows"][0]["aiOverview"] is None
