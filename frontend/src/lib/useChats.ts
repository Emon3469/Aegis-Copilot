"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Chat, Folder, Message } from "./types";

const STORAGE_KEY = "aegis.workspace.v1";

const DEFAULT_FOLDERS: Folder[] = [
  { id: "incidents", name: "Incidents" },
  { id: "runbooks", name: "Runbooks" },
  { id: "deployments", name: "Deployments" },
  { id: "postmortems", name: "Postmortems" },
];

interface Workspace {
  chats: Chat[];
  folders: Folder[];
  activeId: string | null;
}

export function uid(prefix = ""): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${id}` : id;
}

function load(): Workspace {
  const empty: Workspace = { chats: [], folders: DEFAULT_FOLDERS, activeId: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw) as Partial<Workspace>;
    const chats = (data.chats ?? []).map((c) => ({
      ...c,
      messages: c.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    }));
    return {
      chats,
      folders: data.folders?.length ? data.folders : DEFAULT_FOLDERS,
      activeId: data.activeId && chats.some((c) => c.id === data.activeId) ? data.activeId : null,
    };
  } catch {
    return empty;
  }
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean || "New chat";
}

export function useChats() {
  const [state, setState] = useState<Workspace>(load);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {}
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state]);

  const activeChat = state.chats.find((c) => c.id === state.activeId) ?? null;

  const createChat = useCallback((folderId: string | null = null, title = "New chat"): Chat => {
    const now = Date.now();
    const chat: Chat = { id: uid("chat"), title, folderId, createdAt: now, updatedAt: now, messages: [] };
    setState((s) => ({ ...s, chats: [chat, ...s.chats], activeId: chat.id }));
    return chat;
  }, []);

  const selectChat = useCallback((id: string | null) => {
    setState((s) => ({ ...s, activeId: id }));
  }, []);

  const updateChat = useCallback((id: string, patch: Partial<Chat>) => {
    setState((s) => ({
      ...s,
      chats: s.chats.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }, []);

  const deleteChat = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      chats: s.chats.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  }, []);

  const addMessage = useCallback((chatId: string, message: Message) => {
    setState((s) => ({
      ...s,
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, messages: [...c.messages, message], updatedAt: Date.now() } : c,
      ),
    }));
  }, []);

  const updateMessage = useCallback((chatId: string, messageId: string, fn: (m: Message) => Message) => {
    setState((s) => ({
      ...s,
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? fn(m) : m)) } : c,
      ),
    }));
  }, []);

  const removeMessagesFrom = useCallback((chatId: string, messageId: string) => {
    setState((s) => ({
      ...s,
      chats: s.chats.map((c) => {
        if (c.id !== chatId) return c;
        const idx = c.messages.findIndex((m) => m.id === messageId);
        return idx === -1 ? c : { ...c, messages: c.messages.slice(0, idx) };
      }),
    }));
  }, []);

  const addFolder = useCallback((name: string): Folder => {
    const folder = { id: uid("folder"), name: name.trim() || "New folder" };
    setState((s) => ({ ...s, folders: [...s.folders, folder] }));
    return folder;
  }, []);

  const renameFolder = useCallback((id: string, name: string) => {
    setState((s) => ({ ...s, folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)) }));
  }, []);

  const deleteFolder = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      folders: s.folders.filter((f) => f.id !== id),
      chats: s.chats.map((c) => (c.folderId === id ? { ...c, folderId: null } : c)),
    }));
  }, []);

  return {
    chats: state.chats,
    folders: state.folders,
    activeId: state.activeId,
    activeChat,
    createChat,
    selectChat,
    updateChat,
    deleteChat,
    addMessage,
    updateMessage,
    removeMessagesFrom,
    addFolder,
    renameFolder,
    deleteFolder,
  };
}

export type ChatStore = ReturnType<typeof useChats>;
