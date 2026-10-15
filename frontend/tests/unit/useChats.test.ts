import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { titleFrom, uid, useChats } from "@/lib/useChats";

const KEY = "aegis.workspace.v1";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  return renderHook(() => useChats());
}

describe("useChats", () => {
  it("starts with default folders and no chats", () => {
    const { result } = setup();
    expect(result.current.chats).toEqual([]);
    expect(result.current.folders.map((f) => f.name)).toEqual(["Incidents", "Runbooks", "Deployments", "Postmortems"]);
    expect(result.current.activeChat).toBeNull();
  });

  it("creates, selects and updates chats", () => {
    const { result } = setup();
    let id = "";
    act(() => {
      id = result.current.createChat("incidents", "CPU alert").id;
    });
    expect(result.current.activeId).toBe(id);
    expect(result.current.activeChat?.folderId).toBe("incidents");
    act(() => result.current.updateChat(id, { title: "Renamed", pinned: true }));
    expect(result.current.activeChat).toMatchObject({ title: "Renamed", pinned: true });
    act(() => result.current.selectChat(null));
    expect(result.current.activeChat).toBeNull();
  });

  it("adds and streams into messages", () => {
    const { result } = setup();
    let id = "";
    act(() => {
      id = result.current.createChat().id;
    });
    act(() => {
      result.current.addMessage(id, { id: "m1", role: "user", content: "hi", createdAt: 1 });
      result.current.addMessage(id, { id: "m2", role: "assistant", content: "", createdAt: 2, streaming: true });
    });
    act(() => {
      for (const t of ["Hel", "lo"]) result.current.updateMessage(id, "m2", (m) => ({ ...m, content: m.content + t }));
    });
    expect(result.current.activeChat?.messages.map((m) => m.content)).toEqual(["hi", "Hello"]);
    act(() => result.current.removeMessagesFrom(id, "m2"));
    expect(result.current.activeChat?.messages).toHaveLength(1);
  });

  it("persists to localStorage after a debounce and restores on reload", () => {
    const { result, unmount } = setup();
    act(() => {
      const c = result.current.createChat(null, "Persist me");
      result.current.addMessage(c.id, { id: "m", role: "assistant", content: "partial", createdAt: 1, streaming: true });
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    act(() => vi.advanceTimersByTime(450));
    expect(JSON.parse(window.localStorage.getItem(KEY)!).chats[0].title).toBe("Persist me");
    unmount();

    const reloaded = setup();
    expect(reloaded.result.current.chats[0].title).toBe("Persist me");
    expect(reloaded.result.current.activeChat?.messages[0].streaming).toBe(false);
  });

  it("survives corrupted storage", () => {
    window.localStorage.setItem(KEY, "{not json");
    const { result } = setup();
    expect(result.current.chats).toEqual([]);
    expect(result.current.folders).toHaveLength(4);
  });

  it("drops a stale active id", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ chats: [], folders: [], activeId: "gone" }));
    const { result } = setup();
    expect(result.current.activeId).toBeNull();
    expect(result.current.folders).toHaveLength(4);
  });

  it("deletes the active chat", () => {
    const { result } = setup();
    let id = "";
    act(() => {
      id = result.current.createChat().id;
    });
    act(() => result.current.deleteChat(id));
    expect(result.current.chats).toHaveLength(0);
    expect(result.current.activeId).toBeNull();
  });

  it("manages folders and unfiles chats when a folder is deleted", () => {
    const { result } = setup();
    let folderId = "";
    act(() => {
      folderId = result.current.addFolder("  Clients  ").id;
    });
    expect(result.current.folders.at(-1)?.name).toBe("Clients");
    act(() => {
      result.current.createChat(folderId);
      result.current.renameFolder(folderId, "   ");
    });
    expect(result.current.folders.at(-1)?.name).toBe("Clients");
    act(() => result.current.renameFolder(folderId, "Customers"));
    expect(result.current.folders.at(-1)?.name).toBe("Customers");
    act(() => result.current.deleteFolder(folderId));
    expect(result.current.folders.find((f) => f.id === folderId)).toBeUndefined();
    expect(result.current.chats[0].folderId).toBeNull();
  });
});

describe("helpers", () => {
  it("builds readable titles", () => {
    expect(titleFrom("  payments   cpu\nhigh ")).toBe("payments cpu high");
    expect(titleFrom("x".repeat(60))).toHaveLength(43);
    expect(titleFrom("   ")).toBe("New chat");
  });

  it("generates unique, backend-safe ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => uid("chat")));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_\-:.]{3,120}$/);
  });
});
