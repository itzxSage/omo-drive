# omo-drive Operator Policy v0.2

## Status

- Version: v0.2
- Owner: `omo-drive`
- Purpose: authoritative policy and audit vocabulary for remote operator actions handled by `omo-drive`

## 1. Product Boundary

### 1.1 Source of truth

- OpenCode owns live session and conversation truth, including upstream message history, live assistant turns, and OpenCode-native permission prompts.
- `omo-drive` owns bridge-layer trust, dispatch requests and runs, review and voicemail artifacts, handoff packages, reconnect-safe product state, and audit artifacts.

### 1.2 v0.2 scope

- This policy applies to actions initiated from the `omo-drive` mobile UI, voice input, typed input, dispatch mode, review actions, and product-owned APIs.
- This policy does not grant unrestricted shell passthrough, arbitrary desktop mirroring, or a second session authority outside OpenCode.
- This policy is single-user and multi-device only. Team or multi-user sharing is out of scope for v0.2.

### 1.3 Enforcement model

- Action class is determined by server-owned policy, not by UI copy and not by keyword matching alone.
- Frontend hints may warn, summarize, or collect user intent, but the server is the final enforcement point.
- Every approval-required, forbidden, blocked, reconnect, and terminal transition must emit an audit event using the vocabulary in this document.

## 2. Policy Decision Contract

Every action evaluated under this policy must produce a decision object that can later be tested in server and UI code.

Required fields:

- `actionType`: canonical action identifier, for example `dispatch.create` or `session.switch`
- `actionClass`: one of `allowed`, `approval_required`, or `forbidden`
- `targetScope`: one of `active_repo`, `explicit_repo`, `cross_project`, `sensitive_surface`, or `unknown`
- `requiresApproval`: boolean derived from `actionClass`
- `decisionReason`: stable machine-friendly reason code
- `auditEvent`: first event name emitted for the decision

Allowed `decisionReason` values for v0.2:

- `low_risk_repo_scoped`
- `non_destructive_read`
- `review_triage_safe`
- `non_destructive_dispatch`
- `destructive_change`
- `secret_sensitive`
- `deploy_or_prod`
- `cross_project_write`
- `permissions_or_trust_change`
- `sensitive_capture`
- `unsupported_remote_control`
- `unknown_scope`

## 3. Action Classes

## 3.1 Allowed

Definition:

- The action is low-risk, non-destructive, and clearly scoped to the active repo or to product-owned review state.
- The action may execute immediately after trust validation.

Rules:

- Allowed actions still require valid paired or trusted device state for privileged product surfaces.
- Allowed does not mean unauthenticated. It means no additional human approval step after trust is validated.
- Allowed actions must emit `policy.allowed` before execution starts.

Representative allowed actions in v0.2:

| Action type | Conditions | Notes |
| --- | --- | --- |
| `session.list` | read-only session listing through approved OpenCode proxy route | Includes listing recent sessions |
| `session.switch` | switch to an existing OpenCode session id selected by the user | No mutation outside OpenCode session selection |
| `model.list` | read-only provider and model listing | Read-only query |
| `repo.read_status` | repo-scoped read operations such as status, file listing, or diff inspection | Must stay inside targeted repo |
| `review.list` | list review or voicemail items | Product-owned read |
| `review.open` | open a review item, handoff package, or voicemail artifact | Product-owned read |
| `review.snooze` | defer a review item without executing external side effects | Product-owned state change only |
| `dispatch.create` | create a non-destructive dispatch packet with explicit repo target and follow-up policy | Creation is allowed, execution outcome may later block |
| `handoff.open` | open a stored handoff package or audit timeline | Product-owned read |
| `approval.respond` | approve or deny an already pending approval request | Decision is user intent, not privileged execution itself |

## 3.2 Approval Required

Definition:

- The action is potentially valid in v0.2 but may change files, system state, permissions, trust state, screenshots, or execution scope in a way that should not happen silently.
- The action must not execute until an explicit approval decision is recorded.

Rules:

- Approval-required actions must emit `policy.approval_required` and then enter a waiting state before any side effect executes.
- The waiting state must survive reconnect and page reload.
- Approval must be linked to a trust identity, approval request id, and originating action id.

Representative approval-required actions in v0.2:

| Action type | Trigger for approval | Notes |
| --- | --- | --- |
| `repo.write` | any file create, edit, rename, or delete with repo side effects | Includes generated file writes |
| `git.write` | staging, commit, merge, branch deletion, or other git mutation | Read-only git status is not included |
| `dispatch.execute_write` | dispatch run that may edit files, create commits, or run write-capable tooling | Dispatch creation can still be allowed |
| `dispatch.execute_background` | background execution beyond the active repo or beyond an immediate conversational turn | Includes queued work with side effects |
| `permissions.grant` | grant a new trust, permission scope, or durable allow decision | Applies to product-owned approval and trust scopes |
| `trust.pair` | create or re-pair a trusted mobile device credential | Pairing creates future privilege |
| `trust.revoke` | revoke a trusted device or trust token | Security-sensitive state change |
| `screenshot.capture_sensitive` | capture when the declared surface may include secrets, unrelated projects, or broader desktop context | Narrow in-repo capture may later become allowed if explicitly scoped |
| `cleanup.destructive` | remove generated files, caches, branches, or local artifacts | Includes destructive cleanup requests |
| `deploy.trigger` | deploy, publish, release, restart service, or modify production-like runtime state | Always approval-required in v0.2 |

## 3.3 Forbidden

Definition:

- The action is outside the accepted v0.2 boundary and must be rejected even if the user asks for immediate execution.

Rules:

- Forbidden actions must emit `policy.forbidden` and must not create downstream execution side effects.
- The UI may explain why the action was rejected and may offer a safer alternative, but it must not present a one-tap override in v0.2.

Representative forbidden actions in v0.2:

| Action type | Why forbidden | Notes |
| --- | --- | --- |
| `shell.passthrough_unrestricted` | unrestricted remote shell passthrough is explicitly out of scope | No arbitrary shell bridge |
| `desktop.mirror_arbitrary` | arbitrary desktop mirroring is out of scope | Screenshot shortcuts do not imply mirroring |
| `cross_project.write_implicit` | write-capable action without an explicit repo target | Prevents hidden spillover into other projects |
| `secret.read_store` | secrets-store or credential-store access by default | Includes keychains, env vaults, and similar stores unless a later scope explicitly changes this policy |
| `session.shadow_write` | persisting or mutating a competing OpenCode session truth store | `omo-drive` may reference sessions, not replace them |
| `trust.bypass` | unauthenticated or expired device attempts to perform privileged actions | Must reject before route execution |
| `approval.override_missing_record` | executing an approval-required action without a durable approval record | No client-only confirmation bypass |

## 4. Default Classification Rules

Apply these rules in order:

1. If the action would create unrestricted shell passthrough, arbitrary desktop mirroring, default secret-store access, implicit cross-project write access, or shadow OpenCode session ownership, classify it as `forbidden`.
2. Otherwise, if the action can change repo contents, git state, trust state, permission scope, deployment state, screenshot sensitivity, or execution scope outside low-risk repo reads, classify it as `approval_required`.
3. Otherwise, if the action is a read, triage, session or model switch, or a non-destructive dispatch creation scoped to the active repo, classify it as `allowed`.
4. If scope cannot be determined, classify it as `approval_required` with reason `unknown_scope`.

The current frontend keyword list in `public/app.js` may remain as an interim hint, but it is not sufficient to satisfy this policy.

## 5. Audit Event Vocabulary

Event names are stable snake_case identifiers in dot notation. Each event represents one durable timeline entry.

Every audit event record must include:

- `eventName`
- `occurredAt`
- `actorType`, one of `user`, `trusted_device`, `omo_drive`, `opencode`, or `system`
- `actorId`, stable identifier for the device, trust record, session, or process that emitted the event
- `subjectType`, such as `trust`, `dispatch_request`, `dispatch_run`, `review_item`, `approval_request`, `handoff_package`, or `session_bridge`
- `subjectId`
- `status`, current state after the event
- `relatedActionType`, when applicable
- `metadata`, JSON object for route, repo target, approval reason, reconnect token, or error details

## 5.1 Trust and pairing events

| Event name | When emitted | Expected status after event |
| --- | --- | --- |
| `trust.pairing_started` | pairing flow begins for a device or browser | `pairing_pending` |
| `trust.pairing_completed` | trust credential is issued successfully | `trusted` |
| `trust.validated` | trusted credential is checked and accepted for a request | `trusted` |
| `trust.validation_failed` | credential is missing, invalid, or mismatched | `blocked` |
| `trust.expired` | previously valid trust reaches expiry | `expired` |
| `trust.revoked` | trust is explicitly revoked | `revoked` |
| `trust.repairing_required` | device must pair again before proceeding | `blocked` |

## 5.2 Policy and approval events

| Event name | When emitted | Expected status after event |
| --- | --- | --- |
| `policy.allowed` | policy classifies an action as allowed | `ready` |
| `policy.approval_required` | policy classifies an action as needing approval | `awaiting_approval` |
| `policy.forbidden` | policy rejects an action as out of scope | `rejected` |
| `approval.requested` | approval artifact is created and linked to the action | `awaiting_approval` |
| `approval.approved` | user approves a pending action | `approved` |
| `approval.denied` | user denies a pending action | `denied` |
| `approval.expired` | approval window expires before a decision | `expired` |
| `approval.cancelled` | pending approval is withdrawn because the action no longer applies | `cancelled` |

## 5.3 Dispatch and execution events

| Event name | When emitted | Expected status after event |
| --- | --- | --- |
| `dispatch.created` | dispatch request is stored | `queued` |
| `dispatch.accepted` | request passes initial validation and is eligible for execution | `accepted` |
| `dispatch.started` | a run begins execution | `running` |
| `dispatch.progressed` | significant execution progress is recorded | `running` |
| `dispatch.blocked` | execution pauses because approval, clarification, or dependency is missing | `blocked` |
| `dispatch.completed` | run finishes successfully | `completed` |
| `dispatch.failed` | run finishes unsuccessfully | `failed` |
| `dispatch.cancelled` | run is cancelled intentionally | `cancelled` |
| `dispatch.expired` | queued or blocked dispatch becomes stale past retention or timeout policy | `expired` |

## 5.4 Review, voicemail, and handoff events

| Event name | When emitted | Expected status after event |
| --- | --- | --- |
| `review.created` | review item is created from a completed, blocked, or failed action | `pending_review` |
| `review.opened` | user opens the review item | `in_review` |
| `review.snoozed` | user defers the review item | `snoozed` |
| `review.resumed` | snoozed or pending item is reopened for action | `in_review` |
| `review.resolved` | review item is completed with no further action needed | `resolved` |
| `voicemail.created` | voicemail artifact is generated with spoken and text summary | `pending_review` |
| `handoff.created` | handoff package is assembled for later continuation | `ready` |
| `handoff.opened` | user opens the handoff package | `in_review` |
| `handoff.accepted` | user chooses continue or accepts the next action | `accepted` |

## 5.5 Reconnect and idempotency events

| Event name | When emitted | Expected status after event |
| --- | --- | --- |
| `reconnect.detected` | client or stream disconnect is detected | `reconnecting` |
| `reconnect.restored` | client resumes and the prior action state is recovered safely | `ready` or prior durable state |
| `reconnect.replay_blocked` | duplicate replay is prevented during reconnect or retry | `blocked_duplicate` |
| `request.duplicate_detected` | identical request or idempotency key is seen again | `deduplicated` |
| `request.deduplicated` | duplicate request is mapped to the existing logical action | existing durable status |

## 5.6 Terminal and blocked-state events

These statuses may appear on dispatch runs, review items, approvals, trust records, or handoff packages when the event above transitions them there:

- `blocked`
- `awaiting_approval`
- `rejected`
- `completed`
- `failed`
- `cancelled`
- `expired`
- `revoked`
- `resolved`

`blocked` is a pause that may later resume. `rejected`, `completed`, `failed`, `cancelled`, `expired`, `revoked`, and `resolved` are terminal for the current subject record.

## 6. Route and Surface Mapping Rules

- OpenCode passthrough routes under `/api/opencode/*` remain upstream-facing routes and must not be used to store product-owned audit, dispatch, review, or trust records.
- Product-owned trust, dispatch, review, voicemail, handoff, and audit APIs introduced in v0.2 must use this document's action and event names.
- Voice input, typed input, dispatch submissions, and review actions must converge on the same server-side policy classifier before execution.
- Screenshot endpoints are privileged product routes. They require trust validation and must classify sensitive capture as approval-required.

## 7. Testability Requirements

This document is considered implementable only if future automated tests can derive these assertions directly from it:

- At least one representative action exists for each action class: `allowed`, `approval_required`, and `forbidden`.
- An approval-required action emits `policy.approval_required`, then `approval.requested`, and does not emit `dispatch.started` or another execution-start event until `approval.approved` exists.
- A forbidden action emits `policy.forbidden` and produces no downstream side effect event such as `dispatch.started`, `repo.write`, or screenshot bytes returned.
- A reconnect retry can emit `reconnect.detected`, `request.duplicate_detected`, and `request.deduplicated` without creating a second logical run.
- A blocked workflow can produce `dispatch.blocked` or `trust.repairing_required`, then later resume into a non-terminal state or end in a terminal state with a corresponding audit event.

## 8. v0.2 Non-Goals

- No team permissions model
- No unrestricted terminal streaming or arbitrary shell bridge
- No always-on desktop mirroring
- No competing OpenCode transcript or session database
- No approval bypass based only on client-side voice confirmation or keyword detection

## 9. Change Control

- Changes to action classes, decision reasons, or event names must update this document first.
- Backend and frontend implementations must treat this file as the canonical v0.2 vocabulary until a later versioned replacement exists.
