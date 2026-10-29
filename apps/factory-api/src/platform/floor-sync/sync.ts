import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { isFloorSyncKind, QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import {
  clientIdReusedRefusal,
  FLOOR_DISCARD_REASON,
  inDeviceOrder,
  isOwnRefusal,
  notAllowedRefusal,
  otherWorkerRefusal,
  summaryOf,
  unknownKindRefusal,
  type SyncRefusal,
} from '@nexus/factory-domain/floor-sync/rules'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { clockCheck } from '@nexus/factory-domain/production/scans/rules'
import type { ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import type { CommandCaller } from '../../core/command'
import { actorOf, type FloorContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { floorOf } from '../../modules/production/scans/access'
import { discardRefusal as discardScanRefusal, readRefusal as readScanRefusal } from '../../modules/production/scans/refusals-store'
import { hasAcknowledgedNotice, scanSubjectFor } from '../../modules/production/settings/subject'
import { myBlocks, topUpBlocks } from '../numbering/scan-ids'
import { applyQueued, type Applied, type QueuedEvent } from './kinds'
import { discardRefused, lastRecordedAt, readLedger, readRefused, readRefusedOne, recordEvent, recordRefused, type Discard, type LedgerRow, type RefusedRow } from './store'

/**
 * The tablet's side of the floor sync (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-189; A1 §3.8; design floor.sync SCR-023).
 *
 * POST /floor/sync: the queue's events of one send, applied by `seq` (the tablet's order), each through its own module
 * command (kinds.ts), once:
 *   1. the ledger first: an event recorded before is answered `duplicate` with its record and never reaches the module
 *      again (a resend acts once, whatever the module's receipts still hold); the same id for another kind is refused;
 *   2. an unknown kind is refused; another person's action (a site that names workers) waits for them (`waiting`, not
 *      kept: it is never recorded under another name); the kind's permission at the tablet's site, else refused;
 *   3. the module command: accepted (or duplicate: the module had it under the same id) → one ledger row, which resolves
 *      the event's open refused actions; refused → kept with its code, words, fix and final (once per code).
 * Then, when the tablet sent its own counts of numbers left, the top-up of its DEVICE number blocks (platform/numbering).
 * A failure that is not a refusal fails the send: the events before it are recorded, so sending it all again is safe.
 */

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

interface Facts {
  readonly companyId: string
  readonly stationId: string | null
  readonly subject: ScanSubject
  readonly acknowledged: boolean
}

async function factsOf(caller: CommandCaller, context: FloorContext): Promise<Facts> {
  return caller.withClient(async (db) => {
    const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { companyId: true, stationId: true } })
    if (!device) throw new NotFoundError('Tablet not found.')
    const subject = await scanSubjectFor(db, context.siteId)
    return { companyId: device.companyId, stationId: device.stationId, subject, acknowledged: subject === 'WORKER' ? await hasAcknowledgedNotice(db, context.siteId, context.actorId) : false }
  })
}

export interface SentEvent {
  readonly clientEventId: string
  readonly seq: number
  readonly kind: string
  readonly occurredAt?: string | undefined
  readonly workerId?: string | undefined
  readonly payload: Record<string, unknown>
}

export interface SyncBody {
  readonly sentAt?: string | undefined
  readonly events: readonly SentEvent[]
  readonly blocks?: readonly { readonly kind: ScanIdKind; readonly remaining?: number | undefined }[] | undefined
}

type Answer = {
  readonly clientEventId: string
  readonly seq: number
  readonly kind: string
  readonly status: 'accepted' | 'duplicate' | 'refused' | 'waiting'
  readonly serverTime: string | null
  readonly result: { readonly type: string; readonly id: string } | null
  readonly refusal: { readonly id: string | null; readonly code: string; readonly message: string; readonly fix: string; readonly final: boolean } | null
}

const recorded = (event: SentEvent, row: LedgerRow, status: 'accepted' | 'duplicate'): Answer => ({
  clientEventId: event.clientEventId,
  seq: event.seq,
  kind: event.kind,
  status,
  serverTime: row.serverTime,
  result: { type: row.resultType, id: row.resultId },
  refusal: null,
})

export async function syncQueue(caller: CommandCaller, body: SyncBody, idempotencyKey: string | undefined) {
  const context = floorOf(caller)
  const ordered = inDeviceOrder(body.events)
  if (!ordered.ok) throw new ValidationError(`One send names each event once: ${ordered.problem}`, [{ path: 'body/events', message: ordered.problem }])
  const now = serverClock.now()
  const sentAt = body.sentAt ? parseInstant(body.sentAt) : null
  const clock = sentAt ? { deviceSentAt: toUtcIso(sentAt), ...clockCheck(sentAt, now) } : null
  const facts = ordered.events.length > 0 ? await factsOf(caller, context) : null
  const known = await caller.withClient((db) => readLedger(db, context.deviceId, ordered.events.map((event) => event.clientEventId)))

  const answers: Answer[] = []
  for (const event of ordered.events) answers.push(await one(caller, context, facts!, known, event, clock?.skewSeconds ?? null, body.sentAt))

  let blocks: Awaited<ReturnType<typeof myBlocks>> | null = null
  if (body.blocks) {
    blocks =
      body.blocks.length > 0
        ? await topUpBlocks(caller, body.blocks, `${idempotencyKey ?? `fs.t.${context.deviceId}.${newId()}`}.blocks`.slice(0, 128)).then(({ scanTag, blocks: open }) => ({ scanTag, blocks: open }))
        : await myBlocks(caller)
  }
  return { serverTime: toUtcIso(serverClock.now()), clock, events: answers, blocks }
}

async function one(caller: CommandCaller, context: FloorContext, facts: Facts, known: ReadonlyMap<string, LedgerRow>, event: SentEvent, skew: number | null, sentAt: string | undefined): Promise<Answer> {
  const before = known.get(event.clientEventId)
  if (before) return before.kind === event.kind ? recorded(event, before, 'duplicate') : refusedAnswer(event, await keep(caller, context, facts, event, clientIdReusedRefusal(), null))
  if (!isFloorSyncKind(event.kind)) return refusedAnswer(event, await keep(caller, context, facts, event, unknownKindRefusal(event.kind), null))
  // Never recorded under another person's name: it waits until they sign in on this tablet.
  if (facts.subject === 'WORKER' && event.workerId !== undefined && event.workerId !== context.actorId) {
    const waiting = otherWorkerRefusal()
    return { clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: 'waiting', serverTime: null, result: null, refusal: { id: null, ...waiting } }
  }
  if (!can(actorOf(context), QUEUED_ACTIONS[event.kind].permission, { companyId: facts.companyId, siteId: context.siteId })) {
    return refusedAnswer(event, await keep(caller, context, facts, event, notAllowedRefusal(), null))
  }
  const queued: QueuedEvent = { clientEventId: event.clientEventId, kind: event.kind, occurredAt: event.occurredAt, workerId: event.workerId, payload: event.payload }
  const applied: Applied = await applyQueued(caller, queued, { key: `${context.deviceId}.${event.clientEventId}`, sentAt })
  if (applied.status === 'refused') return refusedAnswer(event, await keep(caller, context, facts, event, applied.refusal, applied.moduleRefusal))
  const row = await recordEvent(caller, {
    companyId: facts.companyId,
    siteId: context.siteId,
    deviceId: context.deviceId,
    clientEventId: event.clientEventId,
    kind: event.kind,
    deviceSeq: event.seq,
    deviceTime: event.occurredAt ? at(parseInstant(event.occurredAt)) : null,
    clockSkewSeconds: skew,
    outcome: applied.status === 'accepted' ? 'ACCEPTED' : 'DUPLICATE',
    resultType: applied.result.type,
    resultId: applied.result.id,
  })
  return recorded(event, row, applied.status)
}

function refusedAnswer(event: SentEvent, kept: RefusedRow): Answer {
  return { clientEventId: event.clientEventId, seq: event.seq, kind: event.kind, status: 'refused', serverTime: null, result: null, refusal: { id: kept.id, code: kept.code, message: kept.message, fix: kept.fix, final: kept.final } }
}

function keep(caller: CommandCaller, context: FloorContext, facts: Facts, event: SentEvent, refusal: SyncRefusal, moduleRefusal: { readonly type: string; readonly id: string } | null): Promise<RefusedRow> {
  return recordRefused(caller, {
    companyId: facts.companyId,
    siteId: context.siteId,
    deviceId: context.deviceId,
    clientEventId: event.clientEventId,
    kind: event.kind.slice(0, 80),
    deviceSeq: event.seq,
    code: refusal.code,
    message: refusal.message,
    fix: refusal.fix,
    final: refusal.final,
    summary: isFloorSyncKind(event.kind) ? summaryOf(event.kind, event.payload) : {},
    payload: event.payload,
    moduleRefusal,
    // No floor record names a worker before they acknowledged the notice in force (Statuto art. 4 c.3), a refusal neither.
    workerId: facts.subject === 'WORKER' && facts.acknowledged ? context.actorId : null,
    stationId: facts.stationId,
    deviceTime: event.occurredAt ? at(parseInstant(event.occurredAt)) : null,
  })
}

// ---- the tablet's refused actions ----------------------------------------------------------------------------------------------

export function refusedView(row: RefusedRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    deviceId: row.deviceId,
    clientEventId: row.clientEventId,
    kind: row.kind,
    deviceSeq: row.deviceSeq,
    code: row.code,
    message: row.message,
    fix: row.fix,
    final: row.final,
    summary: row.summary,
    stationId: row.stationId,
    deviceTime: row.deviceTime,
    serverTime: row.serverTime,
    status: row.status,
    resolvedAt: row.resolvedAt,
    discardedAt: row.discardedAt,
    discardedBy: row.discardedBy,
    discardReason: row.discardReason,
    version: row.version,
  }
}

/** GET /floor/sync: the person's open refused actions on this tablet, others' counted, and the tablet's last recorded event. */
export async function mine(caller: CommandCaller) {
  const context = floorOf(caller)
  return caller.withClient(async (db) => {
    const subject = await scanSubjectFor(db, context.siteId)
    const open = await readRefused(db, { deviceId: context.deviceId, status: 'OPEN', limit: 500 })
    const own = open.filter((row) => isOwnRefusal(row, { workerId: context.actorId, subject }))
    return { serverTime: toUtcIso(serverClock.now()), lastRecordedAt: await lastRecordedAt(db, context.deviceId), subject, refused: own.map(refusedView), othersRefused: open.length - own.length }
  })
}

/** Who discards on the floor: the worker where the site names workers and they acknowledged the notice, else nobody. */
async function floorDiscarder(caller: CommandCaller, context: FloorContext, siteId: string): Promise<string | null> {
  return caller.withClient(async (db) => ((await scanSubjectFor(db, siteId)) === 'WORKER' && (await hasAcknowledgedNotice(db, siteId, context.actorId)) ? context.actorId : null))
}

/**
 * Discards a refused action; the module's own record of it (a scan's FloorScanRefusal) with it, in the module's command
 * (it discards this one too). Once: a closed one answers as it is.
 */
export async function discardWithModule(caller: CommandCaller, row: RefusedRow, discard: Discard, idempotencyKey: string | undefined): Promise<RefusedRow> {
  if (row.status !== 'OPEN') return row
  if (row.moduleRefusal?.type === 'FloorScanRefusal') {
    const kept = await caller.withClient((db) => readScanRefusal(db, row.moduleRefusal!.id))
    if (kept && !kept.discardedAt) await discardScanRefusal(caller, kept, { discardedById: discard.discardedById, reason: discard.reason, idempotencyKey: idempotencyKey ? `${idempotencyKey}.m` : `d.${kept.id}` })
    const after = await caller.withClient((db) => readRefusedOne(db, row.id))
    if (after && after.status !== 'OPEN') return after
  }
  return discardRefused(caller, row, discard, idempotencyKey)
}

/** POST /floor/sync/refused/:id/discard: the person's own refused action on this tablet ("Discard": it will not be recorded). */
export async function discardMine(caller: CommandCaller, refusedId: string, idempotencyKey: string | undefined) {
  const context = floorOf(caller)
  const row = await caller.withClient((db) => readRefusedOne(db, refusedId))
  const subject = row ? await caller.withClient((db) => scanSubjectFor(db, row.siteId)) : null
  // Another tablet's, or another person's on this tablet: not found (never shown).
  if (!row || row.deviceId !== context.deviceId || !isOwnRefusal(row, { workerId: context.actorId, subject: subject! })) throw new NotFoundError('Refused action not found.')
  const by = await floorDiscarder(caller, context, row.siteId)
  const kept = await discardWithModule(caller, row, { discardedById: by, discardedBy: 'FLOOR', reason: FLOOR_DISCARD_REASON }, idempotencyKey ?? `fs.d.${row.id}`)
  return { refused: refusedView(kept) }
}
