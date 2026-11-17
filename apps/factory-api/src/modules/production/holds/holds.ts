import type { WorkOrderStatus as DbWorkOrderStatus } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_HOLD_LIST, type WorkOrderHoldKind } from '@nexus/factory-domain/production/holds/kinds'
// B-PR-27a: the words of a customer's pause.
import { CUSTOMER_PAUSE_REASON, plainHoldWordsOf } from '@nexus/factory-domain/production-brand/accept'
import { afterHoldEnds, customerWordsOf, liftProblems, placeProblems, productionHoldMove, unholdableWords, wordsOrNull } from '@nexus/factory-domain/production/holds/rules'
import { WORKORDERS_HOLD, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { reasonFor, reasonWords } from '../../../platform/reasons/service'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { waitForHolds } from '../../quality/holds/checks'
import { mayOn, officeContextOf } from '../work-orders/access'
import { bumpVersion } from '../work-orders/moves'
import { readWorkOrder, type Header, type Reader } from '../work-orders/store'
import { officeWorkOrder } from '../work-orders/work-orders'
import { lockWorkOrderRow, plainHoldReason, standingHoldsOf } from './standing'

/**
 * B-PR-21 — the plain production hold (production plan §5 "holds (one dialog)", 08-backend §4.5; R-22: ONE "Put on hold" dialog,
 * the reason picked decides the kind: a HOLD reason places today's quality hold through /quality/holds, a PRODUCTION_HOLD reason a
 * WorkOrderHold of kind PRODUCTION here; the list's Hold N opens the same dialog and, with a production reason, places one hold per
 * work order in ONE command). Office only; each work order is found through the brand wall (B-PR-03: another customer's work
 * order is "Work order not found.", as an unknown one), then workorders.hold over it (else forbidden).
 *
 *   place   a reason of the PRODUCTION_HOLD list (its note when the reason asks one), the office's note, the words the customer
 *           reads. Lock order per work order, in id order: its issue lock (an issue in flight finishes first), its gate lock
 *           ('factory.work-order-gate': scans, cuts, bundles in flight finish first), its row (FOR UPDATE, then the version
 *           read when sent); then DRAFT / RELEASED / IN_PROGRESS go ON_HOLD (held from its status; the reason's words, which
 *           the floor reads, never the note; the hold as its record), one ON_HOLD already stays held under the record it has;
 *           COMPLETED, CLOSED, CANCELLED are refused in words. The WorkOrderHold row after the work order (its guard reads the
 *           work order FOR SHARE: ours already).
 *   lift    why (one line). The work order's row first, then the quality holds being placed on it finish (their hold locks,
 *           SHARED), then the hold row: ACTIVE at the version read → LIFTED; the work order leaves ON_HOLD only when no hold names
 *           it any more — no ACTIVE quality hold of it, no other ACTIVE WorkOrderHold — else it stays held under the oldest one
 *           still standing (production/holds/rules `afterHoldEnds`, the rule quality's release and close use too). A customer's
 *           pause (BRAND) is lifted here as well: "Lift the hold" is the factory's own act (08-backend §4.6).
 *   read    the work order's plain holds, standing first, with the office's note (office only) and what the customer reads.
 *
 * `placeWorkOrderHoldsInCommand` and `liftWorkOrderHoldInCommand` run inside another command too (B-PR-27a: accepting a
 * customer's HOLD places a BRAND hold on each open work order of the order; RESUME lifts them). Events:
 * work_order_hold.placed / .lifted (ids, number, kind only), workorder.status_changed for each work order held or lifted; one
 * audit row per hold on its work order (the record's history).
 */

const sortedIds = (ids: readonly string[]): string[] => [...new Set(ids)].sort()

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a hold command needs a tenant context')
  return context.tenantId
}

// ---- reading -----------------------------------------------------------------------------------------------------------

const HOLD_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  partyId: true,
  kind: true,
  reasonCode: true,
  note: true,
  brandWords: true,
  requestId: true,
  status: true,
  placedAt: true,
  placedById: true,
  liftedAt: true,
  liftedById: true,
  liftReason: true,
  version: true,
} as const

interface HoldRow {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly partyId: string | null
  readonly kind: WorkOrderHoldKind
  readonly reasonCode: string
  readonly note: string | null
  readonly brandWords: string | null
  readonly requestId: string | null
  readonly status: 'ACTIVE' | 'LIFTED'
  readonly placedAt: Date
  readonly placedById: string
  readonly liftedAt: Date | null
  readonly liftedById: string | null
  readonly liftReason: string | null
  readonly version: number
}

/** The answers' views of holds: the reason in words, the people by name (office users). */
async function holdViews(db: Reader, rows: readonly HoldRow[]) {
  if (rows.length === 0) return []
  const words = await reasonWords(db as CommandTx, PRODUCTION_HOLD_LIST)
  const people = sortedIds(rows.flatMap((row) => [row.placedById, ...(row.liftedById ? [row.liftedById] : [])]))
  const names = new Map((await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const personOf = (id: string | null) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
  return rows.map((row) => {
    // B-PR-27a: a customer's pause in its own words.
    const reason = plainHoldWordsOf(row, words.get(row.reasonCode)?.labelEn)
    return {
      id: row.id,
      workOrderId: row.workOrderId,
      kind: row.kind,
      status: row.status,
      reasonCode: row.reasonCode,
      reason,
      note: row.note,
      brandWords: row.brandWords,
      customerReads: customerWordsOf(row, reason),
      requestId: row.requestId,
      placedAt: toUtcIso(row.placedAt),
      placedBy: personOf(row.placedById),
      liftedAt: row.liftedAt ? toUtcIso(row.liftedAt) : null,
      liftedBy: personOf(row.liftedById),
      liftReason: row.liftReason,
      version: row.version,
    }
  })
}

/** The work order as a hold left it. */
async function heldWorkOrderOf(db: Reader, workOrderId: string) {
  const row = (await readWorkOrder(db, workOrderId))!
  return {
    id: row.id,
    number: row.number,
    status: row.status as WorkOrderStatus,
    version: row.version,
    hold:
      row.status === 'ON_HOLD'
        ? { reason: row.holdReason, at: row.heldAt ? toUtcIso(row.heldAt) : null, fromStatus: (row.heldFromStatus as WorkOrderStatus | null) ?? null, recordType: row.holdRecordType, recordId: row.holdRecordId }
        : null,
  }
}

/** GET /production/work-orders/:workOrderId/holds (workorders.view). */
export async function listWorkOrderHolds(caller: CommandCaller, workOrderId: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (client) => {
    const rows = (await client.workOrderHold.findMany({ where: { workOrderId: workOrder.id }, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }] })) as HoldRow[]
    const ordered = [...rows.filter((row) => row.status === 'ACTIVE'), ...rows.filter((row) => row.status !== 'ACTIVE')]
    const qualityHoldsActive = await client.qualityHold.count({ where: { status: 'ACTIVE', subjectType: 'WorkOrder', subjectIds: { has: workOrder.id } } })
    return { workOrder: await heldWorkOrderOf(client, workOrder.id), holds: await holdViews(client, ordered), qualityHoldsActive }
  })
}

// ---- place -------------------------------------------------------------------------------------------------------------

export interface PlaceWorkOrderHolds {
  readonly workOrderIds: readonly string[]
  readonly kind: WorkOrderHoldKind
  readonly reasonCode: string
  readonly note?: string | null | undefined
  readonly brandWords?: string | null | undefined
  /** BRAND: the customer's HOLD ask (B-PR-27a). PRODUCTION: none. */
  readonly requestId?: string | null | undefined
  /** One work order: its version read (else not checked). */
  readonly version?: number | undefined
}

export interface PlacedWorkOrderHold {
  readonly hold: HoldRow
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: WorkOrderStatus }
  /** It went ON_HOLD now (false: it was on hold already). */
  readonly held: boolean
}

/**
 * Places one plain hold on each work order INSIDE the caller's command (the routes', or B-PR-27a's accept). The caller found each
 * work order through the brand wall first; here they are read again under their locks. Refusals in words at `body/<field>`
 * (`body/workOrderIds/<n>` for one of several).
 */
export async function placeWorkOrderHoldsInCommand(tools: CommandTools, input: PlaceWorkOrderHolds): Promise<PlacedWorkOrderHold[]> {
  const { tx, context } = tools
  if (context.audience !== 'office') throw new ForbiddenError('Work orders are put on hold in the office.')
  const tenantId = tenantOf(tools)
  const problems = placeProblems(input)
  if (problems.length > 0) refuse(problems, 'The hold is not valid.')
  if ((input.kind === 'BRAND') !== Boolean(input.requestId)) throw new Error("a customer's hold answers its HOLD ask; a production hold none")
  const note = wordsOrNull(input.note)
  const brandWords = wordsOrNull(input.brandWords)
  // Why: an active code of the PRODUCTION_HOLD list (a customer's pause keeps the code its accept gives).
  let reasonWordsEn = input.reasonCode
  if (input.kind === 'PRODUCTION') {
    const reason = await reasonFor(tx, PRODUCTION_HOLD_LIST, input.reasonCode)
    if (!reason || !reason.active) refuse([{ path: 'reasonCode', message: 'Pick an active reason of the production hold list.' }], 'The reason is not an active production hold reason.')
    if (reason!.needsDetail && !note) refuse([{ path: 'note', message: `${reason!.labelEn} needs a note: say what is missing or wrong.` }], 'The reason needs a note.')
    reasonWordsEn = reason!.labelEn
  }
  // B-PR-27a: a customer's pause (its accepted HOLD ask) shows its own words, never a code (factory-domain production-brand/accept).
  if (input.kind === 'BRAND') reasonWordsEn = CUSTOMER_PAUSE_REASON.en
  const holdReason = plainHoldReason(reasonWordsEn)

  // The work orders' issue locks, then their gate locks, then their rows, each in id order; then every one is checked, then held.
  const order = sortedIds(input.workOrderIds)
  for (const id of order) await lockWorkOrderIssues(tx, tenantId, id)
  for (const id of order) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-gate', ${tenantId}::uuid, ${id}::uuid), 0))`
  const rows: Header[] = []
  for (const id of order) {
    await lockWorkOrderRow(tx, id)
    const row = await readWorkOrder(tx, id)
    if (!row) throw new NotFoundError('Work order not found.')
    rows.push(row)
  }
  const refused = rows.flatMap((row) => {
    const words = unholdableWords(row.number, row.status as WorkOrderStatus)
    return words ? [words] : []
  })
  if (refused.length > 0) throw new InvalidStateError(refused.length === 1 ? refused[0]! : `${refused.length} of these work orders take no hold now. ${refused.join(' ')}`)
  const placed = new Map<string, PlacedWorkOrderHold>()
  for (const row of rows) placed.set(row.id, await placeOne(tools, row, { ...input, note, brandWords, holdReason }))
  return input.workOrderIds.map((id) => placed.get(id)!)
}

async function placeOne(
  tools: CommandTools,
  row: Header,
  input: PlaceWorkOrderHolds & { readonly note: string | null; readonly brandWords: string | null; readonly holdReason: string },
): Promise<PlacedWorkOrderHold> {
  const { tx, now } = tools
  const actorId = (tools.context as OfficeContext).actorId
  const holdId = newId()
  const move = productionHoldMove(row.status as WorkOrderStatus)
  await bumpVersion(tx, row.id, input.workOrderIds.length === 1 ? input.version : undefined)
  // The work order FIRST (ON_HOLD with this hold as its record), then the hold's row.
  if (move === 'HOLD') {
    await tx.workOrder.update({
      where: { id: row.id },
      data: { status: 'ON_HOLD', heldFromStatus: row.status, heldAt: now, heldById: actorId, holdReason: input.holdReason, holdRecordType: 'WorkOrderHold', holdRecordId: holdId },
      select: { id: true },
    })
  }
  const hold = (await tx.workOrderHold.create({
    data: {
      id: holdId,
      companyId: row.companyId,
      siteId: row.siteId,
      workOrderId: row.id,
      partyId: row.partyId,
      kind: input.kind,
      reasonCode: input.reasonCode,
      note: input.note,
      brandWords: input.brandWords,
      requestId: input.requestId ?? null,
      status: 'ACTIVE',
      placedAt: now,
      placedById: actorId,
      createdAt: now,
      updatedAt: now,
      createdById: actorId,
    },
    select: HOLD_COLUMNS,
  })) as HoldRow
  tools.audit({
    action: 'production.placeHold',
    recordType: 'WorkOrder',
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { status: row.status },
    after: { holdId, kind: input.kind, reasonCode: input.reasonCode, note: input.note, brandWords: input.brandWords, requestId: input.requestId ?? null, status: 'ON_HOLD', ...(move === 'HOLD' ? { heldFromStatus: row.status, holdRecordType: 'WorkOrderHold', holdRecordId: holdId } : {}) },
    reason: input.holdReason,
  })
  tools.emit({
    type: 'work_order_hold.placed',
    subject: holdId,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { holdId, workOrderId: row.id, number: row.number, siteId: row.siteId, partyId: row.partyId, kind: input.kind, requestId: input.requestId ?? null },
  })
  if (move === 'HOLD') {
    tools.emit({ type: 'workorder.status_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { workOrderId: row.id, number: row.number, partyId: row.partyId, from: row.status, to: 'ON_HOLD' } })
  }
  return { hold, workOrder: { id: row.id, number: row.number, status: 'ON_HOLD' }, held: move === 'HOLD' }
}

export interface PlaceBody {
  readonly reasonCode: string
  readonly note?: string | null | undefined
  readonly brandWords?: string | null | undefined
  readonly version?: number | undefined
}

/** POST /production/work-orders/:workOrderId/holds (workorders.hold): a PRODUCTION hold on one work order. */
export async function placeWorkOrderHold(caller: CommandCaller, workOrderId: string, body: PlaceBody, idempotencyKey?: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_HOLD)
  const problems = placeProblems(body)
  if (problems.length > 0) refuse(problems, 'The hold is not valid.')
  const { result } = await command(caller, { name: 'workorders.placeHold', idempotencyKey, input: { workOrderId, ...body } }, async (tools) => {
    const [placed] = await placeWorkOrderHoldsInCommand(tools, { workOrderIds: [workOrder.id], kind: 'PRODUCTION', reasonCode: body.reasonCode, note: body.note, brandWords: body.brandWords, version: body.version })
    const [hold] = await holdViews(tools.tx, [placed!.hold])
    return { hold: hold!, workOrder: await heldWorkOrderOf(tools.tx, workOrder.id), held: placed!.held }
  })
  return result
}

export interface PlaceManyBody {
  readonly workOrderIds: readonly string[]
  readonly reasonCode: string
  readonly note?: string | null | undefined
  readonly brandWords?: string | null | undefined
}

/**
 * POST /production/work-orders/holds (workorders.hold): the list's Hold N with a production reason — one PRODUCTION hold per work
 * order, all or none. A work order the caller does not see (another customer's, another company's or site's, an unknown id) is
 * "Work order not found." at its place in the list, in the same words for each; one seen but not held by the caller's right is
 * forbidden.
 */
export async function placeWorkOrderHolds(caller: CommandCaller, body: PlaceManyBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const problems = placeProblems(body)
  const seen = new Set<string>()
  body.workOrderIds.forEach((id, index) => {
    if (seen.has(id)) problems.push({ path: `workOrderIds/${index}`, message: 'Name each work order once.' })
    seen.add(id)
  })
  if (problems.length > 0) refuse(problems, 'The hold is not valid.')
  const rows = await caller.withClient(async (client) => Promise.all(body.workOrderIds.map((id) => (isUuid(id) ? readWorkOrder(client, id) : null))))
  const missing = body.workOrderIds.flatMap((_, index) => {
    const row = rows[index]
    return row && mayOn(context, WORKORDERS_VIEW, row) ? [] : [{ path: `workOrderIds/${index}`, message: 'Work order not found.' }]
  })
  if (missing.length > 0) refuse(missing, 'Some of these work orders are not found.')
  if (rows.some((row) => !mayOn(context, WORKORDERS_HOLD, row!))) throw new ForbiddenError('You put work orders on hold only where your role reaches.')
  const { result } = await command(caller, { name: 'workorders.placeHolds', idempotencyKey, input: body }, async (tools) => {
    const placed = await placeWorkOrderHoldsInCommand(tools, { workOrderIds: body.workOrderIds, kind: 'PRODUCTION', reasonCode: body.reasonCode, note: body.note, brandWords: body.brandWords })
    return {
      holds: await holdViews(tools.tx, placed.map((entry) => entry.hold)),
      workOrders: placed.map((entry) => ({ id: entry.workOrder.id, number: entry.workOrder.number, status: entry.workOrder.status, held: entry.held })),
    }
  })
  return result
}

// ---- lift --------------------------------------------------------------------------------------------------------------

export interface LiftedWorkOrderHold {
  readonly hold: HoldRow
  /** The work order left ON_HOLD now. */
  readonly lifted: boolean
  readonly stillHeldBy: { readonly quality: number; readonly production: number }
}

/**
 * Lifts one ACTIVE plain hold INSIDE the caller's command (the route's, or B-PR-27a's RESUME): the work order's row first, then
 * the quality holds being placed on it finish, then the hold row at the version read (none: as it is now); the work order leaves
 * ON_HOLD only when no hold names it any more, else it stays held under the oldest one still standing.
 */
export async function liftWorkOrderHoldInCommand(tools: CommandTools, input: { readonly workOrderId: string; readonly holdId: string; readonly reason: string; readonly version?: number | undefined }): Promise<LiftedWorkOrderHold> {
  const { tx, now, context } = tools
  if (context.audience !== 'office') throw new ForbiddenError('Holds are lifted in the office.')
  const tenantId = tenantOf(tools)
  const problems = liftProblems(input)
  if (problems.length > 0) refuse(problems, 'Say why the hold is lifted.')
  const reason = input.reason.trim()
  await lockWorkOrderRow(tx, input.workOrderId)
  await waitForHolds(tx, tenantId, [input.workOrderId])
  const [locked] = await tx.$queryRaw<{ version: number; status: string; workOrderId: string }[]>`SELECT "version", "status"::text AS "status", "workOrderId" FROM "WorkOrderHold" WHERE "id" = ${input.holdId}::uuid FOR UPDATE`
  if (!locked || locked.workOrderId !== input.workOrderId) throw new NotFoundError('Hold not found.')
  if (locked.status !== 'ACTIVE') throw new InvalidStateError('This hold is lifted already: a lifted hold never changes.')
  if (input.version !== undefined && locked.version !== input.version) throw new StaleVersionError('WorkOrderHold', input.holdId, locked.version, input.version)
  const actorId = (context as OfficeContext).actorId
  // The hold FIRST (WorkOrder_production_holds counts the ACTIVE ones when the work order leaves ON_HOLD), then the work order.
  const hold = (await tx.workOrderHold.update({
    where: { id: input.holdId },
    data: { status: 'LIFTED', liftedAt: now, liftedById: actorId, liftReason: reason, version: { increment: 1 }, updatedAt: now },
    select: HOLD_COLUMNS,
  })) as HoldRow
  const row = (await readWorkOrder(tx, input.workOrderId))!
  const standing = await standingHoldsOf(tx, row.id)
  const next = afterHoldEnds({ workOrder: row, ended: { recordType: 'WorkOrderHold', id: hold.id }, standing })
  await bumpVersion(tx, row.id, undefined)
  if (next.action === 'REPOINT') {
    await tx.workOrder.update({ where: { id: row.id }, data: { holdRecordType: next.to.recordType, holdRecordId: next.to.id, holdReason: next.to.reason }, select: { id: true } })
  }
  if (next.action === 'LIFT') {
    const back = row.heldFromStatus as DbWorkOrderStatus
    await tx.workOrder.update({ where: { id: row.id }, data: { status: back, heldFromStatus: null, heldAt: null, heldById: null, holdReason: null, holdRecordType: null, holdRecordId: null }, select: { id: true } })
    tools.emit({ type: 'workorder.status_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { workOrderId: row.id, number: row.number, partyId: row.partyId, from: 'ON_HOLD', to: back } })
  }
  tools.audit({
    action: 'production.liftHold',
    recordType: 'WorkOrder',
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { holdId: hold.id, kind: hold.kind, status: row.status, holdRecordType: row.holdRecordType, holdRecordId: row.holdRecordId },
    after:
      next.action === 'LIFT'
        ? { status: row.heldFromStatus }
        : next.action === 'REPOINT'
          ? { status: 'ON_HOLD', holdRecordType: next.to.recordType, holdRecordId: next.to.id, holdReason: next.to.reason }
          : { status: row.status },
    reason,
  })
  tools.emit({
    type: 'work_order_hold.lifted',
    subject: hold.id,
    companyId: hold.companyId,
    siteId: hold.siteId,
    payload: { holdId: hold.id, workOrderId: row.id, number: row.number, siteId: row.siteId, partyId: hold.partyId, kind: hold.kind, requestId: hold.requestId },
  })
  const left = standing.filter((entry) => !(entry.recordType === 'WorkOrderHold' && entry.id === hold.id))
  return {
    hold,
    lifted: next.action === 'LIFT',
    stillHeldBy: { quality: left.filter((entry) => entry.recordType === 'QualityHold').length, production: left.filter((entry) => entry.recordType === 'WorkOrderHold').length },
  }
}

/** POST /production/work-orders/:workOrderId/holds/:holdId/lift (workorders.hold). */
export async function liftWorkOrderHold(caller: CommandCaller, workOrderId: string, holdId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_HOLD)
  const problems = liftProblems(body)
  if (problems.length > 0) refuse(problems, 'Say why the hold is lifted.')
  // A hold of another work order (another customer's among them) is as unknown as a made-up id.
  const known = await caller.withClient((client) => client.workOrderHold.findFirst({ where: { id: holdId, workOrderId: workOrder.id }, select: { id: true } }))
  if (!known) throw new NotFoundError('Hold not found.')
  const { result } = await command(caller, { name: 'workorders.liftHold', idempotencyKey, input: { workOrderId, holdId, ...body } }, async (tools) => {
    const lifted = await liftWorkOrderHoldInCommand(tools, { workOrderId: workOrder.id, holdId, reason: body.reason, version: body.version })
    const [hold] = await holdViews(tools.tx, [lifted.hold])
    return { hold: hold!, workOrder: await heldWorkOrderOf(tools.tx, workOrder.id), lifted: lifted.lifted, stillHeldBy: lifted.stillHeldBy }
  })
  return result
}
