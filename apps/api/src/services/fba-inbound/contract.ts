/**
 * Step 4 Send to FBA (Owner 2026-10-07) — the FROZEN service signatures (Part A, stage 1).
 *
 * This file is the ONE import point for every caller outside the file that implements a function: routes, Claude's
 * tools, the worker, the resume cron, the status poll, and Part C's send service calling Part B's dispatch. The wire
 * shapes, the states and the box rule live in `@nexus/shared/fba-send`; this file adds the server-side signatures,
 * the error type, and the runtime names (queue, env switches, timings).
 *
 * Stage 1: every function is a STUB that throws `FbaSendError('NOT_BUILT')`. Each part, as its last edit, replaces the
 * stubs of ITS section below — and nothing else in this file — with a re-export of its own file, signatures unchanged:
 *   Part C → `export { readSendDraft, createSendPlan, confirmChoice, cancelPlan, retryPlan } from './send.service.js'`,
 *            `export { markShipped, labelsFor } from './ship.service.js'`, `export { readPlans, readPlan } from './read.service.js'`
 *   Part B → `export { dispatchFbaPlan } from './dispatch.js'`, `export { runFbaPlan } from './runner.js'`
 * Tests mock this module (`vi.mock('./contract.js')` / `'../services/fba-inbound/contract.js'`) to stand in for a part
 * that is not built yet (Part C mocks `dispatchFbaPlan`).
 *
 * Routes (Part C, `routes/fba-send.routes.ts`, zero Prisma; all under `/api/fba/inbound` → `F.inboundManage`):
 *   GET  /fba/inbound/send-draft?productIds=a,b&from=IT-MAIN&market=IT   → readSendDraft        → 200 FbaSendDraft
 *   POST /fba/inbound/plans                     (Idempotency-Key)        → createSendPlan       → 202 FbaCreateAnswer
 *   GET  /fba/inbound/plans?productId=<id>&open=1                        → readPlans            → 200 { plans: FbaPlanView[] }
 *   GET  /fba/inbound/plans/:id                                          → readPlan             → 200 FbaPlanView | 404
 *   POST /fba/inbound/plans/:id/choice          (Idempotency-Key)        → confirmChoice        → 200 FbaPlanView
 *   POST /fba/inbound/plans/:id/cancel          (Idempotency-Key)        → cancelPlan           → 200 FbaPlanView
 *   POST /fba/inbound/plans/:id/retry           (Idempotency-Key)        → retryPlan            → 200 FbaPlanView
 *   GET  /fba/inbound/shipments/:id/labels                               → labelsFor            → 200 FbaLabelsAnswer
 *   POST /fba/inbound/shipments/:id/shipped     (Idempotency-Key)        → markShipped          → 200 FbaPlanView
 * A thrown `FbaSendError` answers `httpStatus` with `{ ok: false, code, error: message, problems }`.
 * COMMAND_SCOPES (lib/command-idempotency.ts): '/api/fba/inbound/plans' 'fba-plan-create', '/api/fba/inbound/plans/:id/choice'
 * 'fba-plan-choice', '/api/fba/inbound/plans/:id/cancel' 'fba-plan-cancel', '/api/fba/inbound/plans/:id/retry'
 * 'fba-plan-retry', '/api/fba/inbound/shipments/:id/shipped' 'fba-shipment-shipped'.
 *
 * Hard rules every body keeps: every Amazon call goes through the client → gateway (never `fetch`); Amazon writes only
 * when `NEXUS_ENABLE_FBA_INBOUND_SEND=1` (else the plan is HELD); CONFIRMING starts only from `confirmChoice` (a person's
 * click, `confirmedBy` set) — never from Claude's tools; Nexus never writes an FBA quantity (the Shipped movement is
 * FBA_TRANSFER_OUT at the From WAREHOUSE only); `fba.plan_changed` is published in the transaction that moves the plan.
 */
import type {
  FbaChoiceRequest, FbaCreateAnswer, FbaCreateRequest, FbaLabelsAnswer, FbaPlanStatus, FbaPlanStep, FbaPlanView,
  FbaSendDraft, FbaSendProblem, FbaShippedRequest,
} from '@nexus/shared/fba-send'

/* ── who acts ─────────────────────────────────────────────────────────────────────────────────── */

/** Who acts. `actor` is what the audit trail and the step log name (the person's e-mail or id, as the Matrix doors do). */
export interface FbaActor {
  actor: string
  /** The person's user id; null for work no person started (a cron, a system run). */
  userId: string | null
}
/** A person — required where only a person may act (confirming at Amazon is final). */
export type FbaPerson = FbaActor & { userId: string }
/** Where a plan was created: the Matrix dialog, or Claude's request after a person approved it. */
export type FbaPlanSource = 'matrix' | 'claude'

export interface FbaSendDraftQuery {
  /** Ticked rows; a parent expands to its variations (a parent is never sent). 1..FBA_SEND_MAX_SKUS after expanding. */
  productIds: string[]
  /** StockLocation.code; absent = the business's default warehouse. */
  from?: string | null
  /** Market code; absent = the From country's market, else IT. */
  market?: string | null
}
export interface FbaPlansQuery {
  /** A product (or a family root: its variations count too); absent = every plan. */
  productId?: string | null
  /** true = only open plans (`isFbaPlanOpen`). */
  open?: boolean
}

/* ── errors ───────────────────────────────────────────────────────────────────────────────────── */

export type FbaSendErrorCode =
  | 'NOT_FOUND'          // no such plan / shipment (or not a Send-to-FBA plan)
  | 'REFUSED'            // the send does not pass sendProblems — `problems` lists the blocking ones
  | 'WRONG_STATE'        // not allowed in the plan's status (choice twice, cancel after Shipped, retry when not FAILED, …)
  | 'OPTION_UNKNOWN'     // the choice names an option / shipment / transport / window not in plan.options
  | 'OPTIONS_EXPIRED'    // Amazon's options expired — "Get new options" (retryPlan)
  | 'NEEDS_PERSON'       // confirming at Amazon needs a person's click
  | 'TRACKING_INVALID'   // Shipped: not one non-empty tracking number for every box of the shipment
  | 'LABELS_UNAVAILABLE' // no confirmed shipment / boxes yet, or Amazon gave no label link
  | 'NOT_BUILT'          // stage-1 stub
export const FBA_SEND_ERROR_HTTP: Readonly<Record<FbaSendErrorCode, number>> = {
  NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403,
  TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, NOT_BUILT: 501,
}
export class FbaSendError extends Error {
  constructor(readonly code: FbaSendErrorCode, message: string, readonly problems: FbaSendProblem[] = []) {
    super(message)
    this.name = 'FbaSendError'
  }
  get httpStatus(): number {
    return FBA_SEND_ERROR_HTTP[this.code]
  }
}

/* ── runtime names (Part B) ───────────────────────────────────────────────────────────────────── */

/** BullMQ queue name (`lib/queue.ts` `fbaInboundQueue`), one job per plan. */
export const FBA_INBOUND_QUEUE = 'fba-inbound'
/** The job id of a plan's run (no ":" — the lib/bullmq-job-ids rule). */
export const fbaPlanJobId = (planRowId: string): string => `fba-plan-${planRowId}`
/** Amazon writes (every POST/PUT of the inbound client) only when this is '1'; off → the plan is HELD. Reads unaffected. */
export const FBA_WRITES_ENV = 'NEXUS_ENABLE_FBA_INBOUND_SEND'
/** The fake Amazon behind the client's transport seam; honoured only off production on a loopback `*test*` database. */
export const FBA_FAKE_ENV = 'NEXUS_FBA_INBOUND_FAKE'
/** '0' switches the resume cron off. */
export const FBA_RESUME_ENV = 'NEXUS_FBA_INBOUND_RESUME'
/** The claim's lease: `nextCheckAt = now + FBA_LEASE_MS`, bumped after every Amazon call. */
export const FBA_LEASE_MS = 120_000
/** An operation still IN_PROGRESS after the in-job polls → `nextCheckAt = now + FBA_RECHECK_MS`, the job exits. */
export const FBA_RECHECK_MS = 60_000
/** In-job polls of getInboundOperationStatus, in seconds (~80 s in all). */
export const FBA_POLL_SECONDS = [2, 3, 5, 8, 13, 20, 30] as const
/** The job's own spacing between Amazon POST/PUTs (Amazon: 2 rps, burst 2). */
export const FBA_POST_SPACING_MS = 600

/** What one run of the job did. */
export interface FbaRunOutcome {
  /** false = another run holds the lease, or the plan is in no claimable state: nothing ran. */
  claimed: boolean
  /** The plan's status / step when the run ended (null when not claimed or not found). */
  status: FbaPlanStatus | null
  step: FbaPlanStep | null
  /** When the job should run again (resume cron / next dispatch); null = it waits for a person, or is done. */
  nextCheckAt: Date | null
}

function notBuilt(name: string): never {
  throw new FbaSendError('NOT_BUILT', `fba-inbound/contract: ${name} is not built yet (Step 4 Part A stage 1 stub)`)
}

/* ══ Part C — send / read / ship (built 2026-10-07; signatures unchanged, rules in each function's JSDoc there). ══════ */

export { readSendDraft, createSendPlan, confirmChoice, cancelPlan, retryPlan } from './send.service.js'
export { markShipped, labelsFor } from './ship.service.js'
export { readPlans, readPlan } from './read.service.js'

/* ══ Part B — the job (built 2026-10-07; signatures unchanged, rules in each function's JSDoc there). ════════════════ */

export { dispatchFbaPlan } from './dispatch.js'
export { runFbaPlan } from './runner.js'
