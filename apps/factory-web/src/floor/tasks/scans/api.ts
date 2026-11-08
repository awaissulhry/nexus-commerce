import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import type { OperationCheck, OperationSteps } from './checks'
import type { FirstPieceFlag } from './first-piece'
import { EXTRA_REASON_CODES, type ExtraChoices, type ExtraPay } from './extra'
import type { OffStandardBlock, OffStandardFloor, OffStandardTile } from './indirect'
import type { BundleCard, CorrectionTarget } from './model'
import { TIMING_KINDS, type OpenItem, type Timing } from './timing'

/**
 * SCR-090's reads (apps/factory-api modules/production/scans, floor + production.scan): the bundle card of a scanned
 * ticket, and the person's own reports today (for "Ask a correction"). Its reports are queued (factory-domain floor-sync
 * `production.scan.report | undo | ask`, through the tablet's queue: they work offline). B-W2b-69 adds what the API of
 * B-W2b-29, -40, -46 and -47 answers at the operation: the bundle's clock, the checks, the steps, a scanned lot, the person's
 * open work, the no-bundle tiles; and the writes that answer at once while online (a timing action, a tile, a stack) and the
 * two that only exist online (a team leader's override, a picture going up).
 */

const kind = z.enum(['REPORT', 'UNDO', 'CORRECTION'])
const operationRef = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() })
// B-W2b-10 (MES-125): the office's icon, colour, other languages and "needs detail" of each tile (optional: an older API).
const reason = z.object({
  kind: z.enum(['SCRAP', 'REWORK']),
  code: z.string(),
  label: z.object({ it: z.string(), en: z.string() }),
  sortOrder: z.number(),
  icon: z.string().nullable().optional(),
  colour: z.string().nullable().optional(),
  labelI18n: z.record(z.string(), z.string()).optional(),
  needsDetail: z.boolean().optional(),
})

// B-W2b-105 (QHS-039): the work order's first piece at the bundle's operations (B-W2b-99; optional: an older API).
export const firstPieceSchema = z.object({
  heldOperationIds: z.array(z.string()),
  firstBundle: z.boolean(),
  check: z.object({ id: z.string(), status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']), outcome: z.string().nullable(), workOrderOperationId: z.string().nullable() }).nullable(),
  message: z.string().nullable(),
  fix: z.string().nullable(),
}) satisfies z.ZodType<FirstPieceFlag>

export const cardSchema = z.object({
  scanned: z.string(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  bundle: z.object({
    id: z.string(),
    code: z.string(),
    status: z.enum(['ACTIVE', 'VOID']),
    quantity: z.number(),
    part: z.string().nullable(),
    workOrderSizeId: z.string(),
    colourwayCode: z.string(),
    colourwayName: z.string(),
    size: z.string(),
  }),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), rush: z.boolean().optional(), siteId: z.string(), style: z.object({ code: z.string(), name: z.string() }) }),
  station: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  operations: z.array(
    operationRef.extend({
      scanRequired: z.boolean(),
      unplanned: z.boolean().optional(),
      workCentreKind: z.string(),
      final: z.boolean(),
      sewn: z.boolean(),
      state: z.enum(['DONE', 'OPEN', 'NOT_REACHED']),
      expected: z.number().nullable(),
      report: z
        .object({
          scanId: z.string(),
          kind,
          goodQuantity: z.number(),
          scrapQuantity: z.number(),
          reworkQuantity: z.number(),
          serverTime: z.string(),
          station: z.object({ id: z.string(), code: z.string() }).nullable(),
          own: z.boolean(),
        })
        .nullable(),
    }),
  ),
  next: z.string().nullable(),
  choose: z.array(z.string()),
  hint: z.object({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
  reasons: z.array(reason),
  firstPiece: firstPieceSchema.nullable().optional(),
}) satisfies z.ZodType<BundleCard>

/** The bundle card of a scanned ticket (404: not a bundle of this site; 400: another kind of label or a typo). */
export function fetchCard(api: ApiClient, code: string): Promise<TaskOutcome<BundleCard>> {
  return floorRead(api, '/production/scans/card', { query: { code }, schema: cardSchema })
}

/** B-W2b-105: the bundle's first-piece flag read again (a live hint: a first piece decided or cancelled elsewhere). production.scan. */
export async function fetchFirstPiece(api: ApiClient, bundleId: string): Promise<TaskOutcome<FirstPieceFlag | null>> {
  const answer = await floorRead(api, '/quality/inprocess/first-piece', { query: { bundleId }, schema: z.object({ firstPiece: firstPieceSchema.nullable() }) })
  return answer.ok ? { ok: true, value: answer.value.firstPiece } : answer
}

const defect = z.object({ kind: z.enum(['SCRAP', 'REWORK']), reason: z.string(), quantity: z.number() })
const mineSchema = z.object({
  since: z.string(),
  undo: z.object({ scanId: z.string(), bundleCode: z.string(), until: z.string() }).nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      kind,
      bundleCode: z.string(),
      operation: operationRef,
      goodQuantity: z.number(),
      scrapQuantity: z.number(),
      reworkQuantity: z.number(),
      defects: z.array(defect),
      clientScanId: z.string(),
      serverTime: z.string(),
      standing: z.boolean(),
      correctionPending: z.boolean(),
    }),
  ),
})

export interface MineReports {
  /** Today's own reports that stand, newest first (UNDO rows never come). */
  readonly targets: readonly CorrectionTarget[]
}

const perReason = (defects: readonly z.infer<typeof defect>[], kind: 'SCRAP' | 'REWORK') => {
  const out: Record<string, number> = {}
  for (const line of defects) if (line.kind === kind) out[line.reason] = (out[line.reason] ?? 0) + line.quantity
  return out
}

/** The person's own reports today, as correction targets (a report a later one voids is left out). */
export async function fetchMine(api: ApiClient): Promise<TaskOutcome<MineReports>> {
  const answer = await floorRead(api, '/production/scans/mine', { schema: mineSchema })
  if (!answer.ok) return answer
  const targets = answer.value.reports
    .filter((row) => row.standing && row.kind !== 'UNDO')
    .map(
      (row): CorrectionTarget => ({
        key: row.id,
        scanId: row.id,
        clientScanId: row.clientScanId,
        bundleCode: row.bundleCode,
        operation: { seq: row.operation.seq, code: row.operation.code, name: row.operation.name },
        good: row.goodQuantity,
        scrap: perReason(row.defects, 'SCRAP'),
        rework: perReason(row.defects, 'REWORK'),
        at: row.serverTime,
        pending: row.correctionPending,
      }),
    )
  return { ok: true, value: { targets } }
}

const reasonsSchema = z.object({ reasons: z.array(reason) })

/** The scrap and rework reasons (the same list the card carries), for a correction opened without a card. */
export async function fetchReasons(api: ApiClient): Promise<TaskOutcome<readonly z.infer<typeof reason>[]>> {
  const answer = await floorRead(api, '/production/scans/reasons', { schema: reasonsSchema })
  return answer.ok ? { ok: true, value: answer.value.reasons } : answer
}

// ---- the bundle at the operation (B-W2b-40, -46, -47) ----------------------------------------------------------------------------

const timingSchema = z.object({
  state: z.enum(['NOT_STARTED', 'RUNNING', 'PAUSED', 'REPORTED']),
  mine: z.boolean(),
  startedAt: z.string().nullable(),
  runningSince: z.string().nullable(),
  secondsBefore: z.number(),
  pausedAt: z.string().nullable(),
  pauseReasonCode: z.string().nullable(),
  pausedAtClockOut: z.boolean(),
  piecesSoFar: z.number(),
  people: z.number(),
  actions: z.array(z.enum(TIMING_KINDS)),
}) satisfies z.ZodType<Timing>

/** The bundle's clock at the operation (never a pace or a target), with the server's time for the skew. */
export async function fetchTiming(api: ApiClient, code: string, operationId: string): Promise<TaskOutcome<{ readonly timing: Timing; readonly serverTime: string }>> {
  return floorRead(api, '/production/terminal/state', { query: { code, workOrderOperationId: operationId }, schema: z.object({ timing: timingSchema, serverTime: z.string() }) })
}

const askedSchema = z.object({ itemId: z.string(), code: z.string(), name: z.string() })
const checkSchema = z.object({
  modes: z.object({ quantityGuard: z.enum(['FREE', 'WARN', 'STRICT']), skippedOperationRule: z.enum(['FREE', 'WARN', 'STRICT']) }),
  expected: z.number().nullable(),
  beyondBundle: z.boolean(),
  findings: z.array(z.object({ kind: z.enum(['QUANTITY', 'SKIPPED_OPERATION', 'WRONG_BUNDLE']), mode: z.enum(['WARN', 'STRICT']), code: z.string(), message: z.string(), fix: z.string(), overridable: z.boolean() })),
  components: z.object({ asked: z.array(askedSchema), traceable: z.array(askedSchema.extend({ asked: z.boolean() })) }),
  overrideReasons: z.array(z.object({ code: z.string(), label: z.object({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
}) satisfies z.ZodType<OperationCheck>

/** The checks of a bundle at an operation; with `counts`, for the counts on the pads (default: all good of what reached it). */
export function fetchCheck(api: ApiClient, code: string, operationId: string, counts?: { readonly good: number; readonly scrap: number; readonly rework: number }): Promise<TaskOutcome<OperationCheck>> {
  return floorRead(api, '/production/guards/check', { query: { code, workOrderOperationId: operationId, ...counts }, schema: checkSchema })
}

const stepsSchema = z.object({
  steps: z.array(z.object({ code: z.string(), words: z.string(), required: z.boolean(), tick: z.object({ outcome: z.enum(['DONE', 'NOT_APPLICABLE']), at: z.string(), mine: z.boolean(), by: z.string().nullable() }).nullable() })),
  open: z.number(),
}) satisfies z.ZodType<OperationSteps>

export function fetchSteps(api: ApiClient, code: string, operationId: string): Promise<TaskOutcome<OperationSteps>> {
  return floorRead(api, '/production/checklists/state', { query: { code, workOrderOperationId: operationId }, schema: stepsSchema })
}

export interface LotAnswer {
  readonly lot: { readonly code: string; readonly itemId: string; readonly itemCode: string } | null
  readonly refusal: { readonly code: string; readonly message: string; readonly fix: string } | null
}

/** A scanned lot before the report: the row ticks, or a wrong item is refused in the report's words. */
export function checkLot(api: ApiClient, query: { readonly code: string; readonly bundle: string; readonly workOrderOperationId: string }): Promise<TaskOutcome<LotAnswer>> {
  return floorRead(api, '/production/guards/lot', { query, schema: z.object({ lot: z.object({ code: z.string(), itemId: z.string(), itemCode: z.string() }).nullable(), refusal: z.object({ code: z.string(), message: z.string(), fix: z.string() }).nullable() }) })
}

const openSchema = z.object({
  items: z.array(
    z.object({
      bundleId: z.string(),
      bundleCode: z.string(),
      operation: operationRef,
      state: z.enum(['NOT_STARTED', 'RUNNING', 'PAUSED', 'REPORTED']),
      pausedAt: z.string().nullable(),
      runningSince: z.string().nullable(),
      pausedAtClockOut: z.boolean(),
    }),
  ),
  serverTime: z.string(),
})

/** The person's open work: running first, then paused (Home's "Unfinished on this tablet", the scan step's Continue). */
export async function fetchOpenWork(api: ApiClient): Promise<TaskOutcome<readonly OpenItem[]>> {
  const answer = await floorRead(api, '/production/terminal/open', { schema: openSchema })
  return answer.ok ? { ok: true, value: answer.value.items } : answer
}

/** The tablet's crew: the people a team operation names (MES-094). Empty: one operator. */
export async function fetchCrew(api: ApiClient): Promise<TaskOutcome<readonly string[]>> {
  const answer = await floorRead(api, '/floor/crew', { schema: z.object({ crew: z.object({ members: z.array(z.object({ workerId: z.string() })) }).nullable() }) })
  return answer.ok ? { ok: true, value: answer.value.crew?.members.map((member) => member.workerId) ?? [] } : answer
}

/** Whether these bundles may be joined into garments (MES-078, shades). Needs production.bundles. */
export async function fetchSetCheck(api: ApiClient, bundleIds: readonly string[]): Promise<TaskOutcome<{ readonly ok: boolean }>> {
  return floorRead(api, '/production/bundles/sets/check', { query: { bundleIds: bundleIds.join(',') }, schema: z.object({ ok: z.boolean() }) })
}

// ---- timing: one tap, answered at once while online ------------------------------------------------------------------------------

const timingAnswer = z.object({
  scan: z.object({ serverTime: z.string() }),
  timing: timingSchema,
  qualification: z.object({ mode: z.literal('WARN'), message: z.string(), fix: z.string() }).nullable(),
})
export type TimingAnswer = z.infer<typeof timingAnswer>

const TIMING_ROUTES = { start: 'start', pause: 'pause', resume: 'resume', handBack: 'hand-back', partial: 'partial' } as const
export type TimingRoute = keyof typeof TIMING_ROUTES

/** A timing action online; its client id is the Idempotency-Key. Refused in words; `offline`: the screen queues the same action. */
export function postTiming(api: ApiClient, route: TimingRoute, clientScanId: string, body: Readonly<Record<string, unknown>>): Promise<TaskOutcome<TimingAnswer>> {
  return floorWrite(api, 'POST', `/production/terminal/${TIMING_ROUTES[route]}`, { body: { ...body, clientScanId }, schema: timingAnswer, idempotencyKey: clientScanId })
}

/** The action, online first: a network failure keeps it on the tablet under the id the try used, so a lost answer never comes back ALREADY_RUNNING. */
export const timingOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, route: TimingRoute, body: Readonly<Record<string, unknown>>) =>
  onlineFirst(queue, { online, kind: `production.scan.${route}`, payload: body, attempt: (clientScanId) => postTiming(api, route, clientScanId, body) })

// ---- the team leader's override: only online, the server checks the PIN ------------------------------------------------------------

export type OverrideLead = { readonly badgeCode: string } | { readonly workerId: string }

interface OverrideSign {
  readonly lead: OverrideLead
  readonly pin: string
  readonly reasonCode: string
  readonly note?: string
}

const overridden = z.object({ scan: z.object({ id: z.string(), serverTime: z.string() }) })

/** The held report, as it would have been sent, with the team leader's PIN and reason (the PIN goes in the body and nowhere else). */
export function overrideReport(api: ApiClient, clientScanId: string, report: Readonly<Record<string, unknown>>, sign: OverrideSign): Promise<TaskOutcome<z.infer<typeof overridden>>> {
  return floorWrite(api, 'POST', '/production/guards/override', {
    body: { report: { ...report, clientScanId }, lead: { ...sign.lead, pin: sign.pin }, reasonCode: sign.reasonCode, ...(sign.note ? { note: sign.note } : {}) },
    schema: overridden,
    idempotencyKey: clientScanId,
  })
}

/** The held Start (a skill the person lacks), with the team leader's PIN and reason. */
export function overrideStart(api: ApiClient, clientScanId: string, start: Readonly<Record<string, unknown>>, sign: OverrideSign): Promise<TaskOutcome<TimingAnswer>> {
  return floorWrite(api, 'POST', '/production/terminal/start/override', {
    body: { start: { ...start, clientScanId }, lead: { ...sign.lead, pin: sign.pin }, reasonCode: sign.reasonCode, ...(sign.note ? { note: sign.note } : {}) },
    schema: timingAnswer,
    idempotencyKey: clientScanId,
  })
}

// ---- several bundles at once -------------------------------------------------------------------------------------------------------

const severalAnswer = z.object({
  items: z.array(z.object({ clientScanId: z.string(), status: z.enum(['accepted', 'duplicate', 'refused']), refusal: z.object({ code: z.string(), message: z.string(), fix: z.string(), final: z.boolean() }).nullable() })),
  finished: z.number(),
  refused: z.number(),
  good: z.number(),
  scrap: z.number(),
  rework: z.number(),
})
export type SeveralAnswer = z.infer<typeof severalAnswer>

/** One tap over the stack: each bundle its own report; a refused one stays with its words. Online only: offline each bundle queues. */
export function finishSeveral(api: ApiClient, items: readonly Record<string, unknown>[]): Promise<TaskOutcome<SeveralAnswer>> {
  return floorWrite(api, 'POST', '/production/several-bundles/finish', { body: { items }, schema: severalAnswer })
}

// ---- no bundle: what are you doing? ------------------------------------------------------------------------------------------------

const tileSchema = z.object({
  id: z.string(),
  code: z.string(),
  kind: z.enum(['OFF_STANDARD', 'INDIRECT']),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
}) satisfies z.ZodType<OffStandardTile>
const blockSchema = z.object({ id: z.string(), code: tileSchema, startedAt: z.string() }) satisfies z.ZodType<OffStandardBlock>

export async function fetchOffStandard(api: ApiClient): Promise<TaskOutcome<OffStandardFloor>> {
  const answer = await floorRead(api, '/production/offstandard/floor', { schema: z.object({ running: blockSchema.nullable(), codes: z.array(tileSchema) }) })
  return answer.ok ? { ok: true, value: { running: answer.value.running, codes: answer.value.codes } } : answer
}

export async function startOffStandard(api: ApiClient, clientEventId: string, codeId: string): Promise<TaskOutcome<OffStandardBlock>> {
  const answer = await floorWrite(api, 'POST', '/production/offstandard/floor/start', { body: { clientEventId, codeId }, schema: z.object({ block: blockSchema }), idempotencyKey: clientEventId })
  return answer.ok ? { ok: true, value: answer.value.block } : answer
}

export async function endOffStandard(api: ApiClient, clientEventId: string): Promise<TaskOutcome<null>> {
  const answer = await floorWrite(api, 'POST', '/production/offstandard/floor/end', { body: { clientEventId }, schema: z.object({ block: z.object({ id: z.string() }) }), idempotencyKey: clientEventId })
  return answer.ok ? { ok: true, value: null } : answer
}

/** A tile, online first (a network failure keeps it under the id the try used). */
export const offStandardStartOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, codeId: string) =>
  onlineFirst(queue, { online, kind: 'production.offStandard.start', payload: { codeId }, attempt: (clientEventId) => startOffStandard(api, clientEventId, codeId) })

/** Done on the running block, online first (a network failure keeps it under the id the try used). */
export const offStandardEndOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean) =>
  onlineFirst(queue, { online, kind: 'production.offStandard.end', payload: {}, attempt: (clientEventId) => endOffStandard(api, clientEventId) })

// ---- a picture or a clip for a note ------------------------------------------------------------------------------------------------

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/**
 * A photo or clip onto the work order (`POST /production/floor-notes/work-orders/:id/files`): announced with its size and SHA-256,
 * its bytes PUT straight to the store, then confirmed; the note then names it. Each step's failure stops it.
 */
export async function uploadNoteFile(api: ApiClient, workOrderId: string, file: Blob, name: string, durationSeconds?: number): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const base = `/production/floor-notes/work-orders/${seg(workOrderId)}/files`
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const contentType = (file.type || 'image/jpeg').split(';')[0]!.trim()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType, sizeBytes: bytes.byteLength, sha256, ...(durationSeconds !== undefined ? { durationSeconds } : {}) }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}

// ---- an unplanned operation (B-W2b-82; MES-086): online only, the choice is the office's list -----------------------------------

const extraPays = z.enum(['PIECE_RATE', 'OFF_STANDARD', 'NO_PIECE_PAY'])
const extraChoices = z.object({
  operations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), workCentreKind: z.string(), standardMinutes: z.string(), pays: extraPays })),
  reasons: z.array(z.object({ code: z.enum(EXTRA_REASON_CODES), label: z.object({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
})

export function fetchExtraChoices(api: ApiClient, workOrderId: string): Promise<TaskOutcome<ExtraChoices>> {
  return floorRead(api, `/production/extra-operations/work-orders/${seg(workOrderId)}/choices`, { schema: extraChoices })
}

const extraAdded = z.object({ workOrderOperationId: z.string().nullable(), seq: z.number().nullable(), operation: z.object({ code: z.string(), name: z.string() }), pays: extraPays })

export function addExtra(api: ApiClient, workOrderId: string, body: Readonly<Record<string, unknown>>, key: string): Promise<TaskOutcome<{ readonly workOrderOperationId: string | null; readonly seq: number | null; readonly operation: { readonly code: string; readonly name: string }; readonly pays: ExtraPay }>> {
  return floorWrite(api, 'POST', `/production/extra-operations/work-orders/${seg(workOrderId)}`, { body, schema: extraAdded, idempotencyKey: key })
}
