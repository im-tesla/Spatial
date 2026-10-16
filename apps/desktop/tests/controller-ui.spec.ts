import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function press(page: Page, name: string) {
  await page.getByRole("button", { name: `Pad ${name}`, exact: true }).click();
  await page.waitForTimeout(160); // press + release across the actual 32 ms sampler
}
async function openSettings(page: Page) { await page.getByRole("button", { name: "Open settings", exact: true }).click(); }
test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => console.error(error));
  await page.addInitScript(() => localStorage.setItem("spatial-output", "fixture-hdmi"));
  await page.goto("/tests/app-preview.html?connection=saved&showcase&controller&long");
  await expect(page.getByText(/TEST INPUT · real API: true · secure: true/)).toBeVisible();
  await openSettings(page);
  await expect(page.getByText("Controller connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
});

test("custom dropdown Back is contained; swaps stay draft until save and persist after reload", async ({ page }) => {
  await openSettings(page);
  const select = page.getByRole("combobox", { name: /^Select / });
  const back = page.getByRole("combobox", { name: /^Back B / });
  await select.click(); await press(page, "B");
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await select.click(); await press(page, "Down"); await press(page, "A");
  await expect(select).toContainText("B / Circle");
  await expect(page.getByRole("combobox", { name: /^Back A / })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("spatial-controller:v1"))).toBeNull();
  await press(page, "B"); // applied Back remains B until save
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
  await openSettings(page); await expect(select).toContainText("A / Cross");
  await expect(back).toBeVisible();
  await select.click(); await page.getByRole("option", { name: "B / Circle", exact: true }).click();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByText("Controller settings saved.", { exact: true })).toBeVisible();
  await select.click(); await press(page, "A"); // newly applied Back is A
  await expect(select).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.reload(); await openSettings(page); await expect(select).toContainText("B / Circle");
  await page.getByRole("button", { name: "Reset mapping", exact: true }).click();
  await expect(select).toContainText("A / Cross");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("spatial-controller:v1")!).bindings.accept)).toBe(1);
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("spatial-controller:v1")!).bindings.accept)).toBe(0);
});

test("first Select establishes focus, and transport/fullscreen/back preserve playback", async ({ page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await press(page, "A");
  await expect(page.locator(".album-grid")).toBeVisible();
  await expect(page.locator(".artwork-wrap:focus")).toHaveCount(1);
  await press(page, "A");
  await expect(page.locator(".album-hero")).toBeVisible();
  await page.getByRole("button", { name: "Play A quiet room", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await press(page, "Menu"); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await press(page, "RB"); await expect(page.getByRole("slider", { name: "Playback position", exact: true })).toHaveValue("14");
  await press(page, "LB"); await expect(page.getByRole("slider", { name: "Playback position", exact: true })).toHaveValue("4");
  await page.getByRole("slider", { name: "Playback position", exact: true }).focus();
  await press(page, "Right"); await expect(page.getByRole("slider", { name: "Playback position", exact: true })).toHaveValue("4.1");
  await press(page, "Y"); await expect(page.getByRole("dialog", { name: "Fullscreen player", exact: true })).toBeVisible();
  await press(page, "B"); await expect(page.getByRole("dialog", { name: "Fullscreen player", exact: true })).toHaveCount(0);
  await expect(page.locator(".album-hero")).toBeVisible();
  await press(page, "B"); await expect(page.locator(".album-grid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible(); // remained paused, no stop/restart
});

test("inactive/disconnected controller cannot affect playback; long lists navigate both directions", async ({ page }) => {
  await page.getByRole("button", { name: "Open album Night Letters", exact: true }).click();
  await page.getByRole("button", { name: "Play A quiet room", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulate inactive window", exact: true }).click();
  await press(page, "Menu"); await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulate inactive window", exact: true }).click(); await page.waitForTimeout(80);
  await page.getByRole("button", { name: "Simulate disconnect", exact: true }).click();
  await press(page, "Menu"); await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulate disconnect", exact: true }).click(); await page.waitForTimeout(80);
  await page.locator(".track-title").first().focus();
  await page.getByRole("button", { name: "Pad to last track", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.classList.contains("track-title") && document.activeElement.textContent?.includes("Controller track 20"), undefined, { timeout: 12000 });
  await expect(page.locator(".track-title:focus")).toBeInViewport();
  await page.getByRole("button", { name: "Pad to first track", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.classList.contains("track-title") && document.activeElement.textContent?.includes("A quiet room"), undefined, { timeout: 12000 });
  await expect(page.locator(".track-title:focus")).toBeInViewport();
});

test("saved Play/Pause remapping and controller switches apply without changing playback setup", async ({ page }) => {
  await page.getByRole("button", { name: "Open album Night Letters", exact: true }).click();
  await page.getByRole("button", { name: "Play A quiet room", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await openSettings(page);
  await page.getByRole("combobox", { name: /^Play \/ Pause / }).click();
  await page.getByRole("option", { name: "X / Square", exact: true }).click();
  const enabled = page.getByRole("switch", { name: "Enable controller controls", exact: true });
  await enabled.focus(); await press(page, "A"); await expect(enabled).toHaveAttribute("aria-checked", "false");
  await press(page, "A"); await expect(enabled).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await press(page, "Menu"); await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await press(page, "X"); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("spatial-output"))).toBe("fixture-hdmi");
  await openSettings(page); await enabled.focus(); await press(page, "A");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await press(page, "X"); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await page.reload(); await openSettings(page); await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("combobox", { name: /^Play \/ Pause / })).toContainText("X / Square");
});
