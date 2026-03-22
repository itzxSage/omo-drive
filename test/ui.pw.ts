import { test, expect } from '@playwright/test';

type RecordingProbe = {
  startCalls: number;
  stopCalls: number;
};

test('tap-to-toggle recording state', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { startCalls: 0, stopCalls: 0 };
    Object.defineProperty(globalThis, '__recordingProbe', {
      value: probe,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: { cancel: () => {} },
      configurable: true,
    });

    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
        }),
      },
      configurable: true,
    });

    class MockMediaRecorder extends EventTarget {
      state: 'inactive' | 'recording' = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      start() {
        this.state = 'recording';
        probe.startCalls += 1;
      }

      stop() {
        this.state = 'inactive';
        probe.stopCalls += 1;
        this.ondataavailable?.({ data: new Blob(['test'], { type: 'audio/webm' }) });
        this.onstop?.(new Event('stop'));
      }
    }

    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: MockMediaRecorder,
      configurable: true,
    });
  });

  await page.route('**/api/stt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: '' }),
    });
  });

  await page.goto('http://localhost:8080');
  
  const pttButton = page.locator('#ptt-button');
  
  await expect(pttButton).not.toHaveClass(/is-recording/);
  
  await pttButton.click();
  await expect(pttButton).toHaveClass(/is-recording/);
  await expect(page.locator('#ptt-status')).toHaveText('Recording...');

  const started = await page.evaluate(() => (globalThis as typeof globalThis & { __recordingProbe: RecordingProbe }).__recordingProbe);
  expect(started.startCalls).toBe(1);
  expect(started.stopCalls).toBe(0);
  
  await pttButton.click({ force: true });
  await expect(pttButton).not.toHaveClass(/is-recording/);

  const stopped = await page.evaluate(() => (globalThis as typeof globalThis & { __recordingProbe: RecordingProbe }).__recordingProbe);
  expect(stopped.startCalls).toBe(1);
  expect(stopped.stopCalls).toBe(1);
});

test('unpaired load stays idle without unauthorized SSE noise', async ({ page }) => {
  const consoleErrors: string[] = [];
  const opencodeEventRequests: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('request', (request) => {
    if (request.url().includes('/api/opencode/event')) {
      opencodeEventRequests.push(request.url());
    }
  });

  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: { cancel: () => {}, speak: () => {} },
      configurable: true,
    });

    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
        }),
      },
      configurable: true,
    });

    Object.defineProperty(globalThis.navigator, 'wakeLock', {
      value: {
        request: async () => ({
          addEventListener: () => {},
          release: async () => {},
        }),
      },
      configurable: true,
    });

    class MockMediaRecorder extends EventTarget {
      state: 'inactive' | 'recording' = 'inactive';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
      static isTypeSupported() {
        return true;
      }
    }

    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: MockMediaRecorder,
      configurable: true,
    });
  });

  await page.goto('http://localhost:8080/public/index.html');
  await expect(page.locator('#session-info')).toHaveText('Pair this device to connect');
  await expect(page.locator('#ptt-status')).toHaveText('Pair device to connect');
  await page.waitForTimeout(750);

  expect(opencodeEventRequests).toHaveLength(0);
  expect(consoleErrors.filter((entry) => entry.includes('SSE Error'))).toHaveLength(0);
});
