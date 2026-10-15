from pathlib import Path

import src.config as cfg


def test_placeholder_keys_are_treated_as_missing(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "YOUR_OPENAI_KEY")
    monkeypatch.setenv("GROQ_API_KEY", "  gsk_real  ")
    assert cfg._secret("OPENAI_API_KEY") == ""
    assert cfg._secret("GROQ_API_KEY") == "gsk_real"


def test_secret_falls_back_to_alternate_name(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("ANTORPIC_API_KEY", "sk-ant-123")
    assert cfg._secret("ANTHROPIC_API_KEY", "ANTORPIC_API_KEY") == "sk-ant-123"


def test_list_and_bool_parsing(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDERS", " Groq , anthropic,, ")
    monkeypatch.setenv("AUTO_INGEST", "Yes")
    assert cfg._list("LLM_PROVIDERS", "") == ["groq", "anthropic"]
    assert cfg._bool("AUTO_INGEST") is True
    monkeypatch.setenv("AUTO_INGEST", "off")
    assert cfg._bool("AUTO_INGEST") is False


def test_relative_paths_resolve_inside_backend(settings, tmp_path):
    absolute = tmp_path / "abs.sqlite"
    s = cfg.Settings(database_path="data/x.db", memory_path=str(absolute))
    assert s.database_file == cfg.ROOT / "data" / "x.db"
    assert s.memory_file == Path(absolute)


def test_defaults_are_production_ready():
    s = cfg.Settings()
    assert s.embedding_providers == ["pinecone"] or "pinecone" in s.embedding_providers
    assert s.rerank_model == "bge-reranker-v2-m3"
    assert s.top_k <= s.rerank_candidates
    assert "groq" in s.llm_providers
