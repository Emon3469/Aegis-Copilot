"use client";

import clsx from "clsx";
import { ArrowRight, Mic, MicOff, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Logo } from "./Logo";

export interface ComposerHandle {
  setText: (text: string) => void;
  focus: () => void;
}

interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
}

interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

type SpeechCtor = new () => SpeechRecognitionLike;

function getSpeech(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, onStop, busy, placeholder = "Type your prompt here..." },
  ref,
) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported] = useState(() => !!getSpeech());
  const area = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const baseText = useRef("");

  useImperativeHandle(ref, () => ({
    setText: (value: string) => {
      setText(value);
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(value.length, value.length);
      });
    },
    focus: () => area.current?.focus(),
  }));

  useEffect(() => () => recognition.current?.stop(), []);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    recognition.current?.stop();
    onSend(value);
    setText("");
  };

  const toggleMic = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = getSpeech();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    baseText.current = text ? `${text.trimEnd()} ` : "";
    rec.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      setText(baseText.current + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 rounded-xl bg-[#f2f4f3] p-1.5 pl-3 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)] ring-1 ring-black/5 transition focus-within:ring-2 focus-within:ring-brand-500/60"
    >
      <span className="mb-2 grid size-6 shrink-0 place-items-center rounded-full bg-ink-900">
        <Logo className="size-4" />
      </span>
      <label htmlFor="prompt" className="sr-only">
        Message
      </label>
      <textarea
        id="prompt"
        ref={area}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={listening ? "Listening…" : placeholder}
        maxLength={4000}
        className="scroll-thin max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-5 text-ink-900 placeholder:text-ink-500/70 outline-none"
      />
      {speechSupported && (
        <button
          type="button"
          onClick={toggleMic}
          aria-label={listening ? "Stop voice input" : "Start voice input"}
          className={clsx(
            "mb-0.5 grid size-9 shrink-0 place-items-center rounded-lg transition",
            listening ? "bg-red-500/15 text-red-600" : "text-ink-500 hover:bg-black/5 hover:text-ink-800",
          )}
        >
          {listening ? <MicOff className="size-[18px]" /> : <Mic className="size-[18px]" />}
        </button>
      )}
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop generating"
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-900 text-white transition hover:bg-ink-700"
        >
          <Square className="size-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send message"
          disabled={!text.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-white shadow-md shadow-brand-700/30 transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowRight className="size-[18px]" strokeWidth={2.5} />
        </button>
      )}
    </form>
  );
});
