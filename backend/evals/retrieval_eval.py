import argparse
import json
import math
import re
import time
import urllib.request
from pathlib import Path
from typing import Callable, Dict, List, Sequence

from src.config import ROOT, get_settings
from src.ingestion import _splitter, load_file

CORPUS_DIRS = [ROOT / "documents", ROOT / "uploads", ROOT / "Self-Rag" / "documents"]
QUERIES = Path(__file__).resolve().parent / "retrieval_queries.json"

Embed = Callable[[List[str], str], List[List[float]]]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def load_corpus() -> List[str]:
    chunks: List[str] = []
    for d in CORPUS_DIRS:
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in {".pdf", ".md", ".txt", ".docx"}:
                chunks += [c.page_content for c in _splitter.split_documents(load_file(p))]
    return chunks


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def pinecone_embedder(model: str, dimension: int | None = None) -> Embed:
    from pinecone import Pinecone

    pc = Pinecone(api_key=get_settings().pinecone_api_key)

    def run(texts: List[str], kind: str) -> List[List[float]]:
        params = {"input_type": "query" if kind == "query" else "passage", "truncate": "END"}
        if dimension:
            params["dimension"] = dimension
        out: List[List[float]] = []
        for i in range(0, len(texts), 90):
            res = pc.inference.embed(model=model, inputs=texts[i:i + 90], parameters=params)
            out += [e["values"] for e in res.data]
        return out

    return run


def gemini_embedder(model: str, dimension: int) -> Embed:
    s = get_settings()
    key = s.gemini_api_key

    def call(texts: List[str], task: str | None) -> List[List[float]]:
        reqs = []
        for t in texts:
            r = {"model": f"models/{model}", "content": {"parts": [{"text": t}]}, "outputDimensionality": dimension}
            if task:
                r["taskType"] = task
            reqs.append(r)
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents",
            data=json.dumps({"requests": reqs}).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
        )
        with urllib.request.urlopen(req, timeout=60) as f:
            return [e["values"] for e in json.load(f)["embeddings"]]

    def run(texts: List[str], kind: str) -> List[List[float]]:
        task = "RETRIEVAL_QUERY" if kind == "query" else "RETRIEVAL_DOCUMENT"
        out: List[List[float]] = []
        for i in range(0, len(texts), 90):
            out += call(texts[i:i + 90], task)
        return out

    return run


def pinecone_reranker(model: str):
    from pinecone import Pinecone

    pc = Pinecone(api_key=get_settings().pinecone_api_key)

    def run(query: str, docs: List[str]) -> List[int]:
        res = pc.inference.rerank(model=model, query=query, documents=docs, top_n=len(docs), return_documents=False)
        return [r["index"] for r in res.data]

    return run


def relevant(chunk: str, answers: List[str]) -> bool:
    c = norm(chunk)
    return any(norm(a) in c for a in answers)


def evaluate(name: str, embed: Embed, chunks: List[str], queries: List[dict], rerankers: Dict[str, Callable] | None = None) -> List[dict]:
    doc_vecs = embed(chunks, "passage")
    rows = []
    variants = {name: None, **{f"{name} + {r}": fn for r, fn in (rerankers or {}).items()}}
    stats = {v: {"h1": 0, "h4": 0, "mrr": 0.0, "lat": 0.0} for v in variants}
    for item in queries:
        started = time.perf_counter()
        qv = embed([item["q"]], "query")[0]
        embed_ms = (time.perf_counter() - started) * 1000
        ranked = sorted(range(len(chunks)), key=lambda i: cosine(qv, doc_vecs[i]), reverse=True)[:10]
        for variant, rerank in variants.items():
            order, extra = ranked, 0.0
            if rerank:
                t = time.perf_counter()
                idx = rerank(item["q"], [chunks[i] for i in ranked])
                extra = (time.perf_counter() - t) * 1000
                order = [ranked[i] for i in idx]
            hits = [relevant(chunks[i], item["a"]) for i in order]
            st = stats[variant]
            st["h1"] += hits[0]
            st["h4"] += any(hits[:4])
            st["mrr"] += next((1 / (k + 1) for k, h in enumerate(hits) if h), 0.0)
            st["lat"] += embed_ms + extra
            if not any(hits[:4]):
                st.setdefault("misses", []).append(item["q"])
    n = len(queries)
    for variant, st in stats.items():
        rows.append({
            "model": variant,
            "hit@1": round(st["h1"] / n, 3),
            "hit@4": round(st["h4"] / n, 3),
            "mrr@10": round(st["mrr"] / n, 3),
            "query_ms": round(st["lat"] / n),
            "misses": st.get("misses", []),
        })
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rerank", action="store_true")
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    s = get_settings()
    chunks = load_corpus()
    queries = json.loads(QUERIES.read_text(encoding="utf-8"))
    print(f"corpus chunks: {len(chunks)}  queries: {len(queries)}\n")

    candidates: Dict[str, Callable[[], Embed]] = {}
    if s.pinecone_api_key:
        candidates["pinecone/multilingual-e5-large"] = lambda: pinecone_embedder("multilingual-e5-large")
        candidates["pinecone/llama-text-embed-v2@1024"] = lambda: pinecone_embedder("llama-text-embed-v2", 1024)
        candidates["pinecone/llama-text-embed-v2@2048"] = lambda: pinecone_embedder("llama-text-embed-v2", 2048)
    if s.gemini_api_key:
        candidates["google/gemini-embedding-001@768"] = lambda: gemini_embedder("gemini-embedding-001", 768)
        candidates["google/gemini-embedding-001@1536"] = lambda: gemini_embedder("gemini-embedding-001", 1536)
        candidates["google/gemini-embedding-2@1536"] = lambda: gemini_embedder("gemini-embedding-2", 1536)

    rerankers = {}
    if args.rerank and s.pinecone_api_key:
        for model in ("bge-reranker-v2-m3", "pinecone-rerank-v0", "cohere-rerank-4-fast", "cohere-rerank-3.5"):
            fn = pinecone_reranker(model)
            try:
                fn("probe", ["probe document", "another document"])
                rerankers[model] = fn
            except Exception as exc:
                print(f"reranker {model} unavailable: {str(exc).splitlines()[0][:80]}")

    results = []
    for name, factory in candidates.items():
        if args.only and args.only not in name:
            continue
        try:
            results += evaluate(name, factory(), chunks, queries, rerankers)
        except Exception as exc:
            print(f"{name}: failed - {str(exc)[:200]}")

    results.sort(key=lambda r: (r["mrr@10"], r["hit@1"]), reverse=True)
    print(f"{'model':<58}{'hit@1':>7}{'hit@4':>7}{'mrr':>7}{'ms':>7}")
    for r in results:
        print(f"{r['model']:<58}{r['hit@1']:>7}{r['hit@4']:>7}{r['mrr@10']:>7}{r['query_ms']:>7}")
    for r in results:
        if r["misses"]:
            print(f"\n{r['model']} missed (top-4):")
            for q in r["misses"]:
                print(f"  - {q}")
    out = Path(__file__).resolve().parent / "results.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
