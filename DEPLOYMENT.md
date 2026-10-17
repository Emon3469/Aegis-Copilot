# Deploying Aegis Copilot

Backend (FastAPI) runs on **Render** from `backend/Dockerfile`. Frontend (Next.js) runs on **Vercel**.
Do them **in this order**: the frontend needs the backend URL at build time.

---

## Before you start

Have these ready:

| What | Where to get it | Required? |
| --- | --- | --- |
| GitHub repo pushed (`Emon3469/Aegis-Copilot`) | — | Yes |
| At least one LLM key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | provider dashboards | Yes (one is enough) |
| `PINECONE_API_KEY` | app.pinecone.io → API Keys | Yes, for runbook search |
| `TAVILY_API_KEY` | app.tavily.com | Optional (web search) |

> Never commit `.env` files. They are already in `.gitignore`.

---

## Part 1 — Backend on Render

1. Go to <https://dashboard.render.com> → **New +** → **Blueprint**.
2. Connect GitHub and pick the **Aegis-Copilot** repo, branch **main**.
   Render finds `render.yaml` and shows one service: `aegis-copilot-api` (Docker).
3. Render asks for the values marked secret. Fill them in:
   - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` → paste the ones you have, **leave the rest empty**.
   - `PINECONE_API_KEY` → paste.
   - `TAVILY_API_KEY` → paste, or leave empty.
   - `CORS_ORIGINS` → **leave empty for now** (any `*.vercel.app` site is already allowed).
4. Click **Apply**. The first Docker build takes about 5–10 minutes.
5. When the status is **Live**, copy the URL at the top, e.g.
   `https://aegis-copilot-api.onrender.com` (yours may have extra letters).
6. Check it works: open `https://<your-render-url>/api/health` in the browser.
   You should see JSON with `"status"`. That is your **backend URL**.

Notes:
- Free plan sleeps after ~15 min idle; the first request after that takes ~50 s. That is normal.
- Free plan has no disk, so the chat history (SQLite) and uploaded files reset on each redeploy.
  Runbooks in `backend/documents/` are re-indexed automatically (`AUTO_INGEST=true`).
- If you only use some LLM providers, you can also edit `LLM_PROVIDERS` in Render → Environment (e.g. `groq`).

---

## Part 2 — Frontend on Vercel

1. Go to <https://vercel.com/new> → **Import** the **Aegis-Copilot** repo.
2. **Root Directory** → click **Edit** → choose **`frontend`**. (Most common mistake — don't skip it.)
3. Framework Preset shows **Next.js**. Leave Build/Install commands as default.
4. Open **Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | your backend URL from Part 1, e.g. `https://aegis-copilot-api.onrender.com` |

   - Use `https://`, and **no trailing slash, no `/api`**.
5. Click **Deploy**. When it finishes, open the `https://<project>.vercel.app` link and ask a question.

> `NEXT_PUBLIC_API_URL` is baked in at build time. If you change it later, go to
> **Deployments → ⋯ → Redeploy** so the new value is used.

---

## Part 3 — Custom domain (optional)

If you add your own domain in Vercel (e.g. `https://aegis.example.com`), it is **not** a `*.vercel.app`
address, so allow it on the backend:

Render → `aegis-copilot-api` → **Environment** → set `CORS_ORIGINS` to
`https://aegis.example.com` (comma-separate several) → **Save** (Render redeploys).

---

## Updating

Push to `main` and both platforms redeploy automatically.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Vercel build: "No Next.js version detected" | Root Directory is not `frontend`. Project → Settings → General → Root Directory. |
| Browser console: **CORS** error | Your site is not on `*.vercel.app` → set `CORS_ORIGINS` on Render (Part 3). |
| Requests go to `localhost:8000` | `NEXT_PUBLIC_API_URL` missing on Vercel, or you didn't redeploy after adding it. |
| First answer is very slow / times out once | Render free plan was asleep. Wait ~1 min and retry. |
| `/api/health` shows `knowledge_base: not_configured` | `PINECONE_API_KEY` missing or wrong on Render. |
| Render build fails | Render → service → **Logs**; confirm Root Directory is `backend` and Runtime is **Docker**. |

---

## Run the whole stack locally with Docker

```bash
cp backend/.env.example backend/.env    # fill in your keys
docker compose up --build
```

Web: <http://localhost:3000> · API: <http://localhost:8000/docs>
