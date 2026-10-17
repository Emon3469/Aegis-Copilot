# Aegis Copilot

Self-RAG copilot for cloud operations. Ask how to handle a failing checkout service or roll back a deployment and get an answer grounded in the runbooks, reranked and self-checked before it is shown, with the sources it used.

- **Frontend**: Next.js 16, React 19, Tailwind CSS 4, streamed chat with citations and support feedback, document upload
- **Backend**: FastAPI, LangGraph, Pinecone with multilingual E5 embeddings, cross-encoder reranking, Tavily web search, SQLite audit log and memory store
- **LLM gateway**: ordered fallback across OpenAI, Anthropic and Groq

## Repository layout

```
Aegis-Copilot/
├── backend/             FastAPI service (deployed to Render)
│   ├── app.py           routes, SSE streaming, uploads, warm-up
│   ├── src/
│   │   ├── config.py    settings from the environment
│   │   ├── db.py        audit log
│   │   ├── ingestion.py document loading and indexing
│   │   ├── llm.py       multi-provider pool with fallback
│   │   └── self_rag.py  retrieval, rewriting and verification graph
│   ├── documents/       seed runbooks indexed at start-up
│   ├── data/            SQLite audit log and memory store
│   └── evals/           evaluation harness
├── frontend/            Next.js app (deployed to Vercel)
├── docker-compose.yml   API + web stack for local Docker runs
├── render.yaml          Render blueprint (Docker)
└── DEPLOYMENT.md        Vercel + Render guide
```

## Running with Docker

Requirements: Docker only.

```bash
cp backend/.env.example backend/.env   # add OPENAI_API_KEY and PINECONE_API_KEY at minimum
docker compose up --build
```

- Web app: http://localhost:3000
- API: http://localhost:8000, interactive docs at http://localhost:8000/docs

Notes:

- `docker-compose.yml` builds `backend/Dockerfile` (Python 3.13 slim, non-root, `HEALTHCHECK` on `/api/health`) and `frontend/Dockerfile` (Next.js standalone output on Node 22 alpine). The web container waits for the API to report healthy.
- Without Pinecone credentials the API still starts and `/api/health` reports `knowledge_base: not_configured`; chat answers then rely on web search only.
- SQLite state and uploads are on the `api-data` and `api-uploads` volumes, so audits and uploaded documents survive rebuilds. The seed runbooks in `backend/documents/` are indexed on start-up when `AUTO_INGEST=true`.
- `NEXT_PUBLIC_API_URL` is compiled into the browser bundle at build time. Its default in `.env.example` is a placeholder; set it to the API address (for Docker, `http://localhost:8000`) before `docker compose up`.

`.github/workflows/docker.yml` builds both images on every push and pull request so Dockerfile changes cannot rot unnoticed.

## Running locally

Requirements: Python 3.13+, Node.js 20+.

1. Copy `backend/.env.example` to `backend/.env` and fill in the keys.
2. Start the API:

   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate            # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   uvicorn app:app --reload --port 8000
   ```

3. Start the web app:

   ```bash
   cd frontend
   cp .env.example .env.local
   npm install
   npm run dev
   ```

Open http://localhost:3000.

## Testing

```bash
cd backend
pip install -r requirements-dev.txt
pytest
```

```bash
cd frontend
npm test
npm run typecheck
npm run lint
npm run test:e2e        # Playwright, needs a running API
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Answer with citations and support verdict |
| `POST` | `/api/chat/stream` | Streamed answer as Server-Sent Events |
| `POST` | `/api/upload` | Upload a runbook and index it |
| `GET` | `/api/audits` | Recent answered questions |
| `GET` | `/api/stats` | Audit statistics |
| `DELETE` | `/api/threads/{thread_id}` | Drop a conversation thread |
| `GET` | `/api/health` | Liveness probe with warm-up and provider status |

## Configuration

All settings are environment variables, listed in [backend/.env.example](backend/.env.example). Only providers with a key set are used, so the app runs with any subset of OpenAI, Anthropic and Groq. Retrieval needs `PINECONE_API_KEY`, web search needs `TAVILY_API_KEY`, and `CORS_ORIGINS` or `CORS_ORIGIN_REGEX` control browser access.

## Deployment

Step-by-step guide: [DEPLOYMENT.md](DEPLOYMENT.md).

- Backend: Render web service built from `backend/Dockerfile` via `render.yaml` (Blueprint).
- Frontend: Vercel project with root directory `frontend` and `NEXT_PUBLIC_API_URL` pointing at the Render URL.
