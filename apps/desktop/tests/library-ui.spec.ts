import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => console.error(error));
  await page.addInitScript(() => localStorage.setItem("spatial-output", "fixture-hdmi"));
  await page.goto("/tests/app-preview.html?connection=saved&showcase");
  await expect(page.locator(".album-grid")).toBeVisible();
});

test("search lives in the sidebar and the artists index opens a full discography", async ({ page }) => {
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search your collection", exact: true })).toBeVisible();
  await page.locator(".sidebar nav .nav-item").filter({ hasText: "Artists" }).click();
  await expect(page.locator(".artist-card")).toHaveCount(5);
  await page.getByRole("button", { name: "Open artist Lowlight", exact: true }).click();
  await expect(page.locator(".artist-hero h1")).toHaveText("Lowlight");
  await expect(page.locator(".artist-albums .album-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Open album Tidal Forms", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar .nav-item.active")).toContainText("Artists");
});

test("settings is a tabbed page and stereo playback reaches the player", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(page.locator(".settings-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Playback", exact: true }).click();
  const stereo = page.getByRole("switch", { name: "Allow stereo playback", exact: true });
  await expect(stereo).toHaveAttribute("aria-checked", "false");
  await stereo.click();
  await expect(stereo).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".sidebar .output-card")).toContainText("STEREO");
  await expect(page.getByRole("switch", { name: "Enable exclusive mode", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: "Open album Night Letters", exact: true }).click();
  await page.getByRole("button", { name: "Play A quiet room", exact: true }).click();
  await expect(page.locator(".player-bar .output-chip")).toContainText("Stereo");
  await expect(page.getByRole("slider", { name: "Playback volume", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("spatial-preferences:v1")!).allowStereo)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("tab", { name: "Playback", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Allow stereo playback", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("favorites only show populated sections and keep album/track toolbars", async ({ page }) => {
  await page.locator(".sidebar nav .nav-item").filter({ hasText: "Favorites" }).click();
  await expect(page.getByText("No favorites yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import favorites", exact: true })).toBeVisible();
  await page.locator(".sidebar nav .nav-item").filter({ hasText: "Albums" }).click();
  const first = page.locator(".album-card").first();
  await first.hover();
  await page.getByRole("button", { name: "Add album Drift to favorites", exact: true }).click();
  await page.locator(".sidebar nav .nav-item").filter({ hasText: "Favorites" }).click();
  await expect(page.locator(".album-grid .album-card")).toHaveCount(1);
  await expect(page.getByText("Favorite songs", { exact: true })).toHaveCount(0);
});

test("external links open through the native link command instead of navigating the webview", async ({ page }) => {
  const opened: string[] = [];
  page.on("console", message => { if (message.text().startsWith("Fixture external link ")) opened.push(message.text().replace("Fixture external link ", "")); });
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("link", { name: /Spatial on GitHub/ }).click();
  await page.getByRole("link", { name: /Lyrics by LRCLIB/ }).click();
  await expect(page.locator(".settings-page")).toBeVisible();
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: "Open album Night Letters", exact: true }).click();
  await page.getByRole("button", { name: "Play A quiet room", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Open lyrics", exact: true }).click();
  const sidebar = page.locator("#lyrics-sidebar");
  await expect(sidebar.getByRole("link", { name: "LRCLIB", exact: true })).toBeVisible();
  await sidebar.getByRole("link", { name: "LRCLIB", exact: true }).click();
  expect(opened).toEqual(["https://github.com/im-tesla/Spatial", "https://lrclib.net", "https://lrclib.net"]);
});
