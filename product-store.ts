import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ProductMetadata = Record<string, unknown>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type Row = Record<string, unknown>;

export type DispatchRequestStatus = "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type DispatchRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewItemStatus = "pending" | "in_review" | "approved" | "rejected" | "needs_input" | "resolved";
export type DecisionOutcome = "approved" | "rejected" | "deferred" | "escalated";
export type HandoffStatus = "open" | "accepted" | "completed" | "cancelled";

export interface OpenCodeRefs {
  sessionId?: string;
  messageId?: string;
  commandId?: string;
  eventId?: string;
}

export interface DispatchRequestRecord {
  requestId: string;
  idempotencyKey?: string | null;
  status: DispatchRequestStatus;
  requestedAt?: string;
  updatedAt?: string;
  actorId?: string | null;
  targetId?: string | null;
  inputSummary?: string | null;
  opencodeRefs?: OpenCodeRefs | null;
  metadata?: ProductMetadata;
}

export interface DispatchRunRecord {
  runId: string;
  requestId: string;
  status: DispatchRunStatus;
  attempt: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  opencodeRefs?: OpenCodeRefs | null;
  error?: string | null;
  metadata?: ProductMetadata;
}

export interface ReviewItemRecord {
  reviewItemId: string;
  subjectType: string;
  subjectId: string;
  status: ReviewItemStatus;
  createdAt?: string;
  updatedAt?: string;
  assignedTo?: string | null;
  title: string;
  summary?: string | null;
  latestDecisionId?: string | null;
  opencodeRefs?: OpenCodeRefs | null;
  metadata?: ProductMetadata;
}

export interface DecisionRecord {
  decisionId: string;
  reviewItemId: string;
  outcome: DecisionOutcome;
  deciderId: string;
  rationale?: string | null;
  idempotencyKey?: string | null;
  decidedAt?: string;
  opencodeRefs?: OpenCodeRefs | null;
  metadata?: ProductMetadata;
}

export interface HandoffRecord {
  handoffId: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  status: HandoffStatus;
  createdAt?: string;
  updatedAt?: string;
  acceptedAt?: string | null;
  completedAt?: string | null;
  summary?: string | null;
  opencodeRefs?: OpenCodeRefs | null;
  metadata?: ProductMetadata;
}

export interface AuditEventRecord {
  eventId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string | null;
  occurredAt?: string;
  opencodeRefs?: OpenCodeRefs | null;
  metadata?: ProductMetadata;
}

export interface AuditEventFilter {
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export interface ReviewItemFilter {
  statuses?: ReviewItemStatus[];
  limit?: number;
}

export interface ProductStoreOptions {
  databasePath?: string;
}

const DEFAULT_DB_PATH = ".omo-drive/product-store.sqlite";

export class ProductStore {
  private readonly db: Database;

  constructor(options: ProductStoreOptions = {}) {
    const databasePath = options.databasePath ?? DEFAULT_DB_PATH;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  upsertDispatchRequest(record: DispatchRequestRecord): DispatchRequestRecord {
    const now = isoNow();
    const requestedAt = record.requestedAt ?? now;
    const updatedAt = record.updatedAt ?? now;

    this.db
      .query(
        `INSERT INTO dispatch_requests (
          request_id, idempotency_key, status, requested_at, updated_at,
          actor_id, target_id, input_summary, opencode_refs_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          idempotency_key = excluded.idempotency_key,
          status = excluded.status,
          updated_at = excluded.updated_at,
          actor_id = excluded.actor_id,
          target_id = excluded.target_id,
          input_summary = excluded.input_summary,
          opencode_refs_json = excluded.opencode_refs_json,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.requestId,
        nullable(record.idempotencyKey),
        record.status,
        requestedAt,
        updatedAt,
        nullable(record.actorId),
        nullable(record.targetId),
        nullable(record.inputSummary),
        stringify(record.opencodeRefs),
        stringify(record.metadata)
      );

    return this.getDispatchRequest(record.requestId)!;
  }

  getDispatchRequest(requestId: string): DispatchRequestRecord | null {
    const row = this.db.query("SELECT * FROM dispatch_requests WHERE request_id = ?").get(requestId) as Row | null;
    return row ? mapDispatchRequest(row) : null;
  }

  listDispatchRequests(): DispatchRequestRecord[] {
    const rows = this.db.query("SELECT * FROM dispatch_requests ORDER BY requested_at ASC").all() as Row[];
    return rows.map(mapDispatchRequest);
  }

  setDispatchRequestStatus(requestId: string, status: DispatchRequestStatus, metadata?: ProductMetadata): DispatchRequestRecord | null {
    this.db
      .query(
        `UPDATE dispatch_requests
         SET status = ?, updated_at = ?, metadata_json = COALESCE(?, metadata_json)
         WHERE request_id = ?`
      )
      .run(status, isoNow(), metadata ? stringify(metadata) : null, requestId);
    return this.getDispatchRequest(requestId);
  }

  upsertDispatchRun(record: DispatchRunRecord): DispatchRunRecord {
    const now = isoNow();
    const startedAt = record.startedAt ?? now;
    const updatedAt = record.updatedAt ?? now;

    this.db
      .query(
        `INSERT INTO dispatch_runs (
          run_id, request_id, status, attempt, started_at, updated_at,
          completed_at, opencode_refs_json, error, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          request_id = excluded.request_id,
          status = excluded.status,
          attempt = excluded.attempt,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          opencode_refs_json = excluded.opencode_refs_json,
          error = excluded.error,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.runId,
        record.requestId,
        record.status,
        record.attempt,
        startedAt,
        updatedAt,
        nullable(record.completedAt),
        stringify(record.opencodeRefs),
        nullable(record.error),
        stringify(record.metadata)
      );

    return this.getDispatchRun(record.runId)!;
  }

  getDispatchRun(runId: string): DispatchRunRecord | null {
    const row = this.db.query("SELECT * FROM dispatch_runs WHERE run_id = ?").get(runId) as Row | null;
    return row ? mapDispatchRun(row) : null;
  }

  listDispatchRunsForRequest(requestId: string): DispatchRunRecord[] {
    const rows = this.db.query("SELECT * FROM dispatch_runs WHERE request_id = ? ORDER BY attempt ASC").all(requestId) as Row[];
    return rows.map(mapDispatchRun);
  }

  setDispatchRunStatus(runId: string, status: DispatchRunStatus, patch: Pick<DispatchRunRecord, "completedAt" | "error" | "metadata"> = {}): DispatchRunRecord | null {
    this.db
      .query(
        `UPDATE dispatch_runs
         SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), error = COALESCE(?, error), metadata_json = COALESCE(?, metadata_json)
         WHERE run_id = ?`
      )
      .run(status, isoNow(), nullable(patch.completedAt), nullable(patch.error), patch.metadata ? stringify(patch.metadata) : null, runId);
    return this.getDispatchRun(runId);
  }

  upsertReviewItem(record: ReviewItemRecord): ReviewItemRecord {
    const now = isoNow();
    const createdAt = record.createdAt ?? now;
    const updatedAt = record.updatedAt ?? now;

    this.db
      .query(
        `INSERT INTO review_items (
          review_item_id, subject_type, subject_id, status, created_at, updated_at,
          assigned_to, title, summary, latest_decision_id, opencode_refs_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(review_item_id) DO UPDATE SET
          subject_type = excluded.subject_type,
          subject_id = excluded.subject_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          assigned_to = excluded.assigned_to,
          title = excluded.title,
          summary = excluded.summary,
          latest_decision_id = excluded.latest_decision_id,
          opencode_refs_json = excluded.opencode_refs_json,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.reviewItemId,
        record.subjectType,
        record.subjectId,
        record.status,
        createdAt,
        updatedAt,
        nullable(record.assignedTo),
        record.title,
        nullable(record.summary),
        nullable(record.latestDecisionId),
        stringify(record.opencodeRefs),
        stringify(record.metadata)
      );

    return this.getReviewItem(record.reviewItemId)!;
  }

  getReviewItem(reviewItemId: string): ReviewItemRecord | null {
    const row = this.db.query("SELECT * FROM review_items WHERE review_item_id = ?").get(reviewItemId) as Row | null;
    return row ? mapReviewItem(row) : null;
  }

  listReviewItems(filter: ReviewItemFilter = {}): ReviewItemRecord[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.statuses && filter.statuses.length > 0) {
      const placeholders = filter.statuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...filter.statuses);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter.limit ? ` LIMIT ${Math.max(filter.limit, 1)}` : "";
    const rows = this.db
      .query(`SELECT * FROM review_items ${whereClause} ORDER BY updated_at DESC${limitClause}`)
      .all(...params) as Row[];
    return rows.map(mapReviewItem);
  }

  listReviewItemsForSubject(subjectType: string, subjectId: string): ReviewItemRecord[] {
    const rows = this.db
      .query("SELECT * FROM review_items WHERE subject_type = ? AND subject_id = ? ORDER BY created_at ASC")
      .all(subjectType, subjectId) as Row[];
    return rows.map(mapReviewItem);
  }

  setReviewItemStatus(reviewItemId: string, status: ReviewItemStatus, metadata?: ProductMetadata): ReviewItemRecord | null {
    this.db
      .query(
        `UPDATE review_items
         SET status = ?, updated_at = ?, metadata_json = COALESCE(?, metadata_json)
         WHERE review_item_id = ?`
      )
      .run(status, isoNow(), metadata ? stringify(metadata) : null, reviewItemId);
    return this.getReviewItem(reviewItemId);
  }

  recordDecision(record: DecisionRecord): DecisionRecord {
    const decidedAt = record.decidedAt ?? isoNow();
    const transaction = this.db.transaction((input: DecisionRecord, when: string) => {
      this.db
        .query(
          `INSERT INTO decisions (
            decision_id, review_item_id, outcome, decider_id, rationale,
            idempotency_key, decided_at, opencode_refs_json, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(decision_id) DO UPDATE SET
            review_item_id = excluded.review_item_id,
            outcome = excluded.outcome,
            decider_id = excluded.decider_id,
            rationale = excluded.rationale,
            idempotency_key = excluded.idempotency_key,
            decided_at = excluded.decided_at,
            opencode_refs_json = excluded.opencode_refs_json,
            metadata_json = excluded.metadata_json`
        )
        .run(
          input.decisionId,
          input.reviewItemId,
          input.outcome,
          input.deciderId,
          nullable(input.rationale),
          nullable(input.idempotencyKey),
          when,
          stringify(input.opencodeRefs),
          stringify(input.metadata)
        );

      this.db
        .query(
          `UPDATE review_items
           SET latest_decision_id = ?, status = ?, updated_at = ?
           WHERE review_item_id = ?`
        )
        .run(input.decisionId, mapOutcomeToReviewStatus(input.outcome), when, input.reviewItemId);
    });

    transaction(record, decidedAt);
    return this.getDecision(record.decisionId)!;
  }

  getDecision(decisionId: string): DecisionRecord | null {
    const row = this.db.query("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as Row | null;
    return row ? mapDecision(row) : null;
  }

  listDecisionsForReviewItem(reviewItemId: string): DecisionRecord[] {
    const rows = this.db.query("SELECT * FROM decisions WHERE review_item_id = ? ORDER BY decided_at ASC").all(reviewItemId) as Row[];
    return rows.map(mapDecision);
  }

  upsertHandoff(record: HandoffRecord): HandoffRecord {
    const now = isoNow();
    const createdAt = record.createdAt ?? now;
    const updatedAt = record.updatedAt ?? now;

    this.db
      .query(
        `INSERT INTO handoffs (
          handoff_id, from_type, from_id, to_type, to_id, status, created_at,
          updated_at, accepted_at, completed_at, summary, opencode_refs_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(handoff_id) DO UPDATE SET
          from_type = excluded.from_type,
          from_id = excluded.from_id,
          to_type = excluded.to_type,
          to_id = excluded.to_id,
          status = excluded.status,
          updated_at = excluded.updated_at,
          accepted_at = excluded.accepted_at,
          completed_at = excluded.completed_at,
          summary = excluded.summary,
          opencode_refs_json = excluded.opencode_refs_json,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.handoffId,
        record.fromType,
        record.fromId,
        record.toType,
        record.toId,
        record.status,
        createdAt,
        updatedAt,
        nullable(record.acceptedAt),
        nullable(record.completedAt),
        nullable(record.summary),
        stringify(record.opencodeRefs),
        stringify(record.metadata)
      );

    return this.getHandoff(record.handoffId)!;
  }

  getHandoff(handoffId: string): HandoffRecord | null {
    const row = this.db.query("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId) as Row | null;
    return row ? mapHandoff(row) : null;
  }

  listHandoffsForSource(fromType: string, fromId: string): HandoffRecord[] {
    const rows = this.db
      .query("SELECT * FROM handoffs WHERE from_type = ? AND from_id = ? ORDER BY created_at ASC")
      .all(fromType, fromId) as Row[];
    return rows.map(mapHandoff);
  }

  setHandoffStatus(
    handoffId: string,
    status: HandoffStatus,
    patch: Pick<HandoffRecord, "acceptedAt" | "completedAt" | "metadata"> = {}
  ): HandoffRecord | null {
    this.db
      .query(
        `UPDATE handoffs
         SET status = ?, updated_at = ?, accepted_at = COALESCE(?, accepted_at), completed_at = COALESCE(?, completed_at), metadata_json = COALESCE(?, metadata_json)
         WHERE handoff_id = ?`
      )
      .run(
        status,
        isoNow(),
        nullable(patch.acceptedAt),
        nullable(patch.completedAt),
        patch.metadata ? stringify(patch.metadata) : null,
        handoffId
      );
    return this.getHandoff(handoffId);
  }

  appendAuditEvent(record: AuditEventRecord): AuditEventRecord {
    const occurredAt = record.occurredAt ?? isoNow();

    this.db
      .query(
        `INSERT INTO audit_events (
          event_id, entity_type, entity_id, action, actor_id, occurred_at, opencode_refs_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          entity_type = excluded.entity_type,
          entity_id = excluded.entity_id,
          action = excluded.action,
          actor_id = excluded.actor_id,
          occurred_at = excluded.occurred_at,
          opencode_refs_json = excluded.opencode_refs_json,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.eventId,
        record.entityType,
        record.entityId,
        record.action,
        nullable(record.actorId),
        occurredAt,
        stringify(record.opencodeRefs),
        stringify(record.metadata)
      );

    return this.getAuditEvent(record.eventId)!;
  }

  getAuditEvent(eventId: string): AuditEventRecord | null {
    const row = this.db.query("SELECT * FROM audit_events WHERE event_id = ?").get(eventId) as Row | null;
    return row ? mapAuditEvent(row) : null;
  }

  listAuditEvents(filter: AuditEventFilter = {}): AuditEventRecord[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.entityType) {
      conditions.push("entity_type = ?");
      params.push(filter.entityType);
    }
    if (filter.entityId) {
      conditions.push("entity_id = ?");
      params.push(filter.entityId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter.limit ? ` LIMIT ${Math.max(filter.limit, 1)}` : "";
    const rows = this.db
      .query(`SELECT * FROM audit_events ${whereClause} ORDER BY occurred_at ASC${limitClause}`)
      .all(...params) as Row[];
    return rows.map(mapAuditEvent);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_requests (
        request_id TEXT PRIMARY KEY,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_id TEXT,
        target_id TEXT,
        input_summary TEXT,
        opencode_refs_json TEXT,
        metadata_json TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_requests_idempotency_key
      ON dispatch_requests(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS dispatch_runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        opencode_refs_json TEXT,
        error TEXT,
        metadata_json TEXT,
        FOREIGN KEY(request_id) REFERENCES dispatch_requests(request_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_runs_request_id
      ON dispatch_runs(request_id, attempt);

      CREATE TABLE IF NOT EXISTS review_items (
        review_item_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        assigned_to TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        latest_decision_id TEXT,
        opencode_refs_json TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_review_items_subject
      ON review_items(subject_type, subject_id, created_at);

      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        review_item_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        decider_id TEXT NOT NULL,
        rationale TEXT,
        idempotency_key TEXT,
        decided_at TEXT NOT NULL,
        opencode_refs_json TEXT,
        metadata_json TEXT,
        FOREIGN KEY(review_item_id) REFERENCES review_items(review_item_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_idempotency_key
      ON decisions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_decisions_review_item_id
      ON decisions(review_item_id, decided_at);

      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        from_type TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT,
        summary TEXT,
        opencode_refs_json TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_handoffs_source
      ON handoffs(from_type, from_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT,
        occurred_at TEXT NOT NULL,
        opencode_refs_json TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_entity
      ON audit_events(entity_type, entity_id, occurred_at);
    `);
  }
}

export function createProductStore(options: ProductStoreOptions = {}): ProductStore {
  return new ProductStore(options);
}

function mapDispatchRequest(row: Row): DispatchRequestRecord {
  return {
    requestId: asString(row.request_id),
    idempotencyKey: asNullableString(row.idempotency_key),
    status: asString(row.status) as DispatchRequestStatus,
    requestedAt: asString(row.requested_at),
    updatedAt: asString(row.updated_at),
    actorId: asNullableString(row.actor_id),
    targetId: asNullableString(row.target_id),
    inputSummary: asNullableString(row.input_summary),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapDispatchRun(row: Row): DispatchRunRecord {
  return {
    runId: asString(row.run_id),
    requestId: asString(row.request_id),
    status: asString(row.status) as DispatchRunStatus,
    attempt: Number(row.attempt),
    startedAt: asString(row.started_at),
    updatedAt: asString(row.updated_at),
    completedAt: asNullableString(row.completed_at),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    error: asNullableString(row.error),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapReviewItem(row: Row): ReviewItemRecord {
  return {
    reviewItemId: asString(row.review_item_id),
    subjectType: asString(row.subject_type),
    subjectId: asString(row.subject_id),
    status: asString(row.status) as ReviewItemStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    assignedTo: asNullableString(row.assigned_to),
    title: asString(row.title),
    summary: asNullableString(row.summary),
    latestDecisionId: asNullableString(row.latest_decision_id),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapDecision(row: Row): DecisionRecord {
  return {
    decisionId: asString(row.decision_id),
    reviewItemId: asString(row.review_item_id),
    outcome: asString(row.outcome) as DecisionOutcome,
    deciderId: asString(row.decider_id),
    rationale: asNullableString(row.rationale),
    idempotencyKey: asNullableString(row.idempotency_key),
    decidedAt: asString(row.decided_at),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapHandoff(row: Row): HandoffRecord {
  return {
    handoffId: asString(row.handoff_id),
    fromType: asString(row.from_type),
    fromId: asString(row.from_id),
    toType: asString(row.to_type),
    toId: asString(row.to_id),
    status: asString(row.status) as HandoffStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    acceptedAt: asNullableString(row.accepted_at),
    completedAt: asNullableString(row.completed_at),
    summary: asNullableString(row.summary),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapAuditEvent(row: Row): AuditEventRecord {
  return {
    eventId: asString(row.event_id),
    entityType: asString(row.entity_type),
    entityId: asString(row.entity_id),
    action: asString(row.action),
    actorId: asNullableString(row.actor_id),
    occurredAt: asString(row.occurred_at),
    opencodeRefs: parseJson<OpenCodeRefs>(row.opencode_refs_json),
    metadata: parseJson<ProductMetadata>(row.metadata_json) ?? {},
  };
}

function mapOutcomeToReviewStatus(outcome: DecisionOutcome): ReviewItemStatus {
  switch (outcome) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "deferred":
      return "needs_input";
    case "escalated":
      return "resolved";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function stringify(value: JsonValue | ProductMetadata | OpenCodeRefs | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return JSON.parse(value) as T;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected string value, received ${typeof value}`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asString(value);
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}
