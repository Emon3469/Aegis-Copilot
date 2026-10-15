from functools import lru_cache
from pathlib import Path
import os
from typing import List
from pydantic import BaseModel
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / ".env")


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    return value.strip() if isinstance(value, str) else default


def _secret(*names: str) -> str:
    for name in names:
        value = _env(name)
        if value and not value.upper().startswith(("YOUR", "SK-XXX", "CHANGE")):
            return value
    return ""


def _list(name: str, default: str) -> List[str]:
    return [x.strip().lower() for x in _env(name, default).split(",") if x.strip()]


def _bool(name: str, default: str = "false") -> bool:
    return _env(name, default).lower() in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    openai_api_key: str = _secret("OPENAI_API_KEY")
    openai_model: str = _env("OPENAI_MODEL", "gpt-4.1-mini")
    anthropic_api_key: str = _secret("ANTHROPIC_API_KEY", "ANTORPIC_API_KEY")
    anthropic_model: str = _env("ANTHROPIC_MODEL", "claude-haiku-5-5")
    groq_api_key: str = _secret("GROQ_API_KEY")
    groq_model: str = _env("GROQ_MODEL", "openai/gpt-oss-120b")
    groq_fallback_models: List[str] = [m.strip() for m in _env("GROQ_FALLBACK_MODELS", "openai/gpt-oss-20b").split(",") if m.strip()]
    llm_providers: List[str] = _list("LLM_PROVIDERS", "openai,anthropic,groq")
    llm_timeout: float = float(_env("LLM_TIMEOUT", "30"))
    llm_max_tokens: int = int(_env("LLM_MAX_TOKENS", "2048"))
    provider_cooldown: int = int(_env("PROVIDER_COOLDOWN_SECONDS", "120"))

    embedding_providers: List[str] = _list("EMBEDDING_PROVIDERS", "pinecone")
    embedding_model: str = _env("EMBEDDING_MODEL", "text-embedding-3-large")
    embedding_dimension: int = int(_env("EMBEDDING_DIMENSION", "3072"))
    pinecone_embedding_model: str = _env("PINECONE_EMBEDDING_MODEL", "multilingual-e5-large")
    pinecone_embedding_dimension: int = int(_env("PINECONE_EMBEDDING_DIMENSION", "1024"))

    gemini_api_key: str = _secret("GEMINI_API_KEY", "GOOGLE_API_KEY")
    pinecone_api_key: str = _secret("PINECONE_API_KEY")
    pinecone_index_name: str = _env("PINECONE_INDEX_NAME", "aegis-copilot")
    pinecone_namespace: str = _env("PINECONE_NAMESPACE", "incident-runbooks")
    pinecone_cloud: str = _env("PINECONE_CLOUD", "aws")
    pinecone_region: str = _env("PINECONE_REGION", "us-east-1")

    tavily_api_key: str = _secret("TAVILY_API_KEY")
    tavily_search_depth: str = _env("TAVILY_SEARCH_DEPTH", "basic")

    rerank_model: str = _env("RERANK_MODEL", "bge-reranker-v2-m3")
    rerank_candidates: int = int(_env("RERANK_CANDIDATES", "12"))
    top_k: int = int(_env("TOP_K", "4"))
    max_support_retries: int = int(_env("MAX_SUPPORT_RETRIES", "1"))
    max_retrieval_rewrites: int = int(_env("MAX_RETRIEVAL_REWRITES", "1"))
    max_web_rewrites: int = int(_env("MAX_WEB_REWRITES", "1"))

    database_path: str = _env("DATABASE_PATH", "data/audit.db")
    memory_path: str = _env("MEMORY_PATH", "data/memory.sqlite")
    auto_ingest: bool = _bool("AUTO_INGEST", "true")
    max_upload_mb: int = int(_env("MAX_UPLOAD_MB", "15"))

    cors_origins: List[str] = [x.strip() for x in _env("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if x.strip()]
    cors_origin_regex: str = _env("CORS_ORIGIN_REGEX", r"https://.*\.vercel\.app")

    def _resolve(self, value: str) -> Path:
        p = Path(value)
        return p if p.is_absolute() else ROOT / p

    @property
    def database_file(self) -> Path:
        return self._resolve(self.database_path)

    @property
    def memory_file(self) -> Path:
        return self._resolve(self.memory_path)


@lru_cache
def get_settings() -> Settings:
    return Settings()
