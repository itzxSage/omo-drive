import { test, expect } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
});

test.describe("PWA UI Tests", () => {
  test("PTT button exists and is full-screen sized", async ({ page }) => {
    await page.goto("http://localhost:8080/public/index.html");
    
    const pttButton = page.locator("#ptt-button");
    await expect(pttButton).toBeVisible();
    
    const box = await pttButton.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThan(300);
      expect(box.height).toBeGreaterThan(300);
    }
  });

  test("Debug input sends text to session message API", async ({ page }) => {
    await page.goto("http://localhost:8080/public/index.html");
    
    await page.click("#debug-toggle");
    const debugSection = page.locator("#debug-section");
    await expect(debugSection).toHaveClass(/visible/);
    
    const debugInput = page.locator("#debug-input");
    await expect(debugInput).toBeVisible();
    
    await page.route("**/api/opencode/session/**/message", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      const postData = request.postDataJSON();
      expect(postData.content).toBe("test message");
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    
    await debugInput.fill("test message");
    await debugInput.press("Enter");
  });

  test("Wake lock status is shown", async ({ page }) => {
    await page.goto("http://localhost:8080/public/index.html");
    const wakeLockStatus = page.locator("#wake-lock-status");
    await expect(wakeLockStatus).toBeVisible();
    const statusText = await wakeLockStatus.textContent();
    expect(statusText).toMatch(/Wake Lock: (Off|Active|Unsupported|Failed)/);
  });
});
