import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/ChatApp";
import type { StreamEvent } from "@/lib/types";
import { DONE, HEALTH, json, sse, sseBody } from "../helpers";

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

const routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  const key = Object.keys(routes).find((k) => path.startsWith(k));
  if (!key) throw new TypeError("Failed to fetch");
  return routes[key](url, init);
});

function streamOf(events: StreamEvent[], delay = 2): Handler {
  return () => new Response(sseBody(sse(events), delay), { headers: { "Content-Type": "text/event-stream" } });
}

const STREAM: StreamEvent[] = [
  { type: "status", text: "Planning the answer" },
  { type: "status", text: "Searching the knowledge base" },
  { type: "sources", sources: DONE.type === "done" ? DONE.sources : [] },
  { type: "reset" },
  { type: "token", text: "Scale the " },
  { type: "token", text: "**payments** replicas." },
  DONE,
];

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  routes["/api/health"] = () => json(HEALTH);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

function setup() {
  render(<ChatApp />);
  return userEvent.setup();
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${text}{Enter}`);
}

const streamCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/chat/stream"));

describe("ChatApp", () => {
  it("shows the welcome screen and the online model badge", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "How can I help you today?" })).toBeInTheDocument();
    expect(await screen.findByText("Self-RAG · gpt-oss-120b")).toBeInTheDocument();
    expect(screen.getByText("Name chat")).toBeInTheDocument();
  });

  it("streams an answer end to end", async () => {
    routes["/api/chat/stream"] = streamOf(STREAM);
    const user = setup();
    await ask(user, "Payments CPU is above 85%, what now?");

    expect(screen.getAllByText("Payments CPU is above 85%, what now?").length).toBeGreaterThan(0);
    expect(await screen.findByText("Knowledge Base")).toBeInTheDocument();
    const answer = screen.getByText("payments").closest(".markdown") as HTMLElement;
    expect(answer).toHaveTextContent("Scale the payments replicas.");
    expect(screen.getByText("grounded")).toBeInTheDocument();
    expect(screen.getByText("4.2s")).toBeInTheDocument();
    expect(screen.getByText("payments-high-cpu-runbook.md")).toBeInTheDocument();

    const body = JSON.parse(streamCalls()[0][1]!.body as string);
    expect(body.question).toBe("Payments CPU is above 85%, what now?");
    expect(body.thread_id).toMatch(/^chat-/);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(screen.getByRole("complementary", { name: "Chat history" })).toHaveTextContent("Payments CPU is above 85%, what now?");
  });

  it("keeps one thread id for follow-ups", async () => {
    routes["/api/chat/stream"] = streamOf(STREAM);
    const user = setup();
    await ask(user, "first question");
    await screen.findByText("Knowledge Base");
    await ask(user, "follow up");
    await waitFor(() => expect(screen.getAllByText("Knowledge Base")).toHaveLength(2));
    const [a, b] = streamCalls().map(([, init]) => JSON.parse(init!.body as string).thread_id);
    expect(a).toBe(b);
  });

  it("replaces a draft when the server sends reset", async () => {
    routes["/api/chat/stream"] = streamOf([
      { type: "reset" },
      { type: "token", text: "draft text" },
      { type: "reset" },
      { type: "token", text: "final text" },
      { ...DONE, answer: "" } as StreamEvent,
    ]);
    const user = setup();
    await ask(user, "question");
    await screen.findByText("Knowledge Base");
    expect(screen.getByText("final text", { selector: ".markdown p" })).toBeInTheDocument();
    expect(screen.queryByText(/draft text/)).not.toBeInTheDocument();
  });

  it("shows server-side errors", async () => {
    routes["/api/chat/stream"] = streamOf([{ type: "status", text: "Planning" }, { type: "error", message: "The assistant is temporarily unavailable." }]);
    const user = setup();
    await ask(user, "question");
    expect(await screen.findByText("The assistant is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("explains when the stream ends without an answer", async () => {
    routes["/api/chat/stream"] = streamOf([{ type: "status", text: "Planning" }]);
    const user = setup();
    await ask(user, "question");
    expect(await screen.findByText(/ended unexpectedly/)).toBeInTheDocument();
  });

  it("shows HTTP error details", async () => {
    routes["/api/chat/stream"] = () => json({ detail: "Rate limited, slow down" }, 429);
    const user = setup();
    await screen.findByText("Self-RAG · gpt-oss-120b");
    await ask(user, "question");
    expect(await screen.findByText("Rate limited, slow down")).toBeInTheDocument();
  });

  it("can stop a running answer", async () => {
    routes["/api/chat/stream"] = (_u, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse([{ type: "status", text: "Searching the knowledge base" }])[0]));
            init!.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
      );
    const user = setup();
    await ask(user, "slow question");
    await screen.findByText("Searching the knowledge base…");
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(await screen.findByText("Stopped.", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("regenerates the last answer in place", async () => {
    routes["/api/chat/stream"] = streamOf(STREAM);
    const user = setup();
    await ask(user, "regenerate me");
    await screen.findByText("Knowledge Base");
    await user.click(screen.getByRole("button", { name: "Regenerate answer" }));
    await waitFor(() => expect(streamCalls()).toHaveLength(2));
    await screen.findByText("Knowledge Base");
    expect(JSON.parse(streamCalls()[1][1]!.body as string).question).toBe("regenerate me");
    expect(screen.getAllByText("Knowledge Base")).toHaveLength(1);
    expect(screen.getAllByText("regenerate me", { selector: "div" })).toHaveLength(1);
  });

  it("uploads documents and reports the result", async () => {
    routes["/api/upload"] = () => json({ filename: "sop.md", chunks_indexed: 4, namespace: "x" });
    const user = setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe(".pdf,.txt,.md,.docx");
    await user.upload(input, new File(["# SOP"], "sop.md", { type: "text/markdown" }));
    expect(await screen.findByText("sop.md added — 4 sections indexed.")).toBeInTheDocument();
  });

  it("reports upload failures", async () => {
    routes["/api/upload"] = () => json({ detail: "File is larger than 15 MB" }, 413);
    const user = setup();
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["x"], "big.pdf"));
    expect(await screen.findByText("File is larger than 15 MB")).toBeInTheDocument();
  });

  it("deletes a chat and its server memory", async () => {
    routes["/api/chat/stream"] = streamOf(STREAM);
    routes["/api/threads"] = () => json({ deleted: true });
    const user = setup();
    await ask(user, "delete me later");
    await screen.findByText("Knowledge Base");
    const sidebar = screen.getByRole("complementary", { name: "Chat history" });
    await user.click(within(sidebar).getByRole("button", { name: "delete me later options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByRole("heading", { name: "How can I help you today?" })).toBeInTheDocument();
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(String(del![0])).toMatch(/\/api\/threads\/chat-/);
  });

  it("renames the chat from the header and pins it", async () => {
    routes["/api/chat/stream"] = streamOf(STREAM);
    const user = setup();
    await ask(user, "original title");
    await screen.findByText("Knowledge Base");
    await user.click(screen.getByRole("button", { name: "original title" }));
    const input = screen.getByDisplayValue("original title");
    await user.clear(input);
    await user.type(input, "Payments incident{Enter}");
    expect(screen.getByRole("button", { name: "Payments incident" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pin chat" }));
    expect(screen.getByRole("button", { name: "Unpin chat" })).toBeInTheDocument();
  });

  it("indicates when the server is waking up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes["/api/health"] = () => {
      throw new TypeError("Failed to fetch");
    };
    render(<ChatApp />);
    await vi.advanceTimersByTimeAsync(5200);
    expect(await screen.findByText("Waking server…")).toBeInTheDocument();
    routes["/api/health"] = () => json(HEALTH);
    await vi.advanceTimersByTimeAsync(5200);
    expect(await screen.findByText("Self-RAG · gpt-oss-120b")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("model badge", () => {
  it("reflects the model that actually answered", async () => {
    routes["/api/health"] = () => json({ ...HEALTH, llm: [{ provider: "anthropic", model: "claude-haiku-5-5", healthy: true }] });
    routes["/api/chat/stream"] = streamOf(STREAM);
    const user = setup();
    expect(await screen.findByText("Self-RAG · claude-haiku-5-5")).toBeInTheDocument();
    await ask(user, "which model?");
    expect(await screen.findByText("Self-RAG · gpt-oss-120b")).toBeInTheDocument();
  });
});
