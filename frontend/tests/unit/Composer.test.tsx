import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerHandle } from "@/components/Composer";

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const ref = createRef<ComposerHandle>();
  render(<Composer ref={ref} onSend={onSend} onStop={onStop} busy={false} {...props} />);
  return { onSend, onStop, ref, box: screen.getByRole("textbox", { name: "Message" }), user: userEvent.setup() };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

describe("Composer", () => {
  it("sends trimmed text on Enter and clears", async () => {
    const { onSend, box, user } = setup();
    await user.type(box, "  payments cpu high  {Enter}");
    expect(onSend).toHaveBeenCalledWith("payments cpu high");
    expect(box).toHaveValue("");
  });

  it("inserts a newline with Shift+Enter", async () => {
    const { onSend, box, user } = setup();
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("line one\nline two");
  });

  it("disables send for empty input", async () => {
    const { onSend, box, user } = setup();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.type(box, "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends with the button", async () => {
    const { onSend, box, user } = setup();
    await user.type(box, "rollback?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("rollback?");
  });

  it("shows stop while busy and blocks sending", async () => {
    const { onSend, onStop, box, user } = setup({ busy: true });
    await user.type(box, "another{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("can be filled programmatically", async () => {
    const { ref, box } = setup();
    act(() => ref.current?.setText("Walk me through the rollback SOP"));
    expect(box).toHaveValue("Walk me through the rollback SOP");
  });

  it("caps input length", () => {
    const { box } = setup();
    expect(box).toHaveAttribute("maxLength", "4000");
  });

  it("hides voice input when unsupported", () => {
    setup();
    expect(screen.queryByRole("button", { name: /voice input/ })).not.toBeInTheDocument();
  });

  it("transcribes speech into the box", async () => {
    const created: { onresult: ((e: unknown) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }[] = [];
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onend?.());
      constructor() {
        created.push(this);
      }
    }
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
    const { box, user } = setup();
    await user.type(box, "Note:");
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(created[0].start).toHaveBeenCalled();
    act(() => created[0].onresult!({ resultIndex: 0, results: [[{ transcript: "checkout is down" }]] }));
    expect(box).toHaveValue("Note: checkout is down");
    await user.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeInTheDocument();
  });
});
