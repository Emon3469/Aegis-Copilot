import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import { useChats } from "@/lib/useChats";

function setup() {
  const hook = renderHook(() => useChats());
  const store = hook.result;
  act(() => {
    const a = store.current.createChat("incidents", "Checkout 502 errors");
    store.current.addMessage(a.id, { id: "m1", role: "user", content: "502 after deploy", createdAt: 1 });
    const b = store.current.createChat(null, "Leave policy");
    store.current.addMessage(b.id, { id: "m2", role: "assistant", content: "Employees get **25** paid leave days", createdAt: 2 });
  });
  const handlers = { onClose: vi.fn(), onNewChat: vi.fn(), onSelectChat: vi.fn(), onDeleteChat: vi.fn() };
  const utils = render(<Sidebar store={store.current} open {...handlers} />);
  const rerender = () => utils.rerender(<Sidebar store={store.current} open {...handlers} />);
  return { store, handlers, rerender, user: userEvent.setup() };
}

const chatItems = () => screen.queryAllByText(/Checkout 502 errors|Leave policy/).map((n) => n.textContent);

describe("Sidebar", () => {
  it("lists folders and chats with previews", () => {
    setup();
    for (const name of ["Incidents", "Runbooks", "Deployments", "Postmortems"]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(chatItems()).toEqual(["Leave policy", "Checkout 502 errors"]);
    expect(screen.getByText("Employees get 25 paid leave days")).toBeInTheDocument();
  });

  it("searches titles and message content", async () => {
    const { user } = setup();
    await user.type(screen.getByPlaceholderText("Search"), "after deploy");
    expect(chatItems()).toEqual(["Checkout 502 errors"]);
    await user.clear(screen.getByPlaceholderText("Search"));
    await user.type(screen.getByPlaceholderText("Search"), "nothing matches");
    expect(screen.getByText("No chats match your search.")).toBeInTheDocument();
  });

  it("filters by folder and starts new chats inside it", async () => {
    const { user, handlers } = setup();
    await user.click(screen.getByText("Incidents"));
    expect(chatItems()).toEqual(["Checkout 502 errors"]);
    await user.click(screen.getByRole("button", { name: /^New chat/ }));
    expect(handlers.onNewChat).toHaveBeenCalledWith("incidents");
    await user.click(screen.getByText("Show all"));
    expect(chatItems()).toHaveLength(2);
  });

  it("selects a chat", async () => {
    const { user, handlers, store } = setup();
    await user.click(screen.getByText("Checkout 502 errors"));
    expect(handlers.onSelectChat).toHaveBeenCalledWith(store.current.chats.find((c) => c.title === "Checkout 502 errors")!.id);
  });

  it("renames, pins, moves and deletes via the menu", async () => {
    const { user, store, rerender, handlers } = setup();
    const chatId = store.current.chats.find((c) => c.title === "Leave policy")!.id;
    const id = () => chatId;

    await user.click(screen.getByRole("button", { name: "Leave policy options" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    rerender();
    expect(store.current.chats.find((c) => c.id === id())!.pinned).toBe(true);

    await user.click(screen.getByRole("button", { name: "Leave policy options" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Runbooks" }));
    rerender();
    expect(store.current.chats.find((c) => c.id === id())!.folderId).toBe("runbooks");

    await user.click(screen.getByRole("button", { name: "Leave policy options" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByDisplayValue("Leave policy");
    await user.clear(input);
    await user.type(input, "HR leave{Enter}");
    rerender();
    expect(store.current.chats.find((c) => c.id === id())!.title).toBe("HR leave");
    expect(handlers.onSelectChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "HR leave options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(handlers.onDeleteChat).toHaveBeenCalledWith(id());
  });

  it("closes menus with Escape", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Leave policy options" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("creates and renames folders", async () => {
    const { user, store, rerender } = setup();
    await user.click(screen.getByRole("button", { name: "New folder" }));
    rerender();
    const input = screen.getByDisplayValue("New folder");
    await user.clear(input);
    await user.type(input, "Clients{Enter}");
    rerender();
    expect(store.current.folders.at(-1)!.name).toBe("Clients");
    expect(screen.getByText("Chats")).toBeInTheDocument();
    const folder = screen.getByText("Clients").closest("[role=button]") as HTMLElement;
    await user.click(within(folder).getByRole("button", { name: "Clients options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    rerender();
    expect(screen.queryByText("Clients")).not.toBeInTheDocument();
  });
});
