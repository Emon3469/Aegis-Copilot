"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Globe,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Source } from "@/lib/types";
import { Logo } from "./Logo";

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return { copied, copy };
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-ink-950/80">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-white/40">{language || "code"}</span>
        <button
          type="button"
          onClick={() => copy(code)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scroll-thin overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed text-[#d7f7e0]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || "");
    const text = String(children ?? "");
    if (!match && !text.includes("\n")) return <code>{children}</code>;
    return <CodeBlock language={match?.[1] ?? ""} code={text.replace(/\n$/, "")} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
});

function SourceChip({ source }: { source: Source }) {
  const web = source.type === "web";
  const label = source.title || source.source || "Source";
  const body = (
    <>
      {web ? <Globe className="size-3 shrink-0" /> : <FileText className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
      {source.page ? <span className="text-white/35">p.{source.page}</span> : null}
    </>
  );
  const cls =
    "flex max-w-[260px] items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/70 transition";
  return web && source.url ? (
    <a href={source.url} target="_blank" rel="noopener noreferrer" className={clsx(cls, "hover:border-brand-500/40 hover:text-white")}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" | "warn" }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px]",
        tone === "brand" && "bg-brand-500/15 text-brand-300",
        tone === "warn" && "bg-amber-500/15 text-amber-300",
        tone === "neutral" && "bg-white/[0.06] text-white/50",
      )}
    >
      {children}
    </span>
  );
}

function Steps({ steps, live }: { steps: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const current = steps[steps.length - 1];

  if (live) {
    return (
      <div className="mb-3 flex items-center gap-2 text-[13px]">
        <Loader2 className="size-3.5 animate-spin text-brand-400" />
        <span className="shimmer-text">{current}…</span>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] text-white/40 transition hover:text-white/70"
      >
        <ShieldCheck className="size-3.5" />
        Reasoning steps
        <ChevronDown className={clsx("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="mt-2 space-y-1 border-l border-white/10 pl-3">
          {steps.map((s, i) => (
            <li key={`${s}-${i}`} className="flex items-center gap-2 text-[12px] text-white/50">
              <Check className="size-3 text-brand-500" />
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const SUPPORT_LABEL: Record<string, string> = {
  fully_supported: "grounded",
  partially_supported: "partly grounded",
  no_support: "unverified",
};

interface MessageViewProps {
  message: Message;
  isLast: boolean;
  onRegenerate?: () => void;
}

export const MessageView = memo(function MessageView({ message, isLast, onRegenerate }: MessageViewProps) {
  const { copied, copy } = useCopy();

  if (message.role === "user") {
    return (
      <div className="flex animate-fade-up justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-500/[0.16] px-4 py-2.5 text-[14px] leading-relaxed text-white ring-1 ring-brand-500/25 sm:max-w-[75%]">
          {message.content}
        </div>
      </div>
    );
  }

  const { meta, sources = [], steps = [], streaming, error } = message;
  const waiting = streaming && !message.content;
  const support = meta?.support_status ? SUPPORT_LABEL[meta.support_status] : "";

  return (
    <div className="flex animate-fade-up gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-ink-950 ring-1 ring-white/10">
        <Logo className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <Steps steps={steps} live={!!streaming} />

        {waiting && !steps.length && (
          <div className="flex h-6 items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand-400" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}

        {message.content && (
          <div className="markdown">
            <Markdown text={message.content} />
            {streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-blink rounded-[1px] bg-brand-400" />}
          </div>
        )}

        {error && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-3 py-2.5 text-[13px] text-red-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!streaming && sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sources.map((s, i) => (
              <SourceChip key={`${s.source}-${s.page ?? ""}-${i}`} source={s} />
            ))}
          </div>
        )}

        {!streaming && (message.content || error) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {message.content && (
              <button
                type="button"
                onClick={() => copy(message.content)}
                aria-label="Copy answer"
                className="grid size-7 place-items-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            )}
            {isLast && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                aria-label="Regenerate answer"
                className="grid size-7 place-items-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white"
              >
                <RefreshCw className="size-3.5" />
              </button>
            )}
            {meta?.route && <Badge tone="brand">{meta.route}</Badge>}
            {support && <Badge tone={meta?.support_status === "fully_supported" ? "brand" : "warn"}>{support}</Badge>}
            {meta?.model && <Badge>{meta.model.split(":").pop()}</Badge>}
            {meta?.latency_ms ? <Badge>{(meta.latency_ms / 1000).toFixed(1)}s</Badge> : null}
          </div>
        )}
      </div>
    </div>
  );
});
