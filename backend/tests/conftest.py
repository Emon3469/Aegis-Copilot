from typing import Any, Callable, Dict, Iterator, List

import pytest
from langchain_core.documents import Document

import app as app_module
import src.config as cfg
import src.db as db
import src.ingestion as ingestion
import src.llm as llm
import src.self_rag as self_rag
import src.vectorstore as vectorstore
from src.self_rag import (
    QueryRewrite,
    RelevanceDecision,
    RetrieveDecision,
    SupportDecision,
    UsefulnessDecision,
)

MODULES = [cfg, llm, vectorstore, ingestion, self_rag, db, app_module]

REAL_SETTINGS = cfg.get_settings()


def pytest_configure(config):
    config.addinivalue_line("markers", "live: calls real external services (Pinecone, Groq, Tavily)")


@pytest.fixture
def make_settings(monkeypatch, tmp_path):
    def build(**overrides: Any) -> cfg.Settings:
        base = {
            "openai_api_key": "",
            "anthropic_api_key": "",
            "groq_api_key": "",
            "gemini_api_key": "",
            "pinecone_api_key": "",
            "tavily_api_key": "",
            "database_path": str(tmp_path / "audit.db"),
            "memory_path": str(tmp_path / "memory.sqlite"),
            "auto_ingest": False,
            "provider_cooldown": 120,
        }
        base.update(overrides)
        s = cfg.Settings(**base)
        for module in MODULES:
            if hasattr(module, "get_settings"):
                monkeypatch.setattr(module, "get_settings", lambda s=s: s)
        return s

    return build


@pytest.fixture
def settings(make_settings):
    return make_settings()


CACHED = [llm.get_pool, vectorstore.get_backends, vectorstore._store]


def _clear_caches():
    for fn in CACHED:
        fn.cache_clear()
    vectorstore._down.clear()
    vectorstore._indexes.clear()


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    _clear_caches()
    monkeypatch.setattr(self_rag, "_graph", None)
    yield
    _clear_caches()


class FakePool:
    def __init__(self, answers: List[str] | None = None, **structured: Callable[[List[Any]], Any]):
        self.answers = list(answers or ["Fake answer."])
        self.calls: List[str] = []
        self.handlers: Dict[type, Callable[[List[Any]], Any]] = {
            QueryRewrite: lambda m: QueryRewrite(query="rewritten query"),
            RetrieveDecision: lambda m: RetrieveDecision(should_retrieve=True),
            RelevanceDecision: lambda m: RelevanceDecision(relevant=[1]),
            SupportDecision: lambda m: SupportDecision(status="fully_supported", evidence=["e"]),
            UsefulnessDecision: lambda m: UsefulnessDecision(status="useful", reason="ok"),
        }
        names = {
            "rewrite": QueryRewrite,
            "decide": RetrieveDecision,
            "relevance": RelevanceDecision,
            "support": SupportDecision,
            "usefulness": UsefulnessDecision,
        }
        for key, fn in structured.items():
            self.handlers[names[key]] = fn

    def structured(self, schema, messages):
        self.calls.append(schema.__name__)
        return self.handlers[schema](messages)

    def _next(self) -> str:
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

    def invoke(self, messages, meta=None):
        self.calls.append("invoke")
        if meta is not None:
            meta["model"] = "fake:model"
        return self._next()

    def stream(self, messages, meta=None) -> Iterator[str]:
        self.calls.append("stream")
        if meta is not None:
            meta["model"] = "fake:model"
        for word in self._next().split(" "):
            yield word + " "


@pytest.fixture
def fake_pool(monkeypatch):
    def install(*args, **kwargs) -> FakePool:
        pool = FakePool(*args, **kwargs)
        monkeypatch.setattr(self_rag, "get_pool", lambda: pool)
        return pool

    return install


def doc(text: str, source: str = "runbook.md", **meta: Any) -> Document:
    return Document(page_content=text, metadata={"source": source, "title": source, **meta})


@pytest.fixture
def make_doc():
    return doc
