import { expect, test, type Page, type Route } from '@playwright/test';

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
});

function buildReviewState() {
  return {
    reviewItem: {
      reviewItemId: 'review-1',
      status: 'pending_review',
      title: 'Voicemail: finish the review overlay',
    },
    voicemail: {
      textSummary: 'The mobile inbox is ready and waiting for your next action.',
      transcriptText: 'I finished the review inbox and linked the handoff package so you can continue from your phone.',
    },
    subject: {
      type: 'dispatch_request',
      id: 'dispatch-1',
      status: 'completed',
    },
    linkedContext: {
      opencodeRefs: {
        sessionId: 'ses_review_1',
        messageId: 'msg_review_1',
      },
      handoffPath: '/api/product/handoffs/handoff-1',
      auditRefs: [{ entityType: 'dispatch_request', entityId: 'dispatch-1' }],
    },
    handoffs: [
      {
        handoffId: 'handoff-1',
        status: 'ready',
        toType: 'opencode_session',
        toId: 'ses_review_1',
        summary: 'Continue from session ses_review_1',
        path: '/api/product/handoffs/handoff-1',
        package: {
          nextActions: [
            'Resume from OpenCode session ses_review_1.',
            'Review the timeline and latest run before taking the next action.',
          ],
        },
      },
    ],
    primaryHandoff: {
      handoffId: 'handoff-1',
      status: 'ready',
      summary: 'Continue from session ses_review_1',
      path: '/api/product/handoffs/handoff-1',
      package: {
        nextActions: [
          'Resume from OpenCode session ses_review_1.',
          'Review the timeline and latest run before taking the next action.',
        ],
      },
    },
    auditEvents: [
      {
        action: 'review.created',
        metadata: { status: 'pending_review' },
      },
    ],
    timeline: [
      {
        action: 'review.created',
        status: 'pending_review',
        title: 'Review item created',
        detail: 'The review inbox now owns the next operator-visible step.',
        entityType: 'review_item',
        entityId: 'review-1',
      },
      {
        action: 'handoff.created',
        status: 'ready',
        title: 'Handoff package created',
        detail: 'Summary, linked context, next actions, and audit refs were bundled into a reusable package.',
        entityType: 'handoff_package',
        entityId: 'handoff-1',
      },
    ],
    availableActions: ['continue', 'snooze'],
  };
}

function buildListResponse(state: ReturnType<typeof buildReviewState>) {
  return {
    items: [
      {
        reviewItem: state.reviewItem,
        voicemail: state.voicemail,
        subject: state.subject,
        handoffCount: state.handoffs.length,
        availableActions: state.availableActions,
      },
    ],
  };
}

function buildDetailResponse(state: ReturnType<typeof buildReviewState>) {
  return {
    detail: {
      reviewItem: state.reviewItem,
      voicemail: state.voicemail,
      subject: state.subject,
      handoffs: state.handoffs,
      primaryHandoff: state.primaryHandoff,
      linkedContext: state.linkedContext,
      auditEvents: state.auditEvents,
      timeline: state.timeline,
      availableActions: state.availableActions,
    },
  };
}

async function installReviewRoutes(page: Page, state: ReturnType<typeof buildReviewState>) {
  await page.route('**/api/trust', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ trusted: true, deviceName: 'playwright-review-phone' }),
    });
  });

  await page.route('**/api/product/review/items?limit=12', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildListResponse(state)),
    });
  });

  await page.route('**/api/product/review/items/review-1/status', async (route: Route) => {
    const body = route.request().postDataJSON();
    state.reviewItem.status = body.status;
    state.auditEvents.push({ action: 'review.opened', metadata: { status: body.status } });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reviewItem: state.reviewItem }),
    });
  });

  await page.route('**/api/product/review/items/review-1/detail', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildDetailResponse(state)),
    });
  });

  await page.route('**/api/product/review/items/review-1/actions', async (route: Route) => {
    const body = route.request().postDataJSON();

    if (body.action === 'continue') {
      state.reviewItem.status = 'resolved';
      if (state.handoffs[0]) {
        state.handoffs[0].status = 'accepted';
      }
      if (state.primaryHandoff) {
        state.primaryHandoff.status = 'accepted';
      }
      state.availableActions = [];
      state.auditEvents.push({ action: 'approval.approved', metadata: { status: 'approved' } });
      state.timeline.push({
        action: 'handoff.accepted',
        status: 'accepted',
        title: 'Handoff accepted',
        detail: 'Follow-up can continue from the accepted handoff package.',
        entityType: 'handoff_package',
        entityId: 'handoff-1',
      });
    }

    if (body.action === 'snooze') {
      state.reviewItem.status = 'snoozed';
      state.availableActions = ['continue'];
      state.auditEvents.push({ action: 'review.snoozed', metadata: { status: 'snoozed' } });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        action: body.action,
        reviewItem: state.reviewItem,
        detail: buildDetailResponse(state).detail,
        handoff: state.handoffs[0],
        decision: { outcome: 'approved' },
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      close() {}
    }

    Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true });
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
});

test('review inbox opens voicemail detail and continues from phone-friendly context', async ({ page }) => {
  const state = buildReviewState();
  await installReviewRoutes(page, state);

  await page.goto('http://localhost:8080/public/index.html');
  await page.click('#review-inbox-toggle');
  await expect(page.locator('#review-list')).toContainText('Voicemail: finish the review overlay');
  await expect(page.locator('#review-list')).toContainText('Completed');

  await page.locator('[data-review-id="review-1"]').click();
  await expect(page.locator('#review-detail-title')).toHaveText('Voicemail: finish the review overlay');
  await expect(page.locator('#review-detail-summary')).toContainText('mobile inbox is ready');
  await expect(page.locator('#review-detail-transcript')).toContainText('linked the handoff package');
  await expect(page.locator('#review-detail-context')).toContainText('ses_review_1');
  await expect(page.locator('#review-detail-context')).toContainText('/api/product/handoffs/handoff-1');
  await expect(page.locator('#review-detail-context')).toContainText('Resume from OpenCode session ses_review_1.');
  await expect(page.locator('#review-detail-timeline')).toContainText('Handoff package created');

  await page.click('[data-action="continue"]');
  await expect(page.locator('#review-count')).toHaveText('Resolved');
  await expect(page.locator('#review-actions')).not.toContainText('Continue');
});

test('review snooze remains visible after reload', async ({ page }) => {
  const state = buildReviewState();
  await installReviewRoutes(page, state);

  await page.goto('http://localhost:8080/public/index.html');
  await page.click('#review-inbox-toggle');
  await page.locator('[data-review-id="review-1"]').click();
  await page.click('[data-action="snooze"]');
  await expect(page.locator('#review-count')).toHaveText('Snoozed');

  await page.reload();
  await page.click('#review-inbox-toggle');
  await expect(page.locator('#review-list')).toContainText('Snoozed');
});
