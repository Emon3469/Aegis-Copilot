import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageView } from "@/components/MessageView";
import type { Message } from "@/lib/types";

const base: Message = { id: "a1", role: "assistant", content: "", createdAt: 0 };

function show(message: Partial<Message>, extra: { isLast?: boolean; onRegenerate?: () => void } = {}) {
  return render(<MessageView message={{ ...base, ...message }} isLast={extra.isLast ?? true} onRegenerate={extra.onRegenerate} />);
}

describe("MessageView", () => {
  it("renders user messages as plain text", () => {
    show({ role: "user", content: "**not bold** <b>raw</b>" });
    expect(screen.getByText("**not bold** <b>raw</b>")).toBeInTheDocument();
  });

  it("renders markdown, lists, tables and links safely", () => {
    show({
      content: "Summary with **bold**.\n\n1. First\n2. Second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[docs](https://k8s.io) <script>alert(1)</script>",
    });
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders code blocks with language and copy", async () => {
    const user = userEvent.setup();
    show({ content: "Run:\n\n```bash\nkubectl rollout undo deploy/checkout\n```" });
    expect(screen.getByText("bash")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("kubectl rollout undo deploy/checkout");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("keeps inline code inline", () => {
    show({ content: "Check `checkout-api` pods." });
    expect(screen.getByText("checkout-api").tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("shows live progress while streaming", () => {
    show({ streaming: true, steps: ["Planning the answer", "Searching the knowledge base"], content: "Partial" });
    expect(screen.getByText("Searching the knowledge base…")).toBeInTheDocument();
    expect(screen.queryByText("Planning the answer…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy answer" })).not.toBeInTheDocument();
  });

  it("shows a typing indicator before the first token", () => {
    const { container } = show({ streaming: true, steps: [] });
    expect(container.querySelectorAll(".animate-bounce")).toHaveLength(3);
  });

  it("collapses reasoning steps after completion", async () => {
    const user = userEvent.setup();
    show({ content: "Done", steps: ["Planning the answer", "Writing the answer"] });
    expect(screen.queryByText("Planning the answer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Reasoning steps/ }));
    expect(screen.getByText("Planning the answer")).toBeInTheDocument();
  });

  it("renders sources and answer metadata", () => {
    show({
      content: "Answer",
      sources: [
        { type: "internal", title: "sop.pdf", source: "sop.pdf", page: 3 },
        { type: "web", title: "Kubernetes releases", source: "https://k8s.io/releases", url: "https://k8s.io/releases" },
      ],
      meta: { route: "Knowledge Base", model: "groq:openai/gpt-oss-120b", latency_ms: 4250, support_status: "fully_supported" },
    });
    expect(screen.getByText("sop.pdf")).toBeInTheDocument();
    expect(screen.getByText("p.3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kubernetes releases/ })).toHaveAttribute("href", "https://k8s.io/releases");
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByText("grounded")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-oss-120b")).toBeInTheDocument();
    expect(screen.getByText("4.3s")).toBeInTheDocument();
  });

  it("flags partially grounded answers", () => {
    show({ content: "Answer", meta: { support_status: "partially_supported" } });
    expect(screen.getByText("partly grounded")).toBeInTheDocument();
  });

  it("shows errors", () => {
    show({ error: "The assistant is temporarily unavailable." });
    expect(screen.getByText("The assistant is temporarily unavailable.")).toBeInTheDocument();
  });

  it("copies the full answer and regenerates only on the last message", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const { rerender } = show({ content: "Full **answer**" }, { onRegenerate });
    await user.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(await navigator.clipboard.readText()).toBe("Full **answer**");
    await user.click(screen.getByRole("button", { name: "Regenerate answer" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
    rerender(<MessageView message={{ ...base, content: "x" }} isLast={false} onRegenerate={onRegenerate} />);
    expect(screen.queryByRole("button", { name: "Regenerate answer" })).not.toBeInTheDocument();
  });

  it("does not render metadata for in-flight answers", () => {
    const { container } = show({ streaming: true, content: "abc", sources: [{ type: "internal", title: "x.md", source: "x.md" }] });
    expect(within(container).queryByText("x.md")).not.toBeInTheDocument();
  });
});
