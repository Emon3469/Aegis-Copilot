import json
import time
import uuid
from pathlib import Path

import pytest

import src.self_rag as rag
import src.vectorstore as vs
from src.ingestion import ingest_file
from src.llm import get_pool
from src.self_rag import RetrieveDecision

from .conftest import REAL_SETTINGS

pytestmark = pytest.mark.live

ROOT = Path(__file__).resolve().parent.parent
CORPUS = sorted((ROOT / "documents").glob("*.md")) + sorted((ROOT / "uploads").glob("*.pdf"))
QUERIES = json.loads((ROOT / "evals" / "retrieval_queries.json").read_text(encoding="utf-8"))
CORPUS_QUERIES = [q for q in QUERIES if "DSwithBappy" not in q["q"] and "Bappy" not in json.dumps(q["a"])]

needs_pinecone = pytest.mark.skipif(not REAL_SETTINGS.pinecone_api_key, reason="PINECONE_API_KEY not set")
needs_llm = pytest.mark.skipif(not (REAL_SETTINGS.groq_api_key or REAL_SETTINGS.anthropic_api_key or REAL_SETTINGS.openai_api_key), reason="no LLM key")


def live_settings(make_settings, **extra):
    data = REAL_SETTINGS.model_dump()
    data.pop("database_path"), data.pop("memory_path")
    return make_settings(**{**data, **extra})


def wait_for_count(backend, expected, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if vs.vector_count(backend) >= expected:
            return
        time.sleep(2)
    raise AssertionError("vectors did not become queryable in time")


@pytest.fixture(scope="module")
def namespace():
    return f"test-{uuid.uuid4().hex[:10]}"


@pytest.fixture
def temp_kb(make_settings, namespace):
    s = live_settings(make_settings, pinecone_namespace=namespace)
    yield s
    for backend in vs.get_backends():
        try:
            vs.get_index(backend).delete(delete_all=True, namespace=namespace)
        except Exception:
            pass


@needs_pinecone
def test_hosted_embeddings_shape_and_semantics(make_settings):
    live_settings(make_settings)
    backend = vs.get_backends()[0]
    e = backend.embeddings
    docs = e.embed_documents(["Payments CPU above 85 percent", "Annual leave policy for employees"])
    q = e.embed_query("the payments service is using too much processor")
    assert len(q) == backend.dimension == 1024

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b)) / ((sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5))

    assert cos(q, docs[0]) > cos(q, docs[1])


@needs_pinecone
def test_bangla_query_matches_english_document(make_settings):
    live_settings(make_settings)
    e = vs.get_backends()[0].embeddings
    docs = e.embed_documents(["Full-time employees receive 25 paid leave days per calendar year.", "Scale replicas when CPU is high."])
    q = e.embed_query("কর্মীরা বছরে কত দিন সবেতন ছুটি পায়?")
    sims = [sum(a * b for a, b in zip(q, d)) for d in docs]
    assert sims[0] > sims[1]


@needs_pinecone
def test_index_upsert_search_and_rerank_end_to_end(temp_kb):
    total = sum(ingest_file(p) for p in CORPUS)
    backend = vs.get_backends()[0]
    wait_for_count(backend, total)

    hits1 = hits4 = 0
    misses = []
    for item in CORPUS_QUERIES:
        docs = vs.search(item["q"])
        assert len(docs) == temp_kb.top_k
        assert all("rerank_score" in d.metadata for d in docs)
        assert [d.metadata["rerank_score"] for d in docs] == sorted((d.metadata["rerank_score"] for d in docs), reverse=True)
        found = [any(" ".join(a.split()).lower() in " ".join(d.page_content.split()).lower() for a in item["a"]) for d in docs]
        hits1 += found[0]
        hits4 += any(found)
        if not any(found):
            misses.append(item["q"])
    n = len(CORPUS_QUERIES)
    print(f"\nlive retrieval over {n} queries: hit@1={hits1 / n:.3f} hit@4={hits4 / n:.3f} misses={misses}")
    assert hits4 / n >= 0.9
    assert hits1 / n >= 0.8


@needs_pinecone
def test_reranker_improves_ranking(make_settings, make_doc):
    live_settings(make_settings)
    docs = [
        make_doc("NovaCore offers employees an annual learning budget for courses and books."),
        make_doc("The office kitchen is cleaned every Friday."),
        make_doc("Engineering employees receive an annual learning budget of $1,500. AI and Data employees receive $2,000."),
    ]
    out = vs.rerank("How much learning budget do AI and Data employees get?", docs, 2)
    assert "$2,000" in out[0].page_content
    assert out[0].metadata["rerank_score"] > out[1].metadata["rerank_score"]


@needs_llm
def test_llm_pool_live_invoke_stream_and_structured(make_settings):
    live_settings(make_settings)
    pool = get_pool()
    meta = {}
    answer = pool.invoke([("human", "Reply with exactly the word: pong")], meta)
    assert "pong" in answer.lower()
    assert meta["model"]
    chunks = list(pool.stream([("human", "Count from 1 to 5 separated by spaces.")]))
    assert len(chunks) >= 1 and "5" in "".join(chunks)
    decision = pool.structured(RetrieveDecision, [("system", "Return should_retrieve=false for greetings."), ("human", "hello!")])
    assert decision.should_retrieve is False


@pytest.mark.skipif(not REAL_SETTINGS.tavily_api_key, reason="TAVILY_API_KEY not set")
def test_web_search_live(make_settings):
    live_settings(make_settings)
    rag._tavily = None
    out = rag.web_search({"question": "Kubernetes latest release", "web_query": "Kubernetes latest stable release"})
    assert out["docs"] and all(d.metadata["url"].startswith("http") for d in out["docs"])


@needs_pinecone
@needs_llm
def test_full_self_rag_pipeline_live(temp_kb):
    for p in CORPUS:
        ingest_file(p)
    wait_for_count(vs.get_backends()[0], 10)

    out = rag.run_self_rag("What does error code ERR_CONN_8421 mean?", f"live-{uuid.uuid4().hex[:6]}")
    assert out["route"] == "Knowledge Base", out["trace"]
    assert "connection" in out["answer"].lower() and "pool" in out["answer"].lower()
    assert any("novacore" in s["title"].lower() for s in out["sources"])

    thread = f"live-{uuid.uuid4().hex[:6]}"
    events = list(rag.stream_self_rag("Payments CPU has been above 85% for 10 minutes. What should I check first?", thread))
    done = events[-1]
    assert done["type"] == "done" and done["route"] == "Knowledge Base"
    assert sum(1 for e in events if e["type"] == "token") > 5
    follow = rag.run_self_rag("And if it started right after a deployment?", thread)
    assert follow["memory_turns"] == 2
    assert "roll" in follow["answer"].lower()
