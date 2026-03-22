import { Hono } from "hono";
import type { Context } from "hono";
import { Buffer } from "node:buffer";
import type {
  AuditEventRecord,
  DecisionRecord,
  DispatchRequestRecord,
  DispatchRunRecord,
  HandoffRecord,
  OpenCodeRefs,
  ProductMetadata,
  ProductStore,
  ReviewItemRecord,
} from "./product-store";
import { getRuntimeConfig } from "./config";
import { captureScreenshot } from "./screenshot";
import { requireTrusted, buildClearedTrustCookie, isSecureRequest, getTrustedSessionFromRequest } from "./trust";
import { trustStore } from "./trust";

type DispatchActionClass = "allowed" | "approval_required" | "forbidden";
type TargetScope = "active_repo" | "explicit_repo" | "cross_project" | "sensitive_surface" | "unknown";
type DecisionReason =
  | "low_risk_repo_scoped"
  | "non_destructive_read"
  | "review_triage_safe"
  | "non_destructive_dispatch"
  | "destructive_change"
  | "secret_sensitive"
  | "deploy_or_prod"
  | "cross_project_write"
  | "permissions_or_trust_change"
  | "sensitive_capture"
  | "unsupported_remote_control"
  | "unknown_scope";

type ProductDecision = {
  actionType: string;
  actionClass: DispatchActionClass;
  targetScope: TargetScope;
  requiresApproval: boolean;
  decisionReason: DecisionReason;
  auditEvent: "policy.allowed" | "policy.approval_required" | "policy.forbidden";
};

type SubmittedActionKind = "message" | "command" | "screenshot";
type SubmittedActionInputMode = "typed" | "voice" | "product";

type SubmittedAction = {
  kind: SubmittedActionKind;
  inputMode: SubmittedActionInputMode;
  sessionId?: string;
  content?: string;
  name?: string;
  args?: string[];
  rawText?: string;
  display?: string;
  max?: number;
  quality?: number;
};

type ExecutedActionResult =
  | { kind: "message"; ok: true }
  | { kind: "command"; ok: true }
  | { kind: "screenshot"; screenshot: { contentType: "image/jpeg"; base64: string } };

type FollowUpPolicy = "complete_when_ready" | "hold_for_review";

type DispatchContext = {
  mode: "dispatch_mode";
  followUpPolicy: FollowUpPolicy;
  executionActionType: string;
  executionDecision: ProductDecision;
  targetLabel?: string | null;
};

type ProductDispatchRequestStatus = "queued" | "accepted" | "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled" | "expired";
type ProductDispatchRunStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "expired";
type ProductReviewStatus = "pending_review" | "in_review" | "snoozed" | "resolved";
type ProductDecisionStatus = "approved" | "denied" | "cancelled" | "expired";
type ProductHandoffStatus = "ready" | "in_review" | "accepted";
type ReviewSurfaceAction = "approve" | "continue" | "snooze";

type HandoffAuditRef = {
  entityType: string;
  entityId: string;
};

type HandoffPackage = {
  kind: "handoff_package";
  version: "v0.2";
  summary: string;
  linkedContext: {
    subjectType: string;
    subjectId: string;
    requestId: string;
    runId: string | null;
    reviewItemId: string | null;
    opencodeRefs: OpenCodeRefs | null;
  };
  nextActions: string[];
  auditRefs: HandoffAuditRef[];
};

type TimelineEntry = {
  eventId: string;
  entityType: string;
  entityId: string;
  action: string;
  occurredAt?: string;
  status: string | null;
  title: string;
  detail: string | null;
};

type ReviewVoicemail = {
  textSummary: string;
  transcriptText: string | null;
  priorityLabel: string | null;
  spokenSummary: string | null;
};

type TrustedContext = Context & {
  get(key: "trustedSession"): {
    deviceId: string;
    deviceName: string;
    sessionToken: string;
    expiresAt: number;
  };
};

type CreateProductApiOptions = {
  productStore: ProductStore;
};

const STATUS_METADATA_KEY = "productStatus";
const DECISION_METADATA_KEY = "policyDecision";
const EXECUTION_METADATA_KEY = "executionRequest";
const APPROVAL_METADATA_KEY = "approvalRequest";
const DISPATCH_CONTEXT_METADATA_KEY = "dispatchContext";
const VOICEMAIL_METADATA_KEY = "voicemail";
const REVIEW_ACTION_METADATA_KEY = "reviewAction";
const HANDOFF_PACKAGE_METADATA_KEY = "handoffPackage";
const REPLAY_METADATA_KEY = "replay";
const RESULT_METADATA_KEY = "executionResult";

const FORBIDDEN_ACTIONS = new Set([
  "shell.passthrough_unrestricted",
  "desktop.mirror_arbitrary",
  "cross_project.write_implicit",
  "secret.read_store",
  "session.shadow_write",
  "trust.bypass",
  "approval.override_missing_record",
]);

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "repo.write",
  "git.write",
  "dispatch.execute_write",
  "dispatch.execute_background",
  "permissions.grant",
  "trust.pair",
  "trust.revoke",
  "screenshot.capture_sensitive",
  "cleanup.destructive",
  "deploy.trigger",
]);

const REQUEST_TRANSITIONS: Record<ProductDispatchRequestStatus, ProductDispatchRequestStatus[]> = {
  queued: ["accepted", "blocked", "cancelled", "expired"],
  accepted: ["blocked", "completed", "failed", "cancelled", "expired"],
  awaiting_approval: ["accepted", "cancelled", "expired"],
  blocked: ["accepted", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

const RUN_TRANSITIONS: Record<ProductDispatchRunStatus, ProductDispatchRunStatus[]> = {
  queued: ["running", "cancelled", "expired"],
  running: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["running", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

const REVIEW_TRANSITIONS: Record<ProductReviewStatus, ProductReviewStatus[]> = {
  pending_review: ["in_review", "snoozed", "resolved"],
  in_review: ["snoozed", "resolved"],
  snoozed: ["in_review", "resolved"],
  resolved: [],
};

const HANDOFF_TRANSITIONS: Record<ProductHandoffStatus, ProductHandoffStatus[]> = {
  ready: ["in_review", "accepted"],
  in_review: ["accepted"],
  accepted: [],
};

function getRequiredParam(c: Context, name: string): string | Response {
  const value = c.req.param(name);
  if (!value) {
    return c.json({ error: `Missing route param: ${name}` }, 400);
  }
  return value;
}

export function createProductApi({ productStore }: CreateProductApiOptions): Hono {
  const app = new Hono();

  app.get("/trust", (c) => {
    const session = getTrustedSessionFromRequest(c.req.raw);
    if (!session) {
      return c.json({ trusted: false, status: "blocked" as const });
    }

    return c.json({
      trusted: true,
      status: "trusted" as const,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.delete("/trust", requireTrusted, (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    trustStore.revokeSessionToken(session.sessionToken);
    trustStore.revokeDevice(session.deviceId);
    c.header("Set-Cookie", buildClearedTrustCookie(isSecureRequest(c)));

    appendAuditEvent(productStore, {
      entityType: "trust",
      entityId: session.deviceId,
      action: "trust.revoked",
      actorId: session.deviceId,
      metadata: { deviceName: session.deviceName, status: "revoked" },
    });

    return c.json({
      ok: true,
      trusted: false,
      status: "revoked" as const,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
    });
  });

  app.post("/actions/execute", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const action = asSubmittedAction(body);

    if (!action) {
      return c.json({ error: "Invalid action payload" }, 400);
    }

    const decision = classifySubmittedAction(action);
    const requestId = asNonEmptyString(body.requestId) ?? crypto.randomUUID();
    const idempotencyKey = asOptionalString(body.idempotencyKey);
    const replayKey = buildReplayKey("product_action", {
      actorId: session.deviceId,
      kind: action.kind,
      inputMode: action.inputMode,
      sessionId: action.sessionId ?? null,
      content: action.content ?? null,
      name: action.name ?? null,
      args: action.args ?? [],
      rawText: action.rawText ?? null,
      display: action.display ?? null,
      max: action.max ?? null,
      quality: action.quality ?? null,
    });
    const duplicate = resolveExistingDispatchRequest(productStore, {
      requestId,
      idempotencyKey,
      replayKey,
    });

    if (duplicate) {
      appendReplayAuditEvents(productStore, {
        entityId: duplicate.requestId,
        actorId: session.deviceId,
        idempotencyKey,
        replayKey,
        existingRequestId: duplicate.requestId,
      });
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: duplicate.requestId,
        action: "reconnect.restored",
        actorId: session.deviceId,
        metadata: {
          status: getDispatchRequestStatus(duplicate),
          replayKey,
          existingRequestId: duplicate.requestId,
        },
      });
      return c.json(buildActionExecutionResponse(productStore, duplicate), 200);
    }

    if (decision.actionClass === "forbidden") {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: requestId,
        action: decision.auditEvent,
        actorId: session.deviceId,
        metadata: { status: "rejected", decision, action },
      });
      return c.json({ error: "Forbidden by policy", decision }, 403);
    }

    const apiStatus: ProductDispatchRequestStatus = decision.actionClass === "approval_required" ? "awaiting_approval" : "queued";
    const requestRecord = productStore.upsertDispatchRequest({
      requestId,
      idempotencyKey,
      status: mapRequestStatusToStore(apiStatus),
      actorId: session.deviceId,
      targetId: action.sessionId,
      inputSummary: summarizeAction(action),
      opencodeRefs: action.sessionId ? { sessionId: action.sessionId } : undefined,
      metadata: withReplayMetadata(
        withExecutionMetadata(withStatusMetadata(asObject(body.metadata), apiStatus, decision), action),
        replayKey
      ),
    });

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: requestRecord.requestId,
      action: decision.auditEvent,
      actorId: session.deviceId,
      metadata: { status: apiStatus, decision, inputMode: action.inputMode },
    });

    if (decision.actionClass === "approval_required") {
      const reviewItem = productStore.upsertReviewItem({
        reviewItemId: asNonEmptyString(body.reviewItemId) ?? crypto.randomUUID(),
        subjectType: "dispatch_request",
        subjectId: requestRecord.requestId,
        status: mapReviewStatusToStore("pending_review"),
        assignedTo: session.deviceId,
        title: approvalTitle(decision),
        summary: approvalSummary(action, decision),
        opencodeRefs: action.sessionId ? { sessionId: action.sessionId } : undefined,
        metadata: withApprovalMetadata(withStatusMetadata(undefined, "pending_review"), requestRecord.requestId),
      });

      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: requestRecord.requestId,
        action: "approval.requested",
        actorId: session.deviceId,
        metadata: { status: apiStatus, reviewItemId: reviewItem.reviewItemId, actionType: decision.actionType },
      });

      return c.json({
        status: "awaiting_approval",
        decision,
        request: serializeDispatchRequest(requestRecord),
        approval: serializeApprovalRequest(reviewItem, requestRecord),
      }, 202);
    }

    const acceptedRequest = productStore.setDispatchRequestStatus(
      requestRecord.requestId,
      mapRequestStatusToStore("accepted"),
      withStatusMetadata(requestRecord.metadata, "accepted", decision)
    ) ?? requestRecord;

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: acceptedRequest.requestId,
      action: "dispatch.accepted",
      actorId: session.deviceId,
      metadata: { status: "accepted", actionType: decision.actionType },
    });

    try {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: acceptedRequest.requestId,
        action: "dispatch.started",
        actorId: session.deviceId,
        metadata: { status: "running", actionType: decision.actionType },
      });

      const result = await executeSubmittedAction(action);
      const completedRequest = productStore.setDispatchRequestStatus(
        acceptedRequest.requestId,
        mapRequestStatusToStore("completed"),
        withExecutionResultMetadata(withStatusMetadata(acceptedRequest.metadata, "completed", decision), result)
      ) ?? acceptedRequest;

      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: completedRequest.requestId,
        action: "dispatch.completed",
        actorId: session.deviceId,
        metadata: { status: "completed", actionType: decision.actionType },
      });

      ensureDispatchHandoffPackage(productStore, {
        actorId: session.deviceId,
        request: completedRequest,
        outcome: "completed",
      });

      return c.json({
        status: "completed",
        decision,
        request: serializeDispatchRequest(completedRequest, productStore),
        result,
      }, 201);
    } catch (error) {
      const failedRequest = productStore.setDispatchRequestStatus(
        acceptedRequest.requestId,
        mapRequestStatusToStore("failed"),
        withStatusMetadata(acceptedRequest.metadata, "failed", decision)
      ) ?? acceptedRequest;

      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: failedRequest.requestId,
        action: "dispatch.failed",
        actorId: session.deviceId,
        metadata: { status: "failed", actionType: decision.actionType, error: toErrorMessage(error) },
      });

      return c.json({ error: toErrorMessage(error), decision, request: serializeDispatchRequest(failedRequest, productStore) }, 502);
    }
  });

  app.post("/actions/:requestId/respond", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const requestId = getRequiredParam(c, "requestId");
    if (requestId instanceof Response) {
      return requestId;
    }
    const request = productStore.getDispatchRequest(requestId);

    if (!request) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const outcome = asDecisionStatus(body.outcome);
    if (!outcome || (outcome !== "approved" && outcome !== "denied" && outcome !== "cancelled")) {
      return c.json({ error: "Invalid approval outcome" }, 400);
    }

    const reviewItem = productStore.listReviewItemsForSubject("dispatch_request", request.requestId)[0];
    if (!reviewItem) {
      return c.json({ error: "Approval review item not found" }, 404);
    }

    const currentStatus = getDispatchRequestStatus(request);
    if (currentStatus !== "awaiting_approval") {
      const existingDecision = getLatestDecisionRecord(productStore, reviewItem);
      if (existingDecision) {
        appendReplayAuditEvents(productStore, {
          entityId: request.requestId,
          actorId: session.deviceId,
          idempotencyKey: asOptionalString(body.idempotencyKey),
          replayKey: buildReplayKey("approval_response", { requestId: request.requestId, outcome }),
          existingRequestId: request.requestId,
        });
        appendAuditEvent(productStore, {
          entityType: "dispatch_request",
          entityId: request.requestId,
          action: "reconnect.restored",
          actorId: session.deviceId,
          metadata: {
            status: getDispatchRequestStatus(request),
            existingRequestId: request.requestId,
          },
        });
        return c.json(buildApprovalResponse(productStore, request, reviewItem, existingDecision), 200);
      }

      return c.json({ error: "Dispatch request is not awaiting approval" }, 409);
    }

    const decision = getDecisionMetadata(request.metadata);
    const action = getExecutionMetadata(request.metadata);
    if (!decision || !action) {
      return c.json({ error: "Approval request metadata is incomplete" }, 409);
    }

    const decisionRecord = productStore.recordDecision({
      decisionId: asNonEmptyString(body.decisionId) ?? crypto.randomUUID(),
      reviewItemId: reviewItem.reviewItemId,
      outcome: mapDecisionStatusToStore(outcome),
      deciderId: session.deviceId,
      rationale: asOptionalString(body.rationale),
      idempotencyKey: asOptionalString(body.idempotencyKey),
      opencodeRefs: action.sessionId ? { sessionId: action.sessionId } : undefined,
      metadata: withDecisionMetadata(asObject(body.metadata), outcome),
    });

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: request.requestId,
      action: mapDecisionEvent(outcome),
      actorId: session.deviceId,
      metadata: { status: outcome, decisionId: decisionRecord.decisionId, reviewItemId: reviewItem.reviewItemId },
    });

    if (outcome !== "approved") {
      const cancelledStatus = outcome === "denied" ? "cancelled" : outcome;
      const blockedRequest = productStore.setDispatchRequestStatus(
        request.requestId,
        mapRequestStatusToStore("cancelled"),
        withStatusMetadata(request.metadata, "cancelled", decision)
      ) ?? request;
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: blockedRequest.requestId,
        action: "dispatch.cancelled",
        actorId: session.deviceId,
        metadata: { status: cancelledStatus, actionType: decision.actionType },
      });

      return c.json({
        status: cancelledStatus,
        decisionRecord: serializeDecision(decisionRecord),
        request: serializeDispatchRequest(blockedRequest),
      });
    }

    const acceptedRequest = productStore.setDispatchRequestStatus(
      request.requestId,
      mapRequestStatusToStore("accepted"),
      withStatusMetadata(request.metadata, "accepted", decision)
    ) ?? request;

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: acceptedRequest.requestId,
      action: "dispatch.accepted",
      actorId: session.deviceId,
      metadata: { status: "accepted", actionType: decision.actionType },
    });

    try {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: acceptedRequest.requestId,
        action: "dispatch.started",
        actorId: session.deviceId,
        metadata: { status: "running", actionType: decision.actionType },
      });

      const result = await executeSubmittedAction(action);
      const completedRequest = productStore.setDispatchRequestStatus(
        acceptedRequest.requestId,
        mapRequestStatusToStore("completed"),
        withExecutionResultMetadata(withStatusMetadata(acceptedRequest.metadata, "completed", decision), result)
      ) ?? acceptedRequest;

      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: completedRequest.requestId,
        action: "dispatch.completed",
        actorId: session.deviceId,
        metadata: { status: "completed", actionType: decision.actionType },
      });

      ensureDispatchHandoffPackage(productStore, {
        actorId: session.deviceId,
        request: completedRequest,
        outcome: "completed",
      });

      return c.json(buildApprovalResponse(productStore, completedRequest, reviewItem, decisionRecord));
    } catch (error) {
      const failedRequest = productStore.setDispatchRequestStatus(
        acceptedRequest.requestId,
        mapRequestStatusToStore("failed"),
        withStatusMetadata(acceptedRequest.metadata, "failed", decision)
      ) ?? acceptedRequest;

      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: failedRequest.requestId,
        action: "dispatch.failed",
        actorId: session.deviceId,
        metadata: { status: "failed", actionType: decision.actionType, error: toErrorMessage(error) },
      });

      return c.json({
        error: toErrorMessage(error),
        decisionRecord: serializeDecision(decisionRecord),
        request: serializeDispatchRequest(failedRequest, productStore),
      }, 502);
    }
  });

  app.post("/dispatch/requests", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const targetScope = asTargetScope(body.targetScope);
    const followUpPolicy = asFollowUpPolicy(body.followUpPolicy);
    const executionActionType = asNonEmptyString(body.executionActionType);
    const usesDispatchMode = executionActionType !== null || followUpPolicy !== null;
    const actionType = usesDispatchMode ? "dispatch.create" : asNonEmptyString(body.actionType);

    if (!actionType || !targetScope) {
      return c.json({ error: "Missing actionType or targetScope" }, 400);
    }

    if (usesDispatchMode && (!executionActionType || !followUpPolicy)) {
      return c.json({ error: "Missing executionActionType or followUpPolicy" }, 400);
    }

    const decision = classifyAction(actionType, targetScope);
    const executionDecision = usesDispatchMode && executionActionType
      ? classifyAction(executionActionType, targetScope)
      : null;
    const requestId = asNonEmptyString(body.requestId) ?? crypto.randomUUID();
    const idempotencyKey = asOptionalString(body.idempotencyKey);
    const replayKey = buildReplayKey("dispatch_create", {
      actorId: session.deviceId,
      actionType,
      targetScope,
      targetId: asOptionalString(body.targetId) ?? null,
      targetLabel: asOptionalString(body.targetLabel) ?? null,
      inputSummary: asOptionalString(body.inputSummary) ?? null,
      followUpPolicy,
      executionActionType,
    });
    const duplicate = resolveExistingDispatchRequest(productStore, {
      requestId,
      idempotencyKey,
      replayKey,
    });

    if (duplicate) {
      appendReplayAuditEvents(productStore, {
        entityId: duplicate.requestId,
        actorId: session.deviceId,
        idempotencyKey,
        replayKey,
        existingRequestId: duplicate.requestId,
      });
      return c.json({ request: serializeDispatchRequest(duplicate), deduplicated: true }, 200);
    }

    if (decision.actionClass === "forbidden") {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: requestId,
        action: decision.auditEvent,
        actorId: session.deviceId,
        metadata: { status: "rejected", decision },
      });
      return c.json({ error: "Forbidden by policy", decision }, 403);
    }

    const apiStatus: ProductDispatchRequestStatus = decision.actionClass === "approval_required" ? "awaiting_approval" : "queued";
    const record = productStore.upsertDispatchRequest({
      requestId,
      idempotencyKey,
      status: mapRequestStatusToStore(apiStatus),
      actorId: session.deviceId,
      targetId: asOptionalString(body.targetId),
      inputSummary: asOptionalString(body.inputSummary),
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withReplayMetadata(
        withDispatchMetadata(asObject(body.metadata), {
          status: apiStatus,
          decision,
          dispatchContext: executionDecision && executionActionType && followUpPolicy
            ? {
                mode: "dispatch_mode",
                followUpPolicy,
                executionActionType,
                executionDecision,
                targetLabel: asOptionalString(body.targetLabel),
              }
            : null,
        }),
        replayKey
      ),
    });

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: record.requestId,
      action: decision.auditEvent,
      actorId: session.deviceId,
      metadata: { status: apiStatus, decision },
    });

    if (decision.actionClass === "approval_required") {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: record.requestId,
        action: "approval.requested",
        actorId: session.deviceId,
        metadata: { status: apiStatus, actionType },
      });
    } else {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: record.requestId,
        action: "dispatch.created",
        actorId: session.deviceId,
        metadata: { status: apiStatus, actionType },
      });
    }

    return c.json({ request: serializeDispatchRequest(record, productStore), decision, executionDecision }, 201);
  });

  app.get("/dispatch/requests", requireTrusted, (c) => {
    const limit = asPositiveInteger(parsePositiveInteger(c.req.query("limit")));
    const requests = productStore.listDispatchRequests().reverse();
    const sliced = limit ? requests.slice(0, limit) : requests;
    return c.json({ requests: sliced.map((request) => serializeDispatchRequest(request, productStore)) });
  });

  app.get("/dispatch/requests/:requestId", requireTrusted, (c) => {
    const requestId = getRequiredParam(c, "requestId");
    if (requestId instanceof Response) {
      return requestId;
    }
    const request = productStore.getDispatchRequest(requestId);
    if (!request) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }
    return c.json({ request: serializeDispatchRequest(request, productStore) });
  });

  app.post("/dispatch/requests/:requestId/status", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const requestId = getRequiredParam(c, "requestId");
    if (requestId instanceof Response) {
      return requestId;
    }
    const request = productStore.getDispatchRequest(requestId);
    if (!request) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const nextStatus = asRequestStatus(body.status);
    if (!nextStatus) {
      return c.json({ error: "Invalid dispatch request status" }, 400);
    }

    const currentStatus = getDispatchRequestStatus(request);
    if (currentStatus === nextStatus) {
      return c.json({ request: serializeDispatchRequest(request, productStore), deduplicated: true });
    }

    if (!REQUEST_TRANSITIONS[currentStatus].includes(nextStatus)) {
      return c.json({ error: `Illegal dispatch request transition: ${currentStatus} -> ${nextStatus}` }, 409);
    }

    const updated = productStore.setDispatchRequestStatus(request.requestId, mapRequestStatusToStore(nextStatus), withStatusMetadata(request.metadata, nextStatus));
    if (!updated) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }

    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: updated.requestId,
      action: mapDispatchRequestEvent(nextStatus),
      actorId: session.deviceId,
      metadata: { fromStatus: currentStatus, status: nextStatus },
    });

    return c.json({ request: serializeDispatchRequest(updated, productStore) });
  });

  app.post("/dispatch/requests/:requestId/execute", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const requestId = getRequiredParam(c, "requestId");
    if (requestId instanceof Response) {
      return requestId;
    }
    const request = productStore.getDispatchRequest(requestId);
    if (!request) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }

    const dispatchContext = getDispatchContext(request.metadata);
    if (!dispatchContext) {
      return c.json({ error: "Dispatch request has no dispatch mode context" }, 409);
    }

    const currentStatus = getDispatchRequestStatus(request);
    if (currentStatus === "blocked" || currentStatus === "completed") {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: request.requestId,
        action: "reconnect.restored",
        actorId: session.deviceId,
        metadata: { status: currentStatus },
      });
      return c.json(buildDispatchExecutionResponse(productStore, request), 200);
    }

    if (!["queued", "accepted"].includes(currentStatus)) {
      return c.json({ error: `Dispatch request is not executable from ${currentStatus}` }, 409);
    }

    if (dispatchContext.executionDecision.actionClass === "forbidden") {
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: request.requestId,
        action: dispatchContext.executionDecision.auditEvent,
        actorId: session.deviceId,
        metadata: { status: currentStatus, decision: dispatchContext.executionDecision },
      });
      return c.json({ error: "Dispatch execution forbidden by policy", decision: dispatchContext.executionDecision }, 403);
    }

    let acceptedRequest = request;
    if (currentStatus === "queued") {
      acceptedRequest = productStore.setDispatchRequestStatus(
        request.requestId,
        mapRequestStatusToStore("accepted"),
        withDispatchMetadata(request.metadata, { status: "accepted" })
      ) ?? request;
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: request.requestId,
        action: "dispatch.accepted",
        actorId: session.deviceId,
        metadata: { fromStatus: currentStatus, status: "accepted" },
      });
    }

    const body = await c.req.json().catch(() => ({}));
    const runId = asNonEmptyString(body.runId) ?? crypto.randomUUID();
    let run = productStore.upsertDispatchRun({
      runId,
      requestId: request.requestId,
      status: mapRunStatusToStore("running"),
      attempt: asPositiveInteger(body.attempt) ?? productStore.listDispatchRunsForRequest(request.requestId).length + 1,
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withStatusMetadata(asObject(body.metadata), "running"),
    });

    appendAuditEvent(productStore, {
      entityType: "dispatch_run",
      entityId: run.runId,
      action: "dispatch.started",
      actorId: session.deviceId,
      metadata: {
        status: "running",
        requestStatus: getDispatchRequestStatus(acceptedRequest),
        executionActionType: dispatchContext.executionActionType,
        followUpPolicy: dispatchContext.followUpPolicy,
      },
    });

    const shouldBlock = dispatchContext.executionDecision.actionClass === "approval_required"
      || dispatchContext.followUpPolicy === "hold_for_review";

    if (shouldBlock) {
      if (dispatchContext.executionDecision.actionClass === "approval_required") {
        appendAuditEvent(productStore, {
          entityType: "dispatch_request",
          entityId: request.requestId,
          action: dispatchContext.executionDecision.auditEvent,
          actorId: session.deviceId,
          metadata: { status: "awaiting_approval", decision: dispatchContext.executionDecision },
        });
        appendAuditEvent(productStore, {
          entityType: "dispatch_request",
          entityId: request.requestId,
          action: "approval.requested",
          actorId: session.deviceId,
          metadata: {
            status: "awaiting_approval",
            actionType: dispatchContext.executionActionType,
            followUpPolicy: dispatchContext.followUpPolicy,
          },
        });
      }

      const blockedRequest = productStore.setDispatchRequestStatus(
        request.requestId,
        mapRequestStatusToStore("blocked"),
        withDispatchMetadata(acceptedRequest.metadata, { status: "blocked" })
      ) ?? acceptedRequest;
      run = productStore.setDispatchRunStatus(run.runId, mapRunStatusToStore("blocked"), {
        metadata: withStatusMetadata(run.metadata, "blocked"),
      }) ?? run;

      appendAuditEvent(productStore, {
        entityType: "dispatch_run",
        entityId: run.runId,
        action: "dispatch.blocked",
        actorId: session.deviceId,
        metadata: {
          status: "blocked",
          actionType: dispatchContext.executionActionType,
          followUpPolicy: dispatchContext.followUpPolicy,
        },
      });

      const reviewItem = ensureDispatchReviewItem(productStore, {
        request: blockedRequest,
        dispatchContext,
      });
      ensureDispatchHandoffPackage(productStore, {
        actorId: session.deviceId,
        request: blockedRequest,
        run,
        reviewItem,
        outcome: "blocked",
      });

      return c.json({
        request: serializeDispatchRequest(blockedRequest, productStore),
        run: serializeDispatchRun(run),
        reviewItem: serializeReviewItem(reviewItem),
      }, 200);
    }

    const completedRequest = productStore.setDispatchRequestStatus(
      request.requestId,
      mapRequestStatusToStore("completed"),
      withDispatchMetadata(acceptedRequest.metadata, { status: "completed" })
    ) ?? acceptedRequest;
    run = productStore.setDispatchRunStatus(run.runId, mapRunStatusToStore("completed"), {
      completedAt: new Date().toISOString(),
      metadata: withStatusMetadata(run.metadata, "completed"),
    }) ?? run;

    appendAuditEvent(productStore, {
      entityType: "dispatch_run",
      entityId: run.runId,
      action: "dispatch.completed",
      actorId: session.deviceId,
      metadata: {
        status: "completed",
        actionType: dispatchContext.executionActionType,
        followUpPolicy: dispatchContext.followUpPolicy,
      },
    });
    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: request.requestId,
      action: "dispatch.completed",
      actorId: session.deviceId,
      metadata: { status: "completed", runId: run.runId },
    });

    ensureDispatchHandoffPackage(productStore, {
      actorId: session.deviceId,
      request: completedRequest,
      run,
      outcome: "completed",
    });

    return c.json({ request: serializeDispatchRequest(completedRequest, productStore), run: serializeDispatchRun(run) }, 200);
  });

  app.post("/dispatch/runs", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const requestId = asNonEmptyString(body.requestId);
    if (!requestId) {
      return c.json({ error: "Missing requestId" }, 400);
    }

    const request = productStore.getDispatchRequest(requestId);
    if (!request) {
      return c.json({ error: "Dispatch request not found" }, 404);
    }

    const requestStatus = getDispatchRequestStatus(request);
    if (requestStatus === "awaiting_approval" || requestStatus === "blocked") {
      return c.json({ error: `Dispatch request is not ready to start from ${requestStatus}` }, 409);
    }
    if (["completed", "failed", "cancelled", "expired"].includes(requestStatus)) {
      return c.json({ error: `Dispatch request is terminal: ${requestStatus}` }, 409);
    }

    let acceptedRequest = request;
    if (requestStatus === "queued") {
      acceptedRequest = productStore.setDispatchRequestStatus(request.requestId, mapRequestStatusToStore("accepted"), withStatusMetadata(request.metadata, "accepted")) ?? request;
      appendAuditEvent(productStore, {
        entityType: "dispatch_request",
        entityId: request.requestId,
        action: "dispatch.accepted",
        actorId: session.deviceId,
        metadata: { fromStatus: requestStatus, status: "accepted" },
      });
    }

    const runId = asNonEmptyString(body.runId) ?? crypto.randomUUID();
    const record = productStore.upsertDispatchRun({
      runId,
      requestId,
      status: mapRunStatusToStore("running"),
      attempt: asPositiveInteger(body.attempt) ?? productStore.listDispatchRunsForRequest(requestId).length + 1,
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withStatusMetadata(asObject(body.metadata), "running"),
    });

    appendAuditEvent(productStore, {
      entityType: "dispatch_run",
      entityId: record.runId,
      action: "dispatch.started",
      actorId: session.deviceId,
      metadata: { status: "running", requestStatus: getDispatchRequestStatus(acceptedRequest) },
    });

    return c.json({ run: serializeDispatchRun(record) }, 201);
  });

  app.get("/dispatch/runs/:runId", requireTrusted, (c) => {
    const runId = getRequiredParam(c, "runId");
    if (runId instanceof Response) {
      return runId;
    }
    const run = productStore.getDispatchRun(runId);
    if (!run) {
      return c.json({ error: "Dispatch run not found" }, 404);
    }
    return c.json({ run: serializeDispatchRun(run) });
  });

  app.post("/dispatch/runs/:runId/status", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const runId = getRequiredParam(c, "runId");
    if (runId instanceof Response) {
      return runId;
    }
    const run = productStore.getDispatchRun(runId);
    if (!run) {
      return c.json({ error: "Dispatch run not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const nextStatus = asRunStatus(body.status);
    if (!nextStatus) {
      return c.json({ error: "Invalid dispatch run status" }, 400);
    }

    const currentStatus = getDispatchRunStatus(run);
    if (currentStatus === nextStatus) {
      return c.json({ run: serializeDispatchRun(run), deduplicated: true });
    }

    if (!RUN_TRANSITIONS[currentStatus].includes(nextStatus)) {
      return c.json({ error: `Illegal dispatch run transition: ${currentStatus} -> ${nextStatus}` }, 409);
    }

    const updated = productStore.setDispatchRunStatus(run.runId, mapRunStatusToStore(nextStatus), {
      completedAt: ["completed", "failed", "cancelled", "expired"].includes(nextStatus) ? new Date().toISOString() : undefined,
      error: asOptionalString(body.error),
      metadata: withStatusMetadata(run.metadata, nextStatus),
    });

    if (!updated) {
      return c.json({ error: "Dispatch run not found" }, 404);
    }

    appendAuditEvent(productStore, {
      entityType: "dispatch_run",
      entityId: updated.runId,
      action: mapDispatchRunEvent(nextStatus),
      actorId: session.deviceId,
      metadata: { fromStatus: currentStatus, status: nextStatus },
    });

    return c.json({ run: serializeDispatchRun(updated) });
  });

  app.post("/review/items", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const subjectType = asNonEmptyString(body.subjectType);
    const subjectId = asNonEmptyString(body.subjectId);
    const title = asNonEmptyString(body.title);

    if (!subjectType || !subjectId || !title) {
      return c.json({ error: "Missing subjectType, subjectId, or title" }, 400);
    }

    const record = productStore.upsertReviewItem({
      reviewItemId: asNonEmptyString(body.reviewItemId) ?? crypto.randomUUID(),
      subjectType,
      subjectId,
      status: mapReviewStatusToStore("pending_review"),
      assignedTo: asOptionalString(body.assignedTo),
      title,
      summary: asOptionalString(body.summary),
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withStatusMetadata(asObject(body.metadata), "pending_review"),
    });

    appendAuditEvent(productStore, {
      entityType: "review_item",
      entityId: record.reviewItemId,
      action: "review.created",
      actorId: session.deviceId,
      metadata: { status: "pending_review", subjectType, subjectId },
    });

    if (hasVoicemailMetadata(record.metadata)) {
      appendAuditEvent(productStore, {
        entityType: "review_item",
        entityId: record.reviewItemId,
        action: "voicemail.created",
        actorId: session.deviceId,
        metadata: { status: "pending_review", subjectType, subjectId },
      });
    }

    return c.json({ reviewItem: serializeReviewItem(record) }, 201);
  });

  app.get("/review/items", requireTrusted, (c) => {
    const statusFilter = parseReviewStatusFilter(c.req.query("status"));
    if (c.req.query("status") && !statusFilter) {
      return c.json({ error: "Invalid review status filter" }, 400);
    }

    const items = productStore.listReviewItems({
      statuses: statusFilter ?? undefined,
      limit: parsePositiveInteger(c.req.query("limit")) ?? undefined,
    });

    return c.json({
      items: items.map((item) => serializeReviewListItem(productStore, item)),
    });
  });

  app.get("/review/items/:reviewItemId", requireTrusted, (c) => {
    const reviewItemId = getRequiredParam(c, "reviewItemId");
    if (reviewItemId instanceof Response) {
      return reviewItemId;
    }
    const reviewItem = productStore.getReviewItem(reviewItemId);
    if (!reviewItem) {
      return c.json({ error: "Review item not found" }, 404);
    }
    return c.json({ reviewItem: serializeReviewItem(reviewItem) });
  });

  app.get("/review/items/:reviewItemId/detail", requireTrusted, (c) => {
    const reviewItemId = getRequiredParam(c, "reviewItemId");
    if (reviewItemId instanceof Response) {
      return reviewItemId;
    }
    const reviewItem = productStore.getReviewItem(reviewItemId);
    if (!reviewItem) {
      return c.json({ error: "Review item not found" }, 404);
    }

    return c.json({
      detail: serializeReviewDetail(productStore, reviewItem),
    });
  });

  app.post("/review/items/:reviewItemId/status", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const reviewItemId = getRequiredParam(c, "reviewItemId");
    if (reviewItemId instanceof Response) {
      return reviewItemId;
    }
    const reviewItem = productStore.getReviewItem(reviewItemId);
    if (!reviewItem) {
      return c.json({ error: "Review item not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const nextStatus = asReviewStatus(body.status);
    if (!nextStatus) {
      return c.json({ error: "Invalid review status" }, 400);
    }

    const currentStatus = getReviewStatus(reviewItem);
    if (currentStatus === nextStatus) {
      return c.json({ reviewItem: serializeReviewItem(reviewItem), deduplicated: true });
    }

    if (!REVIEW_TRANSITIONS[currentStatus].includes(nextStatus)) {
      return c.json({ error: `Illegal review transition: ${currentStatus} -> ${nextStatus}` }, 409);
    }

    const updated = productStore.setReviewItemStatus(reviewItem.reviewItemId, mapReviewStatusToStore(nextStatus), withStatusMetadata(reviewItem.metadata, nextStatus));
    if (!updated) {
      return c.json({ error: "Review item not found" }, 404);
    }

    appendAuditEvent(productStore, {
      entityType: "review_item",
      entityId: updated.reviewItemId,
      action: mapReviewEvent(currentStatus, nextStatus),
      actorId: session.deviceId,
      metadata: { fromStatus: currentStatus, status: nextStatus },
    });

    return c.json({ reviewItem: serializeReviewItem(updated) });
  });

  app.post("/review/items/:reviewItemId/actions", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const reviewItemId = getRequiredParam(c, "reviewItemId");
    if (reviewItemId instanceof Response) {
      return reviewItemId;
    }
    const reviewItem = productStore.getReviewItem(reviewItemId);
    if (!reviewItem) {
      return c.json({ error: "Review item not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const action = asReviewSurfaceAction(body.action);
    if (!action) {
      return c.json({ error: "Invalid review action" }, 400);
    }

    const currentStatus = getReviewStatus(reviewItem);
    if (action === "snooze" && currentStatus === "snoozed") {
      return c.json(buildReviewActionResponse(productStore, reviewItem, action), 200);
    }

    if (currentStatus === "resolved") {
      return c.json(buildReviewActionResponse(productStore, reviewItem, action), 200);
    }

    if (action === "snooze") {
      const updated = productStore.setReviewItemStatus(
        reviewItem.reviewItemId,
        mapReviewStatusToStore("snoozed"),
        withStatusMetadata(reviewItem.metadata, "snoozed")
      );

      if (!updated) {
        return c.json({ error: "Review item not found" }, 404);
      }

      appendAuditEvent(productStore, {
        entityType: "review_item",
        entityId: updated.reviewItemId,
        action: mapReviewEvent(currentStatus, "snoozed"),
        actorId: session.deviceId,
        metadata: { fromStatus: currentStatus, status: "snoozed", action },
      });

      return c.json({
        action,
        reviewItem: serializeReviewItem(updated),
        detail: serializeReviewDetail(productStore, updated),
      });
    }

    const decision = productStore.recordDecision({
      decisionId: asNonEmptyString(body.decisionId) ?? crypto.randomUUID(),
      reviewItemId: reviewItem.reviewItemId,
      outcome: mapDecisionStatusToStore("approved"),
      deciderId: session.deviceId,
      rationale: asOptionalString(body.rationale),
      idempotencyKey: asOptionalString(body.idempotencyKey),
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withDecisionMetadata({
        ...(asObject(body.metadata) ?? {}),
        [REVIEW_ACTION_METADATA_KEY]: action,
      }, "approved"),
    });

    const updatedReviewItem = productStore.setReviewItemStatus(
      reviewItem.reviewItemId,
      mapReviewStatusToStore("resolved"),
      withStatusMetadata(productStore.getReviewItem(reviewItem.reviewItemId)?.metadata, "resolved")
    );

    appendAuditEvent(productStore, {
      entityType: "review_item",
      entityId: reviewItem.reviewItemId,
      action: mapDecisionEvent("approved"),
      actorId: session.deviceId,
      metadata: { status: "approved", decisionId: decision.decisionId, action },
    });

    const subject = action === "approve"
      ? resumeApprovedReviewSubject(productStore, session.deviceId, reviewItem)
      : null;
    const handoff = action === "continue"
      ? acceptLinkedHandoff(productStore, session.deviceId, reviewItem)
      : null;
    const resolvedReviewItem = updatedReviewItem ?? productStore.getReviewItem(reviewItem.reviewItemId);

    return c.json({
      action,
      decision: serializeDecision(decision),
      reviewItem: resolvedReviewItem ? serializeReviewItem(resolvedReviewItem) : null,
      subject,
      handoff: handoff ? serializeHandoff(handoff) : null,
      detail: resolvedReviewItem ? serializeReviewDetail(productStore, resolvedReviewItem) : null,
    });
  });

  app.post("/decisions", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const reviewItemId = asNonEmptyString(body.reviewItemId);
    const outcome = asDecisionStatus(body.outcome);

    if (!reviewItemId || !outcome) {
      return c.json({ error: "Missing reviewItemId or outcome" }, 400);
    }

    const reviewItem = productStore.getReviewItem(reviewItemId);
    if (!reviewItem) {
      return c.json({ error: "Review item not found" }, 404);
    }

    if (getReviewStatus(reviewItem) === "resolved") {
      return c.json({ error: "Cannot record a decision for a resolved review item" }, 409);
    }

    const record = productStore.recordDecision({
      decisionId: asNonEmptyString(body.decisionId) ?? crypto.randomUUID(),
      reviewItemId,
      outcome: mapDecisionStatusToStore(outcome),
      deciderId: session.deviceId,
      rationale: asOptionalString(body.rationale),
      idempotencyKey: asOptionalString(body.idempotencyKey),
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withDecisionMetadata(asObject(body.metadata), outcome),
    });

    const updatedReviewItem = productStore.setReviewItemStatus(reviewItemId, mapReviewStatusToStore("resolved"), withStatusMetadata(productStore.getReviewItem(reviewItemId)?.metadata, "resolved"));

    appendAuditEvent(productStore, {
      entityType: "review_item",
      entityId: reviewItemId,
      action: mapDecisionEvent(outcome),
      actorId: session.deviceId,
      metadata: { status: outcome, decisionId: record.decisionId },
    });

    return c.json({
      decision: serializeDecision(record),
      reviewItem: updatedReviewItem ? serializeReviewItem(updatedReviewItem) : null,
    }, 201);
  });

  app.get("/decisions/:decisionId", requireTrusted, (c) => {
    const decisionId = getRequiredParam(c, "decisionId");
    if (decisionId instanceof Response) {
      return decisionId;
    }
    const decision = productStore.getDecision(decisionId);
    if (!decision) {
      return c.json({ error: "Decision not found" }, 404);
    }
    return c.json({ decision: serializeDecision(decision) });
  });

  app.post("/handoffs", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const body = await c.req.json().catch(() => ({}));
    const fromType = asNonEmptyString(body.fromType);
    const fromId = asNonEmptyString(body.fromId);
    const toType = asNonEmptyString(body.toType);
    const toId = asNonEmptyString(body.toId);

    if (!fromType || !fromId || !toType || !toId) {
      return c.json({ error: "Missing handoff fields" }, 400);
    }

    const record = productStore.upsertHandoff({
      handoffId: asNonEmptyString(body.handoffId) ?? crypto.randomUUID(),
      fromType,
      fromId,
      toType,
      toId,
      status: mapHandoffStatusToStore("ready"),
      summary: asOptionalString(body.summary),
      opencodeRefs: asObject(body.opencodeRefs),
      metadata: withStatusMetadata(asObject(body.metadata), "ready"),
    });

    appendAuditEvent(productStore, {
      entityType: "handoff_package",
      entityId: record.handoffId,
      action: "handoff.created",
      actorId: session.deviceId,
      metadata: { status: "ready", fromType, fromId, toType, toId },
    });

    return c.json({ handoff: serializeHandoff(record) }, 201);
  });

  app.get("/handoffs/:handoffId", requireTrusted, (c) => {
    const handoffId = getRequiredParam(c, "handoffId");
    if (handoffId instanceof Response) {
      return handoffId;
    }
    const handoff = productStore.getHandoff(handoffId);
    if (!handoff) {
      return c.json({ error: "Handoff not found" }, 404);
    }
    return c.json({ handoff: serializeHandoff(handoff) });
  });

  app.post("/handoffs/:handoffId/status", requireTrusted, async (c) => {
    const session = getTrustedContext(c).get("trustedSession");
    const handoffId = getRequiredParam(c, "handoffId");
    if (handoffId instanceof Response) {
      return handoffId;
    }
    const handoff = productStore.getHandoff(handoffId);
    if (!handoff) {
      return c.json({ error: "Handoff not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const nextStatus = asHandoffStatus(body.status);
    if (!nextStatus) {
      return c.json({ error: "Invalid handoff status" }, 400);
    }

    const currentStatus = getHandoffStatus(handoff);
    if (currentStatus === nextStatus) {
      return c.json({ handoff: serializeHandoff(handoff), deduplicated: true });
    }

    if (!HANDOFF_TRANSITIONS[currentStatus].includes(nextStatus)) {
      return c.json({ error: `Illegal handoff transition: ${currentStatus} -> ${nextStatus}` }, 409);
    }

    const updated = productStore.setHandoffStatus(handoff.handoffId, mapHandoffStatusToStore(nextStatus), {
      acceptedAt: nextStatus === "accepted" ? new Date().toISOString() : undefined,
      metadata: withStatusMetadata(handoff.metadata, nextStatus),
    });

    if (!updated) {
      return c.json({ error: "Handoff not found" }, 404);
    }

    appendAuditEvent(productStore, {
      entityType: "handoff_package",
      entityId: updated.handoffId,
      action: nextStatus === "in_review" ? "handoff.opened" : "handoff.accepted",
      actorId: session.deviceId,
      metadata: { fromStatus: currentStatus, status: nextStatus },
    });

    return c.json({ handoff: serializeHandoff(updated) });
  });

  return app;
}

function getTrustedContext(c: Context): TrustedContext {
  return c as TrustedContext;
}

function classifyAction(actionType: string, targetScope: TargetScope): ProductDecision {
  if (FORBIDDEN_ACTIONS.has(actionType)) {
    return {
      actionType,
      actionClass: "forbidden",
      targetScope,
      requiresApproval: false,
      decisionReason: actionType === "secret.read_store" ? "secret_sensitive" : actionType === "desktop.mirror_arbitrary" ? "unsupported_remote_control" : "unsupported_remote_control",
      auditEvent: "policy.forbidden",
    };
  }

  if (targetScope === "unknown") {
    return {
      actionType,
      actionClass: "approval_required",
      targetScope,
      requiresApproval: true,
      decisionReason: "unknown_scope",
      auditEvent: "policy.approval_required",
    };
  }

  if (APPROVAL_REQUIRED_ACTIONS.has(actionType) || targetScope === "cross_project" || targetScope === "sensitive_surface") {
    return {
      actionType,
      actionClass: "approval_required",
      targetScope,
      requiresApproval: true,
      decisionReason: actionType === "deploy.trigger"
        ? "deploy_or_prod"
        : actionType === "trust.revoke" || actionType === "trust.pair" || actionType === "permissions.grant"
          ? "permissions_or_trust_change"
          : actionType === "repo.write" || actionType === "git.write" || actionType === "cleanup.destructive"
            ? "destructive_change"
            : targetScope === "cross_project"
              ? "cross_project_write"
              : targetScope === "sensitive_surface"
                ? "sensitive_capture"
                : "unknown_scope",
      auditEvent: "policy.approval_required",
    };
  }

  return {
    actionType,
    actionClass: "allowed",
    targetScope,
    requiresApproval: false,
    decisionReason: actionType === "review.list" || actionType === "review.open" || actionType === "review.snooze"
      ? "review_triage_safe"
      : actionType === "repo.read_status"
        ? "non_destructive_read"
        : "non_destructive_dispatch",
    auditEvent: "policy.allowed",
  };
}

function appendAuditEvent(productStore: ProductStore, input: Omit<AuditEventRecord, "eventId">): void {
  productStore.appendAuditEvent({
    eventId: crypto.randomUUID(),
    ...input,
  });
}

function serializeDispatchRequest(record: DispatchRequestRecord, productStore?: ProductStore) {
  const dispatchContext = getDispatchContext(record.metadata);
  const latestRun = productStore ? getLatestDispatchRun(productStore, record.requestId) : null;
  const latestReviewItem = productStore ? getLatestDispatchReviewItem(productStore, record.requestId) : null;
  const latestHandoff = productStore ? getLatestHandoffForSource(productStore, "dispatch_request", record.requestId) : null;
  return {
    ...record,
    status: getDispatchRequestStatus(record),
    decision: getDecisionMetadata(record.metadata),
    followUpPolicy: dispatchContext?.followUpPolicy ?? null,
    executionDecision: dispatchContext?.executionDecision ?? null,
    executionActionType: dispatchContext?.executionActionType ?? null,
    targetLabel: dispatchContext?.targetLabel ?? null,
    latestRun: latestRun ? serializeDispatchRun(latestRun) : null,
    latestReviewItem: latestReviewItem ? serializeReviewItem(latestReviewItem) : null,
    latestHandoff: latestHandoff ? serializeHandoff(latestHandoff) : null,
  };
}

function serializeDispatchRun(record: DispatchRunRecord) {
  return {
    ...record,
    status: getDispatchRunStatus(record),
  };
}

function serializeReviewItem(record: ReviewItemRecord) {
  return {
    ...record,
    status: getReviewStatus(record),
  };
}

function serializeReviewListItem(productStore: ProductStore, record: ReviewItemRecord) {
  const handoffs = productStore.listHandoffsForSource(record.subjectType, record.subjectId);
  const subject = serializeReviewSubject(productStore, record);
  return {
    reviewItem: serializeReviewItem(record),
    voicemail: getVoicemailMetadata(record),
    subject,
    latestDecision: getLatestReviewDecision(productStore, record),
    handoffCount: handoffs.length,
    availableActions: getAvailableReviewActions(record, subject, handoffs),
  };
}

function serializeReviewDetail(productStore: ProductStore, record: ReviewItemRecord) {
  const handoffs = productStore.listHandoffsForSource(record.subjectType, record.subjectId);
  const subject = serializeReviewSubject(productStore, record);
  const timeline = buildReviewTimeline(productStore, record, handoffs);
  const primaryHandoff = handoffs.at(-1) ?? null;
  return {
    reviewItem: serializeReviewItem(record),
    voicemail: getVoicemailMetadata(record),
    subject,
    latestDecision: getLatestReviewDecision(productStore, record),
    handoffs: handoffs.map((handoff) => serializeHandoff(handoff)),
    primaryHandoff: primaryHandoff ? serializeHandoff(primaryHandoff) : null,
    linkedContext: {
      opencodeRefs: record.opencodeRefs ?? null,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      handoffPath: primaryHandoff ? `/api/product/handoffs/${primaryHandoff.handoffId}` : null,
      auditRefs: primaryHandoff ? getHandoffPackage(primaryHandoff.metadata)?.auditRefs ?? [] : [],
    },
    auditEvents: timeline.map((entry) => serializeAuditEvent(entry)),
    timeline,
    availableActions: getAvailableReviewActions(record, subject, handoffs),
  };
}

function serializeDecision(record: DecisionRecord) {
  return {
    ...record,
    outcome: getDecisionStatus(record),
  };
}

function serializeHandoff(record: HandoffRecord) {
  const handoffPackage = getHandoffPackage(record.metadata);
  return {
    ...record,
    status: getHandoffStatus(record),
    path: `/api/product/handoffs/${record.handoffId}`,
    package: handoffPackage,
  };
}

function serializeAuditEvent(record: AuditEventRecord) {
  return {
    ...record,
  };
}

function buildReviewTimeline(productStore: ProductStore, record: ReviewItemRecord, handoffs: HandoffRecord[]): TimelineEntry[] {
  const timelineRefs = new Map<string, HandoffAuditRef>();
  timelineRefs.set(`review_item:${record.reviewItemId}`, { entityType: "review_item", entityId: record.reviewItemId });

  if (record.subjectType === "dispatch_request") {
    timelineRefs.set(`dispatch_request:${record.subjectId}`, { entityType: "dispatch_request", entityId: record.subjectId });
    const run = getLatestDispatchRun(productStore, record.subjectId);
    if (run) {
      timelineRefs.set(`dispatch_run:${run.runId}`, { entityType: "dispatch_run", entityId: run.runId });
    }
  }

  for (const handoff of handoffs) {
    timelineRefs.set(`handoff_package:${handoff.handoffId}`, { entityType: "handoff_package", entityId: handoff.handoffId });
    const handoffPackage = getHandoffPackage(handoff.metadata);
    for (const ref of handoffPackage?.auditRefs ?? []) {
      timelineRefs.set(`${ref.entityType}:${ref.entityId}`, ref);
    }
  }

  const entries = Array.from(timelineRefs.values()).flatMap((ref) => (
    productStore.listAuditEvents({ entityType: ref.entityType, entityId: ref.entityId, limit: 12 })
  ));
  const deduped = new Map(entries.map((entry) => [entry.eventId, entry]));
  return Array.from(deduped.values())
    .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""))
    .map((event) => ({
      eventId: event.eventId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      occurredAt: event.occurredAt,
      status: readEventStatus(event.metadata),
      title: buildTimelineTitle(event),
      detail: buildTimelineDetail(event),
    }));
}

function serializeReviewSubject(productStore: ProductStore, record: ReviewItemRecord) {
  if (record.subjectType === "dispatch_request") {
    const request = productStore.getDispatchRequest(record.subjectId);
    if (!request) {
      return {
        type: record.subjectType,
        id: record.subjectId,
        status: "unknown",
        label: record.title,
        decision: null,
        summary: record.summary ?? null,
      };
    }

    return {
      type: record.subjectType,
      id: request.requestId,
      status: getDispatchRequestStatus(request),
      label: request.inputSummary ?? request.targetId ?? request.requestId,
      decision: getDecisionMetadata(request.metadata),
      summary: request.inputSummary ?? null,
      opencodeRefs: request.opencodeRefs ?? null,
    };
  }

  if (record.subjectType === "dispatch_run") {
    const run = productStore.getDispatchRun(record.subjectId);
    if (!run) {
      return {
        type: record.subjectType,
        id: record.subjectId,
        status: "unknown",
        label: record.title,
        decision: null,
        summary: record.summary ?? null,
      };
    }

    return {
      type: record.subjectType,
      id: run.runId,
      status: getDispatchRunStatus(run),
      label: `Attempt ${run.attempt}`,
      decision: null,
      summary: run.error ?? null,
      opencodeRefs: run.opencodeRefs ?? null,
    };
  }

  return {
    type: record.subjectType,
    id: record.subjectId,
    status: getReviewStatus(record),
    label: record.title,
    decision: null,
    summary: record.summary ?? null,
    opencodeRefs: record.opencodeRefs ?? null,
  };
}

function getLatestReviewDecision(productStore: ProductStore, record: ReviewItemRecord) {
  const latestDecisionId = record.latestDecisionId;
  const latestDecision = latestDecisionId
    ? productStore.getDecision(latestDecisionId)
    : productStore.listDecisionsForReviewItem(record.reviewItemId).at(-1) ?? null;
  return latestDecision ? serializeDecision(latestDecision) : null;
}

function getVoicemailMetadata(record: ReviewItemRecord): ReviewVoicemail {
  const value = record.metadata?.[VOICEMAIL_METADATA_KEY];
  const metadata = isRecord(value) ? value : null;
  return {
    textSummary: asNonEmptyString(metadata?.textSummary) ?? record.summary ?? record.title,
    transcriptText: asOptionalString(metadata?.transcriptText) ?? record.summary ?? null,
    priorityLabel: asOptionalString(metadata?.priorityLabel) ?? inferReviewPriority(record),
    spokenSummary: asOptionalString(metadata?.spokenSummary) ?? null,
  };
}

function getHandoffPackage(metadata?: ProductMetadata): HandoffPackage | null {
  const value = metadata?.[HANDOFF_PACKAGE_METADATA_KEY];
  if (!isRecord(value)) {
    return null;
  }

  const summary = asNonEmptyString(value.summary);
  const linkedContext = isRecord(value.linkedContext) ? value.linkedContext : null;
  const nextActions = Array.isArray(value.nextActions)
    ? value.nextActions.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => entry !== null)
    : [];
  const auditRefs = Array.isArray(value.auditRefs)
    ? value.auditRefs
      .map((entry) => isRecord(entry)
        ? {
            entityType: asNonEmptyString(entry.entityType),
            entityId: asNonEmptyString(entry.entityId),
          }
        : null)
      .filter((entry): entry is { entityType: string | null; entityId: string | null } => entry !== null)
      .filter((entry): entry is HandoffAuditRef => entry.entityType !== null && entry.entityId !== null)
    : [];

  if (!summary || !linkedContext) {
    return null;
  }

  return {
    kind: "handoff_package",
    version: "v0.2",
    summary,
    linkedContext: {
      subjectType: asNonEmptyString(linkedContext.subjectType) ?? "dispatch_request",
      subjectId: asNonEmptyString(linkedContext.subjectId) ?? "unknown",
      requestId: asNonEmptyString(linkedContext.requestId) ?? "unknown",
      runId: asOptionalString(linkedContext.runId) ?? null,
      reviewItemId: asOptionalString(linkedContext.reviewItemId) ?? null,
      opencodeRefs: isRecord(linkedContext.opencodeRefs) ? linkedContext.opencodeRefs : null,
    },
    nextActions,
    auditRefs,
  };
}

function hasVoicemailMetadata(metadata?: ProductMetadata): boolean {
  return isRecord(metadata?.[VOICEMAIL_METADATA_KEY]);
}

function inferReviewPriority(record: ReviewItemRecord): string | null {
  const status = getReviewStatus(record);
  if (status === "pending_review") {
    return "needs attention";
  }
  if (status === "snoozed") {
    return "deferred";
  }
  return null;
}

function getAvailableReviewActions(
  record: ReviewItemRecord,
  subject: ReturnType<typeof serializeReviewSubject>,
  handoffs: HandoffRecord[]
): ReviewSurfaceAction[] {
  if (getReviewStatus(record) === "resolved") {
    return [];
  }

  const actions: ReviewSurfaceAction[] = [];
  const hasContinuableHandoff = handoffs.some((handoff) => {
    const status = getHandoffStatus(handoff);
    return status === "ready" || status === "in_review";
  });

  if (
    subject.decision?.requiresApproval
    || subject.status === "awaiting_approval"
    || subject.status === "blocked"
  ) {
    actions.push("approve");
  }

  if (hasContinuableHandoff || subject.status === "completed" || actions.length === 0) {
    actions.push("continue");
  }

  if (getReviewStatus(record) !== "snoozed") {
    actions.push("snooze");
  }

  return actions;
}

function getDispatchRequestStatus(record: DispatchRequestRecord): ProductDispatchRequestStatus {
  const metadataStatus = getStatusMetadata(record.metadata);
  if (metadataStatus && isRequestStatus(metadataStatus)) {
    return metadataStatus;
  }

  switch (record.status) {
    case "pending":
      return "awaiting_approval";
    case "queued":
      return "queued";
    case "running":
      return "accepted";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function getDispatchRunStatus(record: DispatchRunRecord): ProductDispatchRunStatus {
  const metadataStatus = getStatusMetadata(record.metadata);
  if (metadataStatus && isRunStatus(metadataStatus)) {
    return metadataStatus;
  }
  return record.status;
}

function getReviewStatus(record: ReviewItemRecord): ProductReviewStatus {
  const metadataStatus = getStatusMetadata(record.metadata);
  if (metadataStatus && isReviewStatus(metadataStatus)) {
    return metadataStatus;
  }

  switch (record.status) {
    case "pending":
      return "pending_review";
    case "in_review":
      return "in_review";
    case "resolved":
    case "approved":
    case "rejected":
      return "resolved";
    case "needs_input":
      return "snoozed";
  }
}

function getDecisionStatus(record: DecisionRecord): ProductDecisionStatus {
  const metadata = record.metadata ?? {};
  const value = metadata[STATUS_METADATA_KEY];
  if (value === "approved" || value === "denied" || value === "cancelled" || value === "expired") {
    return value;
  }

  switch (record.outcome) {
    case "approved":
      return "approved";
    case "rejected":
      return "denied";
    case "deferred":
      return "cancelled";
    case "escalated":
      return "expired";
  }
}

function getHandoffStatus(record: HandoffRecord): ProductHandoffStatus {
  const metadataStatus = getStatusMetadata(record.metadata);
  if (metadataStatus && isHandoffStatus(metadataStatus)) {
    return metadataStatus;
  }

  switch (record.status) {
    case "open":
      return "ready";
    case "accepted":
      return "accepted";
    case "completed":
      return "accepted";
    case "cancelled":
      return "ready";
  }
}

function getStatusMetadata(metadata?: ProductMetadata): string | null {
  const value = metadata?.[STATUS_METADATA_KEY];
  return typeof value === "string" ? value : null;
}

function getDecisionMetadata(metadata?: ProductMetadata): ProductDecision | null {
  const value = metadata?.[DECISION_METADATA_KEY];
  return isRecord(value) ? (value as ProductDecision) : null;
}

function getExecutionMetadata(metadata?: ProductMetadata): SubmittedAction | null {
  const value = metadata?.[EXECUTION_METADATA_KEY];
  return isSubmittedAction(value) ? value : null;
}

function getExecutionResultMetadata(metadata?: ProductMetadata): ExecutedActionResult | null {
  const value = metadata?.[RESULT_METADATA_KEY];
  return isExecutedActionResult(value) ? value : null;
}

function getDispatchContext(metadata?: ProductMetadata): DispatchContext | null {
  const value = metadata?.[DISPATCH_CONTEXT_METADATA_KEY];
  return isDispatchContext(value) ? value : null;
}

function getReplayMetadata(metadata?: ProductMetadata): string | null {
  const value = metadata?.[REPLAY_METADATA_KEY];
  return typeof value === "string" ? value : null;
}

function withStatusMetadata(metadata: ProductMetadata | null | undefined, status: string, decision?: ProductDecision): ProductMetadata {
  const nextMetadata: ProductMetadata = { ...(metadata ?? {}) };
  nextMetadata[STATUS_METADATA_KEY] = status;
  if (decision) {
    nextMetadata[DECISION_METADATA_KEY] = decision;
  }
  return nextMetadata;
}

function withDispatchMetadata(
  metadata: ProductMetadata | null | undefined,
  input: { status: string; decision?: ProductDecision; dispatchContext?: DispatchContext | null }
): ProductMetadata {
  const nextMetadata = withStatusMetadata(metadata, input.status, input.decision);
  if (input.dispatchContext) {
    nextMetadata[DISPATCH_CONTEXT_METADATA_KEY] = input.dispatchContext;
  }
  return nextMetadata;
}

function withExecutionMetadata(metadata: ProductMetadata | null | undefined, action: SubmittedAction): ProductMetadata {
  const nextMetadata: ProductMetadata = { ...(metadata ?? {}) };
  nextMetadata[EXECUTION_METADATA_KEY] = action;
  return nextMetadata;
}

function withExecutionResultMetadata(metadata: ProductMetadata | null | undefined, result: ExecutedActionResult): ProductMetadata {
  const nextMetadata: ProductMetadata = { ...(metadata ?? {}) };
  nextMetadata[RESULT_METADATA_KEY] = result;
  return nextMetadata;
}

function withApprovalMetadata(metadata: ProductMetadata | null | undefined, requestId: string): ProductMetadata {
  const nextMetadata: ProductMetadata = { ...(metadata ?? {}) };
  nextMetadata[APPROVAL_METADATA_KEY] = { requestId };
  return nextMetadata;
}

function withReplayMetadata(metadata: ProductMetadata | null | undefined, replayKey: string): ProductMetadata {
  const nextMetadata: ProductMetadata = { ...(metadata ?? {}) };
  nextMetadata[REPLAY_METADATA_KEY] = replayKey;
  return nextMetadata;
}

function withDecisionMetadata(metadata: ProductMetadata | null | undefined, status: ProductDecisionStatus): ProductMetadata {
  return withStatusMetadata(metadata, status);
}

function withHandoffPackageMetadata(metadata: ProductMetadata | null | undefined, handoffPackage: HandoffPackage, status: ProductHandoffStatus): ProductMetadata {
  const nextMetadata = withStatusMetadata(metadata, status);
  nextMetadata[HANDOFF_PACKAGE_METADATA_KEY] = handoffPackage;
  return nextMetadata;
}

function mapRequestStatusToStore(status: ProductDispatchRequestStatus): DispatchRequestRecord["status"] {
  switch (status) {
    case "awaiting_approval":
      return "pending";
    case "queued":
      return "queued";
    case "accepted":
    case "blocked":
    case "expired":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function mapRunStatusToStore(status: ProductDispatchRunStatus): DispatchRunRecord["status"] {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "blocked":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "expired":
      return "cancelled";
  }
}

function mapReviewStatusToStore(status: ProductReviewStatus): ReviewItemRecord["status"] {
  switch (status) {
    case "pending_review":
      return "pending";
    case "in_review":
      return "in_review";
    case "snoozed":
      return "needs_input";
    case "resolved":
      return "resolved";
  }
}

function mapDecisionStatusToStore(status: ProductDecisionStatus): DecisionRecord["outcome"] {
  switch (status) {
    case "approved":
      return "approved";
    case "denied":
      return "rejected";
    case "cancelled":
      return "deferred";
    case "expired":
      return "escalated";
  }
}

function mapHandoffStatusToStore(status: ProductHandoffStatus): HandoffRecord["status"] {
  switch (status) {
    case "ready":
    case "in_review":
      return "open";
    case "accepted":
      return "accepted";
  }
}

function mapDispatchRequestEvent(status: ProductDispatchRequestStatus): string {
  switch (status) {
    case "accepted":
      return "dispatch.accepted";
    case "blocked":
      return "dispatch.blocked";
    case "completed":
      return "dispatch.completed";
    case "failed":
      return "dispatch.failed";
    case "cancelled":
      return "dispatch.cancelled";
    case "expired":
      return "dispatch.expired";
    case "queued":
      return "dispatch.created";
    case "awaiting_approval":
      return "approval.requested";
  }
}

function mapDispatchRunEvent(status: ProductDispatchRunStatus): string {
  switch (status) {
    case "queued":
      return "dispatch.created";
    case "running":
      return "dispatch.started";
    case "blocked":
      return "dispatch.blocked";
    case "completed":
      return "dispatch.completed";
    case "failed":
      return "dispatch.failed";
    case "cancelled":
      return "dispatch.cancelled";
    case "expired":
      return "dispatch.expired";
  }
}

function mapReviewEvent(previousStatus: ProductReviewStatus, nextStatus: ProductReviewStatus): string {
  if (nextStatus === "in_review") {
    return previousStatus === "snoozed" ? "review.resumed" : "review.opened";
  }
  if (nextStatus === "snoozed") {
    return "review.snoozed";
  }
  return "review.resolved";
}

function mapDecisionEvent(outcome: ProductDecisionStatus): string {
  switch (outcome) {
    case "approved":
      return "approval.approved";
    case "denied":
      return "approval.denied";
    case "cancelled":
      return "approval.cancelled";
    case "expired":
      return "approval.expired";
  }
}

function serializeApprovalRequest(reviewItem: ReviewItemRecord, request: DispatchRequestRecord) {
  return {
    id: reviewItem.reviewItemId,
    requestId: request.requestId,
    summary: reviewItem.summary ?? reviewItem.title,
    source: "product" as const,
  };
}

function buildActionExecutionResponse(productStore: ProductStore, request: DispatchRequestRecord) {
  const status = getDispatchRequestStatus(request);
  const response: Record<string, unknown> = {
    status,
    decision: getDecisionMetadata(request.metadata),
    request: serializeDispatchRequest(request, productStore),
    deduplicated: true,
  };

  const result = getExecutionResultMetadata(request.metadata);
  if (result) {
    response.result = result;
  }

  if (status === "awaiting_approval") {
    const reviewItem = getLatestDispatchReviewItem(productStore, request.requestId);
    if (reviewItem) {
      response.approval = serializeApprovalRequest(reviewItem, request);
    }
  }

  return response;
}

function buildApprovalResponse(
  productStore: ProductStore,
  request: DispatchRequestRecord,
  reviewItem: ReviewItemRecord,
  decisionRecord: DecisionRecord
) {
  const requestStatus = getDispatchRequestStatus(request);
  return {
    status: requestStatus === "completed" ? "completed" : getDecisionStatus(decisionRecord),
    decisionRecord: serializeDecision(decisionRecord),
    reviewItem: serializeReviewItem(reviewItem),
    request: serializeDispatchRequest(request, productStore),
    result: getExecutionResultMetadata(request.metadata),
    deduplicated: requestStatus !== "awaiting_approval",
  };
}

function buildDispatchExecutionResponse(productStore: ProductStore, request: DispatchRequestRecord) {
  const latestRun = getLatestDispatchRun(productStore, request.requestId);
  const latestReviewItem = getLatestDispatchReviewItem(productStore, request.requestId);
  return {
    request: serializeDispatchRequest(request, productStore),
    run: latestRun ? serializeDispatchRun(latestRun) : null,
    reviewItem: latestReviewItem ? serializeReviewItem(latestReviewItem) : null,
    deduplicated: true,
  };
}

function buildReviewActionResponse(productStore: ProductStore, reviewItem: ReviewItemRecord, action: ReviewSurfaceAction) {
  const currentReviewItem = productStore.getReviewItem(reviewItem.reviewItemId) ?? reviewItem;
  const decision = getLatestDecisionRecord(productStore, currentReviewItem);
  const subject = currentReviewItem.subjectType === "dispatch_request" && action === "approve"
    ? serializeReviewSubject(productStore, currentReviewItem)
    : null;
  const handoff = action === "continue"
    ? productStore.listHandoffsForSource(currentReviewItem.subjectType, currentReviewItem.subjectId).at(-1) ?? null
    : null;

  return {
    action,
    decision: decision ? serializeDecision(decision) : null,
    reviewItem: serializeReviewItem(currentReviewItem),
    subject,
    handoff: handoff ? serializeHandoff(handoff) : null,
    detail: serializeReviewDetail(productStore, currentReviewItem),
    deduplicated: true,
  };
}

function classifySubmittedAction(action: SubmittedAction): ProductDecision {
  if (action.kind === "screenshot") {
    return classifyAction("screenshot.capture_sensitive", "sensitive_surface");
  }

  const lower = summarizeAction(action).toLowerCase();
  const targetScope = inferTargetScope(lower);

  if (includesAny(lower, ["keychain", "secret store", "password manager", "read env", ".env", "credential", "token"])) {
    return classifyAction("secret.read_store", targetScope);
  }

  if (includesAny(lower, ["unrestricted shell", "arbitrary shell", "any shell command", "desktop mirror", "mirror desktop"])) {
    return classifyAction("shell.passthrough_unrestricted", targetScope);
  }

  if (includesAny(lower, ["deploy", "production", "prod", "release", "publish", "restart service"])) {
    return classifyAction("deploy.trigger", targetScope);
  }

  if (includesAny(lower, ["git push", "git commit", "git merge", "git rebase", "branch delete", "stage files", "commit changes", "push changes"])) {
    return classifyAction("git.write", targetScope);
  }

  if (includesAny(lower, ["delete", "remove", "rm ", "rename", "move file", "edit ", "write ", "create file", "update file", "change code", "refactor", "apply patch", "cleanup"])) {
    return classifyAction("repo.write", targetScope);
  }

  return classifyAction("repo.read_status", targetScope);
}

function summarizeAction(action: SubmittedAction): string {
  if (action.kind === "message") {
    return action.content ?? "message";
  }
  if (action.kind === "command") {
    return action.rawText ?? `/${action.name ?? "command"}`;
  }
  return "Capture screenshot";
}

function approvalTitle(decision: ProductDecision): string {
  switch (decision.actionType) {
    case "deploy.trigger":
      return "Approve deploy action";
    case "git.write":
      return "Approve git write action";
    case "screenshot.capture_sensitive":
      return "Approve sensitive screenshot capture";
    default:
      return "Approve repo write action";
  }
}

function approvalSummary(action: SubmittedAction, decision: ProductDecision): string {
  if (decision.actionType === "screenshot.capture_sensitive") {
    return "Allow sensitive screenshot capture?";
  }

  const source = action.inputMode === "voice" ? "voice request" : action.inputMode === "typed" ? "typed request" : "product action";
  return `Allow ${source}: ${summarizeAction(action)}?`;
}

async function executeSubmittedAction(action: SubmittedAction): Promise<ExecutedActionResult> {
  if (action.kind === "screenshot") {
    const jpeg = await captureScreenshot({
      display: action.display,
      max: action.max,
      quality: action.quality,
    });

    return {
      kind: "screenshot",
      screenshot: {
        contentType: "image/jpeg",
        base64: Buffer.from(jpeg).toString("base64"),
      },
    };
  }

  const sessionId = asNonEmptyString(action.sessionId);
  if (!sessionId) {
    throw new Error("Missing sessionId");
  }

  if (action.kind === "message") {
    await postToOpencode(`/session/${sessionId}/message`, { content: action.content ?? "" });
    return { kind: "message", ok: true };
  }

  await postToOpencode(`/session/${sessionId}/command`, { name: action.name, args: action.args ?? [] });
  return { kind: "command", ok: true };
}

async function postToOpencode(path: string, payload: Record<string, unknown>): Promise<void> {
  const { origin, basicAuth } = getRuntimeConfig().opencode;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Authorization: basicAuth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`OpenCode request failed with ${response.status}`);
  }
}

function inferTargetScope(text: string): TargetScope {
  if (includesAny(text, ["another repo", "different repo", "cross project", "outside this repo"])) {
    return "cross_project";
  }
  return "active_repo";
}

function includesAny(text: string, fragments: string[]): boolean {
  return fragments.some((fragment) => text.includes(fragment));
}

function asSubmittedAction(value: unknown): SubmittedAction | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  const inputMode = value.inputMode;
  if ((kind !== "message" && kind !== "command" && kind !== "screenshot") || (inputMode !== "typed" && inputMode !== "voice" && inputMode !== "product")) {
    return null;
  }

  const action: SubmittedAction = {
    kind,
    inputMode,
    sessionId: asOptionalString(value.sessionId) ?? undefined,
    content: asOptionalString(value.content) ?? undefined,
    name: asOptionalString(value.name) ?? undefined,
    rawText: asOptionalString(value.rawText) ?? undefined,
    display: asOptionalString(value.display) ?? undefined,
    max: asPositiveInteger(value.max) ?? undefined,
    quality: asPositiveInteger(value.quality) ?? undefined,
    args: Array.isArray(value.args) ? value.args.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => entry !== null) : undefined,
  };

  if (action.kind === "message" && !action.content) {
    return null;
  }

  if (action.kind === "command" && !action.name) {
    return null;
  }

  return action;
}

function isSubmittedAction(value: unknown): value is SubmittedAction {
  return asSubmittedAction(value) !== null;
}

function isExecutedActionResult(value: unknown): value is ExecutedActionResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if ((value.kind === "message" || value.kind === "command") && value.ok === true) {
    return true;
  }

  return value.kind === "screenshot"
    && isRecord(value.screenshot)
    && value.screenshot.contentType === "image/jpeg"
    && typeof value.screenshot.base64 === "string";
}

function buildReplayKey(prefix: string, input: Record<string, unknown>): string {
  return `${prefix}:${JSON.stringify(input)}`;
}

function resolveExistingDispatchRequest(
  productStore: ProductStore,
  input: { requestId: string; idempotencyKey?: string | null; replayKey?: string | null }
): DispatchRequestRecord | null {
  const byRequestId = productStore.getDispatchRequest(input.requestId);
  if (byRequestId) {
    return byRequestId;
  }

  return productStore.listDispatchRequests().find((request) => {
    if (input.idempotencyKey && request.idempotencyKey === input.idempotencyKey) {
      return true;
    }

    return input.replayKey !== null && input.replayKey !== undefined && getReplayMetadata(request.metadata) === input.replayKey;
  }) ?? null;
}

function appendReplayAuditEvents(
  productStore: ProductStore,
  input: {
    entityId: string;
    actorId: string;
    idempotencyKey?: string | null;
    replayKey?: string | null;
    existingRequestId: string;
  }
): void {
  if (input.replayKey) {
    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: input.entityId,
      action: "reconnect.detected",
      actorId: input.actorId,
      metadata: {
        status: "reconnecting",
        replayKey: input.replayKey,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
  }

  appendAuditEvent(productStore, {
    entityType: "dispatch_request",
    entityId: input.entityId,
    action: "request.duplicate_detected",
    actorId: input.actorId,
    metadata: {
      idempotencyKey: input.idempotencyKey ?? null,
      replayKey: input.replayKey ?? null,
    },
  });

  appendAuditEvent(productStore, {
    entityType: "dispatch_request",
    entityId: input.entityId,
    action: "request.deduplicated",
    actorId: input.actorId,
    metadata: {
      idempotencyKey: input.idempotencyKey ?? null,
      replayKey: input.replayKey ?? null,
      existingRequestId: input.existingRequestId,
    },
  });

  if (input.replayKey) {
    appendAuditEvent(productStore, {
      entityType: "dispatch_request",
      entityId: input.entityId,
      action: "reconnect.replay_blocked",
      actorId: input.actorId,
      metadata: {
        status: "blocked_duplicate",
        replayKey: input.replayKey,
        existingRequestId: input.existingRequestId,
      },
    });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseReviewStatusFilter(value: string | undefined): ReviewItemRecord["status"][] | null {
  if (!value) {
    return [];
  }

  const statuses = value
    .split(",")
    .map((entry) => asReviewStatus(entry.trim()))
    .filter((entry): entry is ProductReviewStatus => entry !== null)
    .map((entry) => mapReviewStatusToStore(entry));

  return statuses.length === value.split(",").length ? statuses : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asNonEmptyString(value);
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asObject(value: unknown): ProductMetadata | undefined {
  return isRecord(value) ? { ...(value as ProductMetadata) } : undefined;
}

function asTargetScope(value: unknown): TargetScope | null {
  return value === "active_repo" || value === "explicit_repo" || value === "cross_project" || value === "sensitive_surface" || value === "unknown"
    ? value
    : null;
}

function asFollowUpPolicy(value: unknown): FollowUpPolicy | null {
  return value === "complete_when_ready" || value === "hold_for_review" ? value : null;
}

function asRequestStatus(value: unknown): ProductDispatchRequestStatus | null {
  return typeof value === "string" && isRequestStatus(value) ? value : null;
}

function asRunStatus(value: unknown): ProductDispatchRunStatus | null {
  return typeof value === "string" && isRunStatus(value) ? value : null;
}

function asReviewStatus(value: unknown): ProductReviewStatus | null {
  return typeof value === "string" && isReviewStatus(value) ? value : null;
}

function asDecisionStatus(value: unknown): ProductDecisionStatus | null {
  return value === "approved" || value === "denied" || value === "cancelled" || value === "expired" ? value : null;
}

function asHandoffStatus(value: unknown): ProductHandoffStatus | null {
  return typeof value === "string" && isHandoffStatus(value) ? value : null;
}

function asReviewSurfaceAction(value: unknown): ReviewSurfaceAction | null {
  return value === "approve" || value === "continue" || value === "snooze" ? value : null;
}

function isRequestStatus(value: string): value is ProductDispatchRequestStatus {
  return value === "queued" || value === "accepted" || value === "awaiting_approval" || value === "blocked" || value === "completed" || value === "failed" || value === "cancelled" || value === "expired";
}

function isRunStatus(value: string): value is ProductDispatchRunStatus {
  return value === "queued" || value === "running" || value === "blocked" || value === "completed" || value === "failed" || value === "cancelled" || value === "expired";
}

function isReviewStatus(value: string): value is ProductReviewStatus {
  return value === "pending_review" || value === "in_review" || value === "snoozed" || value === "resolved";
}

function isHandoffStatus(value: string): value is ProductHandoffStatus {
  return value === "ready" || value === "in_review" || value === "accepted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDispatchContext(value: unknown): value is DispatchContext {
  if (!isRecord(value)) {
    return false;
  }

  return value.mode === "dispatch_mode"
    && asFollowUpPolicy(value.followUpPolicy) !== null
    && typeof value.executionActionType === "string"
    && isRecord(value.executionDecision);
}

function getLatestDispatchRun(productStore: ProductStore, requestId: string): DispatchRunRecord | null {
  const runs = productStore.listDispatchRunsForRequest(requestId);
  return runs.at(-1) ?? null;
}

function getLatestDispatchReviewItem(productStore: ProductStore, requestId: string): ReviewItemRecord | null {
  const items = productStore.listReviewItemsForSubject("dispatch_request", requestId);
  return items.at(-1) ?? null;
}

function getLatestDecisionRecord(productStore: ProductStore, reviewItem: ReviewItemRecord): DecisionRecord | null {
  if (reviewItem.latestDecisionId) {
    return productStore.getDecision(reviewItem.latestDecisionId);
  }

  return productStore.listDecisionsForReviewItem(reviewItem.reviewItemId).at(-1) ?? null;
}

function getLatestHandoffForSource(productStore: ProductStore, fromType: string, fromId: string): HandoffRecord | null {
  const handoffs = productStore.listHandoffsForSource(fromType, fromId);
  return handoffs.at(-1) ?? null;
}

function ensureDispatchHandoffPackage(
  productStore: ProductStore,
  input: {
    actorId: string;
    request: DispatchRequestRecord;
    run?: DispatchRunRecord | null;
    reviewItem?: ReviewItemRecord | null;
    outcome: "blocked" | "completed";
  }
): HandoffRecord {
  const existing = getLatestHandoffForSource(productStore, "dispatch_request", input.request.requestId);
  const dispatchContext = getDispatchContext(input.request.metadata);
  const requestStatus = getDispatchRequestStatus(input.request);
  const run = input.run ?? getLatestDispatchRun(productStore, input.request.requestId);
  const reviewItem = input.reviewItem ?? getLatestDispatchReviewItem(productStore, input.request.requestId);
  const summary = input.outcome === "blocked"
    ? `Blocked dispatch handoff for ${input.request.inputSummary ?? dispatchContext?.executionActionType ?? input.request.requestId}`
    : `Completed dispatch handoff for ${input.request.inputSummary ?? dispatchContext?.executionActionType ?? input.request.requestId}`;
  const nextActions = input.outcome === "blocked"
    ? [
        reviewItem ? `Open review item ${reviewItem.reviewItemId} to resolve the blocker.` : "Open the saved review surface to resolve the blocker.",
        dispatchContext?.executionDecision.actionClass === "approval_required"
          ? "Approve the pending write-capable execution before resuming the run."
          : "Continue once the missing dependency or follow-up review is resolved.",
      ]
    : [
        input.request.opencodeRefs?.sessionId
          ? `Resume from OpenCode session ${input.request.opencodeRefs.sessionId}.`
          : "Resume from the saved product context.",
        "Review the timeline and latest run before taking the next action.",
      ];
  const auditRefs: HandoffAuditRef[] = [
    { entityType: "dispatch_request", entityId: input.request.requestId },
  ];

  if (run) {
    auditRefs.push({ entityType: "dispatch_run", entityId: run.runId });
  }

  if (reviewItem) {
    auditRefs.push({ entityType: "review_item", entityId: reviewItem.reviewItemId });
  }

  if (existing) {
    auditRefs.push({ entityType: "handoff_package", entityId: existing.handoffId });
  }

  const handoffPackage: HandoffPackage = {
    kind: "handoff_package",
    version: "v0.2",
    summary,
    linkedContext: {
      subjectType: "dispatch_request",
      subjectId: input.request.requestId,
      requestId: input.request.requestId,
      runId: run?.runId ?? null,
      reviewItemId: reviewItem?.reviewItemId ?? null,
      opencodeRefs: input.request.opencodeRefs ?? null,
    },
    nextActions,
    auditRefs,
  };
  const handoffStatus = existing && getHandoffStatus(existing) === "accepted" ? "accepted" : "ready";
  const toType = reviewItem ? "review_item" : input.request.opencodeRefs?.sessionId ? "opencode_session" : "dispatch_request";
  const toId = reviewItem?.reviewItemId ?? input.request.opencodeRefs?.sessionId ?? input.request.requestId;
  const record = productStore.upsertHandoff({
    handoffId: existing?.handoffId ?? crypto.randomUUID(),
    fromType: "dispatch_request",
    fromId: input.request.requestId,
    toType,
    toId,
    status: mapHandoffStatusToStore(handoffStatus),
    acceptedAt: handoffStatus === "accepted" ? existing?.acceptedAt ?? new Date().toISOString() : existing?.acceptedAt,
    summary,
    opencodeRefs: input.request.opencodeRefs,
    metadata: withHandoffPackageMetadata(existing?.metadata, handoffPackage, handoffStatus),
  });

  if (!existing) {
    appendAuditEvent(productStore, {
      entityType: "handoff_package",
      entityId: record.handoffId,
      action: "handoff.created",
      actorId: input.actorId,
      metadata: {
        status: handoffStatus,
        fromType: "dispatch_request",
        fromId: input.request.requestId,
        toType,
        toId,
        requestStatus,
      },
    });
  }

  return record;
}

function resumeApprovedReviewSubject(
  productStore: ProductStore,
  actorId: string,
  reviewItem: ReviewItemRecord
) {
  if (reviewItem.subjectType !== "dispatch_request") {
    return null;
  }

  const request = productStore.getDispatchRequest(reviewItem.subjectId);
  if (!request) {
    return null;
  }

  const currentStatus = getDispatchRequestStatus(request);
  if (currentStatus !== "awaiting_approval" && currentStatus !== "blocked") {
    return serializeReviewSubject(productStore, reviewItem);
  }

  const updated = productStore.setDispatchRequestStatus(
    request.requestId,
    mapRequestStatusToStore("accepted"),
    withDispatchMetadata(request.metadata, {
      status: "accepted",
      decision: getDecisionMetadata(request.metadata) ?? undefined,
      dispatchContext: getDispatchContext(request.metadata),
    })
  );

  if (!updated) {
    return null;
  }

  appendAuditEvent(productStore, {
    entityType: "dispatch_request",
    entityId: updated.requestId,
    action: "dispatch.accepted",
    actorId,
    metadata: { fromStatus: currentStatus, status: "accepted", viaReviewItemId: reviewItem.reviewItemId },
  });

  return serializeReviewSubject(productStore, reviewItem);
}

function acceptLinkedHandoff(
  productStore: ProductStore,
  actorId: string,
  reviewItem: ReviewItemRecord
): HandoffRecord | null {
  const handoff = productStore
    .listHandoffsForSource(reviewItem.subjectType, reviewItem.subjectId)
    .find((item) => {
      const status = getHandoffStatus(item);
      return status === "ready" || status === "in_review";
    });

  if (!handoff) {
    return null;
  }

  const currentStatus = getHandoffStatus(handoff);

  if (currentStatus === "ready") {
    appendAuditEvent(productStore, {
      entityType: "handoff_package",
      entityId: handoff.handoffId,
      action: "handoff.opened",
      actorId,
      metadata: { fromStatus: "ready", status: "in_review", viaReviewItemId: reviewItem.reviewItemId },
    });
  }

  const updated = productStore.setHandoffStatus(handoff.handoffId, mapHandoffStatusToStore("accepted"), {
    acceptedAt: new Date().toISOString(),
    metadata: withStatusMetadata(handoff.metadata, "accepted"),
  });

  if (!updated) {
    return null;
  }

  appendAuditEvent(productStore, {
    entityType: "handoff_package",
    entityId: updated.handoffId,
    action: "handoff.accepted",
    actorId,
    metadata: { fromStatus: "accepted", status: "accepted", viaReviewItemId: reviewItem.reviewItemId },
  });

  return updated;
}

function ensureDispatchReviewItem(
  productStore: ProductStore,
  input: {
    request: DispatchRequestRecord;
    dispatchContext: DispatchContext;
  }
): ReviewItemRecord {
  const existing = getLatestDispatchReviewItem(productStore, input.request.requestId);
  if (existing) {
    return existing;
  }

  const reviewItem = productStore.upsertReviewItem({
    reviewItemId: crypto.randomUUID(),
    subjectType: "dispatch_request",
    subjectId: input.request.requestId,
    status: mapReviewStatusToStore("pending_review"),
    assignedTo: input.request.actorId,
    title: buildDispatchReviewTitle(input.request, input.dispatchContext),
    summary: buildDispatchReviewSummary(input.request, input.dispatchContext),
    metadata: {
      followUpPolicy: input.dispatchContext.followUpPolicy,
      executionActionType: input.dispatchContext.executionActionType,
    },
  });

  appendAuditEvent(productStore, {
    entityType: "review_item",
    entityId: reviewItem.reviewItemId,
    action: "review.created",
    actorId: input.request.actorId,
    metadata: {
      status: "pending_review",
      subjectType: "dispatch_request",
      subjectId: input.request.requestId,
    },
  });

  return reviewItem;
}

function buildDispatchReviewTitle(request: DispatchRequestRecord, dispatchContext: DispatchContext): string {
  const summary = request.inputSummary ?? dispatchContext.executionActionType;
  if (dispatchContext.executionDecision.actionClass === "approval_required") {
    return `Approve dispatch: ${summary}`;
  }
  return `Review dispatch: ${summary}`;
}

function buildDispatchReviewSummary(request: DispatchRequestRecord, dispatchContext: DispatchContext): string {
  const scope = getDecisionMetadata(request.metadata)?.targetScope ?? "unknown";
  const target = dispatchContext.targetLabel ?? request.targetId ?? "active repo";
  return `Dispatch for ${target} is blocked under ${scope} with ${dispatchContext.followUpPolicy}.`;
}

function buildTimelineTitle(event: AuditEventRecord): string {
  switch (event.action) {
    case "policy.approval_required":
      return "Approval required";
    case "approval.requested":
      return "Approval request saved";
    case "approval.approved":
      return "Approval approved";
    case "approval.denied":
      return "Approval denied";
    case "dispatch.accepted":
      return "Dispatch accepted";
    case "dispatch.started":
      return "Dispatch started";
    case "dispatch.blocked":
      return "Dispatch blocked";
    case "dispatch.completed":
      return "Dispatch completed";
    case "review.created":
      return "Review item created";
    case "review.opened":
      return "Review opened";
    case "review.snoozed":
      return "Review snoozed";
    case "review.resolved":
      return "Review resolved";
    case "handoff.created":
      return "Handoff package created";
    case "handoff.opened":
      return "Handoff opened";
    case "handoff.accepted":
      return "Handoff accepted";
    default:
      return formatTimelineToken(event.action);
  }
}

function buildTimelineDetail(event: AuditEventRecord): string | null {
  const metadata = isRecord(event.metadata) ? event.metadata : null;
  const actionType = asOptionalString(metadata?.actionType);
  const followUpPolicy = asOptionalString(metadata?.followUpPolicy);
  const fromStatus = asOptionalString(metadata?.fromStatus);
  const reviewItemId = asOptionalString(metadata?.reviewItemId) ?? asOptionalString(metadata?.viaReviewItemId);
  const runId = asOptionalString(metadata?.runId);
  const parts: string[] = [];

  switch (event.action) {
    case "dispatch.blocked":
      parts.push("Execution paused and can be resumed from saved product state.");
      break;
    case "dispatch.completed":
      parts.push("Execution finished and its handoff package can be reopened later.");
      break;
    case "handoff.created":
      parts.push("Summary, linked context, next actions, and audit refs were bundled into a reusable package.");
      break;
    case "handoff.accepted":
      parts.push("Follow-up can continue from the accepted handoff package.");
      break;
    case "approval.requested":
      parts.push("Execution is waiting for an explicit decision before it can continue.");
      break;
    case "review.created":
      parts.push("The review inbox now owns the next operator-visible step.");
      break;
  }

  if (actionType) {
    parts.push(`Action ${actionType}.`);
  }
  if (followUpPolicy) {
    parts.push(`Follow-up ${followUpPolicy.replaceAll("_", " ")}.`);
  }
  if (fromStatus) {
    parts.push(`From ${fromStatus.replaceAll("_", " ")}.`);
  }
  if (reviewItemId) {
    parts.push(`Review ${reviewItemId}.`);
  }
  if (runId) {
    parts.push(`Run ${runId}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function readEventStatus(metadata?: ProductMetadata): string | null {
  const value = metadata?.status;
  return typeof value === "string" ? value : null;
}

function formatTimelineToken(value: string): string {
  return value
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
