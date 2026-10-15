"use client";

import clsx from "clsx";
import {
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatStore } from "@/lib/useChats";
import type { Chat } from "@/lib/types";
import { Logo } from "./Logo";
import { Menu, type MenuItem } from "./Menu";

interface SidebarProps {
  store: ChatStore;
  open: boolean;
  onClose: () => void;
  onNewChat: (folderId?: string | null) => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
}

function preview(chat: Chat): string {
  const last = [...chat.messages].reverse().find((m) => m.content);
  if (!last) return "No messages yet";
  return last.content.replace(/[#*_`>|\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
}

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(value);
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(text);
        if (e.key === "Escape") onDone(null);
      }}
      maxLength={60}
      className="w-full rounded-md border border-brand-500/50 bg-ink-900 px-2 py-1 text-[13px] text-white outline-none"
    />
  );
}

export function Sidebar({ store, open, onClose, onNewChat, onSelectChat, onDeleteChat }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const { chats, folders, activeId } = store;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats
      .filter((c) => (folderFilter ? c.folderId === folderFilter : true))
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          c.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }, [chats, folderFilter, query]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of chats) if (c.folderId) map[c.folderId] = (map[c.folderId] ?? 0) + 1;
    return map;
  }, [chats]);

  const chatMenu = (chat: Chat): MenuItem[] => [
    { label: "Rename", icon: <Pencil className="size-3.5" />, onSelect: () => setEditing(chat.id) },
    {
      label: chat.pinned ? "Unpin" : "Pin to top",
      icon: chat.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />,
      onSelect: () => store.updateChat(chat.id, { pinned: !chat.pinned }),
    },
    ...folders
      .filter((f) => f.id !== chat.folderId)
      .map((f) => ({
        label: `Move to ${f.name}`,
        icon: <FolderInput className="size-3.5" />,
        onSelect: () => store.updateChat(chat.id, { folderId: f.id }),
      })),
    ...(chat.folderId
      ? [{ label: "Remove from folder", icon: <FolderIcon className="size-3.5" />, onSelect: () => store.updateChat(chat.id, { folderId: null }) }]
      : []),
    { label: "Delete chat", icon: <Trash2 className="size-3.5" />, danger: true, onSelect: () => onDeleteChat(chat.id) },
  ];

  return (
    <>
      <div
        onClick={onClose}
        className={clsx(
          "fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        className={clsx(
          "glass fixed inset-y-3 left-3 z-40 flex w-[280px] flex-col rounded-2xl p-3 transition-transform duration-300 lg:static lg:inset-auto lg:z-auto lg:h-full lg:shrink-0",
          open ? "translate-x-0" : "-translate-x-[calc(100%+24px)] lg:hidden",
        )}
        aria-label="Chat history"
      >
        <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-2.5 py-2">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-full bg-ink-950 ring-1 ring-white/10">
              <Logo className="size-5" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white">My Chats</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Filter folders"
              onClick={() => setFolderFilter(null)}
              className="grid size-7 place-items-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              <SlidersHorizontal className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={onClose}
              className="grid size-7 place-items-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white lg:hidden"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-ink-950/60 px-3 py-2 focus-within:border-brand-500/40">
          <Search className="size-4 text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-sm text-white placeholder:text-white/35 outline-none"
          />
        </label>

        <div className="scroll-thin mt-4 flex-1 overflow-y-auto pr-1">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-white/50">Folders</span>
            <button
              type="button"
              aria-label="New folder"
              onClick={() => {
                const f = store.addFolder("New folder");
                setEditing(f.id);
              }}
              className="grid size-5 place-items-center rounded bg-white/[0.06] text-white/60 transition hover:bg-white/15 hover:text-white"
            >
              <FolderPlus className="size-3" />
            </button>
          </div>

          <ul className="space-y-1.5">
            {folders.map((f) => {
              const active = folderFilter === f.id;
              return (
                <li key={f.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setFolderFilter(active ? null : f.id)}
                    onKeyDown={(e) => e.key === "Enter" && setFolderFilter(active ? null : f.id)}
                    className={clsx(
                      "group relative flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border py-2.5 pl-3.5 pr-2 text-[13px] transition",
                      active
                        ? "border-brand-500/30 bg-brand-500/10 text-white"
                        : "border-white/[0.05] bg-white/[0.045] text-white/80 hover:bg-white/[0.08]",
                    )}
                  >
                    <span className={clsx("absolute inset-y-0 left-0 w-[3px]", active ? "bg-brand-500" : "bg-white/70")} />
                    <FolderIcon className="size-4 shrink-0 text-white/70" />
                    {editing === f.id ? (
                      <InlineEdit
                        value={f.name}
                        onDone={(v) => {
                          if (v !== null) store.renameFolder(f.id, v);
                          setEditing(null);
                        }}
                      />
                    ) : (
                      <span className="flex-1 truncate">{f.name}</span>
                    )}
                    {!!counts[f.id] && editing !== f.id && (
                      <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-white/60">{counts[f.id]}</span>
                    )}
                    <Menu
                      label={`${f.name} options`}
                      items={[
                        { label: "New chat here", icon: <Plus className="size-3.5" />, onSelect: () => onNewChat(f.id) },
                        { label: "Rename", icon: <Pencil className="size-3.5" />, onSelect: () => setEditing(f.id) },
                        {
                          label: "Delete folder",
                          icon: <Trash2 className="size-3.5" />,
                          danger: true,
                          onSelect: () => {
                            if (folderFilter === f.id) setFolderFilter(null);
                            store.deleteFolder(f.id);
                          },
                        },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mb-2 mt-5 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-white/50">
              {folderFilter ? folders.find((f) => f.id === folderFilter)?.name ?? "Chats" : "Chats"}
            </span>
            {folderFilter && (
              <button type="button" onClick={() => setFolderFilter(null)} className="text-[11px] text-brand-400 hover:underline">
                Show all
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-white/35">
              {query ? "No chats match your search." : "No chats yet. Start a new one below."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((chat) => (
                <li key={chat.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectChat(chat.id)}
                    onKeyDown={(e) => e.key === "Enter" && onSelectChat(chat.id)}
                    className={clsx(
                      "group flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition",
                      chat.id === activeId
                        ? "border-brand-500/30 bg-brand-500/[0.09]"
                        : "border-white/[0.05] bg-white/[0.045] hover:bg-white/[0.08]",
                    )}
                  >
                    <MessageSquareText className="mt-0.5 size-4 shrink-0 text-white/70" />
                    <div className="min-w-0 flex-1">
                      {editing === chat.id ? (
                        <InlineEdit
                          value={chat.title}
                          onDone={(v) => {
                            if (v !== null && v.trim()) store.updateChat(chat.id, { title: v.trim() });
                            setEditing(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {chat.pinned && <Pin className="size-3 shrink-0 text-brand-400" />}
                          <p className="truncate text-[13px] font-medium text-white/90">{chat.title}</p>
                        </div>
                      )}
                      <p className="mt-0.5 truncate text-[11px] text-white/40">{preview(chat)}</p>
                    </div>
                    <Menu items={chatMenu(chat)} label={`${chat.title} options`} className="opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={() => onNewChat(folderFilter)}
          className="mt-3 flex items-center justify-between rounded-xl bg-brand-500 px-4 py-3.5 text-left text-[15px] font-medium text-white shadow-lg shadow-brand-700/30 transition hover:bg-brand-400 active:scale-[0.99]"
        >
          New chat
          <span className="grid size-7 place-items-center rounded-lg bg-white text-ink-900">
            <Plus className="size-4" strokeWidth={2.5} />
          </span>
        </button>
      </aside>
    </>
  );
}
