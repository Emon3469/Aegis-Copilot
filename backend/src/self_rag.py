import logging
import operator
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Dict, Iterator, List, Literal, TypedDict

from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from src.config import get_settings
from src.llm import get_pool
from src.vectorstore import search

log = logging.getLogger("aegis.rag")


class RAGState(TypedDict, total=False):
    user_question: str
    question: str
    memory: Annotated[List[str], operator.add]
    retrieval_query: str
    web_query: str
    need_retrieval: bool
    docs: List[Document]
    relevant_docs: List[Document]
    context: str
    answer: str
    support_status: Literal["fully_supported", "partially_supported", "no_support", ""]
    evidence: List[str]
    usefulness: Literal["useful", "not_useful", ""]
    use_reason: str
    support_retries: int
    retrieval_rewrites: int
    web_rewrites: int
    retrieval_failed: bool
    prefetch_query: str
    prefetch_docs: List[Document]
    prefetch_failed: bool
    source_mode: Literal["internal", "web", "direct", "none"]
    used_web_search: bool
    model: str
    trace: List[str]


class RetrieveDecision(BaseModel):
    should_retrieve: bool


class RelevanceDecision(BaseModel):
    relevant: List[int] = Field(default_factory=list, description="Numbers of the documents that are relevant")


class SupportDecision(BaseModel):
    status: Literal["fully_supported", "partially_supported", "no_support"]
    evidence: List[str] = Field(default_factory=list)


class UsefulnessDecision(BaseModel):
    status: Literal["useful", "not_useful"]
    reason: str = ""


class QueryRewrite(BaseModel):
    query: str


SYSTEM_PERSONA = (
    "You are Aegis Copilot, an enterprise cloud operations and incident-response assistant. "
    "Write in clear Markdown. Open with a one-sentence summary written as plain text (never a heading), "
    "then use numbered steps or bullets where useful and fenced code blocks for commands."
)

CONTEXTUALIZE = ChatPromptTemplate.from_messages([
    ("system", "Rewrite the newest user message as a standalone question using the previous conversation only when needed. Preserve service names, symptoms, errors, and constraints. If the message already stands alone, return it unchanged. Do not answer the question."),
    ("human", "Previous conversation:\n{history}\n\nNewest message:\n{question}"),
])

DECIDE = ChatPromptTemplate.from_messages([
    ("system", "Decide whether the message needs retrieval from the organisation's knowledge base or the web. Return should_retrieve=false ONLY for greetings, thanks, small talk, questions about the assistant itself, or pure writing/formatting requests. For every other message, including any question about services, systems, incidents, errors, CPU, latency, deployments, rollbacks, runbooks, procedures, policies, products, pricing, the company, or anything current, return should_retrieve=true."),
    ("human", "Question: {question}"),
])

DIRECT = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_PERSONA + " Answer from general technical knowledge. Do not invent organisation-specific infrastructure, runbooks, credentials, incident history, or deployment procedures."),
    ("human", "Conversation so far:\n{history}\n\nQuestion: {question}"),
])

RELEVANCE = ChatPromptTemplate.from_messages([
    ("system", "Judge each numbered document at the topic/evidence level. A document is relevant when it contains information useful for answering the question; it does not need the exact final answer. Be strict about unrelated content. Return the numbers of the relevant documents, or an empty list."),
    ("human", "Question:\n{question}\n\nDocuments:\n{documents}"),
])

REWRITE_INTERNAL = ChatPromptTemplate.from_messages([
    ("system", "Rewrite the question for semantic vector retrieval over internal runbooks, SOPs, postmortems, architecture notes, company documents and troubleshooting guides. Use 6-18 words, keep service names and error symptoms, add useful keywords, and do not answer."),
    ("human", "Question: {question}\nPrevious query: {previous}"),
])

REWRITE_WEB = ChatPromptTemplate.from_messages([
    ("system", "Rewrite the question into a concise internet search query of 6-14 words. Keep important entities. Add recency wording when the question asks for latest/current/today. Do not answer."),
    ("human", "Question: {question}\nPrevious web query: {previous}"),
])

GENERATE = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_PERSONA + " Answer using only the supplied evidence. Prefer private runbooks, SOPs, architecture notes and postmortems when present. If the evidence comes from the web, say it is external guidance and never present it as an organisation-specific procedure. Do not invent infrastructure facts, credentials, commands or incident history. Keep it concise and actionable and preserve any cautions in the evidence."),
    ("human", "Question:\n{question}\n\nEvidence:\n{context}"),
])

SUPPORT = ChatPromptTemplate.from_messages([
    ("system", "Verify whether every meaningful claim in the answer is supported by the supplied evidence. Return fully_supported only when all important claims are grounded; partially_supported when some are grounded and some are not; no_support when key claims are unsupported. Evidence excerpts must be short."),
    ("human", "Question:\n{question}\n\nAnswer:\n{answer}\n\nEvidence:\n{context}"),
])

REVISE = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_PERSONA + " Rewrite the answer so every factual claim is directly supported by the evidence. Remove unsupported interpretation and speculation. Still answer the question naturally and do not mention any verification process."),
    ("human", "Question:\n{question}\n\nCurrent answer:\n{answer}\n\nEvidence:\n{context}"),
])

USEFULNESS = ChatPromptTemplate.from_messages([
    ("system", "Judge only whether the answer directly addresses the user's question. Do not re-grade factual grounding. Return useful or not_useful and a one-line reason."),
    ("human", "Question:\n{question}\n\nAnswer:\n{answer}"),
])

NO_ANSWER = "I could not find enough reliable evidence in the knowledge base or on the web to give a safe answer. Try adding more detail (service name, error message, environment) or upload the relevant runbook."


def _emit(kind: str, **payload: Any) -> None:
    try:
        get_stream_writer()({"type": kind, **payload})
    except Exception:
        pass


def _status(text: str) -> None:
    _emit("status", text=text)


def _trace(state: RAGState, item: str) -> List[str]:
    return [*(state.get("trace") or []), item]


def _memory_text(state: RAGState, limit: int = 4) -> str:
    items = state.get("memory") or []
    return "\n\n".join(i[-1500:] for i in items[-limit:]) if items else "No previous conversation."


def _format_context(docs: List[Document]) -> str:
    blocks = []
    for i, d in enumerate(docs, 1):
        meta = d.metadata or {}
        if meta.get("source_type") == "web":
            head = f"[WEB {i}] {meta.get('title', '')} | {meta.get('url', '')}"
        else:
            head = f"[INTERNAL {i}] {meta.get('title') or meta.get('document_name') or meta.get('source', '')}"
            if meta.get("page") is not None:
                head += f" | page {int(meta['page']) + 1}"
        blocks.append(f"{head}\n{d.page_content}")
    return "\n\n---\n\n".join(blocks)


def _stream_answer(messages) -> Dict[str, str]:
    meta: Dict[str, str] = {}
    parts: List[str] = []
    _emit("reset")
    for piece in get_pool().stream(messages, meta):
        parts.append(piece)
        _emit("token", text=piece)
    return {"answer": "".join(parts).strip(), "model": meta.get("model", "")}


def contextualize_question(state: RAGState):
    user_question = state.get("user_question") or state.get("question", "")
    if not state.get("memory"):
        return {"question": user_question, "trace": _trace(state, "Question received")}
    _status("Reading the conversation")
    out = get_pool().structured(QueryRewrite, CONTEXTUALIZE.format_messages(history=_memory_text(state), question=user_question))
    return {"question": out.query, "retrieval_query": out.query, "trace": _trace(state, f"Contextualised question: {out.query}")}


_executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="aegis-rag")


def _search_safe(query: str):
    try:
        return search(query), False
    except Exception as exc:
        log.warning("internal retrieval failed: %s", exc)
        return [], True


def decide_retrieval(state: RAGState):
    _status("Planning the answer")
    query = state.get("retrieval_query") or state["question"]
    prefetch = _executor.submit(_search_safe, query)
    try:
        out = get_pool().structured(RetrieveDecision, DECIDE.format_messages(question=state["question"]))
        need = bool(out.should_retrieve)
    except Exception as exc:
        log.warning("retrieval decision failed: %s", exc)
        need = True
    update: Dict[str, Any] = {"need_retrieval": need, "trace": _trace(state, f"Retrieval needed: {need}")}
    if need:
        _status("Searching the knowledge base")
        docs, failed = prefetch.result()
        update.update(prefetch_query=query, prefetch_docs=docs, prefetch_failed=failed)
    return update


def route_after_decide(state: RAGState) -> Literal["direct", "retrieve"]:
    return "retrieve" if state.get("need_retrieval", True) else "direct"


def generate_direct(state: RAGState):
    _status("Writing the answer")
    out = _stream_answer(DIRECT.format_messages(history=_memory_text(state), question=state["question"]))
    return {**out, "source_mode": "direct", "trace": _trace(state, "Answered from general knowledge")}


def retrieve_internal(state: RAGState):
    q = state.get("retrieval_query") or state["question"]
    if state.get("prefetch_query") == q:
        docs, failed = state.get("prefetch_docs") or [], bool(state.get("prefetch_failed"))
    else:
        _status("Searching the knowledge base")
        docs, failed = _search_safe(q)
    if failed:
        return {
            "docs": [],
            "relevant_docs": [],
            "retrieval_failed": True,
            "prefetch_query": "",
            "source_mode": "internal",
            "trace": _trace(state, "Knowledge base unavailable"),
        }
    for d in docs:
        d.metadata = {**(d.metadata or {}), "source_type": "internal"}
    return {
        "docs": docs,
        "relevant_docs": [],
        "prefetch_query": "",
        "source_mode": "internal",
        "trace": _trace(state, f"Retrieved {len(docs)} internal chunks"),
    }


def grade_relevance(state: RAGState):
    docs = state.get("docs", [])
    mode = state.get("source_mode", "internal")
    if docs:
        _status(f"Checking {len(docs)} {'web results' if mode == 'web' else 'documents'} for relevance")

    relevant: List[Document] = []
    if docs:
        listing = "\n\n".join(f"[{i}] {d.page_content[:1800]}" for i, d in enumerate(docs, 1))
        try:
            out = get_pool().structured(RelevanceDecision, RELEVANCE.format_messages(question=state["question"], documents=listing))
            picked = sorted({i for i in out.relevant if 1 <= i <= len(docs)})
            relevant = [docs[i - 1] for i in picked]
        except Exception as exc:
            log.warning("relevance grading failed: %s", exc)
            relevant = docs if mode == "internal" else docs[:3]
    return {
        "relevant_docs": relevant,
        "source_mode": mode,
        "trace": _trace(state, f"Relevance ({mode}): {len(relevant)}/{len(docs)} relevant"),
    }


def _web_enabled() -> bool:
    return bool(get_settings().tavily_api_key)


def route_after_relevance(state: RAGState) -> Literal["generate", "rewrite_internal", "rewrite_web", "no_answer"]:
    if state.get("relevant_docs"):
        return "generate"
    s = get_settings()
    if state.get("source_mode") == "web":
        return "rewrite_web" if state.get("web_rewrites", 0) < s.max_web_rewrites else "no_answer"
    if not state.get("retrieval_failed") and state.get("retrieval_rewrites", 0) < s.max_retrieval_rewrites:
        return "rewrite_internal"
    return "rewrite_web" if _web_enabled() else "no_answer"


def rewrite_internal_query(state: RAGState):
    _status("Refining the search")
    try:
        query = get_pool().structured(QueryRewrite, REWRITE_INTERNAL.format_messages(question=state["question"], previous=state.get("retrieval_query", ""))).query
    except Exception:
        query = state["question"]
    return {
        "retrieval_query": query,
        "retrieval_rewrites": state.get("retrieval_rewrites", 0) + 1,
        "docs": [],
        "relevant_docs": [],
        "trace": _trace(state, f"Internal query: {query}"),
    }


def rewrite_web_query(state: RAGState):
    _status("Preparing a web search")
    try:
        query = get_pool().structured(QueryRewrite, REWRITE_WEB.format_messages(question=state["question"], previous=state.get("web_query", ""))).query
    except Exception:
        query = state["question"]
    return {
        "web_query": query,
        "web_rewrites": state.get("web_rewrites", 0) + 1,
        "docs": [],
        "relevant_docs": [],
        "trace": _trace(state, f"Web query: {query}"),
    }


_tavily = None
_tavily_lock = threading.Lock()


def _tavily_client():
    global _tavily
    if _tavily is None:
        with _tavily_lock:
            if _tavily is None:
                from tavily import TavilyClient

                _tavily = TavilyClient(api_key=get_settings().tavily_api_key)
    return _tavily


def web_search(state: RAGState):
    s = get_settings()
    if not s.tavily_api_key:
        return {"docs": [], "source_mode": "web", "used_web_search": True, "trace": _trace(state, "Web search not configured")}
    _status("Searching the web")
    q = state.get("web_query") or state["question"]
    try:
        response = _tavily_client().search(query=q, search_depth=s.tavily_search_depth, max_results=5, include_answer=False)
        results = response.get("results", []) if isinstance(response, dict) else getattr(response, "results", [])
    except Exception as exc:
        log.warning("web search failed: %s", exc)
        results = []
    docs = [
        Document(
            page_content=r.get("content", ""),
            metadata={"source_type": "web", "source": r.get("url", ""), "url": r.get("url", ""), "title": r.get("title", "")},
        )
        for r in results
        if r.get("content")
    ]
    return {"docs": docs, "source_mode": "web", "used_web_search": True, "trace": _trace(state, f"Web search: {len(docs)} results")}


def generate_from_context(state: RAGState):
    docs = state.get("relevant_docs", [])
    _emit("sources", sources=_sources(docs))
    _status("Writing the answer")
    context = _format_context(docs)
    out = _stream_answer(GENERATE.format_messages(question=state["question"], context=context))
    return {
        **out,
        "context": context,
        "support_retries": 0,
        "trace": _trace(state, f"Generated answer from {state.get('source_mode', '')} evidence"),
    }


def _check_support(state: RAGState):
    try:
        out = get_pool().structured(SupportDecision, SUPPORT.format_messages(question=state["question"], answer=state.get("answer", ""), context=state.get("context", "")))
        return out.status, out.evidence
    except Exception as exc:
        log.warning("support check failed: %s", exc)
        return "partially_supported", []


def _check_usefulness(state: RAGState):
    try:
        out = get_pool().structured(UsefulnessDecision, USEFULNESS.format_messages(question=state["question"], answer=state.get("answer", "")))
        return out.status, out.reason
    except Exception as exc:
        log.warning("usefulness check failed: %s", exc)
        return "useful", ""


def verify_answer(state: RAGState):
    _status("Verifying the answer against sources")
    support = _executor.submit(_check_support, state)
    usefulness = _executor.submit(_check_usefulness, state)
    support_status, evidence = support.result()
    use_status, reason = usefulness.result()
    return {
        "support_status": support_status,
        "evidence": evidence,
        "usefulness": use_status,
        "use_reason": reason,
        "trace": _trace(state, f"Support: {support_status} | Usefulness: {use_status}"),
    }


def revise_answer(state: RAGState):
    _status("Tightening the answer to the evidence")
    out = _stream_answer(REVISE.format_messages(question=state["question"], answer=state.get("answer", ""), context=state.get("context", "")))
    return {**out, "support_retries": state.get("support_retries", 0) + 1, "trace": _trace(state, "Revised answer for grounding")}


def route_after_verify(state: RAGState) -> Literal["revise", "end", "rewrite_internal", "rewrite_web"]:
    s = get_settings()
    if state.get("support_status") != "fully_supported" and state.get("support_retries", 0) < s.max_support_retries:
        return "revise"
    if state.get("usefulness") == "useful":
        return "end"
    if state.get("source_mode") == "internal":
        if not state.get("retrieval_failed") and state.get("retrieval_rewrites", 0) < s.max_retrieval_rewrites:
            return "rewrite_internal"
        if _web_enabled():
            return "rewrite_web"
        return "end"
    if state.get("source_mode") == "web" and state.get("web_rewrites", 0) < s.max_web_rewrites:
        return "rewrite_web"
    return "end"


def no_answer(state: RAGState):
    _emit("reset")
    _emit("token", text=NO_ANSWER)
    return {"answer": NO_ANSWER, "source_mode": "none", "relevant_docs": [], "trace": _trace(state, "No reliable answer found")}


def commit_memory(state: RAGState):
    user_question = state.get("user_question") or state.get("question", "")
    entry = f"User: {user_question}\nAssistant: {state.get('answer', '')}"
    return {"memory": [entry], "trace": _trace(state, "Conversation memory updated")}


def build_graph():
    g = StateGraph(RAGState)
    g.add_node("contextualize", contextualize_question)
    g.add_node("decide_retrieval", decide_retrieval)
    g.add_node("direct", generate_direct)
    g.add_node("retrieve", retrieve_internal)
    g.add_node("grade", grade_relevance)
    g.add_node("rewrite_internal", rewrite_internal_query)
    g.add_node("rewrite_web", rewrite_web_query)
    g.add_node("web_search", web_search)
    g.add_node("generate", generate_from_context)
    g.add_node("verify", verify_answer)
    g.add_node("revise", revise_answer)
    g.add_node("no_answer", no_answer)
    g.add_node("commit_memory", commit_memory)

    g.add_edge(START, "contextualize")
    g.add_edge("contextualize", "decide_retrieval")
    g.add_conditional_edges("decide_retrieval", route_after_decide, {"direct": "direct", "retrieve": "retrieve"})
    g.add_edge("direct", "commit_memory")
    g.add_edge("retrieve", "grade")
    g.add_conditional_edges("grade", route_after_relevance, {
        "generate": "generate", "rewrite_internal": "rewrite_internal", "rewrite_web": "rewrite_web", "no_answer": "no_answer",
    })
    g.add_edge("rewrite_internal", "retrieve")
    g.add_edge("rewrite_web", "web_search")
    g.add_edge("web_search", "grade")
    g.add_edge("generate", "verify")
    g.add_edge("revise", "verify")
    g.add_conditional_edges("verify", route_after_verify, {
        "revise": "revise", "end": "commit_memory", "rewrite_internal": "rewrite_internal", "rewrite_web": "rewrite_web",
    })
    g.add_edge("no_answer", "commit_memory")
    g.add_edge("commit_memory", END)

    db_path = get_settings().memory_file
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    return g.compile(checkpointer=SqliteSaver(conn))


def _sources(docs: List[Document]) -> List[dict]:
    seen, out = set(), []
    for d in docs or []:
        m = d.metadata or {}
        typ = "web" if m.get("source_type") == "web" else "internal"
        key = (typ, m.get("url") or m.get("source"), m.get("page"))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "type": typ,
            "title": m.get("title") or m.get("document_name") or "",
            "source": m.get("source") or "",
            "url": m.get("url") if typ == "web" else None,
            "page": (int(m["page"]) + 1) if typ == "internal" and m.get("page") is not None else None,
        })
    return out


_graph = None
_graph_lock = threading.Lock()


def get_graph():
    global _graph
    if _graph is None:
        with _graph_lock:
            if _graph is None:
                _graph = build_graph()
    return _graph


ROUTES = {"internal": "Knowledge Base", "web": "Web Search", "direct": "General Knowledge", "none": "No Reliable Evidence"}


def _initial(question: str) -> RAGState:
    return {
        "user_question": question,
        "question": question,
        "memory": [],
        "retrieval_query": question,
        "web_query": "",
        "docs": [],
        "relevant_docs": [],
        "context": "",
        "answer": "",
        "support_status": "",
        "evidence": [],
        "usefulness": "",
        "use_reason": "",
        "support_retries": 0,
        "retrieval_rewrites": 0,
        "web_rewrites": 0,
        "retrieval_failed": False,
        "prefetch_query": "",
        "prefetch_docs": [],
        "prefetch_failed": False,
        "source_mode": "internal",
        "used_web_search": False,
        "model": "",
        "trace": [],
    }


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}, "recursion_limit": 40}


def _result(result: dict, thread_id: str) -> dict:
    mode = result.get("source_mode", "none")
    return {
        "answer": result.get("answer", ""),
        "route": ROUTES.get(mode, mode),
        "used_web_search": bool(result.get("used_web_search")),
        "support_status": result.get("support_status", ""),
        "usefulness": result.get("usefulness", ""),
        "sources": _sources(result.get("relevant_docs", [])) if mode in ("internal", "web") else [],
        "trace": result.get("trace", []),
        "thread_id": thread_id,
        "memory_turns": len(result.get("memory", [])),
        "model": result.get("model", ""),
    }


def run_self_rag(question: str, thread_id: str) -> dict:
    result = get_graph().invoke(_initial(question), config=_config(thread_id))
    return _result(result, thread_id)


def stream_self_rag(question: str, thread_id: str) -> Iterator[dict]:
    graph = get_graph()
    final: Dict[str, Any] = {}
    for mode, chunk in graph.stream(_initial(question), config=_config(thread_id), stream_mode=["custom", "values"]):
        if mode == "custom":
            yield chunk
        else:
            final = chunk
    yield {"type": "done", **_result(final, thread_id)}
