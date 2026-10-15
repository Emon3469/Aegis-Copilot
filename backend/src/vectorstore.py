import logging
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Dict, List, Optional

from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from pinecone import Pinecone, ServerlessSpec

from src.config import get_settings

log = logging.getLogger("aegis.vectorstore")


@dataclass
class EmbeddingBackend:
    name: str
    model: str
    dimension: int
    embeddings: Embeddings

    @property
    def index_name(self) -> str:
        base = get_settings().pinecone_index_name.lower()
        return f"{base}-{self.name}"[:45]


def _openai_backend() -> Optional[EmbeddingBackend]:
    s = get_settings()
    if not s.openai_api_key:
        return None
    from langchain_openai import OpenAIEmbeddings

    return EmbeddingBackend(
        name="openai",
        model=s.embedding_model,
        dimension=s.embedding_dimension,
        embeddings=OpenAIEmbeddings(
            api_key=s.openai_api_key,
            model=s.embedding_model,
            dimensions=s.embedding_dimension,
            max_retries=1,
            request_timeout=20,
        ),
    )


def _pinecone_backend() -> Optional[EmbeddingBackend]:
    s = get_settings()
    if not s.pinecone_api_key:
        return None
    from langchain_pinecone import PineconeEmbeddings

    return EmbeddingBackend(
        name="pinecone",
        model=s.pinecone_embedding_model,
        dimension=s.pinecone_embedding_dimension,
        embeddings=PineconeEmbeddings(
            model=s.pinecone_embedding_model,
            pinecone_api_key=s.pinecone_api_key,
            dimension=s.pinecone_embedding_dimension,
        ),
    )


BACKENDS = {"openai": _openai_backend, "pinecone": _pinecone_backend}

_down: Dict[str, float] = {}
_lock = threading.Lock()


@lru_cache
def get_backends() -> List[EmbeddingBackend]:
    out = []
    for name in get_settings().embedding_providers:
        factory = BACKENDS.get(name)
        if not factory:
            continue
        try:
            backend = factory()
        except Exception as exc:
            log.warning("embedding backend %s unavailable: %s", name, exc)
            continue
        if backend:
            out.append(backend)
    return out


@lru_cache
def get_pinecone_client() -> Pinecone:
    s = get_settings()
    if not s.pinecone_api_key:
        raise RuntimeError("PINECONE_API_KEY is not configured")
    return Pinecone(api_key=s.pinecone_api_key)


def _get(obj, key, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    value = getattr(obj, key, None)
    if value is None:
        try:
            value = obj[key]
        except Exception:
            value = None
    return default if value is None else value


def _ensure_index(backend: EmbeddingBackend):
    s = get_settings()
    pc = get_pinecone_client()
    name = backend.index_name
    existing = {x.name for x in pc.list_indexes()}
    if name not in existing:
        pc.create_index(
            name=name,
            dimension=backend.dimension,
            metric="cosine",
            spec=ServerlessSpec(cloud=s.pinecone_cloud, region=s.pinecone_region),
        )
        for _ in range(60):
            if _get(_get(pc.describe_index(name), "status"), "ready", False):
                break
            time.sleep(1)
    else:
        dim = _get(pc.describe_index(name), "dimension")
        if dim and int(dim) != backend.dimension:
            raise RuntimeError(
                f"Pinecone index '{name}' has dimension {dim}, but {backend.model} produces {backend.dimension}. "
                "Set a different PINECONE_INDEX_NAME or recreate the index."
            )
    return pc.Index(name)


_indexes: Dict[str, object] = {}


def get_index(backend: EmbeddingBackend):
    index = _indexes.get(backend.name)
    if index is None:
        with _lock:
            index = _indexes.get(backend.name)
            if index is None:
                index = _ensure_index(backend)
                _indexes[backend.name] = index
    return index


@lru_cache(maxsize=8)
def _store(name: str):
    from langchain_pinecone import PineconeVectorStore

    backend = next(b for b in get_backends() if b.name == name)
    return PineconeVectorStore(
        index=get_index(backend),
        embedding=backend.embeddings,
        namespace=get_settings().pinecone_namespace,
    )


def _healthy(name: str) -> bool:
    return time.monotonic() >= _down.get(name, 0.0)


def _fail(name: str, exc: Exception) -> None:
    _down[name] = time.monotonic() + get_settings().provider_cooldown
    log.warning("embedding backend %s failed: %s", name, str(exc)[:300])


def vector_count(backend: EmbeddingBackend) -> int:
    stats = get_index(backend).describe_index_stats()
    ns = _get(_get(stats, "namespaces", {}), get_settings().pinecone_namespace)
    return int(_get(ns, "vector_count", 0))


def rerank(query: str, docs: List[Document], k: int) -> List[Document]:
    s = get_settings()
    if not s.rerank_model or not s.pinecone_api_key or len(docs) <= 1 or not _healthy("rerank"):
        return docs[:k]
    try:
        res = get_pinecone_client().inference.rerank(
            model=s.rerank_model,
            query=query,
            documents=[d.page_content for d in docs],
            top_n=min(k, len(docs)),
            return_documents=False,
        )
    except Exception as exc:
        _fail("rerank", exc)
        return docs[:k]
    out = []
    for item in res.data:
        doc = docs[int(_get(item, "index"))]
        doc.metadata = {**(doc.metadata or {}), "rerank_score": round(float(_get(item, "score", 0.0)), 4)}
        out.append(doc)
    return out


def search(query: str, k: Optional[int] = None) -> List[Document]:
    s = get_settings()
    k = k or s.top_k
    backends = get_backends()
    if not backends:
        raise RuntimeError("No embedding backend is configured. Set PINECONE_API_KEY or OPENAI_API_KEY.")
    fetch = max(k, s.rerank_candidates) if s.rerank_model else k
    ordered = [b for b in backends if _healthy(b.name)] or backends
    last: Optional[Exception] = None
    for backend in ordered:
        try:
            docs = _store(backend.name).similarity_search(query, k=fetch)
            if docs or backend is ordered[-1]:
                return rerank(query, docs, k)
        except Exception as exc:
            last = exc
            _fail(backend.name, exc)
    if last:
        raise last
    return []


def add_documents(chunks: List[Document], ids: List[str], only_empty: bool = False) -> Dict[str, int]:
    written: Dict[str, int] = {}
    errors = []
    for backend in get_backends():
        try:
            if only_empty and vector_count(backend) > 0:
                continue
            _store(backend.name).add_documents(chunks, ids=ids, batch_size=64, embedding_chunk_size=96)
            written[backend.name] = len(chunks)
        except Exception as exc:
            errors.append(f"{backend.name}: {exc}")
            _fail(backend.name, exc)
    if not written and errors and not only_empty:
        raise RuntimeError("Indexing failed on every embedding backend. " + " | ".join(errors))
    return written
