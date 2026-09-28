"""Tests for tools/serp.py — the honesty guarantees, one per audited defect.

Every test here is a regression test for something the data-layer audit found in
this file. They exist because the module has exactly one job: never let an agent
report "not ranking" when the truth is "not measured". Each defect below was a
path back to that error.

The HTTP layer is always mocked. These tests must never spend a SERP credit.

Run:  python -m pytest tests -q
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


serp = _load("serp")


class FakeResponse:
    """Just enough of requests.Response for the retry path."""

    def __init__(self, status: int = 200, payload: dict | None = None, headers: dict | None = None):
        self.status_code = status
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise serp.requests.HTTPError(f"{self.status_code} Server Error")


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """Isolated cwd, isolated cache, no inherited provider keys."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(serp, "CACHE_DIR", tmp_path / ".cache/serp")
    for k in ("SERPER_API_KEY", "SERPAPI_API_KEY", "VALUESERP_API_KEY", "SERP_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path


def serper_payload(q: str = "ai agents", n: int = 10) -> dict:
    return {"searchParameters": {"q": q, "location": "United States"},
            "organic": [{"position": i + 1, "title": f"r{i}", "link": f"https://e{i}.com/x"}
                        for i in range(n)]}


# ============================ 1. a failed query must survive into the JSON

@pytest.mark.integration
def test_an_errored_query_still_appears_in_the_batch_json_with_status_error(
        sandbox, monkeypatch, capsys):
    """THE defect. A query that errored was written to the .md and deleted from
    serp-batch.json — the file agents actually cite — so 27 rows out of a
    30-keyword run read as "0 of 30 not ranking"."""
    monkeypatch.setenv("SERPER_API_KEY", "test-key")
    Path("kw.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    calls = {"n": 0}

    def fake_post(url, **kw):
        calls["n"] += 1
        if (kw.get("json") or {}).get("q") == "beta":     # fails on every attempt
            raise serp.requests.ConnectionError("boom")
        return FakeResponse(200, serper_payload(f"echo-{calls['n']}"))

    monkeypatch.setattr(serp.requests, "post", fake_post)
    monkeypatch.setattr(serp.time, "sleep", lambda s: None)
    monkeypatch.setattr(sys, "argv", ["serp.py", "batch", "kw.txt", "--out", "out"])
    assert serp.main() == 0

    rows = json.loads(Path("out/serp-batch.json").read_text(encoding="utf-8"))
    assert len(rows) == 3, "every requested query must have a row, measured or not"
    assert [r["query"] for r in rows] == ["alpha", "beta", "gamma"]

    bad = rows[1]
    assert bad["status"] == "error"
    assert bad["measured"] is False
    assert "boom" in bad["error"], "the error text travels with the row"
    assert bad["errorAt"]
    assert all(r["status"] == "measured" for r in (rows[0], rows[2]))
    assert all(r["measured"] is True for r in (rows[0], rows[2]))
    # A row is keyed by the query that was asked. The provider's echo is kept
    # beside it, but a row labelled with the echo cannot be joined back to the
    # keyword list — which turns a measured query into a missing one.
    assert rows[0]["queryEcho"] == "echo-1"


@pytest.mark.integration
def test_the_batch_denominator_is_reported_honestly(sandbox, monkeypatch, capsys):
    """measured-count and error-count separately, and the requested total."""
    monkeypatch.setenv("SERPER_API_KEY", "test-key")
    Path("kw.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    monkeypatch.setattr(serp.requests, "post",
                        lambda url, **kw: (_ for _ in ()).throw(serp.requests.ConnectionError("no")))
    monkeypatch.setattr(serp.time, "sleep", lambda s: None)
    monkeypatch.setattr(sys, "argv", ["serp.py", "batch", "kw.txt", "--out", "out"])
    serp.main()

    stdout = capsys.readouterr().out
    assert "0 measured" in stdout and "2 error" in stdout and "2 requested" in stdout

    md = Path("out/serp-batch.md").read_text(encoding="utf-8")
    assert "Measured: 0 · errored: 2 · requested: 2" in md
    assert "NOT evidence of absence" in md
    assert "NOT MEASURED" in md, "the per-query section must not read as an empty SERP"


@pytest.mark.unit
def test_compare_keeps_unmeasured_queries_out_of_both_sides_of_the_rate():
    """"ranks for 0/27" used to print as though 27 had been the ask."""
    ok = serp.empty_result("a")
    ok["provider"] = "serper"
    ok["organic"] = [{"position": 1, "domain": "you.com", "title": "t"}]
    serp.apply_capabilities(ok)
    missed = serp.empty_result("b")
    missed["organic"] = [{"position": 1, "domain": "rival.com", "title": "t"}]
    failed = serp.error_result("c", "429 Too Many Requests")

    s = serp.compare_domains([ok, missed, failed], "you.com", ["rival.com"])["summary"]
    assert s["keywordsRequested"] == 3
    assert s["keywordsMeasured"] == 2
    assert s["keywordsErrored"] == 1
    assert s["erroredQueries"] == ["c"]
    assert s["targetRanksIn"] == 1
    assert s["targetVisibilityRate"] == 50.0, "1 of 2 MEASURED, never 1 of 3"
    assert "MEASURED" in s["targetVisibilityRateBasis"]
    assert "NOT evidence of absence" in s["targetVisibilityRateBasis"]


@pytest.mark.unit
def test_compare_row_for_an_unmeasured_query_is_not_a_missing_rank():
    rows = serp.compare_domains([serp.error_result("c", "timeout")], "you.com", [])["rows"]
    assert rows[0]["status"] == "error"
    assert rows[0]["target"] is None
    assert rows[0]["depthRetrieved"] == 0


# ============================ 2. declared capability must match parsed capability

@pytest.mark.unit
def test_no_provider_declares_a_feature_its_normalizer_does_not_parse():
    """The drift guard itself. valueserp declared featuredSnippet/knowledgeGraph/
    localPack/videos and serpapi declared localPack/videos/images/shopping while
    neither normalizer read those keys, so all of them reported ABSENT for SERPs
    nobody had looked at."""
    for name, cap in serp.CAPABILITIES.items():
        drift = set(cap["detects"]) - serp.PARSES[name]
        assert not drift, f"{name} declares {sorted(drift)} but does not parse it"


@pytest.mark.unit
def test_reconcile_capabilities_raises_when_the_table_drifts(monkeypatch):
    """If someone re-adds a declared-but-unparsed feature, import must fail loudly
    rather than shipping a run that reports it as absent."""
    monkeypatch.setitem(serp.PARSES, "valueserp", {"organic"})
    with pytest.raises(AssertionError, match="does not parse"):
        serp.reconcile_capabilities()


@pytest.mark.unit
def test_an_unparsed_feature_degrades_to_not_checked_never_to_absent():
    for name, cap in serp.CAPABILITIES.items():
        for feature in serp.FEATURES - serp.PARSES[name]:
            assert feature in cap["cannot_detect"], (
                f"{name}: {feature} is unparsed and must be reported as not checked")


@pytest.mark.unit
@pytest.mark.parametrize("provider,payload,expected", [
    ("serper", {
        "searchParameters": {"q": "q", "location": "United States"},
        "organic": [{"position": 1, "title": "t", "link": "https://a.com/1"}],
        "answerBox": {"snippet": "s", "link": "https://a.com/1"},
        "peopleAlsoAsk": [{"question": "why?", "link": "https://a.com/2"}],
        "relatedSearches": [{"query": "more"}],
        "knowledgeGraph": {"title": "Acme", "type": "Org", "website": "https://a.com"},
        "places": [{"title": "Acme HQ", "rating": 4.5, "ratingCount": 10}],
    }, ["organic", "featuredSnippet", "peopleAlsoAsk", "relatedSearches",
        "knowledgeGraph", "localPack"]),
    ("serpapi", {
        "search_parameters": {"q": "q", "location_requested": "United States"},
        "organic_results": [{"position": 1, "title": "t", "link": "https://a.com/1"}],
        "answer_box": {"type": "paragraph", "snippet": "s", "link": "https://a.com/1"},
        "ai_overview": {"text_blocks": [{"snippet": "x"}],
                        "references": [{"link": "https://a.com/3", "title": "r"}]},
        "related_questions": [{"question": "why?", "link": "https://a.com/2"}],
        "related_searches": [{"query": "more"}],
        "knowledge_graph": {"title": "Acme", "type": "Org", "website": "https://a.com"},
        "local_results": {"places": [{"title": "Acme HQ", "rating": 4.5}]},
        "inline_videos": [{"title": "v", "link": "https://yt.com/v"}],
        "inline_images": [{"link": "https://a.com/i.png"}],
        "shopping_results": [{"title": "p", "link": "https://a.com/p", "price": "$1"}],
        "ads": [{"block_position": "top"}, {"block_position": "bottom"}],
    }, ["organic", "featuredSnippet", "aiOverview", "peopleAlsoAsk", "relatedSearches",
        "knowledgeGraph", "localPack", "videos", "images", "shopping", "topAds", "bottomAds"]),
    ("valueserp", {
        "search_parameters": {"q": "q", "location": "United States"},
        "organic_results": [{"position": 1, "title": "t", "link": "https://a.com/1"}],
        "answer_box": {"type": "paragraph", "snippet": "s", "link": "https://a.com/1"},
        "ai_overview": {"text": "x", "sources": [{"link": "https://a.com/3", "title": "r"}]},
        "related_questions": [{"question": "why?", "link": "https://a.com/2"}],
        "related_searches": [{"query": "more"}],
        "knowledge_graph": {"title": "Acme", "type": "Org", "website": "https://a.com"},
        "local_results": [{"title": "Acme HQ", "rating": 4.5}],
        "inline_videos": [{"title": "v", "link": "https://yt.com/v"}],
    }, ["organic", "featuredSnippet", "aiOverview", "peopleAlsoAsk", "relatedSearches",
        "knowledgeGraph", "localPack", "videos"]),
])
def test_every_declared_feature_survives_its_normalizer(provider, payload, expected):
    """Behavioural half of the drift guard: a fixture carrying every declared
    feature must come out of the normalizer non-empty. A set comparison alone
    would pass if PARSES were edited without the parser."""
    r = {"serper": serp.normalize_serper, "serpapi": serp.normalize_serpapi,
         "valueserp": serp.normalize_valueserp}[provider](payload)
    assert set(serp.CAPABILITIES[provider]["detects"]) <= set(expected)
    for feature in serp.CAPABILITIES[provider]["detects"]:
        assert r[feature], f"{provider}: declared {feature} came back empty from the normalizer"


@pytest.mark.unit
def test_serper_stays_blind_to_ai_overviews_and_ads():
    """The existing rule, pinned: serper must always report these as not checked,
    even when the payload contains them."""
    r = serp.normalize_serper({**serper_payload(),
                               "aiOverview": {"text": "x", "references": []},
                               "ads": [{"title": "ad"}]})
    serp.apply_capabilities(r)
    for f in ("aiOverview", "topAds", "bottomAds"):
        assert f in r["notChecked"]
        assert r[f] is None
    assert serp.analyze_serp(r)["aiOverviewPresent"] is None


# ============================ 3. depth honesty

@pytest.mark.unit
def test_depth_reported_is_what_was_retrieved_not_what_was_requested():
    """compare printed "Ranks in top 20" off ten-result data."""
    r = serp.empty_result("q")
    r["provider"] = "serper"
    r["num"] = 20
    r["organic"] = [{"position": i + 1, "domain": f"e{i}.com", "title": "t"} for i in range(10)]
    serp.apply_capabilities(r)

    s = serp.compare_domains([r], "you.com", [])["summary"]
    assert s["depthRetrievedMin"] == 10 and s["depthRetrievedMax"] == 10
    assert "top 10 retrieved" in s["depthBasis"]
    assert "20" not in s["depthBasis"]


@pytest.mark.unit
def test_per_query_depth_is_recorded_per_row():
    a = serp.empty_result("a"); a["organic"] = [{"position": 1, "domain": "x.com"}]
    b = serp.empty_result("b")
    b["organic"] = [{"position": i + 1, "domain": "x.com"} for i in range(9)]
    rows = serp.compare_domains([a, b], "you.com", [])["rows"]
    assert [r["depthRetrieved"] for r in rows] == [1, 9]


@pytest.mark.unit
def test_markdown_labels_absence_by_retrieved_depth():
    r = serp.empty_result("q")
    r["provider"] = "serper"
    r["num"] = 20
    r["organic"] = [{"position": i + 1, "domain": f"e{i}.com", "title": "t"} for i in range(10)]
    serp.apply_capabilities(r)
    md = serp.to_markdown(r, serp.analyze_serp(r))
    assert "depth 10 retrieved of 20 requested" in md
    assert "absent from the top 10 retrieved" in md


# ============================ 4. cache correctness

@pytest.mark.unit
def test_cache_key_separates_providers_when_provider_is_auto(sandbox, monkeypatch):
    """The key recorded the literal "auto" when nothing was set, so a serper entry
    — which carries notChecked: [aiOverview, ...] — could be served to a later run
    that had switched to a provider which does report AI Overviews."""
    opts = {"location": "US", "gl": "us", "hl": "en", "num": 10}

    monkeypatch.setenv("SERPER_API_KEY", "k")
    as_serper = serp.cache_key("q", opts)

    monkeypatch.delenv("SERPER_API_KEY")
    monkeypatch.setenv("SERPAPI_API_KEY", "k")
    as_serpapi = serp.cache_key("q", opts)

    assert as_serper != as_serpapi, "auto-resolved providers must not share a cache slot"
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.delenv("SERPAPI_API_KEY")
    assert serp.cache_key("q", opts) == as_serper, "the same resolution must hit the same slot"


@pytest.mark.unit
def test_cache_key_still_separates_explicit_providers():
    assert (serp.cache_key("q", {"provider": "serper", "location": "US"})
            != serp.cache_key("q", {"provider": "serpapi", "location": "US"}))


@pytest.mark.integration
def test_a_cached_result_carries_its_age_and_the_ttl(sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.setattr(serp.requests, "post", lambda url, **kw: FakeResponse(200, serper_payload()))
    opts = {"location": "US", "gl": "us", "hl": "en", "num": 10}

    first = serp.serp_search("ai agents", opts)
    assert first["cached"] is False and first["cacheAgeHours"] == 0.0

    def explode(url, **kw):
        raise AssertionError("second call must be served from cache, not from the network")

    monkeypatch.setattr(serp.requests, "post", explode)
    second = serp.serp_search("ai agents", opts)
    assert second["cached"] is True
    assert second["cacheAgeHours"] is not None
    assert second["cacheTtlHours"] == serp.TTL_HOURS
    assert second["_cached"] is True, "the old flag stays for existing agent prompts"


@pytest.mark.unit
def test_compare_surfaces_cache_state_and_ttl():
    r = serp.empty_result("q")
    r["provider"] = "serper"
    r["organic"] = [{"position": 1, "domain": "you.com", "title": "t"}]
    r["cached"], r["cacheAgeHours"] = True, 1.0
    serp.apply_capabilities(r)
    s = serp.compare_domains([r], "you.com", [])["summary"]
    assert s["cachedRows"] == 1
    assert s["cacheAgeHoursMax"] == 1.0
    assert s["cacheTtlHours"] == serp.TTL_HOURS


@pytest.mark.unit
def test_a_malformed_ttl_env_var_does_not_take_the_tool_down(monkeypatch):
    monkeypatch.setenv("SERP_CACHE_TTL_HOURS", "twenty-four")
    assert serp._env_float("SERP_CACHE_TTL_HOURS", 24) == 24


# ============================ 5. .env loading

@pytest.mark.unit
def test_env_local_beats_env(sandbox, monkeypatch):
    """Inverted precedence: an operator overriding a stale .env key in .env.local
    kept getting the stale one, which 401s, which used to become a dropped row."""
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("SERPER_API_KEY=stale-key\n", encoding="utf-8")
    Path(".env.local").write_text("SERPER_API_KEY=local-key\n", encoding="utf-8")

    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "local-key"


@pytest.mark.unit
def test_export_prefix_is_honoured(sandbox, monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("export SERPER_API_KEY=shell-style\n", encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "shell-style"


@pytest.mark.unit
def test_a_trailing_comment_is_not_part_of_the_value(sandbox, monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("SERPER_API_KEY=abc123 # serper dev key\n", encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "abc123"


@pytest.mark.unit
def test_a_hash_inside_quotes_stays_in_the_value(sandbox, monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text('SERPER_API_KEY="ab#c123" # note\n', encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "ab#c123"


@pytest.mark.unit
def test_a_blank_still_never_claims_the_slot(sandbox, monkeypatch):
    """The original regression, re-pinned against the rewritten loader."""
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("SERPER_API_KEY=\nSERPER_API_KEY=real-key-value\n", encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "real-key-value"


@pytest.mark.unit
def test_a_blank_in_env_local_does_not_erase_a_real_key_in_env(sandbox, monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("SERPER_API_KEY=real-key\n", encoding="utf-8")
    Path(".env.local").write_text("SERPER_API_KEY=\n", encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "real-key"


@pytest.mark.unit
def test_the_real_environment_still_beats_both_files(sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "from-shell")
    Path(".env").write_text("SERPER_API_KEY=from-file\n", encoding="utf-8")
    Path(".env.local").write_text("SERPER_API_KEY=from-local\n", encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "from-shell"


@pytest.mark.unit
def test_comment_lines_are_skipped(sandbox, monkeypatch):
    monkeypatch.delenv("SERPER_API_KEY", raising=False)
    Path(".env").write_text("# SERPER_API_KEY=commented-out\nSERPER_API_KEY=real\n",
                            encoding="utf-8")
    serp.load_dotenv()
    import os
    assert os.environ["SERPER_API_KEY"] == "real"


# ============================ 6. retries and rate limits

@pytest.mark.unit
def test_a_429_is_retried_and_retry_after_is_honoured():
    slept: list[float] = []
    responses = [FakeResponse(429, headers={"Retry-After": "2"}),
                 FakeResponse(200, serper_payload())]

    resp = serp.request_with_retry(lambda: responses.pop(0), sleeper=slept.append)
    assert resp.status_code == 200
    assert slept == [2.0], "Retry-After wins over the exponential default"


@pytest.mark.unit
def test_backoff_is_exponential_and_bounded():
    slept: list[float] = []
    responses = [FakeResponse(503), FakeResponse(503), FakeResponse(200, serper_payload())]
    serp.request_with_retry(lambda: responses.pop(0), attempts=3, sleeper=slept.append)
    assert slept == [serp.RETRY_BASE_SECONDS, serp.RETRY_BASE_SECONDS * 2]
    assert sum(slept) < 5, "total added delay stays modest — the guard hook rule applies here too"


@pytest.mark.unit
def test_retry_after_is_capped():
    slept: list[float] = []
    responses = [FakeResponse(429, headers={"Retry-After": "9999"}),
                 FakeResponse(200, serper_payload())]
    serp.request_with_retry(lambda: responses.pop(0), sleeper=slept.append)
    assert slept == [serp.MAX_SLEEP_SECONDS], "a hostile Retry-After cannot wedge the run"


@pytest.mark.unit
@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_auth_and_client_errors_are_never_retried(status):
    slept: list[float] = []
    calls = {"n": 0}

    def send():
        calls["n"] += 1
        return FakeResponse(status)

    with pytest.raises(serp.requests.HTTPError):
        serp.request_with_retry(send, sleeper=slept.append)
    assert calls["n"] == 1, "a bad key is still a bad key in four seconds"
    assert slept == []


@pytest.mark.unit
def test_retries_are_bounded_and_the_failure_is_raised():
    slept: list[float] = []
    calls = {"n": 0}

    def send():
        calls["n"] += 1
        return FakeResponse(429)

    with pytest.raises(serp.requests.HTTPError):
        serp.request_with_retry(send, attempts=3, sleeper=slept.append)
    assert calls["n"] == 3, "exactly the configured attempts, never an unbounded loop"


@pytest.mark.integration
def test_a_query_that_exhausts_its_retries_becomes_an_error_row_not_a_dropped_one(
        sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.setattr(serp.requests, "post", lambda url, **kw: FakeResponse(429))
    monkeypatch.setattr(serp.time, "sleep", lambda s: None)
    Path("kw.txt").write_text("alpha\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["serp.py", "batch", "kw.txt", "--out", "out"])
    serp.main()

    rows = json.loads(Path("out/serp-batch.json").read_text(encoding="utf-8"))
    assert len(rows) == 1 and rows[0]["status"] == "error"
    assert "429" in rows[0]["error"]


@pytest.mark.integration
def test_fail_on_error_is_opt_in_so_existing_callers_keep_their_exit_code(
        sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.setattr(serp.requests, "post",
                        lambda url, **kw: (_ for _ in ()).throw(serp.requests.ConnectionError("x")))
    monkeypatch.setattr(serp.time, "sleep", lambda s: None)
    Path("kw.txt").write_text("alpha\n", encoding="utf-8")

    monkeypatch.setattr(sys, "argv", ["serp.py", "batch", "kw.txt", "--out", "out"])
    assert serp.main() == 0, "52 agent prompts depend on this exit code"

    monkeypatch.setattr(sys, "argv",
                        ["serp.py", "batch", "kw.txt", "--out", "out", "--fail-on-error"])
    assert serp.main() == 1


# ============================ 7. provenance

@pytest.mark.integration
@pytest.mark.parametrize("provider,env,method", [
    ("serper", "SERPER_API_KEY", "post"),
    ("serpapi", "SERPAPI_API_KEY", "get"),
    ("valueserp", "VALUESERP_API_KEY", "get"),
])
def test_device_reaches_every_provider(sandbox, monkeypatch, provider, env, method):
    """--device mobile was honoured only by serper; serpapi and valueserp silently
    returned desktop results labelled nothing."""
    monkeypatch.setenv(env, "k")
    seen = {}

    def capture(url, **kw):
        seen.update(kw.get("json") or kw.get("params") or {})
        return FakeResponse(200, {"searchParameters": {"q": "q"}, "search_parameters": {"q": "q"}})

    monkeypatch.setattr(serp.requests, method, capture)
    serp.serp_search("q", {"provider": provider, "device": "mobile", "location": "US",
                           "gl": "us", "hl": "en", "num": 10})
    assert seen.get("device") == "mobile", f"{provider} never received the device"


@pytest.mark.integration
def test_every_result_records_what_was_asked(sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.setattr(serp.requests, "post", lambda url, **kw: FakeResponse(200, serper_payload()))
    r = serp.serp_search("q", {"provider": "serper", "device": "mobile", "location": "Austin,Texas",
                               "gl": "us", "hl": "en", "num": 20})
    req = r["request"]
    assert req["provider"] == "serper"
    assert req["device"] == "mobile"
    assert (req["gl"], req["hl"], req["num"]) == ("us", "en", 20)
    assert req["location"] == "Austin,Texas"
    assert r["fetchedAt"].endswith("+00:00") or r["fetchedAt"].endswith("Z")
    assert r["fetchedAtLocal"], "local time with offset, so nobody has to guess the clock"


@pytest.mark.integration
def test_a_location_the_provider_does_not_echo_is_still_recorded(sandbox, monkeypatch):
    """location came from the provider's echo only, so a US-targeted query and an
    untargeted one were indistinguishable in the saved artifact."""
    monkeypatch.setenv("SERPER_API_KEY", "k")
    monkeypatch.setattr(serp.requests, "post",
                        lambda url, **kw: FakeResponse(200, {"searchParameters": {"q": "q"},
                                                             "organic": []}))
    r = serp.serp_search("q", {"provider": "serper", "location": "United States",
                               "gl": "us", "hl": "en", "num": 10})
    assert r["locationEcho"] is None
    assert r["locationRequested"] == "United States"
    assert r["location"] == "United States"
    assert "did not echo" in serp.to_markdown(r, serp.analyze_serp(r))


@pytest.mark.unit
def test_no_output_path_can_leak_the_api_key(sandbox, monkeypatch):
    monkeypatch.setenv("SERPER_API_KEY", "super-secret-key")
    monkeypatch.setattr(serp.requests, "post", lambda url, **kw: FakeResponse(200, serper_payload()))
    r = serp.serp_search("q", {"provider": "serper", "location": "US", "gl": "us",
                               "hl": "en", "num": 10})
    blob = json.dumps(r) + serp.to_markdown(r, serp.analyze_serp(r))
    assert "super-secret-key" not in blob


@pytest.mark.integration
def test_a_legacy_auto_keyed_entry_is_reused_only_for_the_same_provider(sandbox, monkeypatch):
    """Resolving the provider into the key orphaned every entry written under
    "auto". Reuse them when the recorded provider matches — and never when it
    does not, which is the bleed the fix exists to stop."""
    monkeypatch.setenv("SERPER_API_KEY", "k")
    opts = {"location": "US", "gl": "us", "hl": "en", "num": 10}

    entry = serp.empty_result("q")
    entry["provider"] = "serpapi"          # written by a DIFFERENT provider
    entry["organic"] = [{"position": 1, "domain": "x.com"}]
    serp.write_cache(serp.legacy_cache_key("q", opts), entry)

    monkeypatch.setattr(serp.requests, "post", lambda url, **kw: FakeResponse(200, serper_payload()))
    fresh = serp.serp_search("q", opts)
    assert fresh["provider"] == "serper"
    assert fresh["cached"] is False, "a serpapi entry must never be served to a serper run"

    entry["provider"] = "serper"
    serp.write_cache(serp.legacy_cache_key("q2", opts), entry)
    reused = serp.serp_search("q2", opts)
    assert reused["cached"] is True and reused["provider"] == "serper"
