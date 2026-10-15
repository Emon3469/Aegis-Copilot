import { defineConfig, devices } from "@playwright/test";

const LIVE = !!process.env.E2E_LIVE;
const API = process.env.E2E_API_URL || "http://127.0.0.1:8000";
const PORT = Number(process.env.E2E_PORT || 3100);
const channel = process.env.CI ? undefined : "chrome";
const python = process.platform === "win32" ? String.raw`.venv\Scripts\python.exe` : ".venv/bin/python";

interface Server {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
  env?: Record<string, string>;
  cwd?: string;
}

const webServer: Server[] = [
  {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NEXT_PUBLIC_API_URL: API },
  },
];

if (LIVE && !process.env.E2E_API_URL) {
  webServer.push({
    command: `${python} -m uvicorn app:app --port 8000`,
    url: `${API}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: "../backend",
    env: { CORS_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT}` },
  });
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: LIVE ? 120_000 : 30_000,
  expect: { timeout: LIVE ? 60_000 : 7_000 },
  fullyParallel: !LIVE,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer,
  projects: LIVE
    ? [{ name: "live", grep: /@live/, use: { ...devices["Desktop Chrome"], channel, viewport: { width: 1366, height: 860 } } }]
    : [
        { name: "desktop", grepInvert: /@live|@mobile/, use: { ...devices["Desktop Chrome"], channel, viewport: { width: 1366, height: 860 } } },
        { name: "mobile", grep: /@mobile/, use: { ...devices["Pixel 7"], channel } },
      ],
});
