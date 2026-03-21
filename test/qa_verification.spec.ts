import { test, expect } from "@playwright/test";

test.describe("Real Manual QA (F3) - UI Revamp", () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('Wake Lock error')) {
        consoleErrors.push(msg.text());
      }
      console.log(`BROWSER [${msg.type()}]: ${msg.text()}`);
    });

    await page.addInitScript(() => {
      class MockEventSource extends EventTarget {
        constructor(url: string) {
          super();
          (globalThis as any).mockEventSource = this;
        }
        close() {}
      }
      Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource });

      const mockSpeechSynthesis = {
        speak: (utterance: any) => {
          (globalThis as any).lastSpoken = utterance.text;
        },
        cancel: () => {},
        getVoices: () => [],
        pause: () => {},
        resume: () => {},
        speaking: false,
        pending: false,
        paused: false
      };
      Object.defineProperty(globalThis, 'speechSynthesis', { value: mockSpeechSynthesis, writable: true });

      class MockUtterance {
        text: string;
        constructor(text: string) { 
          this.text = text; 
          (globalThis as any).lastUtterance = this;
        }
      }
      Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { value: MockUtterance });

      (globalThis as any).navigator.mediaDevices.getUserMedia = async () => {
        return {
          getTracks: () => [{ stop: () => {} }],
        };
      };
      
      (globalThis as any).MediaRecorder = class extends EventTarget {
        state = 'inactive';
        onstop: any;
        start() { this.state = 'recording'; }
        stop() { 
          this.state = 'inactive';
          const event = new MessageEvent('stop');
          this.dispatchEvent(event);
          if (this.onstop) this.onstop(event);
        }
        static isTypeSupported() { return true; }
      };

      (globalThis as any).navigator.wakeLock = {
        request: async () => ({
          addEventListener: () => {},
          release: async () => {}
        })
      };
    });

    await page.goto("http://localhost:8080/public/index.html");
  });

  test("Error toast appears when API call fails", async ({ page }) => {
    await page.route("**/api/opencode/session*", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: "Internal Server Error" })
      });
    });

    await page.click("#sessions");

    const errorToast = page.locator("#error-toast");
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("Failed to fetch sessions");
    
    await expect(errorToast).toHaveClass(/toast/);
    await expect(errorToast).toHaveClass(/visible/);
  });

  test("Secondary buttons can be clicked without console errors", async ({ page }) => {
    await page.route("**", async (route) => {
      const url = route.request().url();
      if (url.includes('/api/opencode/session')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([])
        });
      } else if (url.includes('/api/opencode/config/providers')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([])
        });
      } else if (url.includes('/api/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true })
        });
      } else {
        await route.continue();
      }
    });

    const buttons = [
      "#stop-speaking",
      "#repeat-last",
      "#screenshot",
      "#sessions",
      "#models",
      "#debug-toggle"
    ];

    for (const selector of buttons) {
      await page.click(selector);
      await page.waitForTimeout(100);
    }

    expect(consoleErrors).toHaveLength(0);
  });
});
