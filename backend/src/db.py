import json
import sqlite3
from datetime import datetime, timezone

from src.config import get_settings


def _connect() -> sqlite3.Connection:
    return sqlite3.connect(get_settings().database_file, timeout=10)


def init_db() -> None:
    path = get_settings().database_file
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS rag_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            thread_id TEXT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            route TEXT,
            model TEXT,
            used_web INTEGER DEFAULT 0,
            support_status TEXT,
            usefulness TEXT,
            latency_ms INTEGER,
            trace_json TEXT,
            sources_json TEXT
        )
        """)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(rag_audit)")}
        for name, kind in (("thread_id", "TEXT"), ("model", "TEXT"), ("latency_ms", "INTEGER")):
            if name not in cols:
                conn.execute(f"ALTER TABLE rag_audit ADD COLUMN {name} {kind}")


def save_audit(question: str, result: dict, latency_ms: int = 0) -> None:
    with _connect() as conn:
        conn.execute(
            """INSERT INTO rag_audit
            (created_at, thread_id, question, answer, route, model, used_web, support_status, usefulness, latency_ms, trace_json, sources_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.now(timezone.utc).isoformat(),
                result.get("thread_id", ""),
                question,
                result.get("answer", ""),
                result.get("route", ""),
                result.get("model", ""),
                int(bool(result.get("used_web_search"))),
                result.get("support_status", ""),
                result.get("usefulness", ""),
                latency_ms,
                json.dumps(result.get("trace", []), ensure_ascii=False),
                json.dumps(result.get("sources", []), ensure_ascii=False),
            ),
        )


def latest_audits(limit: int = 25):
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM rag_audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        for key in ("trace_json", "sources_json"):
            try:
                item[key.replace("_json", "")] = json.loads(item.pop(key) or "[]")
            except Exception:
                item[key.replace("_json", "")] = []
        out.append(item)
    return out


def audit_stats() -> dict:
    with _connect() as conn:
        row = conn.execute(
            """SELECT COUNT(*), COALESCE(AVG(latency_ms), 0), COALESCE(SUM(used_web), 0),
                      COALESCE(SUM(CASE WHEN support_status = 'fully_supported' THEN 1 ELSE 0 END), 0)
               FROM rag_audit"""
        ).fetchone()
        routes = conn.execute("SELECT route, COUNT(*) FROM rag_audit GROUP BY route").fetchall()
    total = row[0] or 0
    return {
        "total": total,
        "avg_latency_ms": round(row[1] or 0),
        "web_searches": row[2],
        "grounded_rate": round((row[3] / total) * 100, 1) if total else 0.0,
        "routes": {r[0] or "unknown": r[1] for r in routes},
    }
