"use client";

import clsx from "clsx";
import { Bookmark, BookmarkCheck, ChevronLeft, CloudUpload, Loader2, Menu as MenuIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteThread, getHealth, streamChat, uploadDocument } from "@/lib/api";
import { createTypewriter, type Typewriter } from "@/lib/typewriter";
import type { AnswerMeta, Health, Message, Source, StreamEvent } from "@/lib/types";
import { titleFrom, uid, useChats } from "@/lib/useChats";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageView } from "./MessageView";
import { Sidebar } from "./Sidebar";
import { Welcome } from "./Welcome";

type Connection = "connecting" | "waking" | "online" | "offline";

interface Toast {
  id: string;
  text: string;
  tone: "ok" | "error" | "info";
}

const ACCEPT = ".pdf,.txt,.md,.docx";

export function ChatApp() {
  const store = useChats();
  const { activeChat, createChat, addMessage, updateMessage, updateChat, selectChat, removeMessagesFrom } = store;

  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 1023px)").matches);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [health, setHealth] = useState<Health | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);

  const composer = useRef<ComposerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const writerRef = useRef<Typewriter | null>(null);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = uid();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const ping = async () => {
      attempts += 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const h = await getHealth(ctrl.signal);
        if (cancelled) return;
        setHealth(h);
        setConnection("online");
      } catch {
        if (cancelled) return;
        if (attempts < 12) {
          setConnection(attempts > 1 ? "waking" : "connecting");
          setTimeout(ping, 5000);
        } else {
          setConnection("offline");
        }
      } finally {
        clearTimeout(timer);
      }
    };
    ping();
    return () => {
      cancelled = true;
    };
  }, []);

  const messages = activeChat?.messages ?? [];
  const lastContent = messages[messages.length - 1]?.content;

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [messages.length, lastContent, busy]);

  useEffect(() => {
    stickToBottom.current = true;
    setEditingTitle(false);
  }, [activeChat?.id]);

  const run = useCallback(
    async (chatId: string, question: string) => {
      const assistantId = uid("msg");
      const assistant: Message = { id: assistantId, role: "assistant", content: "", createdAt: Date.now(), steps: [], streaming: true };
      addMessage(chatId, assistant);
      setBusy(true);
      stickToBottom.current = true;

      const ctrl = new AbortController();
      controller.current = ctrl;

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const writer = createTypewriter(
        (visible) => updateMessage(chatId, assistantId, (m) => (m.content === visible ? m : { ...m, content: visible })),
        { instant: reducedMotion },
      );
      writerRef.current = writer;
      let final: { meta: AnswerMeta; sources?: Source[] } | null = null;
      let failure: string | null = null;

      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case "status":
            updateMessage(chatId, assistantId, (m) => {
              const steps = m.steps ?? [];
              return steps[steps.length - 1] === event.text ? m : { ...m, steps: [...steps, event.text] };
            });
            break;
          case "reset":
            writer.reset();
            break;
          case "token":
            writer.push(event.text);
            break;
          case "sources":
            updateMessage(chatId, assistantId, (m) => ({ ...m, sources: event.sources }));
            break;
          case "done":
            writer.replace(event.answer || writer.received);
            final = {
              sources: event.sources,
              meta: {
                route: event.route,
                model: event.model,
                latency_ms: event.latency_ms,
                support_status: event.support_status,
                usefulness: event.usefulness,
                used_web_search: event.used_web_search,
              },
            };
            break;
          case "error":
            failure = event.message;
            break;
        }
      };

      try {
        await streamChat(question, chatId, onEvent, ctrl.signal);
        if (failure) writer.flushAll();
        await writer.drained();
        const done = final as { meta: AnswerMeta; sources?: Source[] } | null;
        const visible = writer.visible;
        updateMessage(chatId, assistantId, (m) => ({
          ...m,
          content: visible,
          streaming: false,
          ...(done ? { meta: done.meta, sources: done.sources ?? m.sources } : {}),
          error: failure ?? (done || visible ? undefined : "The response ended unexpectedly. Please try again."),
        }));
      } catch (err) {
        writer.flushAll();
        const aborted = (err as Error)?.name === "AbortError";
        const visible = writer.visible;
        updateMessage(chatId, assistantId, (m) => ({
          ...m,
          streaming: false,
          content: aborted && !visible ? "_Stopped._" : visible,
          error: aborted
            ? undefined
            : connection === "online"
              ? (err as Error)?.message || "Something went wrong. Please try again."
              : "Can't reach the server right now. It may be waking up — please try again in a few seconds.",
        }));
      } finally {
        writer.cancel();
        writerRef.current = null;
        controller.current = null;
        setBusy(false);
      }
    },
    [addMessage, updateMessage, connection],
  );

  const send = useCallback(
    (text: string) => {
      if (busy) return;
      let chat = activeChat;
      if (!chat) chat = createChat(null, titleFrom(text));
      else if (!chat.messages.length) updateChat(chat.id, { title: titleFrom(text) });
      addMessage(chat.id, { id: uid("msg"), role: "user", content: text, createdAt: Date.now() });
      run(chat.id, text);
    },
    [activeChat, addMessage, busy, createChat, run, updateChat],
  );

  const regenerate = useCallback(() => {
    if (!activeChat || busy) return;
    const msgs = activeChat.messages;
    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (!last || last.role !== "assistant" || !lastUser) return;
    removeMessagesFrom(activeChat.id, last.id);
    run(activeChat.id, lastUser.content);
  }, [activeChat, busy, removeMessagesFrom, run]);

  const stop = useCallback(() => {
    controller.current?.abort();
    writerRef.current?.flushAll();
  }, []);

  const newChat = useCallback(
    (folderId: string | null = null) => {
      if (activeChat && !activeChat.messages.length) {
        if (folderId !== undefined) updateChat(activeChat.id, { folderId });
      } else {
        createChat(folderId ?? null);
      }
      if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false);
      requestAnimationFrame(() => composer.current?.focus());
    },
    [activeChat, createChat, updateChat],
  );

  const openChat = useCallback(
    (id: string) => {
      selectChat(id);
      if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false);
    },
    [selectChat],
  );

  const removeChat = useCallback(
    (id: string) => {
      store.deleteChat(id);
      deleteThread(id);
    },
    [store],
  );

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    toast(`Indexing ${file.name}…`, "info");
    try {
      const res = await uploadDocument(file);
      toast(`${res.filename} added — ${res.chunks_indexed} sections indexed.`, "ok");
    } catch (err) {
      toast((err as Error).message || "Upload failed", "error");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const answeredBy = [...messages].reverse().find((m) => m.meta?.model)?.meta?.model?.split(":").pop();
  const activeModel = answeredBy ?? (health?.llm.find((p) => p.healthy) ?? health?.llm[0])?.model;
  const badge = activeModel ? `Self-RAG · ${activeModel.split("/").pop()}` : "Self-RAG";

  const composerNode = (
    <Composer ref={composer} onSend={send} onStop={stop} busy={busy} />
  );

  return (
    <div className="app-backdrop flex h-dvh w-full gap-3 overflow-hidden p-3">
      <Sidebar
        store={store}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newChat}
        onSelectChat={openChat}
        onDeleteChat={removeChat}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              onClick={() => setSidebarOpen((v) => !v)}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              {sidebarOpen ? <ChevronLeft className="size-5" /> : <MenuIcon className="size-5" />}
            </button>
            {editingTitle && activeChat ? (
              <input
                autoFocus
                defaultValue={activeChat.title}
                maxLength={60}
                onBlur={(e) => {
                  if (e.target.value.trim()) updateChat(activeChat.id, { title: e.target.value.trim() });
                  setEditingTitle(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="min-w-0 rounded-md border border-brand-500/40 bg-ink-900 px-2 py-1 text-[15px] text-white outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => activeChat && setEditingTitle(true)}
                title={activeChat ? "Rename chat" : undefined}
                className="min-w-0 truncate text-[15px] font-medium text-white"
              >
                {activeChat?.title ?? "Name chat"}
              </button>
            )}
            <span className="hidden shrink-0 items-center gap-1.5 rounded-md border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 font-mono text-[10px] text-brand-300 sm:inline-flex">
              <span
                className={clsx(
                  "size-1.5 rounded-full",
                  connection === "online" && "bg-brand-400",
                  (connection === "connecting" || connection === "waking") && "animate-pulse bg-amber-400",
                  connection === "offline" && "bg-red-400",
                )}
              />
              {connection === "waking" ? "Waking server…" : connection === "offline" ? "Offline" : badge}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Upload a document to the knowledge base"
              title="Upload PDF, DOCX, MD or TXT"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              className="grid size-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            >
              {uploading ? <Loader2 className="size-[18px] animate-spin" /> : <CloudUpload className="size-[18px]" />}
            </button>
            <button
              type="button"
              aria-label={activeChat?.pinned ? "Unpin chat" : "Pin chat"}
              disabled={!activeChat}
              onClick={() => activeChat && updateChat(activeChat.id, { pinned: !activeChat.pinned })}
              className="grid size-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
            >
              {activeChat?.pinned ? <BookmarkCheck className="size-[18px] text-brand-400" /> : <Bookmark className="size-[18px]" />}
            </button>
            <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
        </header>

        {messages.length === 0 ? (
          <div className="scroll-thin flex flex-1 items-center justify-center overflow-y-auto py-4">
            {(
              <Welcome
                composer={composerNode}
                onPrompt={(p) => composer.current?.setText(p)}
                onUpload={() => fileInput.current?.click()}
              />
            )}
          </div>
        ) : (
          <>
            <div
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className="scroll-thin flex-1 overflow-y-auto"
            >
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-1 py-6 sm:px-4">
                {messages.map((m, i) => (
                  <MessageView
                    key={m.id}
                    message={m}
                    isLast={i === messages.length - 1}
                    onRegenerate={i === messages.length - 1 && !busy ? regenerate : undefined}
                  />
                ))}
              </div>
            </div>
            <div className="mx-auto w-full max-w-3xl px-1 pt-2 sm:px-4">{composerNode}</div>
          </>
        )}

        <p className="shrink-0 px-2 pb-1 pt-2.5 text-center text-[11px] text-white/35">
          Aegis Copilot can make mistakes. Consider checking important information.
        </p>
      </main>

      <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "animate-fade-up rounded-xl border px-4 py-2.5 text-[13px] shadow-2xl shadow-black/50 backdrop-blur",
              t.tone === "ok" && "border-brand-500/30 bg-ink-800/95 text-brand-300",
              t.tone === "error" && "border-red-500/30 bg-ink-800/95 text-red-200",
              t.tone === "info" && "border-white/10 bg-ink-800/95 text-white/80",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
