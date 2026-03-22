import { describe, expect, test } from 'bun:test';
import { createApprovals } from '../public/app/approvals.js';
import { createCommands } from '../public/app/commands.js';
import { createSSETransport } from '../public/app/sse-transport.js';

type TimeoutCallback = () => void;
type PermissionPayload = { id: string; permission: string; patterns: string[] };

describe('Live Control contracts', () => {
  test('reconnect ignores stale SSE instances and clears in-progress speech before reconnecting', async () => {
    const originalEventSource = globalThis.EventSource;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timers: Array<() => void> = [];
    const eventSources: MockEventSource[] = [];

    class MockEventSource extends EventTarget {
      closed = false;
      onerror: (() => void) | null = null;

      constructor(_url: string) {
        super();
        eventSources.push(this);
      }

      close() {
        this.closed = true;
      }
    }

    const state = {
      currentSessionId: 'session-1',
      eventSource: null as MockEventSource | null,
      getCurrentSessionId() {
        return this.currentSessionId;
      },
      getEventSource() {
        return this.eventSource;
      },
      setEventSource(eventSource: MockEventSource | null) {
        this.eventSource = eventSource;
      },
    };

    const permissionCalls: PermissionPayload[] = [];
    const speechEvents: string[] = [];
    const trustChecks: Array<{ trusted: boolean }> = [];

    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.setTimeout = ((callback: TimeoutCallback) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

    try {
      const transport = createSSETransport(
        state,
        {
          handlePermissionAsked(payload: PermissionPayload) {
            permissionCalls.push(payload);
          },
        },
        {
          handleSpeechDelta(delta: string) {
            speechEvents.push(`delta:${delta}`);
          },
          flushSpeechBuffer() {
            speechEvents.push('flush');
          },
          stopSpeaking() {
            speechEvents.push('stop');
          },
        },
        {
          async fetchTrustStatus() {
            return { trusted: true };
          },
          applyTrustState(trustStatus: { trusted: boolean }) {
            trustChecks.push(trustStatus);
          },
        }
      );

      transport.initSSE();
      const firstSource = eventSources[0];
      expect(firstSource).toBeDefined();
      if (!firstSource) {
        throw new Error('Expected initial EventSource');
      }
      expect(state.getEventSource()).toBe(firstSource);

      firstSource.dispatchEvent(new MessageEvent('message.part.delta', {
        data: JSON.stringify({
          sessionID: 'session-1',
          field: 'text',
          part: { delta: 'hello' },
        }),
      }));

      expect(speechEvents).toEqual(['delta:hello']);

      firstSource.onerror?.();
      await Promise.resolve();

      expect(firstSource.closed).toBe(true);
      expect(state.getEventSource()).toBeNull();
      expect(speechEvents).toEqual(['delta:hello', 'stop']);
      expect(trustChecks).toEqual([{ trusted: true }]);
      expect(timers).toHaveLength(1);

      timers[0]!();

      const secondSource = eventSources[1];
      expect(secondSource).toBeDefined();
      if (!secondSource) {
        throw new Error('Expected reconnected EventSource');
      }
      expect(state.getEventSource()).toBe(secondSource);

      firstSource.dispatchEvent(new MessageEvent('permission.asked', {
        data: JSON.stringify({
          id: 'stale-permission',
          permission: 'edit',
          patterns: ['src/index.ts'],
        }),
      }));
      firstSource.dispatchEvent(new MessageEvent('message.updated', {
        data: JSON.stringify({
          sessionID: 'session-1',
          status: 'finished',
          role: 'assistant',
        }),
      }));

      expect(permissionCalls).toEqual([]);
      expect(speechEvents).toEqual(['delta:hello', 'stop']);

      secondSource.dispatchEvent(new MessageEvent('permission.asked', {
        data: JSON.stringify({
          id: 'fresh-permission',
          permission: 'edit',
          patterns: ['src/index.ts'],
        }),
      }));
      secondSource.dispatchEvent(new MessageEvent('message.updated', {
        data: JSON.stringify({
          sessionID: 'session-1',
          status: 'finished',
          role: 'assistant',
        }),
      }));

      expect(permissionCalls).toEqual([
        {
          id: 'fresh-permission',
          permission: 'edit',
          patterns: ['src/index.ts'],
        },
      ]);
      expect(speechEvents).toEqual(['delta:hello', 'stop', 'flush']);
    } finally {
      globalThis.EventSource = originalEventSource;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('replayed permission prompts do not duplicate overlay or speech', async () => {
    const summaries: string[] = [];
    const speeches: string[] = [];
    const timers: Array<{ callback: () => void; delay?: number }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    type StoredPermissionRequest = { id: string; permission: string; patterns: string[]; source?: string };

    const state = {
      currentPermissionRequest: null as StoredPermissionRequest | null,
      getCurrentPermissionRequest() {
        return this.currentPermissionRequest;
      },
      setCurrentPermissionRequest(request: StoredPermissionRequest) {
        this.currentPermissionRequest = request;
      },
      showPermissionOverlay(summary: string) {
        summaries.push(summary);
      },
      getMediaRecorder() {
        return null;
      },
      setPermissionVoiceActive() {},
      resetAudioChunks() {},
    };

    globalThis.setTimeout = ((callback: TimeoutCallback, delay?: number) => {
      timers.push({ callback, delay });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const approvals = createApprovals(state, {
        speak(text: string) {
          speeches.push(text);
        },
      });

      const request = { id: 'perm-1', permission: 'edit', patterns: ['src/index.ts'] };
      await approvals.handlePermissionAsked(request);
      await approvals.handlePermissionAsked(request);

      expect(summaries).toEqual(['Allow edit on src/index.ts?']);
      expect(speeches).toEqual(['Permission requested: Allow edit on src/index.ts?. Say approve or deny.']);
      expect(timers).toHaveLength(1);
      expect(state.getCurrentPermissionRequest()).toEqual({
        ...request,
        source: 'opencode',
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('duplicate in-flight message submits collapse to one server-owned action request and allow later retries', async () => {
    const originalFetch = globalThis.fetch;
    const pendingResolvers: Array<() => void> = [];
    const requestUrls: string[] = [];
    const requestBodies: string[] = [];
    const debugInputs: string[] = [];
    const errors: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrls.push(String(input));
      requestBodies.push(String(init?.body));
      await new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
      return new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const commands = createCommands(
        {
          getCurrentSessionId() {
            return 'session-1';
          },
          setDebugInputValue(value: string) {
            debugInputs.push(value);
          },
          showError(message: string) {
            errors.push(message);
          },
          getCurrentPermissionRequest() {
            return null;
          },
          setPTTStatus() {},
        },
        {
          speak() {},
        },
        {
          handleProductApprovalRequested() {},
          sendPermissionResponse() {},
        }
      );

      const firstSend = commands.sendText('Repeat Last');
      const secondSend = commands.sendText('  Repeat Last  ');

      await Promise.resolve();

      expect(requestUrls).toEqual(['/api/product/actions/execute']);
      expect(requestBodies).toEqual(['{"kind":"message","inputMode":"typed","sessionId":"session-1","content":"Repeat Last"}']);
      expect(debugInputs).toEqual([]);

      pendingResolvers.shift()?.();
      await firstSend;
      await secondSend;

      const thirdSend = commands.sendText('Repeat Last');
      await Promise.resolve();

      expect(requestUrls).toEqual([
        '/api/product/actions/execute',
        '/api/product/actions/execute',
      ]);
      expect(requestBodies).toEqual([
        '{"kind":"message","inputMode":"typed","sessionId":"session-1","content":"Repeat Last"}',
        '{"kind":"message","inputMode":"typed","sessionId":"session-1","content":"Repeat Last"}',
      ]);
      expect(debugInputs).toEqual(['']);
      expect(errors).toEqual([]);

      pendingResolvers.shift()?.();
      await thirdSend;
      expect(debugInputs).toEqual(['', '']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('voice requests that need approval are delegated to the product approval path', async () => {
    const originalFetch = globalThis.fetch;
    const approvalRequests: Array<{ id: string; requestId: string; summary: string }> = [];

    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'awaiting_approval',
      approval: {
        id: 'review-1',
        requestId: 'request-1',
        summary: 'Allow voice request: delete all files?',
      },
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    try {
      const commands = createCommands(
        {
          getCurrentSessionId() {
            return 'session-voice';
          },
          setDebugInputValue() {},
          showError() {},
          getCurrentPermissionRequest() {
            return null;
          },
          setPTTStatus() {},
        },
        {
          speak() {},
        },
        {
          handleProductApprovalRequested(request: { id: string; requestId: string; summary: string }) {
            approvalRequests.push(request);
          },
          sendPermissionResponse() {},
        }
      );

      await commands.handleTranscribedText('delete all files');

      expect(approvalRequests).toEqual([
        {
          id: 'review-1',
          requestId: 'request-1',
          summary: 'Allow voice request: delete all files?',
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('session and model commands handle live payload objects instead of only flat arrays', async () => {
    const originalFetch = globalThis.fetch;
    const speeches: string[] = [];
    const sessionInfo: string[] = [];
    const sessionIds: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/opencode/session?limit=5')) {
        return new Response(JSON.stringify({
          data: [
            { sessionID: 'session-live-1' },
            { session: { id: 'session-live-2' } },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/api/opencode/config/providers')) {
        return new Response(JSON.stringify({
          providers: {
            openai: { models: ['gpt-4.1', 'gpt-4.1-mini'] },
            anthropic: { models: [{ name: 'claude-sonnet-4' }] },
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const commands = createCommands(
        {
          getCurrentSessionId() {
            return 'session-initial';
          },
          setCurrentSessionId(sessionId: string) {
            sessionIds.push(sessionId);
          },
          setSessionInfo(text: string) {
            sessionInfo.push(text);
          },
          setDebugInputValue() {},
          showError(message: string) {
            throw new Error(message);
          },
          getCurrentPermissionRequest() {
            return null;
          },
          setPTTStatus() {},
        },
        {
          speak(text: string) {
            speeches.push(text);
          },
          repeatLast() {
            return false;
          },
        },
        {
          handleProductApprovalRequested() {},
          sendPermissionResponse() {},
        }
      );

      await commands.handleCommand('/session');
      await commands.handleCommand('/session switch 2');
      await commands.handleCommand('/models');

      expect(speeches).toEqual([
        'Last sessions: 1: session-, 2: session-',
        'Switched to session 2',
        'Available models: openai/gpt-4.1, openai/gpt-4.1-mini, anthropic/claude-sonnet-4',
      ]);
      expect(sessionIds).toEqual(['session-live-2']);
      expect(sessionInfo).toEqual(['Session: session-live-2']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('repeat last replays local speech instead of sending a product action', () => {
    let repeated = 0;

    const commands = createCommands(
      {
        showError(message: string) {
          throw new Error(message);
        },
      },
      {
        repeatLast() {
          repeated += 1;
          return true;
        },
      },
      {
        handleProductApprovalRequested() {},
        sendPermissionResponse() {},
      }
    );

    commands.repeatLast();
    expect(repeated).toBe(1);
  });
});
