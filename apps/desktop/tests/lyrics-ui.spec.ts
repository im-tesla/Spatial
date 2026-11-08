import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function playingSidebar(page: Page, scenario: string) {
  await page.addInitScript(() => localStorage.setItem("spatial-output", "fixture-hdmi"));
  await page.goto(`/tests/app-preview.html?connection=saved&showcase&${scenario}`);
  await page.getByRole("button", { name: "Open album Night Letters", exact: true }).click();
  await page.getByRole("button", { name: /^Play A quiet room/ }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Open lyrics", exact: true }).click();
  return page.locator("#lyrics-sidebar");
}

test("server word cues work in the sidebar and fullscreen without contacting LRCLIB", async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("console", message => { if (message.text() === "Fixture LRCLIB request") requests.push(message.text()); });
  page.on("pageerror", error => errors.push(error.message));
  const sidebar = await playingSidebar(page, "sidecar=words");
  await expect(sidebar.getByText("Local TTML", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Word-synced lyrics", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "The lights turn green · Seek to 0:04", exact: true }).click();
  await expect(sidebar.locator('.lyric-word[data-word-state="active"]')).toHaveText("The ");
  await sidebar.getByRole("button", { name: "A little space to breathe · Seek to 0:08", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Playback position", exact: true })).toHaveValue("8");
  await expect(sidebar.locator('.lyric-word[data-word-state="active"]')).toHaveText("A ");
  await page.getByRole("button", { name: "Open fullscreen player", exact: true }).click();
  const fullscreen = page.getByRole("dialog", { name: "Fullscreen player", exact: true });
  await expect(fullscreen.getByText("Local TTML", { exact: true })).toBeVisible();
  await expect(fullscreen.getByText("Word-synced lyrics", { exact: true })).toBeVisible();
  await expect(fullscreen.locator('.lyric-word[data-word-state="active"]')).toHaveText("A ");
  await expect(page.locator(".sidebar nav button")).toHaveCount(4);
  await expect(fullscreen).toHaveCSS("opacity", "1");
  await expect(fullscreen.locator(".listening-lyrics")).toHaveCSS("opacity", "1");
  expect(requests).toHaveLength(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "../../target/ttml-fullscreen.png" });
});

test("line TTML takes precedence over a service word result and does not invent word cues", async ({ page }) => {
  const requests: string[] = [];
  page.on("console", message => { if (message.text() === "Fixture LRCLIB request") requests.push(message.text()); });
  const sidebar = await playingSidebar(page, "sidecar=lines&lyrics=words");
  await expect(sidebar.getByText("Local TTML", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Line-synced lyrics", { exact: true })).toBeVisible();
  await expect(sidebar.locator(".lyric-word")).toHaveCount(0);
  expect(requests).toHaveLength(0);
  await page.setViewportSize({ width: 1100, height: 740 });
  await expect(sidebar.locator(".lyrics-panel")).toBeVisible();
  await page.screenshot({ path: "../../target/ttml-sidebar.png" });
});

for (const reason of ["missing", "invalid", "offline"]) {
  test(`${reason} server lyrics use the existing LRCLIB fallback`, async ({ page }) => {
    const requests: string[] = [];
    page.on("console", message => { if (message.text() === "Fixture LRCLIB request") requests.push(message.text()); });
    const sidebar = await playingSidebar(page, `sidecar=${reason}`);
    await expect(sidebar.getByRole("link", { name: "LRCLIB", exact: true })).toBeVisible();
    await expect(sidebar.getByText("Line-synced lyrics", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
  });
}
