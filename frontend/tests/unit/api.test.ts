import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteThread, getHealth, getStats, streamChat, uploadDocument } from "@/lib/api";
import type { StreamEvent } from "@/lib/types";
import { DONE, HEALTH, json, sse, sseBody } from "../helpers";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

async function collect(chunks: string[]): Promise<StreamEvent[]> {
  fetchMock.mockResolvedValueOnce(new Response(sseBody(chunks), { headers: { "Content-Type": "text/event-stream" } }));
  const events: StreamEvent[] = [];
  await streamChat("cpu high", "chat-1", (e) => events.push(e));
  return events;
}

describe("streamChat", () => {
  it("posts the question and thread id", async () => {
    await collect(sse([DONE]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/chat/stream");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ question: "cpu high", thread_id: "chat-1" });
  });

  it("parses events in order", async () => {
    const events = await collect([
      ": open\n\n",
      ...sse([{ type: "status", text: "Thinking" }, { type: "reset" }, { type: "token", text: "Hel" }, { type: "token", text: "lo" }, DONE]),
    ]);
    expect(events.map((e) => e.type)).toEqual(["status", "reset", "token", "token", "done"]);
  });

  it("reassembles events split across arbitrary network chunks", async () => {
    const whole = sse([{ type: "token", text: "αβγ 🚀 multi-byte" }, { type: "token", text: "second" }, DONE]).join("");
    const bytes = new TextEncoder().encode(whole);
    const pieces: string[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < bytes.length; i += 7) pieces.push(decoder.decode(bytes.slice(i, i + 7), { stream: true }));
    const events = await collect(pieces);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "token", text: "αβγ 🚀 multi-byte" });
  });

  it("reassembles events when bytes split inside a multi-byte character", async () => {
    const bytes = new TextEncoder().encode(sse([{ type: "token", text: "ছুটি" }]).join(""));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body));
    const events: StreamEvent[] = [];
    await streamChat("q", "chat-1", (e) => events.push(e));
    expect(events).toEqual([{ type: "token", text: "ছুটি" }]);
  });

  it("ignores comments, blank and malformed frames", async () => {
    const events = await collect([": keepalive\n\n", "\n\n", "data: {not json}\n\n", "event: ping\n\n", ...sse([DONE])]);
    expect(events).toEqual([DONE]);
  });

  it("surfaces the server detail on HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "Question is empty" }, 422));
    await expect(streamChat("", "chat-1", () => {})).rejects.toThrow("Question is empty");
  });

  it("joins validation error arrays", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: [{ msg: "too short" }, { msg: "bad id" }] }, 422));
    await expect(streamChat("x", "c", () => {})).rejects.toThrow("too short, bad id");
  });

  it("falls back to a status message for non-JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }));
    await expect(streamChat("x", "chat-1", () => {})).rejects.toThrow("Request failed (502)");
  });

  it("passes the abort signal through", async () => {
    const ctrl = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response(sseBody(sse([DONE]))));
    await streamChat("x", "chat-1", () => {}, ctrl.signal);
    expect(fetchMock.mock.calls[0][1].signal).toBe(ctrl.signal);
  });
});

describe("REST helpers", () => {
  it("uploads multipart form data", async () => {
    fetchMock.mockResolvedValueOnce(json({ filename: "a.md", chunks_indexed: 2 }));
    const file = new File(["# hi"], "a.md", { type: "text/markdown" });
    await expect(uploadDocument(file)).resolves.toEqual({ filename: "a.md", chunks_indexed: 2 });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect((body.get("file") as File).name).toBe("a.md");
  });

  it("reports upload rejections", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "Supported file types: PDF, TXT, MD, DOCX" }, 400));
    await expect(uploadDocument(new File(["x"], "a.exe"))).rejects.toThrow("Supported file types");
  });

  it("reads health and stats", async () => {
    fetchMock.mockResolvedValueOnce(json(HEALTH)).mockResolvedValueOnce(json({ total: 3 }));
    await expect(getHealth()).resolves.toMatchObject({ status: "ok" });
    await expect(getStats()).resolves.toMatchObject({ total: 3 });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8000/api/health");
  });

  it("deleteThread never throws", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(deleteThread("chat/1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8000/api/threads/chat%2F1");
  });
});

describe("API_URL", () => {
  it("uses NEXT_PUBLIC_API_URL without trailing slashes", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://aegis-api.onrender.com//");
    const mod = await import("@/lib/api");
    expect(mod.API_URL).toBe("https://aegis-api.onrender.com");
    vi.unstubAllEnvs();
  });
});
