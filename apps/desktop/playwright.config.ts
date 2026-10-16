import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests", testMatch: "controller-ui.spec.ts", workers: 1, timeout: 40000,
  outputDir: "../../target/controller-ui", reporter: "list",
  use: { baseURL: "http://127.0.0.1:14720", viewport: { width: 1280, height: 850 }, screenshot: "only-on-failure" },
  webServer: { command: "npm run dev -- --port 14720", url: "http://127.0.0.1:14720", reuseExistingServer: !process.env.CI },
});
