import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductStore, type ProductStore } from "../product-store";

describe("ProductStore", () => {
  let tempDir: string;
  let databasePath: string;
  let store: ProductStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-drive-product-store-"));
    databasePath = join(tempDir, "product-store.sqlite");
    store = createProductStore({ databasePath });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists bridge artifacts without copying session transcripts", () => {
    store.upsertDispatchRequest({
      requestId: "dispatch-1",
      idempotencyKey: "dispatch-key-1",
      status: "queued",
      actorId: "user:mobile",
      targetId: "review:alpha",
      inputSummary: "Deliver QA packet",
      opencodeRefs: { sessionId: "ses_live_123", messageId: "msg_987" },
      metadata: { trustTokenId: "trust-1", replayWindowMs: 30000 },
    });

    store.upsertDispatchRun({
      runId: "run-1",
      requestId: "dispatch-1",
      status: "running",
      attempt: 1,
      opencodeRefs: { sessionId: "ses_live_123", commandId: "cmd_1" },
      metadata: { lane: "voice-review" },
    });

    store.upsertReviewItem({
      reviewItemId: "review-1",
      subjectType: "dispatch_run",
      subjectId: "run-1",
      status: "in_review",
      assignedTo: "qa:desk",
      title: "Review voicemail summary",
      summary: "Confirm routing before handoff",
      opencodeRefs: { sessionId: "ses_live_123" },
      metadata: { origin: "dispatch" },
    });

    store.recordDecision({
      decisionId: "decision-1",
      reviewItemId: "review-1",
      outcome: "approved",
      deciderId: "qa:desk",
      rationale: "Summary matches the run output",
      idempotencyKey: "decision-key-1",
      opencodeRefs: { sessionId: "ses_live_123", messageId: "msg_review_1" },
      metadata: { trustScore: 0.91 },
    });

    store.upsertHandoff({
      handoffId: "handoff-1",
      fromType: "dispatch_run",
      fromId: "run-1",
      toType: "human_queue",
      toId: "queue-a",
      status: "open",
      summary: "Escalate approved item to human queue",
      opencodeRefs: { sessionId: "ses_live_123" },
      metadata: { urgency: "normal" },
    });

    store.appendAuditEvent({
      eventId: "audit-1",
      entityType: "handoff",
      entityId: "handoff-1",
      action: "created",
      actorId: "qa:desk",
      opencodeRefs: { sessionId: "ses_live_123" },
      metadata: { reason: "approval_complete" },
    });

    const request = store.getDispatchRequest("dispatch-1");
    const run = store.getDispatchRun("run-1");
    const reviewItem = store.getReviewItem("review-1");
    const decision = store.getDecision("decision-1");
    const handoff = store.getHandoff("handoff-1");
    const auditEvents = store.listAuditEvents({ entityType: "handoff", entityId: "handoff-1" });

    expect(request?.opencodeRefs).toEqual({ sessionId: "ses_live_123", messageId: "msg_987" });
    expect((request?.metadata as Record<string, unknown>).transcript).toBeUndefined();
    expect(run?.opencodeRefs).toEqual({ sessionId: "ses_live_123", commandId: "cmd_1" });
    expect(reviewItem?.status).toBe("approved");
    expect(reviewItem?.latestDecisionId).toBe("decision-1");
    expect(decision?.metadata).toEqual({ trustScore: 0.91 });
    expect(handoff?.summary).toContain("human queue");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("created");
  });

  test("reopens the same sqlite file after restart and reads prior state", () => {
    store.upsertDispatchRequest({
      requestId: "dispatch-restart",
      status: "running",
      actorId: "user:ios",
      targetId: "handoff:desk",
      inputSummary: "Retry after reconnect",
      metadata: { reconnect: true },
    });

    store.upsertDispatchRun({
      runId: "run-restart",
      requestId: "dispatch-restart",
      status: "running",
      attempt: 2,
      metadata: { resumed: true },
    });

    store.close();
    store = createProductStore({ databasePath });

    const request = store.getDispatchRequest("dispatch-restart");
    const runs = store.listDispatchRunsForRequest("dispatch-restart");

    expect(request?.status).toBe("running");
    expect(request?.metadata).toEqual({ reconnect: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.attempt).toBe(2);
    expect(runs[0]?.metadata).toEqual({ resumed: true });
  });

  test("treats retries as idempotent upserts and preserves one durable record per id", () => {
    store.upsertDispatchRequest({
      requestId: "dispatch-idempotent",
      idempotencyKey: "request-key",
      status: "queued",
      inputSummary: "First attempt",
      metadata: { attempt: 1 },
    });

    store.upsertDispatchRequest({
      requestId: "dispatch-idempotent",
      idempotencyKey: "request-key",
      status: "completed",
      inputSummary: "Second attempt settled",
      metadata: { attempt: 2 },
    });

    store.upsertReviewItem({
      reviewItemId: "review-idempotent",
      subjectType: "dispatch_request",
      subjectId: "dispatch-idempotent",
      status: "in_review",
      title: "Retry-safe decision",
    });

    store.recordDecision({
      decisionId: "decision-idempotent",
      reviewItemId: "review-idempotent",
      outcome: "deferred",
      deciderId: "system:trust",
      idempotencyKey: "decision-key",
      metadata: { attempt: 1 },
    });

    store.recordDecision({
      decisionId: "decision-idempotent",
      reviewItemId: "review-idempotent",
      outcome: "approved",
      deciderId: "system:trust",
      idempotencyKey: "decision-key",
      metadata: { attempt: 2 },
    });

    store.appendAuditEvent({
      eventId: "audit-idempotent",
      entityType: "dispatch_request",
      entityId: "dispatch-idempotent",
      action: "retried",
      metadata: { count: 1 },
    });

    store.appendAuditEvent({
      eventId: "audit-idempotent",
      entityType: "dispatch_request",
      entityId: "dispatch-idempotent",
      action: "settled",
      metadata: { count: 2 },
    });

    const requests = store.listDispatchRequests();
    const decisions = store.listDecisionsForReviewItem("review-idempotent");
    const reviewItem = store.getReviewItem("review-idempotent");
    const auditEvents = store.listAuditEvents({ entityType: "dispatch_request", entityId: "dispatch-idempotent" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe("completed");
    expect(requests[0]?.inputSummary).toBe("Second attempt settled");
    expect(requests[0]?.metadata).toEqual({ attempt: 2 });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe("approved");
    expect(decisions[0]?.metadata).toEqual({ attempt: 2 });
    expect(reviewItem?.status).toBe("approved");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("settled");
    expect(auditEvents[0]?.metadata).toEqual({ count: 2 });
  });
});
