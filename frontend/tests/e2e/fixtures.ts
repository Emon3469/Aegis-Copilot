import { test as base, expect, type Page, type Route } from "@playwright/test";

export const API = process.env.E2E_API_URL || "http://127.0.0.1:8000";

export const HEALTH = {
  status: "ok",
  warm: true,
  knowledge_base: "ready",
  llm: [{ provider: "groq", model: "openai/gpt-oss-120b", healthy: true }],
  web_search: true,
};

export const ANSWER =
  "Follow the payments high CPU runbook.\n\n1. **Confirm traffic** volume.\n2. Compare CPU across replicas.\n\n```bash\nkubectl top pods -l app=payments\n```";

export function sse(events: object[]): string {
  return ": open\n\n" + events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

export function answerEvents(answer = ANSWER) {
  const tokens = answer.match(/[\s\S]{1,12}/g) ?? [];
  return [
    { type: "status", text: "Thinking" },
    { type: "status", text: "Searching the knowledge base" },
    { type: "sources", sources: [{ type: "internal", title: "payments-high-cpu-runbook.md", source: "payments-high-cpu-runbook.md" }] },
    { type: "reset" },
    ...tokens.map((text) => ({ type: "token", text })),
    {
      type: "done",
      answer,
      route: "Knowledge Base",
      model: "groq:openai/gpt-oss-120b",
      latency_ms: 4800,
      support_status: "fully_supported",
      usefulness: "useful",
      used_web_search: false,
      trace: [],
      sources: [{ type: "internal", title: "payments-high-cpu-runbook.md", source: "payments-high-cpu-runbook.md" }],
      thread_id: "x",
      memory_turns: 1,
    },
  ];
}

export interface MockApi {
  chatBodies: { question: string; thread_id: string }[];
  deleted: string[];
  setStream: (events: object[]) => void;
}

export async function mockApi(page: Page): Promise<MockApi> {
  const state: MockApi & { events: object[] } = {
    chatBodies: [],
    deleted: [],
    events: answerEvents(),
    setStream(events) {
      state.events = events;
    },
  };
  await page.route(`${API}/api/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return route.fulfill({ json: HEALTH, headers: cors });
    if (path === "/api/stats") return route.fulfill({ json: { total: 12, avg_latency_ms: 5100, web_searches: 2, grounded_rate: 91.7, routes: {} }, headers: cors });
    if (path === "/api/chat/stream") {
      state.chatBodies.push(req.postDataJSON());
      return route.fulfill({ body: sse(state.events), headers: { ...cors, "Content-Type": "text/event-stream" } });
    }
    if (path === "/api/upload") return route.fulfill({ json: { filename: "incident-sop.md", chunks_indexed: 3, namespace: "incident-runbooks" }, headers: cors });
    if (path.startsWith("/api/threads/")) {
      state.deleted.push(decodeURIComponent(path.split("/").pop()!));
      return route.fulfill({ json: { deleted: true }, headers: cors });
    }
    return route.fulfill({ status: 404, headers: cors });
  });
  return state;
}

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await provide(errors);
  },
});

export { expect };

export async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}
