import type { StreamEvent } from "@/lib/types";

const encoder = new TextEncoder();

export function sseBody(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
}

export function sse(events: StreamEvent[]): string[] {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

export const DONE: StreamEvent = {
  type: "done",
  answer: "Scale the **payments** replicas.",
  route: "Knowledge Base",
  model: "groq:openai/gpt-oss-120b",
  latency_ms: 4200,
  support_status: "fully_supported",
  usefulness: "useful",
  used_web_search: false,
  trace: [],
  sources: [{ type: "internal", title: "payments-high-cpu-runbook.md", source: "payments-high-cpu-runbook.md", page: null, url: null }],
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const HEALTH = {
  status: "ok",
  warm: true,
  knowledge_base: "ready",
  llm: [{ provider: "groq", model: "openai/gpt-oss-120b", healthy: true }],
  web_search: true,
};
