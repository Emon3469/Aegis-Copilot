import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Welcome } from "@/components/Welcome";
import { json } from "../helpers";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function setup() {
  const onPrompt = vi.fn();
  const onUpload = vi.fn();
  render(<Welcome onPrompt={onPrompt} onUpload={onUpload} composer={<div>composer slot</div>} />);
  return { onPrompt, onUpload, user: userEvent.setup() };
}

describe("Welcome", () => {
  it("matches the landing layout", () => {
    setup();
    expect(screen.getByRole("heading", { name: "How can I help you today?" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "Runbooks", "Incidents", "Deployments", "Web", "Analytics"]);
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    for (const t of ["Saved Prompt Templates", "Knowledge Upload", "Multilingual Support"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText("composer slot")).toBeInTheDocument();
  });

  it("feature cards trigger actions", async () => {
    const { user, onUpload, onPrompt } = setup();
    await user.click(screen.getByText("Knowledge Upload"));
    expect(onUpload).toHaveBeenCalled();
    await user.click(screen.getByText("Multilingual Support"));
    expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining("Bangla"));
    await user.click(screen.getByText("Saved Prompt Templates"));
    expect(screen.getByRole("tab", { name: "Incidents" })).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    ["Runbooks", "High CPU procedure", /CPU has been above 85%/],
    ["Incidents", "Retry storms", /retry storm/],
    ["Deployments", "Rollback SOP", /rollback SOP/],
    ["Web", "Latest Kubernetes", /Kubernetes/],
  ])("%s tab fills a prompt", async (tab, card, prompt) => {
    const { user, onPrompt } = setup();
    await user.click(screen.getByRole("tab", { name: tab }));
    await user.click(screen.getByText(card));
    expect(onPrompt).toHaveBeenCalledWith(expect.stringMatching(prompt));
  });

  it("analytics tab shows live stats", async () => {
    fetchMock.mockResolvedValueOnce(json({ total: 42, avg_latency_ms: 5320, web_searches: 3, grounded_rate: 88.1, routes: {} }));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Analytics" }));
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("5.3s")).toBeInTheDocument();
    expect(screen.getByText("88.1%")).toBeInTheDocument();
  });

  it("analytics degrades when offline", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Analytics" }));
    expect(await screen.findByText(/unavailable while the server is offline/)).toBeInTheDocument();
  });
});
