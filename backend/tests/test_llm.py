from types import SimpleNamespace

import pytest
from pydantic import BaseModel

import src.llm as llm
from src.llm import NoProviderAvailable, Provider, ProviderPool


class Answer(BaseModel):
    value: str


class StubModel:
    def __init__(self, reply="ok", error=None, chunks=None, fail_after=None, structured=None):
        self.reply, self.error, self.chunks, self.fail_after = reply, error, chunks, fail_after
        self.structured_value = structured
        self.calls = 0
        self.method = None

    def invoke(self, messages):
        self.calls += 1
        if self.error:
            raise self.error
        return SimpleNamespace(content=self.reply)

    def stream(self, messages):
        self.calls += 1
        if self.error and self.fail_after is None:
            raise self.error
        for i, c in enumerate(self.chunks or [self.reply]):
            if self.fail_after is not None and i == self.fail_after:
                raise self.error
            yield SimpleNamespace(content=c)

    def with_structured_output(self, schema, method=None, strict=None):
        self.method, self.strict = method, strict
        outer = self

        class Runner:
            def invoke(self, messages):
                outer.calls += 1
                if outer.error:
                    raise outer.error
                return outer.structured_value

        return Runner()


def pool(*models, names=None):
    names = names or [f"p{i}" for i in range(len(models))]
    return ProviderPool([Provider(name=n, model_name=f"m{i}", model=m) for i, (n, m) in enumerate(zip(names, models))])


def test_first_healthy_provider_answers(settings):
    a, b = StubModel("from a"), StubModel("from b")
    meta = {}
    assert pool(a, b).invoke([], meta) == "from a"
    assert meta["model"] == "p0:m0"
    assert b.calls == 0


def test_falls_back_and_puts_failed_provider_on_cooldown(settings):
    a = StubModel(error=RuntimeError("Error code: 401 invalid api key"))
    b = StubModel("from b")
    p = pool(a, b)
    assert p.invoke([]) == "from b"
    assert p.invoke([]) == "from b"
    assert a.calls == 1
    status = {s["provider"]: s for s in p.status()}
    assert status["p0"]["healthy"] is False and status["p0"]["cooldown_seconds"] > 600
    assert status["p1"]["healthy"] is True


def test_all_providers_failing_raises(settings):
    p = pool(StubModel(error=RuntimeError("401")), StubModel(error=RuntimeError("403 permission")))
    with pytest.raises(NoProviderAvailable):
        p.invoke([])


def test_no_providers_configured(settings):
    with pytest.raises(NoProviderAvailable):
        ProviderPool([]).invoke([])


def test_short_rate_limit_is_retried_on_same_provider(settings):
    a = StubModel(error=RuntimeError("Error code: 429 Rate limit reached. Please try again in 150ms."))
    p = pool(a)
    with pytest.raises(NoProviderAvailable):
        p.invoke([])
    assert a.calls == 2


@pytest.mark.parametrize(
    "message,low,high",
    [
        ("Error code: 429 rate limit. Please try again in 1.86s.", 1.8, 2.5),
        ("Error code: 429 rate limit. Please try again in 232.4ms.", 0.2, 0.6),
        ("Error code: 429 rate limit. Please try again in 1m30s.", 90, 91),
        ("Error code: 400 Your credit balance is too low", 1199, 1201),
        ("Error code: 404 model_not_found", 1199, 1201),
        ("Error code: 529 overloaded", 19, 21),
        ("Connection reset by peer", 14, 16),
        ("OutputParserException: Failed to parse QueryRewrite from completion", 0, 0),
        ("Error code: 400 tool_use_failed", 0, 0),
    ],
)
def test_cooldown_classification(settings, message, low, high):
    assert low <= llm._cooldown_for(RuntimeError(message)) <= high


def test_recovered_provider_is_reset(settings):
    a = StubModel(error=RuntimeError("timeout"))
    p = pool(a)
    with pytest.raises(NoProviderAvailable):
        p.invoke([])
    a.error = None
    p.providers[0].down_until = 0
    assert p.invoke([]) == "ok"
    assert p.providers[0].failures == 0


def test_stream_falls_back_before_first_token(settings):
    a = StubModel(error=RuntimeError("503"))
    b = StubModel(chunks=["Hel", "lo"])
    meta = {}
    assert "".join(pool(a, b).stream([], meta)) == "Hello"
    assert meta["model"] == "p1:m1"


def test_stream_skips_empty_chunks_and_rejects_empty_response(settings):
    a = StubModel(chunks=["", ""])
    b = StubModel(chunks=["", "real"])
    assert "".join(pool(a, b).stream([])) == "real"


def test_stream_failure_mid_answer_is_raised(settings):
    a = StubModel(chunks=["one", "two"], error=RuntimeError("boom"), fail_after=1)
    b = StubModel("never")
    out = []
    with pytest.raises(RuntimeError):
        for c in pool(a, b).stream([]):
            out.append(c)
    assert out == ["one"]
    assert b.calls == 0


def test_structured_uses_json_schema_for_groq_and_validates(settings):
    g = StubModel(structured={"value": "x"})
    p = pool(g, names=["groq"])
    out = p.structured(Answer, [])
    assert isinstance(out, Answer) and out.value == "x"
    assert g.method == "json_schema" and g.strict is True


def test_structured_none_triggers_fallback(settings):
    a = StubModel(structured=None)
    b = StubModel(structured=Answer(value="y"))
    assert pool(a, b, names=["openai", "anthropic"]).structured(Answer, []).value == "y"
    assert a.method is None


def test_probe_marks_unusable_providers_at_startup(settings):
    broke = StubModel(error=RuntimeError("Error code: 400 Your credit balance is too low"))
    ok = StubModel("OK")
    p = pool(broke, ok)
    p.probe()
    health = {s["provider"]: s["healthy"] for s in p.status()}
    assert health == {"p0": False, "p1": True}
    assert p.invoke([]) == "OK"
    assert broke.calls == 1


def test_text_extraction_handles_content_blocks():
    assert llm._text("plain") == "plain"
    assert llm._text([{"type": "text", "text": "a"}, {"type": "tool_use", "id": 1}, "b"]) == "ab"
    assert llm._text(None) == ""


def test_pool_builds_configured_providers_in_order(make_settings):
    make_settings(groq_api_key="gsk_x", anthropic_api_key="sk-ant-x", llm_providers=["anthropic", "groq"], groq_fallback_models=["openai/gpt-oss-20b"])
    labels = [p.label for p in llm.get_pool().providers]
    assert labels == ["anthropic:claude-haiku-5-5", "groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b"]


def test_pool_skips_providers_without_keys(make_settings):
    make_settings(groq_api_key="gsk_x")
    assert [p.name for p in llm.get_pool().providers] == ["groq", "groq"]


def test_reasoning_models_do_not_get_temperature(make_settings):
    make_settings(openai_api_key="sk-x")
    model = llm._build_openai("gpt-5-mini")
    assert model.temperature is None
    assert llm._build_openai("gpt-4.1-mini").temperature == 0


def test_malformed_output_falls_through_without_cooldown(settings):
    a = StubModel(error=RuntimeError("Failed to parse QueryRewrite from completion"), structured=None)
    b = StubModel(structured=Answer(value="ok"))
    p = pool(a, b)
    assert p.structured(Answer, []).value == "ok"
    assert p.status()[0]["healthy"] is True
