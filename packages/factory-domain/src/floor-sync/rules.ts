import { CLIENT_SCAN_ID } from '../production/scans/rules'
import type { FloorSyncKind } from './kinds'

/**
 * The floor sync's rules (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-189; A1 §3.8; design floor.sync): pure, so the tests
 * hold them. apps/factory-api platform/floor-sync applies them; each module's own rules judge the action itself.
 *
 * - A tablet sends its queue in its own order (`seq`, FIFO per device). The server applies the events of one send by
 *   `seq`, whatever order they arrive in; one send never names a `seq` or a client event id twice.
 * - An event is recorded once per device and client event id: a resend is answered from the ledger (`duplicate`), and
 *   the module's own key answers a resend the ledger did not see. The same id for another kind is refused.
 * - A refusal keeps its code, its words, ONE fix and whether it may pass when sent again (`final: false`: the tablet keeps
 *   it in its queue and sends it again by itself). It is kept until the same event is recorded later (RESOLVED) or
 *   someone discards it with a reason (DISCARDED).
 */

/** The tablet's id for an event: 8 to 64 letters, digits, dots, colons, underscores or hyphens (a UUID fits). */
export const CLIENT_EVENT_ID = CLIENT_SCAN_ID

/** Events in one send. */
export const MAX_SYNC_EVENTS = 50

/** The words of a discard: 3 to 200 characters. */
export const DISCARD_REASON_MIN = 3
export const DISCARD_REASON_MAX = 200

/** The reason a tablet's own discard records (the design's confirm asks no words: the operator read the refusal). */
export const FLOOR_DISCARD_REASON = 'Discarded on the tablet after the refusal was read.'

export const SYNC_REFUSAL_CODES = ['UNKNOWN_KIND', 'BAD_EVENT', 'NOT_ALLOWED', 'NOT_FOUND', 'CLIENT_ID_REUSED', 'OTHER_WORKER', 'CONFLICT'] as const
export type SyncRefusalCode = (typeof SYNC_REFUSAL_CODES)[number]

export interface SyncRefusal {
  /** The module's refusal code (`HIDE_USED_UP`, `UNKNOWN_BUNDLE`, `NOT_RESERVED` …) or one of SYNC_REFUSAL_CODES. */
  readonly code: string
  /** What happened and why, in words (never another worker's name). */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
  /** False: it may pass when sent again later; the tablet keeps it in its queue. */
  readonly final: boolean
}

const DISCARD = 'Discard it, or ask your team leader.'
const AGAIN = 'It is sent again by itself; if it stays here, ask your team leader.'

export const unknownKindRefusal = (kind: string): SyncRefusal => ({
  code: 'UNKNOWN_KIND',
  message: `This tablet sent an action the office does not take from the queue (${kind.slice(0, 60)}).`,
  fix: 'Discard it and update the app; ask your team leader.',
  final: true,
})

export const badEventRefusal = (problem: string): SyncRefusal => ({
  code: 'BAD_EVENT',
  message: `The tablet kept this action with something missing or wrong: ${problem}`,
  fix: 'Discard it and do it again.',
  final: true,
})

export const notAllowedRefusal = (): SyncRefusal => ({
  code: 'NOT_ALLOWED',
  message: 'The person signed in may not do this at this site.',
  fix: 'Ask your team leader for the role, or discard it.',
  final: true,
})

export const clientIdReusedRefusal = (): SyncRefusal => ({
  code: 'CLIENT_ID_REUSED',
  message: "This tablet used one action's id for another action.",
  fix: 'Discard it and do it again.',
  final: true,
})

/** Another person's queued action while someone else is signed in: it waits for them (never recorded under another name). */
export const otherWorkerRefusal = (): SyncRefusal => ({
  code: 'OTHER_WORKER',
  message: 'This action was done by another person on this tablet.',
  fix: 'It is sent when that person signs in on this tablet.',
  final: false,
})

/** Codes after which the same action may pass later: the queue sends it again by itself. */
const PASSES_LATER = new Set(['FLOOR_NOT_READY', 'WORK_ORDER_NOT_OPEN', 'CR_VI_PENDING', 'QUALITY_HOLD', 'PREVIOUS_NOT_REPORTED', 'NOT_SIGNED_IN', 'NOTICE_NOT_ACKNOWLEDGED', 'OTHER_WORKER', 'CONFLICT'])

/** The fix for a module refusal that brings none (bundles' and cuts' refusals carry a code and words only). */
const FIXES: Readonly<Record<string, string>> = Object.freeze({
  FLOOR_NOT_READY: 'It is sent again by itself once the floor is ready; ask your team leader.',
  WORK_ORDER_NOT_OPEN: 'Ask your team leader: the work order is not open.',
  QUALITY_HOLD: 'Ask your team leader: quality holds this.',
  CR_VI_PENDING: 'It is sent again by itself once the test result is in.',
  HIDE_USED_UP: 'Discard it: the hide is used up.',
  REPLACED: 'Discard it and scan the new ticket.',
  VOIDED: 'Discard it: the bundle was voided.',
  NOT_RESERVED: 'Discard it, print a new label and put it on instead.',
  BLOCK_CLOSED: 'Discard it, print a new label and put it on instead.',
  ALREADY_USED: 'Discard it, print a new label and put it on instead.',
})

/** What a module refused, as the API reads it off its error: the module's refusal (code, words, maybe fix and final). */
export interface ModuleRefusal {
  readonly code: string
  readonly message: string
  readonly fix?: string | undefined
  readonly final?: boolean | undefined
}

/** A module's refusal with its fix and whether it may pass later. */
export function moduleRefusal(refusal: ModuleRefusal): SyncRefusal {
  const final = refusal.final ?? !PASSES_LATER.has(refusal.code)
  return { code: refusal.code, message: refusal.message, fix: refusal.fix ?? FIXES[refusal.code] ?? (final ? DISCARD : AGAIN), final }
}

/** A module error without a refusal of its own (a 404, a 403, a 409 in words), by the error's code. */
export function errorRefusal(error: { readonly code: string; readonly message: string; readonly issues?: readonly { readonly path: string; readonly message: string }[] | undefined }): SyncRefusal {
  switch (error.code) {
    case 'validation_failed':
    case 'bad_request': {
      const first = error.issues?.[0]
      return badEventRefusal(first ? `${first.message} (${first.path})` : error.message)
    }
    case 'not_found':
      return { code: 'NOT_FOUND', message: error.message, fix: DISCARD, final: true }
    case 'forbidden':
      return { ...notAllowedRefusal(), message: error.message === 'You may not do this.' ? notAllowedRefusal().message : error.message }
    case 'invalid_state':
      return { code: 'CONFLICT', message: error.message, fix: DISCARD, final: true }
    default:
      return { code: 'CONFLICT', message: error.message, fix: AGAIN, final: false }
  }
}

// ---- one send ---------------------------------------------------------------------------------------------------------------------

export interface SentEvent {
  readonly clientEventId: string
  readonly seq: number
}

/**
 * The events of one send in the tablet's order (by `seq`), or the problem: a `seq` or a client event id named twice.
 * The order they arrived in does not matter (a queue sends in order; a proxy may not).
 */
export function inDeviceOrder<Event extends SentEvent>(events: readonly Event[]): { readonly ok: true; readonly events: Event[] } | { readonly ok: false; readonly problem: string } {
  const seqs = new Set<number>()
  const ids = new Set<string>()
  for (const event of events) {
    if (seqs.has(event.seq)) return { ok: false, problem: `seq ${event.seq} is sent twice.` }
    if (ids.has(event.clientEventId)) return { ok: false, problem: `client event ${event.clientEventId} is sent twice.` }
    seqs.add(event.seq)
    ids.add(event.clientEventId)
  }
  return { ok: true, events: [...events].sort((a, b) => a.seq - b.seq) }
}

// ---- what an event was, for the lists ------------------------------------------------------------------------------------------

/** The facts the lists show of an event ("Report BN-… · 20 good"): never money, never a person. */
export interface EventSummary {
  readonly code?: string | null
  readonly good?: number
  readonly scrap?: number
  readonly rework?: number
  readonly quantity?: number
  readonly workOrderId?: string
  readonly target?: string | null
  readonly sets?: number
}

const text = (value: unknown, max = 80): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null)
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)
const sumOf = (lines: unknown): number => (Array.isArray(lines) ? lines.reduce((total: number, line) => total + (whole((line as { quantity?: unknown } | null)?.quantity) ?? 0), 0) : 0)

/** The summary of an event's payload (what the tablet sent): known facts only, everything else left out. */
export function summaryOf(kind: FloorSyncKind, payload: unknown): EventSummary {
  const p = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const workOrderId = text(p.workOrderId, 40) ?? undefined
  switch (kind) {
    case 'production.scan.report':
      return { code: text(p.code) ?? text(p.bundleId), good: whole(p.good) ?? 0, scrap: sumOf(p.scrap), rework: sumOf(p.rework) }
    case 'production.scan.undo':
      return { target: text(p.undoesClientScanId) ?? text(p.scanId) }
    case 'production.scan.ask':
      return { target: text(p.targetClientScanId) ?? text(p.scanId), good: whole(p.good) ?? 0, scrap: sumOf(p.scrap), rework: sumOf(p.rework) }
    case 'production.cut.log': {
      const lines = Array.isArray(p.lines) ? p.lines : []
      return { code: text(p.code) ?? text(p.hideId), sets: lines.reduce((total: number, line) => total + (whole((line as { sets?: unknown } | null)?.sets) ?? 0), 0), ...(workOrderId ? { workOrderId } : {}) }
    }
    case 'production.cut.remnant':
      return { code: text(p.hideId), ...(workOrderId ? { workOrderId } : {}) }
    case 'production.bundles.make': {
      const cells = Array.isArray(p.cells) ? (p.cells as Record<string, unknown>[]) : []
      const quantity = cells.reduce((total: number, cell) => total + (whole(cell?.quantity) ?? (Array.isArray(cell?.quantities) ? sumOf((cell.quantities as unknown[]).map((n) => ({ quantity: n }))) : 0)), 0)
      return { code: text(p.ticketCode), ...(quantity > 0 ? { quantity } : {}), ...(workOrderId ? { workOrderId } : {}) }
    }
    case 'plant.report':
      return { code: text(p.assetNumber, 40) ?? text(p.machineId, 40) }
    // B-W2b-29: the code's id (the tablet shows its own tile words); an end names nothing.
    case 'production.offStandard.start':
      return { code: text(p.codeId, 40) }
    case 'production.offStandard.end':
      return {}
    // B-W2b-33: which clock action (IN, OUT, BREAK_OUT, BREAK_IN); never who or when (the ledger keeps the tablet time).
    case 'people.clock.record':
      return { code: text(p.action, 20) }
  }
}

// ---- the tablet's view of refused actions (Statuto dei Lavoratori art. 4: other people's are counted, never shown) -----------

export interface RefusedOwner {
  readonly workerId: string | null
}

/**
 * Whose a refused action is, seen from the person signed in on the tablet: at a site that names workers, theirs when it
 * names them (a refusal of a worker who had not acknowledged the notice names nobody, so it counts as another
 * person's); at a site that records the station only, every refused action of the tablet is the tablet's.
 */
export function isOwnRefusal(row: RefusedOwner, viewer: { readonly workerId: string; readonly subject: 'WORKER' | 'STATION' }): boolean {
  return viewer.subject === 'WORKER' ? row.workerId === viewer.workerId : true
}
