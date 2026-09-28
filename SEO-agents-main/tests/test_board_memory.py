"""Tests for the board and memory correctness fixes.

Every test here is a regression test for something that already happened to this
team's data: a silently truncated digest that hid the standing "no repo writes"
decision, a retired 683-URL figure that kept rendering next to the verified 779,
a withdrawn "55 of 115" finding that vanished along with the ruling that
withdrew it, and six concurrent agents that produced a duplicate claim.

Run:  python -m pytest tests -q
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"


def _load(name: str):
    """Import a tools/*.py module by path — they are scripts, not a package."""
    spec = importlib.util.spec_from_file_location(f"{name}_bm", TOOLS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


board = _load("board")
memory = _load("memory")


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Each test gets its own memory/ root."""
    monkeypatch.chdir(tmp_path)
    for mod in (board, memory):
        monkeypatch.setattr(mod, "ROOT", Path("memory"))
    return tmp_path


# ===================================================== 1. truncation discloses

@pytest.mark.integration
def test_board_digest_never_drops_findings_silently(workspace):
    """65 findings with limit 40 used to print 40 and say nothing — so an agent
    reading it had positive evidence the other 25 did not exist."""
    for i in range(60):
        board.append("example.com", type="finding", body=f"routine observation number {i} "
                     + "padding " * 20, **{"from": f"agent-{i % 7}"})

    out = board.digest("example.com")
    shown = out.count("\n- `bd_")
    assert shown < 60, "this test is meaningless if everything fits"
    assert "Not shown above" in out
    assert f"{60 - shown} finding(s)" in out
    assert "--full" in out, "the digest must name the command that shows the rest"


@pytest.mark.integration
def test_the_oldest_correction_outranks_the_newest_routine_finding(workspace):
    """The dropped set was the OLDEST findings, which are the corrections. A
    CRITICAL correction from wave one must survive a board full of wave-four
    noise."""
    old = board.append("example.com", type="finding", **{"from": "technical-seo-engineer"},
                       body="CORRECTION: the /us/ tree is 240 URLs, not 198")
    for i in range(80):
        board.append("example.com", type="finding", body=f"routine {i} " + "padding " * 30,
                     **{"from": f"agent-{i % 9}"})

    out = board.digest("example.com")
    assert old["id"] in out
    assert "[binding]" in out


@pytest.mark.integration
def test_board_digest_fits_its_budget(workspace):
    for i in range(200):
        board.append("example.com", type="finding", body=f"finding {i} " + "padding " * 40,
                     **{"from": "agent"}, evidence="evidence " * 40)
    assert len(board.digest("example.com")) < 20000
    assert len(board.digest("example.com", full=True)) > 20000


@pytest.mark.integration
def test_memory_digest_shows_every_standing_decision_and_discloses_the_rest(workspace):
    """The real loss: `decisions[-8:]` of 16 hid "Recommendations only, no repo
    writes" — the single most consequential instruction in the engagement."""
    memory.append("example.com", "decisions", {
        "what": "Recommendations only, no repo writes", "why": "owner instruction",
        "by": "seo-director"})
    for i in range(40):
        memory.append("example.com", "decisions", {
            "what": f"tactical call {i}", "why": "reason " * 40, "by": f"agent-{i}"})

    out = memory.digest("example.com")
    assert "Recommendations only, no repo writes" in out
    assert "[standing]" in out
    if "tactical call 39" not in out or out.count("tactical call") < 40:
        assert "Not shown above" in out and "decision(s)" in out


@pytest.mark.integration
def test_memory_facts_truncation_discloses_and_keeps_the_newest(workspace):
    topics = ["hreflang", "schema", "rendering", "crawl_budget", "nap", "llms_txt",
              "orphans", "canonicals", "pagination", "robots"]
    for i, name in enumerate(topics * 6):
        memory.upsert_fact("example.com", f"{name}_observation_{i}",
                           "value " * 40, "crawl", observed=f"2026-01-{i % 28 + 1:02d}")
    out = memory.digest("example.com")
    assert "Not shown above" in out and "fact(s)" in out
    assert "--full" in out
    assert len(memory.digest("example.com", full=True)) > len(out)


# ================================================== 2. supersession, as data

@pytest.mark.integration
def test_a_superseded_fact_stops_rendering_and_says_why_in_full(workspace, capsys):
    """683 kept rendering beside the verified 779 because "Supersedes the earlier
    683 figure" was prose the tool never parsed."""
    memory.upsert_fact("example.com", "sitemap_urls", "683", "first count",
                       observed="2026-09-17")
    memory.upsert_fact("example.com", "url_inventory", "779", "full sitemap walk",
                       observed="2026-09-18", supersedes="sitemap_urls")

    default = memory.digest("example.com")
    assert "779" in default
    assert "683" not in default, "a retired value must not render as current"

    full = memory.digest("example.com", full=True)
    assert "683" in full and "RETIRED" in full
    assert "url_inventory" in full

    stored = memory.load("example.com", "facts")
    assert stored["sitemap_urls"]["value"] == "683", "append-only: the claim itself is untouched"
    assert stored["sitemap_urls"]["supersededBy"] == "url_inventory"


@pytest.mark.integration
def test_a_superseded_baseline_stops_rendering(workspace):
    memory.append("example.com", "baselines", {"metric": "us_tree_urls", "value": 198,
                                               "source": "brief", "observedAt": "2026-09-17"})
    assert memory.main(["baseline", "example.com", "--metric", "us_tree_urls", "--value", "240",
                        "--source", "live enumeration", "--observed", "2026-09-18",
                        "--supersedes", "us_tree_urls"]) == 0

    out = memory.digest("example.com")
    assert "240" in out and "198" not in out
    assert "RETIRED" in memory.digest("example.com", full=True)


@pytest.mark.integration
def test_board_post_supersedes_marks_the_old_entry_without_deleting_it(workspace):
    old = board.append("example.com", type="finding", body="the /us/ tree is 198 URLs",
                       **{"from": "seo-recon"})
    assert board.main(["post", "example.com", "--type", "finding", "--from", "tech-seo",
                       "--body", "the /us/ tree is 240 URLs", "--supersedes", old["id"]]) == 0

    out = board.digest("example.com")
    assert "Withdrawn and superseded" in out
    assert "SUPERSEDED" in out and old["id"] in out
    ids = [e["id"] for e in board.load("example.com")["entries"]]
    assert old["id"] in ids, "append-only: superseding never deletes"


@pytest.mark.integration
def test_supersedes_refuses_an_id_that_does_not_exist(workspace):
    assert board.main(["post", "example.com", "--type", "finding", "--from", "a",
                       "--body", "x", "--supersedes", "bd_nope"]) == 1


# ========================================================= 2b. withdrawal

@pytest.mark.integration
def test_withdraw_leaves_a_louder_trace_than_the_claim_did(workspace):
    """The 55-of-115 case: the figure disappeared and so did the ruling. An agent
    that cached the number had no way to learn it was withdrawn."""
    bad = board.append("example.com", type="finding", **{"from": "internal-linking-engineer"},
                       body="55 of 115 blog posts carry in-body service links")
    assert board.main(["withdraw", "example.com", "--from", "seo-orchestrator",
                       "--re", bad["id"],
                       "--body", "measurement artifact: counted nav and footer links; "
                                 "the correct figure is 0"]) == 0

    out = board.digest("example.com")
    assert bad["id"] in out
    assert "WITHDRAWN" in out
    assert "measurement artifact" in out
    assert "~~" in out, "a withdrawn finding renders struck, never hidden"

    entry = next(e for e in board.load("example.com")["entries"] if e["id"] == bad["id"])
    assert entry["body"].startswith("55 of 115"), "append-only: the entry is not edited"


@pytest.mark.integration
def test_withdraw_refuses_an_unknown_entry(workspace):
    assert board.main(["withdraw", "example.com", "--from", "orch", "--re", "bd_nope",
                       "--body", "why"]) == 1


@pytest.mark.integration
def test_an_adjudication_is_rendered_not_swallowed(workspace):
    """digest() had no answer section at all, so a ruling on a conflict was
    written to the board and shown to nobody."""
    f = board.append("example.com", type="finding", body="55 of 115", **{"from": "ile"})
    c = board.append("example.com", type="conflict", re=f["id"], body="cannot reproduce",
                     **{"from": "sas"})
    board.append("example.com", type="answer", re=c["id"], **{"from": "seo-orchestrator"},
                 body="ADJUDICATED - the 55-of-115 figure is an artifact and is withdrawn")

    out = board.digest("example.com")
    assert "Adjudicated" in out
    assert "ADJUDICATED - the 55-of-115 figure" in out


# ============================================================ 3. key aliasing

@pytest.mark.integration
def test_hyphen_and_underscore_keys_are_one_key(workspace, capsys):
    """Four keys held the /us/ page count, so upsert_fact never saw a conflict."""
    memory.upsert_fact("example.com", "us-sitemap-url-count", "198", "brief")
    memory.upsert_fact("example.com", "us_sitemap_url_count", "240", "live enumeration")

    facts = memory.load("example.com", "facts")
    assert list(facts) == ["us-sitemap-url-count"], "the alias must land on the existing key"
    assert facts["us-sitemap-url-count"]["value"] == "240"
    assert facts["us-sitemap-url-count"]["previous"] == "198"
    assert "us_sitemap_url_count" in facts["us-sitemap-url-count"]["aliases"]


@pytest.mark.integration
def test_a_near_duplicate_key_warns_on_write(workspace, capsys):
    memory.upsert_fact("example.com", "us_tree_size", "240", "live enumeration")
    memory.upsert_fact("example.com", "us_tree_urls", "240", "live enumeration")
    err = capsys.readouterr().err
    assert "NEAR-DUPLICATE KEY" in err
    assert "us_tree_size" in err


@pytest.mark.integration
def test_keys_lint_reports_the_cluster(workspace, capsys):
    memory.upsert_fact("example.com", "us-tree-size", "240", "a")
    memory.upsert_fact("example.com", "us_tree_size_urls", "240", "b")
    memory.key_lint("example.com")
    assert "near-duplicate" in capsys.readouterr().out


# =========================================================== 4. observed dates

@pytest.mark.integration
def test_observed_date_is_separate_from_write_time(workspace):
    """Entries were stamped with write time in UTC while the team worked in IST,
    so everything written on the 18th read 2026-09-17."""
    memory.main(["fact", "example.com", "--key", "crawl", "--value", "240",
                 "--source", "sitemap walk", "--observed", "2026-08-01"])
    fact = memory.load("example.com", "facts")["crawl"]

    assert fact["observedAt"] == "2026-08-01"
    assert fact["updatedAt"][:10] != "2026-08-01", "the write stamp is its own field"
    assert "2026-08-01" in memory.digest("example.com")


@pytest.mark.integration
def test_write_stamps_carry_a_local_offset(workspace):
    e = board.append("example.com", type="finding", body="x", **{"from": "a"})
    assert board.parse_at(e["at"]).utcoffset() is not None
    assert not e["at"].endswith("Z") or "+" in e["at"]


@pytest.mark.integration
def test_legacy_utc_entries_render_in_local_time(workspace):
    """Existing rows are not rewritten, so the digest has to read them sensibly."""
    board.append("example.com", type="finding", body="x", **{"from": "a"})
    path = board.board_path("example.com")
    data = json.loads(path.read_text(encoding="utf-8"))
    data["entries"][0]["at"] = "2026-09-17T21:42:57Z"
    path.write_text(json.dumps(data), encoding="utf-8")

    rendered = board.observed_of(board.load("example.com")["entries"][0])
    assert rendered in ("2026-09-17", "2026-09-18"), rendered
    assert rendered == memory.parse_at("2026-09-17T21:42:57Z").astimezone().date().isoformat()


@pytest.mark.integration
def test_memory_reads_the_observation_date_an_agent_wrote_into_its_source(workspace):
    memory.upsert_fact("example.com", "k", "v", "live enumeration 2026-09-18")
    facts = memory.load("example.com", "facts")
    del facts["k"]["observedAt"]  # simulate a pre-observedAt row
    memory.save("example.com", "facts", facts)
    assert memory.observed_of(memory.load("example.com", "facts")["k"]) == "2026-09-18"


@pytest.mark.integration
def test_baselines_are_ordered_by_observation_not_by_insertion(workspace):
    """A backfilled older reading appended later must not become "current" and
    invert the delta."""
    memory.append("example.com", "baselines", {"metric": "clicks", "value": 150,
                                               "source": "GSC", "observedAt": "2026-09-20"})
    memory.append("example.com", "baselines", {"metric": "clicks", "value": 100,
                                               "source": "GSC", "observedAt": "2026-09-01"})
    out = memory.digest("example.com")
    assert "**clicks**: 150" in out
    assert "+50.0%" in out


# ================================================================== 5. dedup

@pytest.mark.integration
def test_one_agent_posting_twice_renders_once(workspace):
    body = "the /us/ tree is 240 URLs across 8 sub-sitemaps, not 198"
    board.append("example.com", type="finding", body=body, **{"from": "tech-seo"})
    board.append("example.com", type="finding", body=body + " (confirmed)",
                 **{"from": "tech-seo"})

    out = board.digest("example.com")
    assert out.count("240 URLs across 8 sub-sitemaps") == 1
    assert "recorded 2×" in out


@pytest.mark.integration
def test_two_agents_agreeing_are_shown_as_one_ratified_decision(workspace):
    memory.append("example.com", "decisions", {
        "what": "Keep both trees and differentiate - do NOT consolidate /us/ into global "
                "or vice versa", "why": "measured 6-gram similarity is 0.7-4.1%",
        "by": "international-seo-specialist"})
    memory.append("example.com", "decisions", {
        "what": "Keep both trees and differentiate - do NOT consolidate /us/ into global",
        "why": "measured 6-gram similarity is 0.7-4.1%", "by": "seo-orchestrator"})

    out = memory.digest("example.com")
    assert "restates the international-seo-specialist decision" in out


@pytest.mark.integration
def test_a_duplicate_claim_renders_once(workspace):
    board.append("example.com", type="claim", topic="entity-schema-new-pages",
                 **{"from": "entity-grounding-specialist"})
    board.append("example.com", type="claim", topic="entity-schema-new-pages",
                 **{"from": "entity-grounding-specialist"})
    out = board.digest("example.com")
    assert out.count("entity-schema-new-pages") == 1


# ====================================================== 6. concurrency, claims

@pytest.mark.integration
def test_reclaiming_your_own_topic_is_idempotent(workspace, capsys):
    board.main(["open", "example.com", "--run", "daily"])
    assert board.main(["claim", "example.com", "--from", "entity-grounding-specialist",
                       "--topic", "entity-schema"]) == 0
    assert board.main(["claim", "example.com", "--from", "entity-grounding-specialist",
                       "--topic", "entity-schema"]) == 0

    claims = [e for e in board.load("example.com")["entries"] if e["type"] == "claim"]
    assert len(claims) == 1, "a restarted agent must not file a second claim"
    assert "already yours" in capsys.readouterr().out


@pytest.mark.integration
def test_another_agent_is_still_refused(workspace):
    board.main(["open", "example.com", "--run", "daily"])
    board.main(["claim", "example.com", "--from", "a", "--topic", "t"])
    assert board.main(["claim", "example.com", "--from", "b", "--topic", "t"]) == 2


@pytest.mark.integration
def test_six_concurrent_processes_lose_no_claims(tmp_path):
    """Observed 2026-09-22: six agent processes wrote 7 claims in 66 seconds
    through an unlocked read-modify-write and produced a duplicate. Six
    processes, six distinct topics, no lost update and no duplicate id."""
    subprocess.run([sys.executable, str(TOOLS / "board.py"), "open", "example.com",
                    "--run", "daily"], cwd=tmp_path, check=True, capture_output=True)

    procs = [subprocess.Popen(
        [sys.executable, str(TOOLS / "board.py"), "claim", "example.com",
         "--from", f"agent-{i}", "--topic", f"topic-{i}"],
        cwd=tmp_path, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(6)]
    for p in procs:
        assert p.wait(timeout=60) == 0

    entries = json.loads((tmp_path / "memory" / "example.com" / "board.json")
                         .read_text(encoding="utf-8"))["entries"]
    claims = [e for e in entries if e["type"] == "claim"]
    assert len(claims) == 6, "a lost update ate a claim"
    assert len({c["topic"] for c in claims}) == 6
    assert len({e["id"] for e in entries}) == len(entries), "duplicate id"


@pytest.mark.integration
def test_six_concurrent_processes_cannot_double_claim_one_topic(tmp_path):
    subprocess.run([sys.executable, str(TOOLS / "board.py"), "open", "example.com",
                    "--run", "daily"], cwd=tmp_path, check=True, capture_output=True)

    procs = [subprocess.Popen(
        [sys.executable, str(TOOLS / "board.py"), "claim", "example.com",
         "--from", "entity-grounding-specialist", "--topic", "entity-schema-new-pages"],
        cwd=tmp_path, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(6)]
    for p in procs:
        assert p.wait(timeout=60) == 0

    entries = json.loads((tmp_path / "memory" / "example.com" / "board.json")
                         .read_text(encoding="utf-8"))["entries"]
    claims = [e for e in entries if e["type"] == "claim"]
    assert len(claims) == 1, f"the 2026-09-22 duplicate claim is back: {claims}"


@pytest.mark.integration
def test_concurrent_memory_writes_lose_nothing(tmp_path):
    procs = [subprocess.Popen(
        [sys.executable, str(TOOLS / "memory.py"), "decide", "example.com",
         "--what", f"call {i}", "--why", "reason", "--by", f"agent-{i}"],
        cwd=tmp_path, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(6)]
    for p in procs:
        assert p.wait(timeout=60) == 0

    items = json.loads((tmp_path / "memory" / "example.com" / "decisions.json")
                       .read_text(encoding="utf-8"))
    assert len(items) == 6
    assert len({i["id"] for i in items}) == 6, "two writes in one millisecond shared an id"


# ============================================================ 7. run lifecycle

@pytest.mark.integration
def test_closing_a_run_frees_its_claims(workspace):
    board.main(["open", "example.com", "--run", "daily-2026-09-22"])
    board.main(["claim", "example.com", "--from", "a", "--topic", "t"])
    assert board.main(["close", "example.com"]) == 0

    out = board.digest("example.com")
    assert "stale" in out and "FREE to claim" in out
    assert board.load("example.com")["run"] is None
    assert board.main(["claim", "example.com", "--from", "b", "--topic", "t"]) == 0, \
        "a stale claim must not block tomorrow's agent"


@pytest.mark.integration
def test_a_claim_from_another_run_is_stale(workspace):
    board.main(["open", "example.com", "--run", "day-1"])
    board.main(["claim", "example.com", "--from", "a", "--topic", "t"])
    board.main(["open", "example.com", "--run", "day-2"])
    assert board.main(["claim", "example.com", "--from", "b", "--topic", "t"]) == 0


@pytest.mark.integration
def test_close_refuses_when_no_run_is_open(workspace):
    board.append("example.com", type="finding", body="x", **{"from": "a"})
    assert board.main(["close", "example.com"]) == 1


# ========================================================= CLI compatibility

@pytest.mark.integration
@pytest.mark.parametrize("argv", [
    ["open", "example.com", "--run", "r"],
    ["post", "example.com", "--type", "finding", "--from", "a", "--body", "b"],
    ["ask", "example.com", "--from", "a", "--to", "b", "--body", "q"],
    ["claim", "example.com", "--from", "a", "--topic", "t"],
    ["digest", "example.com"],
    ["pending", "example.com"],
])
def test_board_cli_shape_is_unchanged(workspace, argv):
    """52 agent prompt files and two scheduled jobs call these. Flags may be
    added; nothing may be renamed."""
    assert board.main(argv) in (0, 1)


@pytest.mark.integration
@pytest.mark.parametrize("argv", [
    ["init", "example.com"],
    ["fact", "example.com", "--key", "k", "--value", "v", "--source", "s"],
    ["decide", "example.com", "--what", "w", "--why", "y", "--by", "b"],
    ["baseline", "example.com", "--metric", "m", "--value", "1", "--source", "s"],
    ["change", "example.com", "--what", "w", "--agent", "a"],
    ["learn", "example.com", "--what", "w", "--outcome", "worked"],
    ["trend", "example.com", "--metric", "m"],
    ["digest", "example.com"],
    ["sites"],
])
def test_memory_cli_shape_is_unchanged(workspace, argv):
    assert memory.main(argv) == 0
