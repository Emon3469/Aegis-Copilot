import json
import logging
import os
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from src.config import get_settings
from src.db import audit_stats, init_db, latest_audits, save_audit
from src.ingestion import SUPPORTED, ingest_directory, ingest_file, namespace
from src.llm import get_pool
from src.models import ChatRequest, ChatResponse, UploadResponse
from src.self_rag import get_graph, run_self_rag, stream_self_rag
from src.vectorstore import get_backends, get_index

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("aegis")

ROOT = Path(__file__).resolve().parent
UPLOADS = ROOT / "uploads"
DOCUMENTS = ROOT / "documents"

state = {"knowledge_base": "starting", "warm": False}


def _warm_up() -> None:
    try:
        get_pool().probe()
        get_graph()
        for backend in get_backends():
            get_index(backend)
        if get_settings().auto_ingest and get_backends():
            written = ingest_directory(DOCUMENTS, only_empty=True)
            if written:
                log.info("seeded knowledge base: %s", written)
        state["knowledge_base"] = "ready" if get_backends() else "not_configured"
    except Exception as exc:
        state["knowledge_base"] = "degraded"
        log.warning("warm-up issue: %s", exc)
    finally:
        state["warm"] = True


@asynccontextmanager
async def lifespan(_: FastAPI):
    UPLOADS.mkdir(exist_ok=True)
    init_db()
    threading.Thread(target=_warm_up, daemon=True).start()
    yield


settings = get_settings()

app = FastAPI(
    title="Aegis Copilot API",
    version="2.1.0",
    description="Self-RAG copilot for cloud operations, production troubleshooting and incident-response runbooks.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"service": "Aegis Copilot API", "status": "ok", "docs": "/docs"}


@app.get("/api/health")
def health():
    s = get_settings()
    return {
        "status": "ok",
        "service": "aegis-copilot",
        "warm": state["warm"],
        "knowledge_base": state["knowledge_base"],
        "llm": get_pool().status(),
        "embeddings": [{"provider": b.name, "model": b.model, "index": b.index_name} for b in get_backends()],
        "web_search": bool(s.tavily_api_key),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest):
    question, thread_id = payload.question.strip(), payload.thread_id.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Question is empty")
    started = time.perf_counter()
    try:
        result = await run_in_threadpool(run_self_rag, question, thread_id)
    except Exception as exc:
        log.exception("chat failed")
        raise HTTPException(status_code=503, detail=f"The assistant is temporarily unavailable: {exc}")
    latency = int((time.perf_counter() - started) * 1000)
    try:
        await run_in_threadpool(save_audit, question, result, latency)
    except Exception:
        log.exception("audit write failed")
    return ChatResponse(**result)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/api/chat/stream")
def chat_stream(payload: ChatRequest):
    question, thread_id = payload.question.strip(), payload.thread_id.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Question is empty")

    def events():
        started = time.perf_counter()
        yield ": open\n\n"
        yield _sse({"type": "status", "text": "Thinking"})
        try:
            for event in stream_self_rag(question, thread_id):
                if event.get("type") == "done":
                    latency = int((time.perf_counter() - started) * 1000)
                    event["latency_ms"] = latency
                    try:
                        save_audit(question, event, latency)
                    except Exception:
                        log.exception("audit write failed")
                yield _sse(event)
        except Exception as exc:
            log.exception("stream failed")
            yield _sse({"type": "error", "message": "The assistant is temporarily unavailable. Please try again in a moment.", "detail": str(exc)[:300]})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/threads/{thread_id}")
def delete_thread(thread_id: str):
    try:
        get_graph().checkpointer.delete_thread(thread_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"deleted": thread_id}


@app.post("/api/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)):
    name = Path(file.filename or "").name
    suffix = Path(name).suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(status_code=400, detail="Supported file types: PDF, TXT, MD, DOCX")
    limit = get_settings().max_upload_mb * 1024 * 1024
    UPLOADS.mkdir(exist_ok=True)
    target = UPLOADS / f"{uuid.uuid4().hex[:8]}-{name}"
    size = 0
    with target.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                f.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"File is larger than {get_settings().max_upload_mb} MB")
            f.write(chunk)
    final = UPLOADS / name
    shutil.move(str(target), str(final))
    try:
        count = await run_in_threadpool(ingest_file, final)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("ingestion failed")
        raise HTTPException(status_code=500, detail=f"Indexing failed: {exc}")
    return UploadResponse(filename=name, chunks_indexed=count, namespace=namespace())


@app.get("/api/audits")
def audits(limit: int = 20):
    return latest_audits(min(max(limit, 1), 100))


@app.get("/api/stats")
def stats():
    return audit_stats()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
