import json

import pytest
from fastapi.testclient import TestClient

import app as app_module

DONE = {
    "type": "done",
    "answer": "Scale replicas.",
    "route": "Knowledge Base",
    "used_web_search": False,
    "support_status": "fully_supported",
    "usefulness": "useful",
    "sources": [{"type": "internal", "title": "runbook.md", "source": "runbook.md", "url": None, "page": None}],
    "trace": ["Question received"],
    "thread_id": "thread-api",
    "memory_turns": 1,
    "model": "groq:openai/gpt-oss-120b",
}


@pytest.fixture
def client(settings, fake_pool):
    fake_pool()
    with TestClient(app_module.app) as c:
        yield c


def sse_events(text):
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


def test_root_and_health(client):
    assert client.get("/").json()["status"] == "ok"
    h = client.get("/api/health").json()
    assert h["status"] == "ok"
    assert set(h) >= {"warm", "knowledge_base", "llm", "embeddings", "web_search"}


@pytest.mark.parametrize(
    "payload",
    [
        {"question": "", "thread_id": "thread-1"},
        {"question": "x" * 4001, "thread_id": "thread-1"},
        {"question": "hello", "thread_id": "ab"},
        {"question": "hello", "thread_id": "bad id with spaces"},
        {"question": "hello"},
    ],
)
def test_chat_validation(client, payload):
    assert client.post("/api/chat", json=payload).status_code == 422
    assert client.post("/api/chat/stream", json=payload).status_code == 422


def test_whitespace_question_rejected(client):
    assert client.post("/api/chat/stream", json={"question": "   ", "thread_id": "thread-1"}).status_code == 422


def test_chat_returns_answer_and_writes_audit(client, monkeypatch):
    payload = {k: v for k, v in DONE.items() if k != "type"}
    monkeypatch.setattr(app_module, "run_self_rag", lambda q, t: {**payload, "thread_id": t})
    r = client.post("/api/chat", json={"question": "cpu high", "thread_id": "chat-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "Scale replicas." and body["thread_id"] == "chat-1"
    audit = client.get("/api/audits?limit=1").json()[0]
    assert audit["question"] == "cpu high"
    assert audit["model"] == "groq:openai/gpt-oss-120b"
    assert audit["sources"][0]["title"] == "runbook.md"


def test_chat_failure_is_503(client, monkeypatch):
    def boom(q, t):
        raise RuntimeError("All LLM providers failed")

    monkeypatch.setattr(app_module, "run_self_rag", boom)
    r = client.post("/api/chat", json={"question": "cpu", "thread_id": "chat-1"})
    assert r.status_code == 503
    assert "temporarily unavailable" in r.json()["detail"]


def test_stream_emits_sse_and_records_latency(client, monkeypatch):
    def fake_stream(q, t):
        yield {"type": "status", "text": "Searching the knowledge base"}
        yield {"type": "reset"}
        yield {"type": "token", "text": "Scale "}
        yield {"type": "token", "text": "replicas."}
        yield {**DONE, "thread_id": t}

    monkeypatch.setattr(app_module, "stream_self_rag", fake_stream)
    r = client.post("/api/chat/stream", json={"question": "cpu", "thread_id": "stream-1"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"].startswith("no-cache")
    assert r.headers["x-accel-buffering"] == "no"
    assert r.text.startswith(": open")
    events = sse_events(r.text)
    assert [e["type"] for e in events] == ["status", "status", "reset", "token", "token", "done"]
    assert events[-1]["latency_ms"] >= 0
    stats = client.get("/api/stats").json()
    assert stats["total"] == 1 and stats["grounded_rate"] == 100.0
    assert stats["routes"] == {"Knowledge Base": 1}


def test_stream_turns_exceptions_into_error_event(client, monkeypatch):
    def broken(q, t):
        yield {"type": "status", "text": "Planning"}
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(app_module, "stream_self_rag", broken)
    r = client.post("/api/chat/stream", json={"question": "cpu", "thread_id": "stream-2"})
    events = sse_events(r.text)
    assert events[-1]["type"] == "error"
    assert "temporarily unavailable" in events[-1]["message"]
    assert client.get("/api/stats").json()["total"] == 0


def test_stream_end_to_end_with_real_graph(client, monkeypatch, make_doc):
    import src.self_rag as rag

    monkeypatch.setattr(rag, "search", lambda q: [make_doc("Scale replicas when CPU > 85%.")])
    r = client.post("/api/chat/stream", json={"question": "payments cpu", "thread_id": "stream-e2e"})
    events = sse_events(r.text)
    assert events[-1]["type"] == "done"
    assert events[-1]["route"] == "Knowledge Base"
    assert "".join(e["text"] for e in events if e["type"] == "token").strip() == "Fake answer."


def test_upload_rejects_unsupported_type(client):
    r = client.post("/api/upload", files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 400


def test_upload_enforces_size_limit(make_settings, fake_pool, monkeypatch):
    make_settings(max_upload_mb=1)
    fake_pool()
    monkeypatch.setattr(app_module, "ingest_file", lambda p: 1)
    with TestClient(app_module.app) as c:
        r = c.post("/api/upload", files={"file": ("big.txt", b"a" * (1024 * 1024 + 10), "text/plain")})
    assert r.status_code == 413
    assert not (app_module.UPLOADS / "big.txt").exists()


def test_upload_indexes_file_and_strips_path(client, monkeypatch):
    seen = []
    monkeypatch.setattr(app_module, "ingest_file", lambda p: seen.append(p) or 3)
    r = client.post("/api/upload", files={"file": ("../../etc/runbook-test.md", b"# Runbook\nRestart", "text/markdown")})
    try:
        assert r.status_code == 200
        assert r.json() == {"filename": "runbook-test.md", "chunks_indexed": 3, "namespace": "incident-runbooks"}
        assert seen[0].parent == app_module.UPLOADS
    finally:
        (app_module.UPLOADS / "runbook-test.md").unlink(missing_ok=True)


def test_upload_reports_unreadable_file(client, monkeypatch):
    def bad(p):
        raise ValueError("No readable text was found in this file.")

    monkeypatch.setattr(app_module, "ingest_file", bad)
    r = client.post("/api/upload", files={"file": ("blank-test.txt", b" ", "text/plain")})
    (app_module.UPLOADS / "blank-test.txt").unlink(missing_ok=True)
    assert r.status_code == 400
    assert "No readable text" in r.json()["detail"]


def test_delete_thread_clears_memory(client, monkeypatch, make_doc):
    import src.self_rag as rag

    monkeypatch.setattr(rag, "search", lambda q: [make_doc("x")])
    rag.run_self_rag("first question", "thread-del")
    assert rag.run_self_rag("second", "thread-del")["memory_turns"] == 2
    assert client.delete("/api/threads/thread-del").json() == {"deleted": "thread-del"}
    assert rag.run_self_rag("again", "thread-del")["memory_turns"] == 1


def test_audit_limit_is_clamped(client):
    assert client.get("/api/audits?limit=0").status_code == 200
    assert client.get("/api/audits?limit=5000").status_code == 200


@pytest.mark.parametrize(
    "origin,allowed",
    [
        ("http://localhost:3000", True),
        ("https://aegis-copilot.vercel.app", True),
        ("https://aegis-copilot-git-main-team.vercel.app", True),
        ("https://evil.example.com", False),
    ],
)
def test_cors(client, origin, allowed):
    r = client.options("/api/chat/stream", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
    assert (r.headers.get("access-control-allow-origin") == origin) is allowed
