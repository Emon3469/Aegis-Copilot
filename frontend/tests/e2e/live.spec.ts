import { API, expect, send, test } from "./fixtures";

test.describe("live backend @live", () => {
  test("answers from the knowledge base with real token streaming", async ({ page, consoleErrors }) => {
    await page.goto("/");
    await expect(page.getByText(/^Self-RAG · /)).toBeVisible({ timeout: 90_000 });

    const streamResponse = page.waitForResponse((r) => r.url() === `${API}/api/chat/stream`);
    await send(page, "Payments service CPU has been above 85% for 10 minutes. What should I check first?");
    const res = await streamResponse;
    expect(res.headers()["content-type"]).toContain("text/event-stream");

    await expect(page.getByText(/Searching the knowledge base|Checking|Writing the answer/).first()).toBeVisible();

    const answer = page.locator(".markdown").last();
    const lengths: number[] = [];
    for (let i = 0; i < 120; i++) {
      const len = ((await answer.textContent().catch(() => "")) ?? "").length;
      if (len && lengths.at(-1) !== len) lengths.push(len);
      if (await page.getByText("Knowledge Base", { exact: true }).isVisible()) break;
      await page.waitForTimeout(50);
    }
    expect(lengths.length, `observed answer lengths ${lengths.join(",")}`).toBeGreaterThanOrEqual(3);

    await expect(page.getByText("Knowledge Base", { exact: true })).toBeVisible();
    await expect(answer).toContainText(/traffic|replica|CPU/i);
    await expect(page.getByText("payments-high-cpu-runbook.md")).toBeVisible();
    await page.screenshot({ path: "test-results/live-answer.png", fullPage: true });

    await send(page, "And if it started right after a deployment?");
    await expect(page.locator(".markdown")).toHaveCount(2);
    await expect(page.getByText("Knowledge Base", { exact: true })).toHaveCount(2, { timeout: 90_000 });
    await expect(page.locator(".markdown").last()).toContainText(/roll ?back/i);
    expect(consoleErrors).toEqual([]);
  });

  test("small talk is answered quickly without retrieval", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/^Self-RAG · /)).toBeVisible({ timeout: 90_000 });
    const started = Date.now();
    await send(page, "Hi there!");
    await expect(page.getByText("General Knowledge", { exact: true })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
