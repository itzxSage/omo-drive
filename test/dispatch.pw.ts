import { expect, test } from '@playwright/test';

test('dispatch mode creates persisted blocked and completed outcomes', async ({ page }) => {
  const requests: Array<Record<string, any>> = [];

  await page.route('**/api/trust', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trusted: true, deviceName: 'dispatch-device' }),
    });
  });

  await page.route('**/api/product/dispatch/requests?limit=6', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests }),
    });
  });

  await page.route('**/api/product/dispatch/requests', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }

    const body = route.request().postDataJSON();
    expect(body.targetScope).toBeTruthy();
    expect(body.followUpPolicy).toBeTruthy();
    expect(body.executionActionType).toBeTruthy();

    const request = {
      requestId: `dispatch-${requests.length + 1}`,
      inputSummary: body.inputSummary,
      targetId: body.targetId,
      targetLabel: body.targetLabel,
      status: 'queued',
      decision: {
        actionType: 'dispatch.create',
        actionClass: 'allowed',
        targetScope: body.targetScope,
      },
      followUpPolicy: body.followUpPolicy,
      executionActionType: body.executionActionType,
      executionDecision: {
        actionType: body.executionActionType,
        actionClass: body.executionActionType === 'repo.write' ? 'approval_required' : 'allowed',
        targetScope: body.targetScope,
      },
      latestRun: null,
      latestReviewItem: null,
    };

    requests.unshift(request);

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        request,
        decision: request.decision,
        executionDecision: request.executionDecision,
      }),
    });
  });

  await page.route('**/api/product/dispatch/requests/*/execute', async (route) => {
    const requestId = route.request().url().split('/').at(-2) as string;
    const request = requests.find((entry) => entry.requestId === requestId);
    expect(request).toBeTruthy();
    if (!request) {
      throw new Error(`Missing request for ${requestId}`);
    }

    if (request.executionDecision.actionClass === 'approval_required' || request.followUpPolicy === 'hold_for_review') {
      request.status = 'blocked';
      request.latestRun = { status: 'blocked' };
      request.latestReviewItem = { reviewItemId: `review-${requestId}`, status: 'pending_review' };
      request.latestHandoff = {
        path: `/api/product/handoffs/handoff-${requestId}`,
        package: {
          summary: `Blocked dispatch handoff for ${request.inputSummary}`,
          nextActions: [`Open review item review-${requestId} to resolve the blocker.`],
        },
      };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          request,
          run: { status: 'blocked' },
          reviewItem: request.latestReviewItem,
        }),
      });
      return;
    }

    request.status = 'completed';
    request.latestRun = { status: 'completed' };
    request.latestReviewItem = null;
    request.latestHandoff = {
      path: `/api/product/handoffs/handoff-${requestId}`,
      package: {
        summary: `Completed dispatch handoff for ${request.inputSummary}`,
        nextActions: ['Review the timeline and latest run before taking the next action.'],
      },
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        request,
        run: { status: 'completed' },
      }),
    });
  });

  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      constructor(_url: string) {
        super();
      }
      close() {}
    }

    Object.defineProperty(globalThis, 'EventSource', {
      value: MockEventSource,
      configurable: true,
    });

    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: {
        cancel: () => {},
        speak: () => {},
        getVoices: () => [],
      },
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
      state = 'inactive';
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

  await expect(page.locator('#dispatch-status')).toContainText('Ready to create');
  await expect(page.locator('#dispatch-list')).toContainText('No dispatch requests yet.');

  await page.fill('#dispatch-summary', 'Apply repo write after review');
  await page.selectOption('#dispatch-scope', 'explicit_repo');
  await page.fill('#dispatch-target', 'omo-drive');
  await page.selectOption('#dispatch-action', 'repo.write');
  await page.selectOption('#dispatch-follow-up', 'complete_when_ready');
  await page.click('#dispatch-submit');

  await expect(page.locator('#dispatch-status')).toContainText('blocked and saved for review');
  await expect(page.locator('.dispatch-card').first()).toContainText('Apply repo write after review');
  await expect(page.locator('.dispatch-card').first()).toContainText('blocked');
  await expect(page.locator('.dispatch-card').first()).toContainText('Blocked dispatch handoff');
  await expect(page.locator('.dispatch-card').first()).toContainText('resolve the blocker');

  await page.fill('#dispatch-summary', 'Inspect repo status');
  await page.selectOption('#dispatch-scope', 'active_repo');
  await page.fill('#dispatch-target', '');
  await page.selectOption('#dispatch-action', 'repo.read_status');
  await page.selectOption('#dispatch-follow-up', 'complete_when_ready');
  await page.click('#dispatch-submit');

  await expect(page.locator('#dispatch-status')).toContainText('completed and saved');
  await expect(page.locator('.dispatch-card').first()).toContainText('Inspect repo status');
  await expect(page.locator('.dispatch-card').first()).toContainText('completed');
  await expect(page.locator('.dispatch-card').first()).toContainText('Completed dispatch handoff');
  await expect(page.locator('#dispatch-list .dispatch-card')).toHaveCount(2);
});
