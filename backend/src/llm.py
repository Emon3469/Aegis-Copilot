import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Dict, Iterator, List, Optional, Type, TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel

from src.config import get_settings

log = logging.getLogger("aegis.llm")

T = TypeVar("T", bound=BaseModel)

MAX_WAIT_SECONDS = 6.0


class NoProviderAvailable(RuntimeError):
    pass


def _is_reasoning_model(name: str) -> bool:
    return name.lower().startswith(("o1", "o3", "o4", "gpt-5"))


def _build_openai(model: str) -> Optional[BaseChatModel]:
    s = get_settings()
    if not s.openai_api_key:
        return None
    from langchain_openai import ChatOpenAI

    kwargs: Dict[str, Any] = {
        "api_key": s.openai_api_key,
        "model": model,
        "request_timeout": s.llm_timeout,
        "max_retries": 0,
    }
    if _is_reasoning_model(model):
        kwargs["reasoning_effort"] = "low"
    else:
        kwargs["temperature"] = 0
    return ChatOpenAI(**kwargs)


def _build_anthropic(model: str) -> Optional[BaseChatModel]:
    s = get_settings()
    if not s.anthropic_api_key:
        return None
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        api_key=s.anthropic_api_key,
        model=model,
        temperature=0,
        max_tokens=s.llm_max_tokens,
        default_request_timeout=s.llm_timeout,
        max_retries=0,
    )


def _build_groq(model: str) -> Optional[BaseChatModel]:
    s = get_settings()
    if not s.groq_api_key:
        return None
    from langchain_groq import ChatGroq

    kwargs: Dict[str, Any] = {
        "api_key": s.groq_api_key,
        "model": model,
        "temperature": 0,
        "request_timeout": s.llm_timeout,
        "max_retries": 0,
    }
    if "gpt-oss" in model:
        kwargs["reasoning_effort"] = "low"
    return ChatGroq(**kwargs)


BUILDERS: Dict[str, Callable[[str], Optional[BaseChatModel]]] = {
    "openai": _build_openai,
    "anthropic": _build_anthropic,
    "groq": _build_groq,
}

STRUCTURED_OPTIONS: Dict[str, Dict[str, Any]] = {"groq": {"method": "json_schema", "strict": True}}


@dataclass
class Provider:
    name: str
    model_name: str
    model: BaseChatModel
    down_until: float = 0.0
    failures: int = 0
    structured: Dict[type, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.name}:{self.model_name}"

    def wait_time(self) -> float:
        return max(0.0, self.down_until - time.monotonic())


_HARD_FAIL = (
    "401", "403", "authentication", "permission", "invalid api key", "invalid x-api-key",
    "credit balance", "billing", "insufficient_quota", "not_found", "404", "does not exist", "decommissioned",
)
_RETRY_IN = re.compile(r"try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)", re.I)


_MALFORMED = ("outputparserexception", "validationerror", "failed to parse", "empty structured response", "tool_use_failed", "json_validate_failed")


def _cooldown_for(exc: Exception) -> float:
    base = get_settings().provider_cooldown
    text = f"{type(exc).__name__} {exc}".lower()
    if any(k in text for k in _MALFORMED):
        return 0.0
    if any(k in text for k in _HARD_FAIL):
        return base * 10
    if "429" in text or "rate limit" in text or "overloaded" in text or "529" in text:
        m = _RETRY_IN.search(text)
        if m:
            minutes = int(m.group(1) or 0)
            value = float(m.group(2))
            seconds = minutes * 60 + (value / 1000 if m.group(3).lower() == "ms" else value)
            return min(seconds + 0.25, base)
        return min(20.0, base)
    return min(15.0, base)


class ProviderPool:
    def __init__(self, providers: List[Provider]):
        self.providers = providers
        self._lock = threading.Lock()

    def _ordered(self) -> List[Provider]:
        ready = [p for p in self.providers if p.wait_time() == 0]
        waiting = sorted((p for p in self.providers if p.wait_time() > 0), key=lambda p: p.down_until)
        return ready + waiting

    def _mark_failed(self, provider: Provider, exc: Exception) -> None:
        with self._lock:
            provider.failures += 1
            provider.down_until = time.monotonic() + _cooldown_for(exc)
        log.warning("provider %s failed: %s", provider.label, str(exc)[:300])

    def _mark_ok(self, provider: Provider) -> None:
        if provider.failures:
            with self._lock:
                provider.failures = 0
                provider.down_until = 0.0

    def _candidates(self) -> Iterator[Provider]:
        if not self.providers:
            raise NoProviderAvailable("No LLM provider is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GROQ_API_KEY.")
        tried = set()
        for _ in range(2):
            for provider in self._ordered():
                if provider.label in tried and provider.wait_time() == 0 and provider.failures == 0:
                    continue
                wait = provider.wait_time()
                if wait > MAX_WAIT_SECONDS:
                    continue
                if wait:
                    time.sleep(wait)
                tried.add(provider.label)
                yield provider

    def _run(self, call: Callable[[Provider], Any]) -> Any:
        last: Optional[Exception] = None
        for provider in self._candidates():
            try:
                result = call(provider)
                self._mark_ok(provider)
                return result
            except Exception as exc:
                last = exc
                self._mark_failed(provider, exc)
        raise NoProviderAvailable(f"All LLM providers failed. Last error: {last}")

    def invoke(self, messages: List[Any], meta: Optional[dict] = None) -> str:
        def call(p: Provider) -> str:
            out = _text(p.model.invoke(messages).content)
            if meta is not None:
                meta["model"] = p.label
            return out

        return self._run(call)

    def structured(self, schema: Type[T], messages: List[Any]) -> T:
        def call(p: Provider) -> T:
            runnable = p.structured.get(schema)
            if runnable is None:
                runnable = p.model.with_structured_output(schema, **STRUCTURED_OPTIONS.get(p.name, {}))
                p.structured[schema] = runnable
            out = runnable.invoke(messages)
            if out is None:
                raise ValueError("empty structured response")
            return out if isinstance(out, schema) else schema.model_validate(out)

        return self._run(call)

    def stream(self, messages: List[Any], meta: Optional[dict] = None) -> Iterator[str]:
        last: Optional[Exception] = None
        for provider in self._candidates():
            started = False
            try:
                for chunk in provider.model.stream(messages):
                    piece = _text(chunk.content)
                    if not piece:
                        continue
                    if not started:
                        started = True
                        if meta is not None:
                            meta["model"] = provider.label
                    yield piece
                if not started:
                    raise ValueError("empty response")
                self._mark_ok(provider)
                return
            except Exception as exc:
                self._mark_failed(provider, exc)
                if started:
                    raise
                last = exc
        raise NoProviderAvailable(f"All LLM providers failed. Last error: {last}")

    def probe(self) -> None:
        def check(p: Provider) -> None:
            try:
                p.model.invoke([("human", "Reply with OK.")])
                self._mark_ok(p)
            except Exception as exc:
                self._mark_failed(p, exc)

        if self.providers:
            with ThreadPoolExecutor(max_workers=len(self.providers)) as ex:
                list(ex.map(check, self.providers))

    def status(self) -> List[dict]:
        return [
            {"provider": p.name, "model": p.model_name, "healthy": p.wait_time() == 0, "cooldown_seconds": round(p.wait_time())}
            for p in self.providers
        ]


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in (None, "text"):
                parts.append(block.get("text", ""))
        return "".join(parts)
    return ""


def _models_for(name: str) -> List[str]:
    s = get_settings()
    if name == "openai":
        return [s.openai_model]
    if name == "anthropic":
        return [s.anthropic_model]
    if name == "groq":
        return [s.groq_model, *[m for m in s.groq_fallback_models if m != s.groq_model]]
    return []


@lru_cache
def get_pool() -> ProviderPool:
    providers: List[Provider] = []
    for name in get_settings().llm_providers:
        builder = BUILDERS.get(name)
        if not builder:
            continue
        for model_name in _models_for(name):
            try:
                model = builder(model_name)
            except Exception as exc:
                log.warning("could not initialise %s:%s: %s", name, model_name, exc)
                continue
            if model is not None:
                providers.append(Provider(name=name, model_name=model_name, model=model))
    return ProviderPool(providers)
