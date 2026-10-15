from types import SimpleNamespace

import pytest

import src.vectorstore as vs
from src.vectorstore import EmbeddingBackend


class StubStore:
    def __init__(self, docs=None, error=None):
        self.docs, self.error, self.k, self.added = docs or [], error, None, []

    def similarity_search(self, query, k):
        self.k = k
        if self.error:
            raise self.error
        return list(self.docs[:k])

    def add_documents(self, chunks, ids, **kwargs):
        if self.error:
            raise self.error
        self.added.append((chunks, ids))


class StubInference:
    def __init__(self, order=None, error=None):
        self.order, self.error, self.calls = order, error, []

    def rerank(self, model, query, documents, top_n, return_documents):
        self.calls.append((model, query, len(documents), top_n))
        if self.error:
            raise self.error
        order = self.order or list(reversed(range(len(documents))))
        return SimpleNamespace(data=[{"index": i, "score": 1 - n / 10} for n, i in enumerate(order[:top_n])])


def backend(name):
    return EmbeddingBackend(name=name, model=f"{name}-model", dimension=8, embeddings=None)


@pytest.fixture
def wire(monkeypatch):
    def install(stores, inference=None):
        monkeypatch.setattr(vs, "get_backends", lambda: [backend(n) for n in stores])
        monkeypatch.setattr(vs, "_store", lambda name: stores[name])
        if inference is not None:
            monkeypatch.setattr(vs, "get_pinecone_client", lambda: SimpleNamespace(inference=inference))

    return install


def test_search_reranks_candidates(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk", top_k=2, rerank_candidates=5)
    docs = [make_doc(f"chunk {i}") for i in range(5)]
    store = StubStore(docs)
    inference = StubInference(order=[3, 0, 1])
    wire({"pinecone": store}, inference)

    out = vs.search("cpu high")
    assert store.k == 5
    assert [d.page_content for d in out] == ["chunk 3", "chunk 0"]
    assert out[0].metadata["rerank_score"] == 1.0
    assert inference.calls == [("bge-reranker-v2-m3", "cpu high", 5, 2)]


def test_rerank_failure_degrades_to_vector_order(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk", top_k=2)
    wire({"pinecone": StubStore([make_doc("a"), make_doc("b"), make_doc("c")])}, StubInference(error=RuntimeError("403")))
    assert [d.page_content for d in vs.search("q")] == ["a", "b"]
    assert not vs._healthy("rerank")
    assert [d.page_content for d in vs.search("q")] == ["a", "b"]


def test_rerank_disabled(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk", top_k=3, rerank_model="")
    store = StubStore([make_doc(str(i)) for i in range(9)])
    wire({"pinecone": store}, StubInference())
    assert len(vs.search("q")) == 3
    assert store.k == 3


def test_search_falls_back_to_next_backend(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk", rerank_model="", embedding_providers=["openai", "pinecone"])
    broken = StubStore(error=RuntimeError("401"))
    wire({"openai": broken, "pinecone": StubStore([make_doc("from pinecone")])})
    assert vs.search("q")[0].page_content == "from pinecone"
    assert not vs._healthy("openai")


def test_empty_primary_backend_uses_secondary(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk", rerank_model="")
    wire({"openai": StubStore([]), "pinecone": StubStore([make_doc("x")])})
    assert vs.search("q")[0].page_content == "x"


def test_search_raises_when_every_backend_fails(make_settings, wire):
    make_settings(pinecone_api_key="pk")
    wire({"pinecone": StubStore(error=RuntimeError("down"))})
    with pytest.raises(RuntimeError, match="down"):
        vs.search("q")


def test_search_without_backends(make_settings, monkeypatch):
    make_settings()
    monkeypatch.setattr(vs, "get_backends", lambda: [])
    with pytest.raises(RuntimeError, match="No embedding backend"):
        vs.search("q")


def test_add_documents_writes_every_backend_and_skips_non_empty(make_settings, wire, monkeypatch, make_doc):
    make_settings(pinecone_api_key="pk")
    a, b = StubStore(), StubStore()
    wire({"openai": a, "pinecone": b})
    monkeypatch.setattr(vs, "vector_count", lambda be: 5 if be.name == "openai" else 0)
    written = vs.add_documents([make_doc("x")], ["id-1"], only_empty=True)
    assert written == {"pinecone": 1}
    assert not a.added and b.added


def test_add_documents_reports_total_failure(make_settings, wire, make_doc):
    make_settings(pinecone_api_key="pk")
    wire({"pinecone": StubStore(error=RuntimeError("quota"))})
    with pytest.raises(RuntimeError, match="Indexing failed"):
        vs.add_documents([make_doc("x")], ["id"])


def test_get_helper_reads_dicts_objects_and_mappings():
    class Mapping:
        def __getitem__(self, key):
            return {"ready": True}[key]

    assert vs._get({"a": 1}, "a") == 1
    assert vs._get(SimpleNamespace(a=2), "a") == 2
    assert vs._get(Mapping(), "ready") is True
    assert vs._get(None, "x", "d") == "d"
    assert vs._get(SimpleNamespace(), "missing", 0) == 0


def test_index_name_is_provider_specific(make_settings):
    make_settings(pinecone_index_name="Aegis-Copilot")
    assert backend("pinecone").index_name == "aegis-copilot-pinecone"
    assert len(backend("x" * 80).index_name) <= 45


def test_backends_follow_configuration(make_settings):
    make_settings(pinecone_api_key="pk", embedding_providers=["openai", "pinecone"])
    names = [b.name for b in vs.get_backends()]
    assert names == ["pinecone"]
    b = vs.get_backends()[0]
    assert (b.model, b.dimension) == ("multilingual-e5-large", 1024)
