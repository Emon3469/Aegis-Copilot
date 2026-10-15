import { answerEvents, expect, mockApi, send, test } from "./fixtures";

test.describe("Aegis Copilot UI", () => {
  test("landing page renders the full layout without errors", async ({ page, consoleErrors }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page).toHaveTitle("Aegis Copilot");
    await expect(page.getByRole("heading", { name: "How can I help you today?" })).toBeVisible();
    await expect(page.getByText("Self-RAG · gpt-oss-120b")).toBeVisible();
    for (const t of ["Saved Prompt Templates", "Knowledge Upload", "Multilingual Support"]) await expect(page.getByText(t)).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(6);
    for (const f of ["Incidents", "Runbooks", "Deployments", "Postmortems"]) await expect(page.getByRole("complementary").getByText(f, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^New chat/ })).toBeVisible();
    await expect(page.getByText("Aegis Copilot can make mistakes.", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/landing-desktop.png" });
    expect(consoleErrors).toEqual([]);
  });

  test("favicon and metadata are served", async ({ page, request }) => {
    await page.goto("/");
    const href = await page.locator('link[rel="icon"]').first().getAttribute("href");
    expect(href).toContain("icon.svg");
    const icon = await request.get(href!);
    expect(icon.ok()).toBeTruthy();
    expect(icon.headers()["content-type"]).toContain("image/svg+xml");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Incident-response copilot/);
  });

  test("a full conversation streams, renders and persists", async ({ page, consoleErrors }) => {
    const api = await mockApi(page);
    await page.goto("/");
    await send(page, "Payments CPU is above 85% for 10 minutes. What should I do?");

    await expect(page.locator(".markdown").last()).toContainText("Compare CPU across replicas.");
    await expect(page.getByText("Knowledge Base")).toBeVisible();
    await expect(page.getByText("grounded", { exact: true })).toBeVisible();
    await expect(page.getByText("4.8s")).toBeVisible();
    await expect(page.getByText("payments-high-cpu-runbook.md")).toBeVisible();
    await expect(page.locator("pre code")).toHaveText("kubectl top pods -l app=payments");
    await expect(page.locator("header").getByRole("button", { name: "Payments CPU is above 85% for 10 minutes.…", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Chat history" }).getByText("Payments CPU is above 85% for 10", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

    await send(page, "And if it started after a deploy?");
    await expect(page.getByText("Knowledge Base")).toHaveCount(2);
    expect(api.chatBodies).toHaveLength(2);
    expect(api.chatBodies[0].thread_id).toBe(api.chatBodies[1].thread_id);

    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.getByText("And if it started after a deploy?", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".markdown")).toHaveCount(2);
    await page.screenshot({ path: "test-results/conversation-desktop.png" });
    expect(consoleErrors).toEqual([]);
  });

  test("prompt cards fill the composer", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Deployments" }).click();
    await page.getByText("Rollback SOP").click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/rollback SOP/);
    await page.getByRole("tab", { name: "Analytics" }).click();
    await expect(page.getByText("91.7%")).toBeVisible();
  });

  test("server errors are shown inline and the user can retry", async ({ page }) => {
    const api = await mockApi(page);
    api.setStream([{ type: "status", text: "Planning" }, { type: "error", message: "The assistant is temporarily unavailable. Please try again in a moment." }]);
    await page.goto("/");
    await send(page, "anything");
    await expect(page.getByText("temporarily unavailable", { exact: false })).toBeVisible();
    api.setStream(answerEvents("Recovered answer."));
    await page.getByRole("button", { name: "Regenerate answer" }).click();
    await expect(page.locator(".markdown").last()).toHaveText("Recovered answer.");
  });

  test("documents can be uploaded", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({ name: "incident-sop.md", mimeType: "text/markdown", buffer: Buffer.from("# SOP\nRestart safely") });
    await expect(page.getByText("incident-sop.md added — 3 sections indexed.")).toBeVisible();
  });

  test("chats can be organised and deleted", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/");
    await send(page, "Checkout 502 after deploy");
    await expect(page.getByText("Knowledge Base")).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "Chat history" });
    await sidebar.getByRole("button", { name: "Checkout 502 after deploy options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to Incidents" }).click();
    await sidebar.getByText("Runbooks", { exact: true }).click();
    await expect(sidebar.getByText("No chats yet.", { exact: false })).toBeVisible();
    await sidebar.getByText("Incidents", { exact: true }).click();
    await expect(sidebar.getByText("Checkout 502 after deploy")).toBeVisible();
    await sidebar.getByRole("button", { name: "Checkout 502 after deploy options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    await expect(page.getByRole("heading", { name: "How can I help you today?" })).toBeVisible();
    expect(api.deleted).toHaveLength(1);
  });

  test("shows waking state when the backend is asleep", async ({ page }) => {
    await page.route("**/api/health", (r) => r.abort());
    await page.goto("/");
    await expect(page.getByText("Waking server…")).toBeVisible({ timeout: 15_000 });
  });

  test("mobile layout uses a drawer @mobile", async ({ page, consoleErrors }) => {
    await mockApi(page);
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Chat history" });
    await expect(sidebar).not.toBeInViewport();
    await expect(page.getByRole("heading", { name: "How can I help you today?" })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(sidebar).toBeInViewport();
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(sidebar).not.toBeInViewport();
    await send(page, "Payments CPU high on mobile");
    await expect(page.locator(".markdown").last()).toContainText("Compare CPU across replicas.");
    await page.screenshot({ path: "test-results/conversation-mobile.png" });
    expect(consoleErrors).toEqual([]);
  });
});
