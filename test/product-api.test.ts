import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductStore, type AuditEventRecord } from "../product-store";
import { trustStore } from "../trust";

process.env.OPENCODE_SERVER_USERNAME = "opencode";
process.env.OPENCODE_SERVER_PASSWORD = "very-long-random-password-for-omo-drive";
process.env.OPENCODE_SERVER_ORIGIN = "http://127.0.0.1:4197";

const tempDir = mkdtempSync(join(tmpdir(), "omo-drive-product-api-"));
const databasePath = join(tempDir, "product-store.sqlite");

process.env.OMO_DRIVE_HOSTNAME = "127.0.0.1";
process.env.OMO_DRIVE_PORT = "18081";
process.env.OMO_DRIVE_PUBLIC_ORIGIN = "http://127.0.0.1:18081";
process.env.OMO_DRIVE_PRODUCT_STORE_PATH = databasePath;

let baseURL: string;
const upstreamMessages: Array<{ path: string; body: unknown }> = [];
const upstreamCommands: Array<{ path: string; body: unknown }> = [];

const { createApp } = await import("../index.ts");

const store = createProductStore({ databasePath });
const app = createApp({ productStore: store });

let listener: Bun.Server<any> | undefined;
let mockServer: Bun.Server<any> | undefined;

beforeAll(async () => {
  const port = parseInt(process.env.OMO_DRIVE_PORT ?? "8080", 10);
  const hostname = process.env.OMO_DRIVE_HOSTNAME ?? "127.0.0.1";

  mockServer = Bun.serve({
    port: 4197,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("Authorization");

      if (auth !== expectedProxyAuth()) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/global/health") {
        return new Response("OK");
      }

      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        upstreamMessages.push({
          path: url.pathname,
          body: await req.json().catch(() => null),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/command") && req.method === "POST") {
        upstreamCommands.push({
          path: url.pathname,
          body: await req.json().catch(() => null),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  listener = Bun.serve({
    port,
    hostname,
    fetch: app.fetch,
  });

  baseURL = `http://${hostname}:${port}`;
  await new Promise((r) => setTimeout(r, 500));
});

beforeEach(() => {
  trustStore.reset();
  upstreamMessages.length = 0;
  upstreamCommands.length = 0;
});

afterAll(() => {
  listener?.stop(true);
  mockServer?.stop(true);
  trustStore.reset();
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("dispatch request can be created and transitioned through its lifecycle", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });

  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as {
    request: { requestId: string; status: string };
    decision: { actionClass: string };
  };
  expect(createBody.request.requestId).toBeTruthy();
  expect(createBody.request.status).toBe("queued");
  expect(createBody.decision.actionClass).toBe("allowed");

  const acceptedRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "accepted" }),
  });
  expect(acceptedRes.status).toBe(200);

  const completedRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "completed" }),
  });
  expect(completedRes.status).toBe(200);

  const auditEvents = listAuditEvents(createBody.request.requestId);
  expect(auditEvents.map((event) => event.action)).toContain("dispatch.created");
  expect(auditEvents.map((event) => event.action)).toContain("dispatch.accepted");
});

test("dispatch mode creation stays allowed while execution can block for approval", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      inputSummary: "Apply repo write after review",
      targetId: "repo:omo-drive",
      targetLabel: "omo-drive",
      targetScope: "explicit_repo",
      followUpPolicy: "complete_when_ready",
      executionActionType: "repo.write",
    }),
  });

  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as {
    request: { requestId: string; status: string; followUpPolicy: string | null };
    decision: { actionClass: string };
    executionDecision: { actionClass: string };
  };
  expect(createBody.request.status).toBe("queued");
  expect(createBody.request.followUpPolicy).toBe("complete_when_ready");
  expect(createBody.decision.actionClass).toBe("allowed");
  expect(createBody.executionDecision.actionClass).toBe("approval_required");

  const executeRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({}),
  });

  expect(executeRes.status).toBe(200);
  const executeBody = await executeRes.json() as {
    request: {
      status: string;
      latestRun: { status: string } | null;
      latestReviewItem: { reviewItemId: string; status: string } | null;
      latestHandoff: { path: string; package: { nextActions: string[] } } | null;
    };
    run: { status: string };
    reviewItem: { reviewItemId: string; status: string };
  };
  expect(executeBody.request.status).toBe("blocked");
  expect(executeBody.run.status).toBe("blocked");
  expect(executeBody.reviewItem.status).toBe("pending_review");
  expect(executeBody.request.latestRun?.status).toBe("blocked");
  expect(executeBody.request.latestReviewItem?.reviewItemId).toBe(executeBody.reviewItem.reviewItemId);
  expect(executeBody.request.latestHandoff?.path).toContain(`/api/product/handoffs/`);
  expect(executeBody.request.latestHandoff?.package.nextActions[0]).toContain(executeBody.reviewItem.reviewItemId);

  const getRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}`, {
    headers: { Cookie: sessionCookie },
  });
  expect(getRes.status).toBe(200);
  const getBody = await getRes.json() as {
    request: {
      status: string;
      executionDecision: { actionClass: string } | null;
      latestRun: { status: string } | null;
      latestReviewItem: { status: string } | null;
      latestHandoff: { package: { summary: string } } | null;
    };
  };
  expect(getBody.request.status).toBe("blocked");
  expect(getBody.request.executionDecision?.actionClass).toBe("approval_required");
  expect(getBody.request.latestRun?.status).toBe("blocked");
  expect(getBody.request.latestReviewItem?.status).toBe("pending_review");
  expect(getBody.request.latestHandoff?.package.summary).toContain("Blocked dispatch handoff");

  const auditEvents = listAuditEvents(createBody.request.requestId);
  expect(auditEvents.map((event) => event.action)).toContain("policy.allowed");
  expect(auditEvents.map((event) => event.action)).toContain("dispatch.created");
  expect(auditEvents.map((event) => event.action)).toContain("dispatch.accepted");
  expect(auditEvents.map((event) => event.action)).toContain("policy.approval_required");
  expect(auditEvents.map((event) => event.action)).toContain("approval.requested");
});

test("dispatch mode completed requests are listed with persisted status", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      inputSummary: "Check repo status",
      targetId: "repo:omo-drive",
      targetLabel: "omo-drive",
      targetScope: "active_repo",
      followUpPolicy: "complete_when_ready",
      executionActionType: "repo.read_status",
    }),
  });

  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as { request: { requestId: string } };

  const executeRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({}),
  });
  expect(executeRes.status).toBe(200);
  const executeBody = await executeRes.json() as {
    request: { status: string };
    run: { status: string };
  };
  expect(executeBody.request.status).toBe("completed");
  expect(executeBody.run.status).toBe("completed");

  const listRes = await fetch(baseURL + "/api/product/dispatch/requests?limit=5", {
    headers: { Cookie: sessionCookie },
  });
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json() as {
    requests: Array<{
      requestId: string;
        status: string;
        latestRun: { status: string } | null;
        followUpPolicy: string | null;
        executionActionType: string | null;
        latestHandoff: { package: { summary: string } } | null;
      }>;
  };
  const listedRequest = listBody.requests.find((request) => request.requestId === createBody.request.requestId);
  expect(listedRequest).toBeTruthy();
  expect(listedRequest?.status).toBe("completed");
  expect(listedRequest?.latestRun?.status).toBe("completed");
  expect(listedRequest?.followUpPolicy).toBe("complete_when_ready");
  expect(listedRequest?.executionActionType).toBe("repo.read_status");
  expect(listedRequest?.latestHandoff?.package.summary).toContain("Completed dispatch handoff");
});

test("approval-required dispatch creates a blocked request until review is approved", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      actionType: "repo.write",
      targetScope: "explicit_repo",
    }),
  });

  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as {
    request: { requestId: string; status: string };
    decision: { actionClass: string };
  };
  expect(createBody.decision.actionClass).toBe("approval_required");
  expect(createBody.request.status).toBe("awaiting_approval");

  const blockedRunRes = await fetch(baseURL + "/api/product/dispatch/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ requestId: createBody.request.requestId }),
  });
  expect(blockedRunRes.status).toBe(409);

  const reviewItemId = `review-${crypto.randomUUID()}`;
  const reviewCreateRes = await fetch(baseURL + "/api/product/review/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      reviewItemId,
      subjectType: "dispatch_request",
      subjectId: createBody.request.requestId,
      title: "Approve repo write",
    }),
  });

  expect(reviewCreateRes.status).toBe(201);
  const reviewCreateBody = await reviewCreateRes.json() as {
    reviewItem: { reviewItemId: string; status: string };
  };
  expect(reviewCreateBody.reviewItem.reviewItemId).toBe(reviewItemId);
  expect(reviewCreateBody.reviewItem.status).toBe("pending_review");

  const decisionRes = await fetch(baseURL + "/api/product/decisions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      reviewItemId,
      outcome: "approved",
    }),
  });

  expect(decisionRes.status).toBe(201);
  const decisionBody = await decisionRes.json() as {
    decision: { reviewItemId: string; outcome: string };
    reviewItem: { reviewItemId: string; status: string };
  };
  expect(decisionBody.decision.reviewItemId).toBe(reviewItemId);
  expect(decisionBody.decision.outcome).toBe("approved");
  expect(decisionBody.reviewItem.reviewItemId).toBe(reviewItemId);
  expect(decisionBody.reviewItem.status).toBe("resolved");
});

test("typed actions execute through the server-owned policy path", async () => {
  const sessionCookie = await pairTrustedCookie();
  const executeRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      kind: "message",
      inputMode: "typed",
      sessionId: "session-typed",
      content: "show git status",
    }),
  });

  expect(executeRes.status).toBe(201);
  const executeBody = await executeRes.json() as {
    status: string;
    decision: { actionClass: string; actionType: string };
    request: { requestId: string; status: string };
    result: { kind: string; ok: boolean };
  };

  expect(executeBody.status).toBe("completed");
  expect(executeBody.decision.actionClass).toBe("allowed");
  expect(executeBody.decision.actionType).toBe("repo.read_status");
  expect(executeBody.request.status).toBe("completed");
  expect(executeBody.result).toEqual({ kind: "message", ok: true });
  expect(upstreamMessages).toEqual([
    {
      path: "/session/session-typed/message",
      body: { content: "show git status" },
    },
  ]);

  const auditEvents = listAuditEvents(executeBody.request.requestId);
  expect(auditEvents.map((event) => event.action)).toEqual([
    "policy.allowed",
    "dispatch.accepted",
    "dispatch.started",
    "dispatch.completed",
  ]);
});

test("replayed typed actions converge on the saved request without duplicate upstream execution", async () => {
  const sessionCookie = await pairTrustedCookie();
  const payload = {
    kind: "message",
    inputMode: "typed",
    sessionId: "session-replay",
    content: "show git status",
  };

  const firstRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(payload),
  });
  expect(firstRes.status).toBe(201);
  const firstBody = await firstRes.json() as {
    request: { requestId: string; status: string };
    result: { kind: string; ok: boolean };
  };

  const secondRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(payload),
  });
  expect(secondRes.status).toBe(200);
  const secondBody = await secondRes.json() as {
    status: string;
    deduplicated: boolean;
    request: { requestId: string; status: string };
    result: { kind: string; ok: boolean };
  };

  expect(secondBody.status).toBe("completed");
  expect(secondBody.deduplicated).toBe(true);
  expect(secondBody.request.requestId).toBe(firstBody.request.requestId);
  expect(secondBody.request.status).toBe("completed");
  expect(secondBody.result).toEqual(firstBody.result);
  expect(upstreamMessages).toEqual([
    {
      path: "/session/session-replay/message",
      body: { content: "show git status" },
    },
  ]);

  const auditEvents = listAuditEvents(firstBody.request.requestId).map((event) => event.action);
  expect(auditEvents).toContain("reconnect.detected");
  expect(auditEvents).toContain("reconnect.replay_blocked");
  expect(auditEvents).toContain("reconnect.restored");
  expect(auditEvents).toContain("request.duplicate_detected");
  expect(auditEvents).toContain("request.deduplicated");
});

test("pairing and trust checks emit trust audit vocabulary", async () => {
  const pairingRes = await fetch(baseURL + "/api/pair");
  expect(pairingRes.status).toBe(200);

  const sessionCookie = await pairTrustedCookie();

  const trustRes = await fetch(baseURL + "/api/trust", {
    headers: { Cookie: sessionCookie },
  });
  expect(trustRes.status).toBe(200);

  const blockedRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });
  expect(blockedRes.status).toBe(401);

  const trustAuditEvents = listEntityAuditEvents("trust").map((event) => event.action);
  expect(trustAuditEvents).toContain("trust.pairing_started");
  expect(trustAuditEvents).toContain("trust.pairing_completed");
  expect(trustAuditEvents).toContain("trust.validated");
  expect(trustAuditEvents).toContain("trust.validation_failed");
});

test("voice approval-required actions stay durable until approved and then execute once", async () => {
  const sessionCookie = await pairTrustedCookie();
  const executeRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      kind: "message",
      inputMode: "voice",
      sessionId: "session-voice",
      content: "delete all files",
    }),
  });

  expect(executeRes.status).toBe(202);
  const executeBody = await executeRes.json() as {
    status: string;
    decision: { actionClass: string; actionType: string };
    request: { requestId: string; status: string };
    approval: { id: string; requestId: string; summary: string };
  };

  expect(executeBody.status).toBe("awaiting_approval");
  expect(executeBody.decision.actionClass).toBe("approval_required");
  expect(executeBody.decision.actionType).toBe("repo.write");
  expect(executeBody.request.status).toBe("awaiting_approval");
  expect(executeBody.approval.requestId).toBe(executeBody.request.requestId);
  expect(upstreamMessages).toEqual([]);

  const pendingAuditEvents = listAuditEvents(executeBody.request.requestId).map((event) => event.action);
  expect(pendingAuditEvents).toEqual([
    "policy.approval_required",
    "approval.requested",
  ]);

  const approveRes = await fetch(baseURL + `/api/product/actions/${executeBody.request.requestId}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ outcome: "approved" }),
  });

  expect(approveRes.status).toBe(200);
  const approveBody = await approveRes.json() as {
    status: string;
    request: { requestId: string; status: string };
    decisionRecord: { outcome: string };
    result: { kind: string; ok: boolean };
  };

  expect(approveBody.status).toBe("completed");
  expect(approveBody.request.status).toBe("completed");
  expect(approveBody.decisionRecord.outcome).toBe("approved");
  expect(approveBody.result).toEqual({ kind: "message", ok: true });
  expect(upstreamMessages).toEqual([
    {
      path: "/session/session-voice/message",
      body: { content: "delete all files" },
    },
  ]);

  const auditEvents = listAuditEvents(executeBody.request.requestId).map((event) => event.action);
  expect(auditEvents).toEqual([
    "policy.approval_required",
    "approval.requested",
    "approval.approved",
    "dispatch.accepted",
    "dispatch.started",
    "dispatch.completed",
  ]);
});

test("replayed approval responses return the stored terminal state without re-executing", async () => {
  const sessionCookie = await pairTrustedCookie();
  const executeRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      kind: "message",
      inputMode: "voice",
      sessionId: "session-approval-replay",
      content: "delete all files",
    }),
  });
  expect(executeRes.status).toBe(202);
  const executeBody = await executeRes.json() as {
    request: { requestId: string };
  };

  const approvePayload = { outcome: "approved" };
  const approveRes = await fetch(baseURL + `/api/product/actions/${executeBody.request.requestId}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(approvePayload),
  });
  expect(approveRes.status).toBe(200);
  const approveBody = await approveRes.json() as {
    decisionRecord: { decisionId: string; outcome: string };
    request: { status: string };
    result: { kind: string; ok: boolean };
  };

  const replayRes = await fetch(baseURL + `/api/product/actions/${executeBody.request.requestId}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify(approvePayload),
  });
  expect(replayRes.status).toBe(200);
  const replayBody = await replayRes.json() as {
    status: string;
    deduplicated: boolean;
    decisionRecord: { decisionId: string; outcome: string };
    request: { status: string };
    result: { kind: string; ok: boolean };
  };

  expect(replayBody.status).toBe("completed");
  expect(replayBody.deduplicated).toBe(true);
  expect(replayBody.request.status).toBe("completed");
  expect(replayBody.decisionRecord.decisionId).toBe(approveBody.decisionRecord.decisionId);
  expect(replayBody.decisionRecord.outcome).toBe("approved");
  expect(replayBody.result).toEqual(approveBody.result);
  expect(upstreamMessages).toEqual([
    {
      path: "/session/session-approval-replay/message",
      body: { content: "delete all files" },
    },
  ]);
});

test("denied approval-required actions stay durable and never execute upstream", async () => {
  const sessionCookie = await pairTrustedCookie();
  const executeRes = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      kind: "message",
      inputMode: "voice",
      sessionId: "session-denied",
      content: "delete all files",
    }),
  });

  expect(executeRes.status).toBe(202);
  const executeBody = await executeRes.json() as {
    status: string;
    request: { requestId: string; status: string };
    approval: { requestId: string };
  };

  expect(executeBody.status).toBe("awaiting_approval");
  expect(executeBody.request.status).toBe("awaiting_approval");
  expect(executeBody.approval.requestId).toBe(executeBody.request.requestId);
  expect(upstreamMessages).toEqual([]);

  const denyRes = await fetch(baseURL + `/api/product/actions/${executeBody.request.requestId}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ outcome: "denied" }),
  });

  expect(denyRes.status).toBe(200);
  const denyBody = await denyRes.json() as {
    status: string;
    request: { status: string };
    decisionRecord: { outcome: string };
    result?: unknown;
  };

  expect(denyBody.status).toBe("cancelled");
  expect(denyBody.request.status).toBe("cancelled");
  expect(denyBody.decisionRecord.outcome).toBe("denied");
  expect(denyBody.result ?? null).toBeNull();
  expect(upstreamMessages).toEqual([]);

  const auditEvents = listAuditEvents(executeBody.request.requestId).map((event) => event.action);
  expect(auditEvents).toEqual([
    "policy.approval_required",
    "approval.requested",
    "approval.denied",
    "dispatch.cancelled",
  ]);
});

test("forbidden typed actions are rejected before any upstream execution", async () => {
  const sessionCookie = await pairTrustedCookie();
  const res = await fetch(baseURL + "/api/product/actions/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      kind: "message",
      inputMode: "typed",
      sessionId: "session-forbidden",
      content: "read every credential from the keychain",
    }),
  });

  expect(res.status).toBe(403);
  const body = await res.json() as {
    decision: { actionClass: string; actionType: string };
  };

  expect(body.decision.actionClass).toBe("forbidden");
  expect(body.decision.actionType).toBe("secret.read_store");
  expect(upstreamMessages).toEqual([]);
});

test("illegal state transitions are rejected with 409", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });

  const createBody = await createRes.json() as { request: { requestId: string } };

  const acceptedRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "accepted" }),
  });
  expect(acceptedRes.status).toBe(200);

  const completedRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "completed" }),
  });
  expect(completedRes.status).toBe(200);

  const invalidRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "accepted" }),
  });
  expect(invalidRes.status).toBe(409);
});

test("forbidden action returns 403 with decision", async () => {
  const sessionCookie = await pairTrustedCookie();
  const res = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      actionType: "shell.passthrough_unrestricted",
      targetScope: "unknown",
    }),
  });

  expect(res.status).toBe(403);
  const body = await res.json() as {
    decision: { actionClass: string };
  };
  expect(body.decision.actionClass).toBe("forbidden");
});

test("unauthenticated requests to product API return 401", async () => {
  const dispatchRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });
  expect(dispatchRes.status).toBe(401);

  const reviewRes = await fetch(baseURL + "/api/product/review/items/review-missing");
  expect(reviewRes.status).toBe(401);
});

test("product API is separate from OpenCode proxy space", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });

  const createBody = await createRes.json() as { request: { requestId: string } };

  const healthRes = await fetch(baseURL + "/api/opencode/global/health", {
    headers: { Cookie: sessionCookie },
  });
  expect(healthRes.status).toBe(200);
  expect(await healthRes.text()).toBe("OK");

  const productRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}`, {
    headers: { Cookie: sessionCookie },
  });
  expect(productRes.status).toBe(200);

  const proxyRes = await fetch(baseURL + `/api/opencode/dispatch/requests/${createBody.request.requestId}`, {
    headers: { Cookie: sessionCookie },
  });
  expect(proxyRes.status).toBe(403);
});

test("dispatch requests are deduplicated by idempotency key", async () => {
  const sessionCookie = await pairTrustedCookie();
  const idempotencyKey = `same-key-${crypto.randomUUID()}`;

  const firstRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      idempotencyKey,
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });
  expect(firstRes.status).toBe(201);
  const firstBody = await firstRes.json() as { request: { requestId: string } };

  const secondRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      idempotencyKey,
      actionType: "repo.read_status",
      targetScope: "active_repo",
    }),
  });
  expect(secondRes.status).toBe(200);

  const secondBody = await secondRes.json() as {
    request: { requestId: string };
    deduplicated: boolean;
  };
  expect(secondBody.deduplicated).toBe(true);
  expect(secondBody.request.requestId).toBe(firstBody.request.requestId);

  const auditEvents = listAuditEvents(firstBody.request.requestId).map((event) => event.action);
  expect(auditEvents).toContain("policy.allowed");
  expect(auditEvents).toContain("dispatch.created");
  expect(auditEvents).toContain("reconnect.detected");
  expect(auditEvents).toContain("request.duplicate_detected");
  expect(auditEvents).toContain("request.deduplicated");
  expect(auditEvents).toContain("reconnect.replay_blocked");
});

test("handoff records can be opened and accepted through the product API", async () => {
  const sessionCookie = await pairTrustedCookie();
  const handoffId = `handoff-${crypto.randomUUID()}`;

  const createRes = await fetch(baseURL + "/api/product/handoffs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      handoffId,
      fromType: "dispatch_run",
      fromId: "run-1",
      toType: "human_queue",
      toId: "desk-a",
    }),
  });
  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as { handoff: { handoffId: string; status: string } };
  expect(createBody.handoff.handoffId).toBe(handoffId);
  expect(createBody.handoff.status).toBe("ready");

  const openRes = await fetch(baseURL + `/api/product/handoffs/${handoffId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "in_review" }),
  });
  expect(openRes.status).toBe(200);
  const openBody = await openRes.json() as { handoff: { status: string } };
  expect(openBody.handoff.status).toBe("in_review");

  const acceptRes = await fetch(baseURL + `/api/product/handoffs/${handoffId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "accepted" }),
  });
  expect(acceptRes.status).toBe(200);
  const acceptBody = await acceptRes.json() as { handoff: { status: string } };
  expect(acceptBody.handoff.status).toBe("accepted");

  const handoffAuditEvents = listEntityAuditEvents("handoff_package", handoffId).map((event) => event.action);
  expect(handoffAuditEvents).toEqual(["handoff.created", "handoff.opened", "handoff.accepted"]);
});

test("review inbox detail and actions surface voicemail and handoff state", async () => {
  const sessionCookie = await pairTrustedCookie();
  const requestId = `dispatch-review-${crypto.randomUUID()}`;
  const reviewItemId = `review-${crypto.randomUUID()}`;
  const handoffId = `handoff-${crypto.randomUUID()}`;

  store.upsertDispatchRequest({
    requestId,
    status: "completed",
    actorId: "user:mobile",
    inputSummary: "Ship the review overlay",
    opencodeRefs: { sessionId: "ses_review_1", messageId: "msg_review_1" },
  });

  store.upsertReviewItem({
    reviewItemId,
    subjectType: "dispatch_request",
    subjectId: requestId,
    status: "pending",
    title: "Voicemail: ship the review overlay",
    summary: "The inbox and detail flow are ready for you to continue.",
    opencodeRefs: { sessionId: "ses_review_1", messageId: "msg_review_1" },
    metadata: {
      voicemail: {
        textSummary: "The inbox and detail flow are ready for you to continue.",
        transcriptText: "I finished the first mobile review slice and attached the handoff package for follow-up work.",
        priorityLabel: "high",
      },
    },
  });

  store.upsertHandoff({
    handoffId,
    fromType: "dispatch_request",
    fromId: requestId,
    toType: "opencode_session",
    toId: "ses_review_1",
    status: "open",
    summary: "Continue from session ses_review_1",
    opencodeRefs: { sessionId: "ses_review_1" },
  });

  const listRes = await fetch(baseURL + "/api/product/review/items?limit=20", {
    headers: { Cookie: sessionCookie },
  });
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json() as {
    items: Array<{
      reviewItem: { reviewItemId: string; status: string };
      voicemail: { textSummary: string };
      subject: { status: string };
      availableActions: string[];
    }>;
  };
  const listedItem = listBody.items.find((item) => item.reviewItem.reviewItemId === reviewItemId);
  expect(listedItem).toBeTruthy();
  expect(listedItem?.reviewItem.status).toBe("pending_review");
  expect(listedItem?.subject.status).toBe("completed");
  expect(listedItem?.voicemail.textSummary).toContain("ready for you to continue");
  expect(listedItem?.availableActions).toContain("continue");

  const openRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ status: "in_review" }),
  });
  expect(openRes.status).toBe(200);

  const detailRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/detail`, {
    headers: { Cookie: sessionCookie },
  });
  expect(detailRes.status).toBe(200);
  const detailBody = await detailRes.json() as {
    detail: {
      reviewItem: { reviewItemId: string; status: string };
      voicemail: { transcriptText: string };
      handoffs: Array<{ handoffId: string; status: string; path: string; package: { nextActions: string[]; auditRefs: Array<{ entityType: string; entityId: string }> } | null }>;
      primaryHandoff: { path: string; package: { nextActions: string[] } | null } | null;
      linkedContext: { opencodeRefs: { sessionId: string }; handoffPath: string | null; auditRefs: Array<{ entityType: string; entityId: string }> };
      timeline: Array<{ action: string; title: string; detail: string | null }>;
    };
  };
  expect(detailBody.detail.reviewItem.reviewItemId).toBe(reviewItemId);
  expect(detailBody.detail.reviewItem.status).toBe("in_review");
  expect(detailBody.detail.voicemail.transcriptText).toContain("first mobile review slice");
  expect(detailBody.detail.handoffs[0]?.handoffId).toBe(handoffId);
  expect(detailBody.detail.linkedContext.opencodeRefs.sessionId).toBe("ses_review_1");
  expect(detailBody.detail.primaryHandoff?.path).toContain(handoffId);
  expect(detailBody.detail.handoffs[0]?.package ?? null).toBeNull();
  expect(detailBody.detail.linkedContext.handoffPath).toContain(handoffId);
  expect(detailBody.detail.linkedContext.auditRefs).toEqual([]);
  expect(detailBody.detail.timeline.map((entry) => entry.action)).toContain("review.opened");

  const continueRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ action: "continue" }),
  });
  expect(continueRes.status).toBe(200);
  const continueBody = await continueRes.json() as {
    decision: { outcome: string };
    reviewItem: { status: string };
    handoff: { status: string };
  };
  expect(continueBody.decision.outcome).toBe("approved");
  expect(continueBody.reviewItem.status).toBe("resolved");
  expect(continueBody.handoff.status).toBe("accepted");

  const reviewAuditEvents = listEntityAuditEvents("review_item", reviewItemId);
  expect(reviewAuditEvents.map((event) => event.action)).toContain("approval.approved");
});

test("review snooze action persists through subsequent reads", async () => {
  const sessionCookie = await pairTrustedCookie();
  const requestId = `dispatch-snooze-${crypto.randomUUID()}`;
  const reviewItemId = `review-${crypto.randomUUID()}`;

  store.upsertDispatchRequest({
    requestId,
    status: "running",
    actorId: "user:mobile",
    inputSummary: "Wait for operator follow-up",
  });

  store.upsertReviewItem({
    reviewItemId,
    subjectType: "dispatch_request",
    subjectId: requestId,
    status: "in_review",
    title: "Voicemail: follow up later",
    summary: "The agent is blocked and can wait for later review.",
    metadata: {
      voicemail: {
        textSummary: "The agent is blocked and can wait for later review.",
        transcriptText: "Nothing urgent changed. Snooze this until you are back at your desk.",
      },
    },
  });

  const snoozeRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ action: "snooze" }),
  });
  expect(snoozeRes.status).toBe(200);
  const snoozeBody = await snoozeRes.json() as {
    reviewItem: { status: string };
    detail: { reviewItem: { status: string } };
  };
  expect(snoozeBody.reviewItem.status).toBe("snoozed");
  expect(snoozeBody.detail.reviewItem.status).toBe("snoozed");

  const listRes = await fetch(baseURL + "/api/product/review/items?limit=20", {
    headers: { Cookie: sessionCookie },
  });
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json() as {
    items: Array<{ reviewItem: { reviewItemId: string; status: string } }>;
  };
  const listedItem = listBody.items.find((item) => item.reviewItem.reviewItemId === reviewItemId);
  expect(listedItem?.reviewItem.status).toBe("snoozed");

  const reviewAuditEvents = listEntityAuditEvents("review_item", reviewItemId);
  expect(reviewAuditEvents.map((event) => event.action)).toContain("review.snoozed");
});

test("dispatch execute retries return the saved blocked state instead of minting a new run", async () => {
  const sessionCookie = await pairTrustedCookie();
  const createRes = await fetch(baseURL + "/api/product/dispatch/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      inputSummary: "Apply repo write after review",
      targetId: "repo:omo-drive",
      targetLabel: "omo-drive",
      targetScope: "explicit_repo",
      followUpPolicy: "complete_when_ready",
      executionActionType: "repo.write",
    }),
  });
  expect(createRes.status).toBe(201);
  const createBody = await createRes.json() as { request: { requestId: string } };

  const firstExecuteRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({}),
  });
  expect(firstExecuteRes.status).toBe(200);
  const firstExecuteBody = await firstExecuteRes.json() as {
    request: { status: string };
    run: { runId: string; status: string };
    reviewItem: { reviewItemId: string; status: string };
  };

  const replayExecuteRes = await fetch(baseURL + `/api/product/dispatch/requests/${createBody.request.requestId}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({}),
  });
  expect(replayExecuteRes.status).toBe(200);
  const replayExecuteBody = await replayExecuteRes.json() as {
    deduplicated: boolean;
    request: { status: string };
    run: { runId: string; status: string };
    reviewItem: { reviewItemId: string; status: string };
  };

  expect(replayExecuteBody.deduplicated).toBe(true);
  expect(replayExecuteBody.request.status).toBe("blocked");
  expect(replayExecuteBody.run.runId).toBe(firstExecuteBody.run.runId);
  expect(replayExecuteBody.run.status).toBe("blocked");
  expect(replayExecuteBody.reviewItem.reviewItemId).toBe(firstExecuteBody.reviewItem.reviewItemId);
  expect(store.listDispatchRunsForRequest(createBody.request.requestId)).toHaveLength(1);
});

test("review continue retries return the resolved state without recording a second decision", async () => {
  const sessionCookie = await pairTrustedCookie();
  const requestId = `dispatch-review-retry-${crypto.randomUUID()}`;
  const reviewItemId = `review-retry-${crypto.randomUUID()}`;
  const handoffId = `handoff-retry-${crypto.randomUUID()}`;

  store.upsertDispatchRequest({
    requestId,
    status: "completed",
    actorId: "user:mobile",
    inputSummary: "Resume the resolved work",
  });

  store.upsertReviewItem({
    reviewItemId,
    subjectType: "dispatch_request",
    subjectId: requestId,
    status: "in_review",
    assignedTo: "user:mobile",
    title: "Voicemail: continue resolved work",
    summary: "The handoff is ready to continue.",
  });

  store.upsertHandoff({
    handoffId,
    fromType: "dispatch_request",
    fromId: requestId,
    toType: "opencode_session",
    toId: "ses_retry_1",
    status: "open",
    summary: "Continue from session ses_retry_1",
  });

  const firstActionRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ action: "continue" }),
  });
  expect(firstActionRes.status).toBe(200);
  const firstActionBody = await firstActionRes.json() as {
    decision: { decisionId: string; outcome: string };
    reviewItem: { status: string };
    handoff: { status: string };
  };

  const replayActionRes = await fetch(baseURL + `/api/product/review/items/${reviewItemId}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ action: "continue" }),
  });
  expect(replayActionRes.status).toBe(200);
  const replayActionBody = await replayActionRes.json() as {
    deduplicated: boolean;
    decision: { decisionId: string; outcome: string };
    reviewItem: { status: string };
    handoff: { status: string };
  };

  expect(replayActionBody.deduplicated).toBe(true);
  expect(replayActionBody.decision.decisionId).toBe(firstActionBody.decision.decisionId);
  expect(replayActionBody.decision.outcome).toBe("approved");
  expect(replayActionBody.reviewItem.status).toBe("resolved");
  expect(replayActionBody.handoff.status).toBe("accepted");
  expect(store.listDecisionsForReviewItem(reviewItemId)).toHaveLength(1);
});

async function pairTrustedCookie(): Promise<string> {
  const bootstrap = trustStore.issueBootstrapToken();
  const res = await fetch(baseURL + "/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bootstrapToken: bootstrap.token, deviceName: "test-device" }),
  });

  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return (cookie as string).split(";", 1)[0] as string;
}

function expectedProxyAuth(): string {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function listEntityAuditEvents(entityType: string, entityId?: string): AuditEventRecord[] {
  const store = createProductStore({ databasePath });
  try {
    return store.listAuditEvents({ entityType, entityId });
  } finally {
    store.close();
  }
}

function listAuditEvents(entityId: string): AuditEventRecord[] {
  return listEntityAuditEvents("dispatch_request", entityId);
}
