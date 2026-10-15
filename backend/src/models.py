from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    thread_id: str = Field(..., min_length=3, max_length=120, pattern=r"^[A-Za-z0-9_\-:.]+$")


class SourceItem(BaseModel):
    type: Literal["internal", "web"]
    title: str = ""
    source: str = ""
    url: Optional[str] = None
    page: Optional[int] = None


class ChatResponse(BaseModel):
    answer: str
    route: str
    used_web_search: bool
    support_status: str = ""
    usefulness: str = ""
    sources: List[SourceItem] = []
    trace: List[str] = []
    thread_id: str
    memory_turns: int = 0
    model: str = ""


class UploadResponse(BaseModel):
    filename: str
    chunks_indexed: int
    namespace: str
