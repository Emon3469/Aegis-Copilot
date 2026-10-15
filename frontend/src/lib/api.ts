import type { Health, Stats, StreamEvent } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) return data.detail.map((d: { msg?: string }) => d.msg).join(", ");
  } catch {}
  return `Request failed (${res.status})`;
}

export async function streamChat(
  question: string,
  threadId: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question, thread_id: threadId }),
    signal,
    cache: "no-store",
  });

  if (!res.ok || !res.body) throw new Error(await parseError(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as StreamEvent);
      } catch {}
    }
  }
}

export async function uploadDocument(file: File): Promise<{ filename: string; chunks_indexed: number }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_URL}/api/health`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_URL}/api/stats`, { cache: "no-store" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function deleteThread(threadId: string): Promise<void> {
  try {
    await fetch(`${API_URL}/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  } catch {}
}
