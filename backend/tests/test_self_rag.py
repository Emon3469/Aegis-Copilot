import pytest

import src.self_rag as rag
from src.self_rag import RelevanceDecision, RetrieveDecision, SupportDecision, UsefulnessDecision


class StubTavily:
    def __init__(self, results=None, error=None):
        self.results, self.error, self.queries = results or [], error, []

    def search(self, query, **kwargs):
        self.queries.append(query)
        if self.error:
            raise self.error
        return {"results": self.results}


@pytest.fixture
def kb(monkeypatch, make_doc):
    state = {"docs": [make_doc("Scale replicas when CPU > 85%.", "payments-high-cpu-runbook.md")], "error": None, "queries": []}

    def search(q):
        state["queries"].append(q)
        if state["error"]:
            raise state["error"]
        return [d.model_copy(deep=True) for d in state["docs"]]

    monkeypatch.setattr(rag, "search", search)
    return state


@pytest.fixture
def web(monkeypatch):
    client = StubTavily([{"title": "K8s docs", "url": "https://k8s.io/x", "content": "Kubernetes v1.37 is current."}])
    monkeypatch.setattr(rag, "_tavily_client", lambda: client)
    return client


def run(question, thread="thread-1"):
    return rag.run_self_rag(question, thread)


def stream(question, thread="thread-s"):
    return list(rag.stream_self_rag(question, thread))


def test_small_talk_is_answered_directly(settings, fake_pool, kb):
    pool = fake_pool(["Hello there!"], decide=lambda m: RetrieveDecision(should_retrieve=False))
    out = run("hi")
    assert out["route"] == "General Knowledge"
    assert out["answer"] == "Hello there!"
    assert out["sources"] == []
    assert "SupportDecision" not in pool.calls
    assert "RelevanceDecision" not in pool.calls


def test_grounded_internal_answer(settings, fake_pool, kb):
    fake_pool(["Scale replicas per the runbook."])
    out = run("payments cpu is high")
    assert out["route"] == "Knowledge Base"
    assert out["support_status"] == "fully_supported"
    assert out["usefulness"] == "useful"
    assert out["sources"][0]["title"] == "payments-high-cpu-runbook.md"
    assert out["sources"][0]["type"] == "internal"
    assert out["model"] == "fake:model"
    assert out["used_web_search"] is False


def test_irrelevant_kb_rewrites_then_falls_back_to_web(make_settings, fake_pool, kb, web):
    make_settings(tavily_api_key="tvly", max_retrieval_rewrites=1)
    relevance = iter([[], [], [1]])
    fake_pool(["From the web."], relevance=lambda m: RelevanceDecision(relevant=next(relevance)))
    out = run("latest kubernetes version")
    assert out["route"] == "Web Search"
    assert out["used_web_search"] is True
    assert len(kb["queries"]) == 2
    assert web.queries == ["rewritten query"]
    assert out["sources"] == [{"type": "web", "title": "K8s docs", "source": "https://k8s.io/x", "url": "https://k8s.io/x", "page": None}]


def test_kb_outage_skips_rewrites_and_goes_to_web(make_settings, fake_pool, kb, web):
    make_settings(tavily_api_key="tvly")
    kb["error"] = RuntimeError("pinecone down")
    fake_pool(["web answer"])
    out = run("payments cpu")
    assert out["route"] == "Web Search"
    assert len(kb["queries"]) == 1
    assert "Knowledge base unavailable" in out["trace"]


def test_no_evidence_anywhere_returns_safe_message(make_settings, fake_pool, kb, web):
    make_settings(tavily_api_key="tvly", max_web_rewrites=1)
    web.results = []
    fake_pool(relevance=lambda m: RelevanceDecision(relevant=[]))
    out = run("unknowable thing")
    assert out["route"] == "No Reliable Evidence"
    assert out["answer"] == rag.NO_ANSWER
    assert out["sources"] == []


def test_without_web_search_key_stops_after_kb(settings, fake_pool, kb):
    fake_pool(relevance=lambda m: RelevanceDecision(relevant=[]))
    out = run("unknowable thing")
    assert out["route"] == "No Reliable Evidence"
    assert out["used_web_search"] is False


def test_unsupported_answer_is_revised_once(make_settings, fake_pool, kb):
    make_settings(max_support_retries=1)
    pool = fake_pool(["draft with a made up claim", "revised grounded answer"], support=lambda m: SupportDecision(status="partially_supported"))
    out = run("payments cpu")
    assert out["answer"] == "revised grounded answer"
    assert pool.calls.count("stream") == 2
    assert pool.calls.count("SupportDecision") == 2
    assert out["support_status"] == "partially_supported"


def test_relevance_out_of_range_indexes_are_ignored(settings, fake_pool, kb):
    fake_pool(relevance=lambda m: RelevanceDecision(relevant=[0, 1, 1, 7]))
    out = run("payments cpu")
    assert len(out["sources"]) == 1


def test_grader_failure_keeps_internal_docs(settings, fake_pool, kb):
    def boom(m):
        raise RuntimeError("llm down")

    fake_pool(relevance=boom)
    assert run("payments cpu")["route"] == "Knowledge Base"


def test_failed_checks_do_not_break_answer(settings, fake_pool, kb):
    def boom(m):
        raise RuntimeError("down")

    fake_pool(["answer"], decide=boom, support=boom, usefulness=boom)
    out = run("payments cpu")
    assert out["answer"] == "answer"
    assert out["support_status"] == "partially_supported"


def test_memory_contextualises_follow_up(settings, fake_pool, kb):
    seen = []

    def rewrite(messages):
        seen.append(messages[-1].content)
        from src.self_rag import QueryRewrite

        return QueryRewrite(query="should payments be rolled back after high cpu")

    fake_pool(["first", "second"], rewrite=rewrite)
    first = run("payments cpu is high", "thread-mem")
    second = run("and if that fails?", "thread-mem")
    assert first["memory_turns"] == 1 and second["memory_turns"] == 2
    assert "payments cpu is high" in seen[0]
    assert kb["queries"][-1] == "should payments be rolled back after high cpu"
    other = run("hello", "thread-other")
    assert other["memory_turns"] == 1


def test_useless_answer_triggers_internal_retry(make_settings, fake_pool, kb):
    make_settings(max_retrieval_rewrites=1)
    verdicts = iter(["not_useful", "useful"])
    fake_pool(["a1", "a2"], usefulness=lambda m: UsefulnessDecision(status=next(verdicts), reason=""))
    out = run("payments cpu")
    assert out["answer"] == "a2"
    assert len(kb["queries"]) == 2


def test_stream_event_contract(settings, fake_pool, kb):
    fake_pool(["Scale the replicas now."])
    events = stream("payments cpu")
    types = [e["type"] for e in events]
    assert types[-1] == "done"
    assert "status" in types and "sources" in types and "reset" in types
    assert types.index("sources") < types.index("reset") < types.index("token")
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert tokens.strip() == "Scale the replicas now."
    done = events[-1]
    assert done["answer"] == "Scale the replicas now."
    assert done["thread_id"] == "thread-s"
    statuses = [e["text"] for e in events if e["type"] == "status"]
    assert statuses[:2] == ["Planning the answer", "Searching the knowledge base"]


def test_stream_resets_before_revision(make_settings, fake_pool, kb):
    make_settings(max_support_retries=1)
    fake_pool(["draft", "final"], support=lambda m: SupportDecision(status="no_support"))
    events = stream("payments cpu")
    resets = [i for i, e in enumerate(events) if e["type"] == "reset"]
    assert len(resets) == 2
    after = "".join(e["text"] for e in events[resets[1]:] if e["type"] == "token")
    assert after.strip() == "final"


def test_context_formatting_labels_sources(make_doc):
    internal = make_doc("body", "sop.pdf", page=2)
    web_doc = make_doc("w", "https://x", source_type="web", url="https://x")
    text = rag._format_context([internal, web_doc])
    assert "[INTERNAL 1] sop.pdf | page 3" in text
    assert "[WEB 2]" in text and "https://x" in text


def test_sources_are_deduplicated(make_doc):
    d1 = make_doc("a", "sop.pdf", page=0)
    d2 = make_doc("b", "sop.pdf", page=0)
    d3 = make_doc("c", "sop.pdf", page=1)
    out = rag._sources([d1, d2, d3])
    assert [s["page"] for s in out] == [1, 2]


def test_prefetched_retrieval_is_reused(settings, fake_pool, kb):
    pool = fake_pool()
    out = run("payments cpu")
    assert out["route"] == "Knowledge Base"
    assert kb["queries"] == ["payments cpu"]
    assert pool.calls.count("SupportDecision") == 1 and pool.calls.count("UsefulnessDecision") == 1


def test_verification_checks_run_concurrently(settings, fake_pool, kb):
    import threading

    barrier = threading.Barrier(2, timeout=5)

    def support(m):
        barrier.wait()
        return SupportDecision(status="fully_supported")

    def usefulness(m):
        barrier.wait()
        return UsefulnessDecision(status="useful", reason="")

    fake_pool(support=support, usefulness=usefulness)
    assert run("payments cpu")["support_status"] == "fully_supported"
