import { test, expect } from "@playwright/test";

test.describe("Permission Prompt and Safety Gate", () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log(`BROWSER: ${msg.text()}`));
    await page.route("**/api/trust", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ trusted: true, deviceName: 'playwright-device' })
      });
    });
    await page.addInitScript(() => {
      class MockEventSource extends EventTarget {
        constructor(_url: string) {
          super();
          (globalThis as any).__lastMockEventSource = this;
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
    });

    await page.goto("http://localhost:8080/public/index.html");
  });

  test("Shows permission overlay when permission.asked is received", async ({ page }) => {
    const overlay = page.locator("#permission-overlay");
    await expect(overlay).not.toBeVisible();

    await page.waitForFunction(() => (globalThis as any).__lastMockEventSource != null);
    await page.evaluate(() => {
      const source = (globalThis as any).__lastMockEventSource;
      const event = new MessageEvent('permission.asked', {
        data: JSON.stringify({
          id: 'perm-123',
          permission: 'edit',
          patterns: ['src/index.ts']
        })
      });
      source.dispatchEvent(event);
    });

    await expect(overlay).toBeVisible();
    await expect(page.locator("#permission-summary")).toContainText("Allow edit on src/index.ts?");
    
    const lastSpoken = await page.evaluate(() => (globalThis as any).lastSpoken);
    expect(lastSpoken).toContain("Permission requested");
  });

  test("Approving via UI sends POST request", async ({ page }) => {
    await page.waitForFunction(() => (globalThis as any).__lastMockEventSource != null);
    await page.evaluate(() => {
      const source = (globalThis as any).__lastMockEventSource;
      const event = new MessageEvent('permission.asked', {
        data: JSON.stringify({
          id: 'perm-123',
          permission: 'edit',
          patterns: ['src/index.ts']
        })
      });
      source.dispatchEvent(event);
    });

    await page.route("**/api/opencode/session/**/permissions/perm-123", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON().reply).toBe("once");
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.click("#permission-approve");
    await expect(page.locator("#permission-overlay")).not.toBeVisible();
  });

  test("Denying via UI sends POST request", async ({ page }) => {
    await page.waitForFunction(() => (globalThis as any).__lastMockEventSource != null);
    await page.evaluate(() => {
      const source = (globalThis as any).__lastMockEventSource;
      const event = new MessageEvent('permission.asked', {
        data: JSON.stringify({
          id: 'perm-123',
          permission: 'edit',
          patterns: ['src/index.ts']
        })
      });
      source.dispatchEvent(event);
    });

    await page.route("**/api/opencode/session/**/permissions/perm-123", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON().reply).toBe("reject");
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.click("#permission-deny");
    await expect(page.locator("#permission-overlay")).not.toBeVisible();
  });

  test("Server-backed approval gate triggers for risky voice commands", async ({ page }) => {
    let sttRequestCount = 0;
    await page.route("**/api/stt", async (route) => {
      sttRequestCount += 1;
      await route.fulfill({ 
        status: 200, 
        contentType: 'application/json', 
        body: JSON.stringify({
          text: sttRequestCount === 1 ? "delete all files" : "yes"
        }) 
      });
    });

    let approvalExecutionCount = 0;
    await page.route("**/api/product/actions/execute", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'awaiting_approval',
          approval: {
            id: 'review-1',
            requestId: 'request-1',
            summary: 'Allow voice request: delete all files?'
          }
        })
      });
    });

    await page.route("**/api/product/actions/request-1/respond", async (route) => {
      approvalExecutionCount += 1;
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON().outcome).toBe("approved");
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'completed',
          result: { kind: 'message', ok: true }
        })
      });
    });

    await page.evaluate(() => { (globalThis as any).lastSpoken = ""; });

    const pttButton = page.locator("#ptt-button");
    await pttButton.click();
    await pttButton.click({ force: true });

    await expect(page.locator("#permission-overlay")).toBeVisible();
    await expect(page.locator("#permission-summary")).toContainText("Allow voice request: delete all files?");

    await page.waitForFunction(() => (globalThis as any).lastSpoken && (globalThis as any).lastSpoken.includes("approve or deny"));
    const lastSpoken = await page.evaluate(() => (globalThis as any).lastSpoken);
    expect(lastSpoken).toContain("Approval required");

    await pttButton.click();
    await pttButton.click({ force: true });

    await page.waitForTimeout(500);
    expect(approvalExecutionCount).toBe(1);
  });
});
