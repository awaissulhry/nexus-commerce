import { createHash } from 'node:crypto'
import type { Prisma, WorkOrderStatus as DbWorkOrderStatus } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { QUALITY_HOLDS_PLACE, QUALITY_HOLDS_RELEASE, QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import {
  GARMENT_SUBJECTS,
  HOLD_LIMITS,
  placeProblems,
  placedByKind,
  releasable,
  releaseChecks,
  releaseRefusal,
  releaseStatement,
  STOCK_SUBJECTS,
  unholdableWords,
  workOrderHoldMove,
  workOrderHoldReason,
  type HoldSourceType,
  type HoldSubjectType,
  type ReleaseCheck,
} from '@nexus/factory-domain/quality/holds/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { reasonFor } from '../../../platform/reasons/service'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { identityOf, madeAny } from '../final/facts'
import { makersOf } from '../final/store'
import { activeHoldsOf } from './checks'
import { holdReasonWords, HOLD_COLUMNS, holdView, readHold, readSubjects, viewFactsOf, type HoldRow, type Reader, type Subject } from './store'

/**
 * Quality holds: place, change, release, close (B-W2a-26; QHS-074, MES-008; design quality.holds qh-place, qh-release,
 * hold-main; production.workorders wo-hold). Each write is ONE command(); the refusals come first in words, the database
 * (…_quality_plant_w2a_guards, …_production_w2a_guards) holds the same rules for every login.
 *
 *   place    (quality.holds.place over the site) the records of one kind, all of one site, each holdable; a reason of
 *            the HOLD list (reasonFor; its note when it asks one); the owner an active office person; the quarantine
 *            move asked to a QUARANTINE place of the site (only stock). Lock order: for held work orders, each one's
 *            issue lock (an issue in flight finishes first; one after waits and sees the hold) and gate lock
 *            ('factory.work-order-gate', wave 5: the scans, cuts, bundles … in flight finish first), in id order, then
 *            each work order DRAFT / RELEASED / IN_PROGRESS goes ON_HOLD (held from its status, the reason in words,
 *            the hold as its record) — the work order FIRST, then the QualityHold row (its trigger takes the records'
 *            hold locks EXCLUSIVE). One already ON_HOLD stays held; a COMPLETED one keeps its status.
 *   change   (quality.holds.place) the owner, the expected release, the notes, while ACTIVE.
 *   release  (quality.holds.release, the office's step-up: an e-signature) every release check (rules.ts): never the
 *            person who placed it; for garments never one who made them (the signed statement where the floor names
 *            stations only); a lab hold's Cr VI PASS; an inspection's hold a passed inspection after it. The hold →
 *            RELEASED with the SHA-256 of what was signed; each held work order no other ACTIVE hold names goes back to
 *            the status it was held from (another hold still naming it: it stays ON_HOLD under that one).
 *   close    `closeHoldInCommand` for the NCR's disposition (B-W2a-47): CLOSED with its NCR and why; work orders as at
 *            a release.
 *
 * `placeHoldInCommand` and `closeHoldInCommand` run inside another command (a failed inspection, a Cr VI fail, a
 * certificate's suspension, an NCR: the system places holds with no person). Events: quality.hold_placed,
 * quality.hold_released, quality.hold_changed; workorder.status_changed for each work order held or lifted.
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a hold command needs a tenant context')
  return context.tenantId
}

const sortedIds = (ids: readonly string[]): string[] => [...new Set(ids)].sort()
const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))
}

/** A hold the caller may see with the permission (another site's or company's: not found). */
async function visibleHold(caller: CommandCaller, holdId: string, permission: typeof QUALITY_HOLDS_VIEW | typeof QUALITY_HOLDS_PLACE | typeof QUALITY_HOLDS_RELEASE): Promise<HoldRow> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readHold(client, holdId))
  if (!row || !can(actorOf(context), QUALITY_HOLDS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Hold not found.')
  if (!can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  return row
}

async function detailOf(db: Reader, row: HoldRow, now: Date) {
  const facts = await viewFactsOf(db, [row], now)
  return holdView(row, facts)
}

// ---- work orders ON_HOLD (wave 5's columns) ------------------------------------------------------------------------

interface WorkOrderMove {
  readonly id: string
  readonly number: string
  readonly from: WorkOrderStatus
  readonly to: WorkOrderStatus
}

/** command()'s record guard by hand on a work order (after its locks): bump its version. */
async function bumpWorkOrder(tools: CommandTools, workOrderId: string): Promise<void> {
  const row = await tools.tx.workOrder.findUnique({ where: { id: workOrderId }, select: { version: true } })
  if (!row) throw new NotFoundError('Work order not found.')
  const { count } = await tools.tx.workOrder.updateMany({ where: { id: workOrderId, version: row.version }, data: { version: row.version + 1 } })
  if (count !== 1) throw new StaleVersionError('WorkOrder', workOrderId, row.version + 1, row.version)
}

function emitWorkOrderMove(tools: CommandTools, workOrder: { readonly companyId: string; readonly siteId: string }, move: WorkOrderMove): void {
  tools.emit({ type: 'workorder.status_changed', subject: move.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: move.id, number: move.number, from: move.from, to: move.to } })
}

/**
 * Puts held work orders ON_HOLD, inside the placing command, BEFORE the hold's row: their issue and gate locks in id
 * order, then each one DRAFT / RELEASED / IN_PROGRESS → ON_HOLD with the hold as its record. Answers those it moved.
 */
async function holdWorkOrders(tools: CommandTools, ids: readonly string[], hold: { readonly id: string; readonly reason: string; readonly byId: string | null }): Promise<WorkOrderMove[]> {
  const tenantId = tenantOf(tools)
  const { tx, now } = tools
  const order = sortedIds(ids)
  for (const id of order) await lockWorkOrderIssues(tx, tenantId, id)
  for (const id of order) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-gate', ${tenantId}::uuid, ${id}::uuid), 0))`
  const moved: WorkOrderMove[] = []
  for (const id of order) {
    const row = await tx.workOrder.findUnique({ where: { id }, select: { id: true, number: true, status: true, companyId: true, siteId: true } })
    if (!row) throw new NotFoundError('Work order not found.')
    const move = workOrderHoldMove(row.status as WorkOrderStatus)
    if (move === 'REFUSED') throw new InvalidStateError(unholdableWords('WorkOrder', { label: row.number, state: row.status })!)
    if (move !== 'HOLD') continue
    await bumpWorkOrder(tools, row.id)
    await tx.workOrder.update({
      where: { id: row.id },
      data: { status: 'ON_HOLD', heldFromStatus: row.status, heldAt: now, heldById: hold.byId, holdReason: hold.reason, holdRecordType: 'QualityHold', holdRecordId: hold.id },
      select: { id: true },
    })
    tools.audit({ action: 'quality.holdWorkOrder', recordType: 'WorkOrder', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'ON_HOLD', heldFromStatus: row.status, holdReason: hold.reason, holdRecordType: 'QualityHold', holdRecordId: hold.id }, reason: hold.reason })
    const entry = { id: row.id, number: row.number, from: row.status as WorkOrderStatus, to: 'ON_HOLD' as const }
    emitWorkOrderMove(tools, row, entry)
    moved.push(entry)
  }
  return moved
}

/**
 * After a hold ends (released or closed): each of its work orders ON_HOLD under it goes back to the status it was held
 * from — unless another ACTIVE hold still names it: then it stays ON_HOLD under that one (its record and reason put
 * right). Answers the work orders lifted.
 */
async function liftWorkOrders(tools: CommandTools, hold: HoldRow, why: string): Promise<WorkOrderMove[]> {
  const { tx } = tools
  const lifted: WorkOrderMove[] = []
  if (hold.subjectType !== 'WorkOrder') return lifted
  const reasons = await holdReasonWords(tx)
  for (const id of sortedIds(hold.subjectIds)) {
    const row = await tx.workOrder.findUnique({ where: { id }, select: { id: true, number: true, status: true, heldFromStatus: true, holdRecordType: true, holdRecordId: true, companyId: true, siteId: true } })
    if (!row || row.status !== 'ON_HOLD') continue
    const others = (await activeHoldsOf(tx, 'WorkOrder', [row.id])).filter((other) => other.id !== hold.id)
    if (others.length > 0) {
      if (row.holdRecordType === 'QualityHold' && row.holdRecordId === hold.id) {
        const next = (await tx.qualityHold.findUnique({ where: { id: others[0]!.id }, select: { id: true, reasonCode: true, reasonNote: true } }))!
        await bumpWorkOrder(tools, row.id)
        const reason = workOrderHoldReason(reasons.get(next.reasonCode) ?? next.reasonCode, next.reasonNote)
        await tx.workOrder.update({ where: { id: row.id }, data: { holdRecordId: next.id, holdReason: reason }, select: { id: true } })
        tools.audit({ action: 'quality.holdWorkOrder', recordType: 'WorkOrder', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { holdRecordId: hold.id }, after: { holdRecordId: next.id, holdReason: reason }, reason: why })
      }
      continue
    }
    // ON_HOLD under another kind of record (an NCR): that record lifts it.
    if (row.holdRecordType !== null && row.holdRecordType !== 'QualityHold') continue
    const back = row.heldFromStatus as DbWorkOrderStatus
    await bumpWorkOrder(tools, row.id)
    await tx.workOrder.update({ where: { id: row.id }, data: { status: back, heldFromStatus: null, heldAt: null, heldById: null, holdReason: null, holdRecordType: null, holdRecordId: null }, select: { id: true } })
    tools.audit({ action: 'quality.liftWorkOrderHold', recordType: 'WorkOrder', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'ON_HOLD', holdRecordId: row.holdRecordId }, after: { status: back }, reason: why })
    const entry = { id: row.id, number: row.number, from: 'ON_HOLD' as const, to: back as WorkOrderStatus }
    emitWorkOrderMove(tools, row, entry)
    lifted.push(entry)
  }
  return lifted
}

// ---- place ----------------------------------------------------------------------------------------------------------

export interface PlaceHoldInput {
  readonly subjectType: HoldSubjectType
  readonly subjectIds: readonly string[]
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly sourceType?: HoldSourceType | null | undefined
  readonly sourceId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedReleaseOn?: string | null | undefined
  readonly askQuarantine?: boolean | undefined
  readonly quarantineLocationId?: string | null | undefined
  readonly note?: string | null | undefined
  /** B-W2a-75: the floor worker who held it at the inspection bench (a system command after the floor's checks only). */
  readonly placedByWorkerId?: string | null | undefined
}

export interface PlacedHold {
  readonly hold: HoldRow
  readonly subjects: Subject[]
  readonly workOrdersHeld: WorkOrderMove[]
}

const SOURCE_SITES: Partial<Record<HoldSourceType, (tx: Reader, id: string) => Promise<{ siteId: string | null } | null>>> = {
  Inspection: (tx, id) => tx.inspection.findUnique({ where: { id }, select: { siteId: true } }),
  Nonconformance: (tx, id) => tx.nonconformance.findUnique({ where: { id }, select: { siteId: true } }),
  LabResult: async (tx, id) => ((await tx.labResult.findUnique({ where: { id }, select: { id: true } })) ? { siteId: null } : null),
  Certificate: async (tx, id) => ((await tx.certificate.findUnique({ where: { id }, select: { id: true } })) ? { siteId: null } : null),
  QualityReleaseReversal: async (tx, id) => ((await tx.qualityReleaseReversal.findUnique({ where: { id }, select: { id: true } })) ? { siteId: null } : null),
  Complaint: async (tx, id) => ((await tx.complaint.findUnique({ where: { id }, select: { id: true } })) ? { siteId: null } : null),
}

/**
 * Places a hold INSIDE the caller's command (the route's, or a system's: a failed inspection, a Cr VI fail …). The
 * placer is the office person of the context, else the floor worker a system command names (the bench's Hold lot,
 * quality/final/bench-hold.ts), else nobody (the system). Refusals in words at `body/<field>`.
 */
export async function placeHoldInCommand(tools: CommandTools, input: PlaceHoldInput): Promise<PlacedHold> {
  const { tx, now, context } = tools
  if (context.audience !== 'office' && context.audience !== 'system') throw new ForbiddenError('Holds are placed in the office (or by the system).')
  const placedById = context.audience === 'office' ? context.actorId : null
  const placedByWorkerId = context.audience === 'system' ? (input.placedByWorkerId ?? null) : null
  const problems: Issue[] = placeProblems(input, businessDate(now))
  if (problems.length > 0) refuse(problems, 'The hold is not valid.')

  // What it holds: rows of one site, each holdable now.
  const subjects = await readSubjects(tx, input.subjectType, input.subjectIds)
  const byId = new Map(subjects.map((subject) => [subject.id, subject]))
  const missing = input.subjectIds.map((id, index) => ({ id, index })).filter((entry) => !byId.has(entry.id))
  if (missing.length > 0) refuse(missing.map((entry) => ({ path: `body/subjectIds/${entry.index}`, message: `Not a ${input.subjectType === 'GarmentSerial' ? 'garment serial' : input.subjectType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} of the factory.` })), 'Some of these records are not found.')
  const sites = new Set(subjects.map((subject) => subject.siteId))
  if (sites.size > 1) refuse([{ path: 'body/subjectIds', message: 'A hold holds the goods of one site: place one hold per site.' }], 'The goods are at several sites.')
  const unholdable = input.subjectIds.flatMap((id, index) => {
    const words = unholdableWords(input.subjectType, byId.get(id)!)
    return words ? [{ path: `body/subjectIds/${index}`, message: words }] : []
  })
  if (unholdable.length > 0) refuse(unholdable, 'Some of these records cannot be held now.')
  const siteId = subjects[0]!.siteId
  const companyId = subjects[0]!.companyId
  if (context.audience === 'office' && !can(actorOf(context), QUALITY_HOLDS_PLACE, { companyId, siteId })) throw new ForbiddenError('You place holds only at the sites your role reaches.')

  // Why: a code of the HOLD reason list.
  const reason = await reasonFor(tx, 'HOLD', input.reasonCode)
  if (!reason || !reason.active) refuse([{ path: 'body/reasonCode', message: 'Pick an active reason of the hold list.' }], 'The reason is not an active hold reason.')
  const reasonNote = input.reasonNote?.trim() || null
  if (reason!.needsDetail && !reasonNote) refuse([{ path: 'body/reasonNote', message: `${reason!.labelEn} needs a note: say what is wrong.` }], 'The reason needs a note.')
  // Where it came from.
  if (input.sourceType && input.sourceId) {
    const source = isUuid(input.sourceId) ? await SOURCE_SITES[input.sourceType]?.(tx, input.sourceId) : null
    if (!source || (source.siteId !== null && source.siteId !== siteId)) refuse([{ path: 'body/sourceId', message: `Not a ${input.sourceType} of this site.` }], 'The record behind the hold is not found.')
  }
  // Who follows it up.
  if (input.ownerId) {
    const owner = isUuid(input.ownerId) ? await tx.user.findUnique({ where: { id: input.ownerId }, select: { status: true } }) : null
    if (!owner || owner.status !== 'ACTIVE') refuse([{ path: 'body/ownerId', message: 'The owner is an active person of the office.' }], 'The owner is not an active person.')
  }
  // The move to quarantine: a QUARANTINE place of the site (the site's one, when only one and none is named).
  let quarantineLocationId: string | null = null
  if (input.askQuarantine && STOCK_SUBJECTS.includes(input.subjectType)) {
    const places = await tx.location.findMany({ where: { siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true } })
    quarantineLocationId = input.quarantineLocationId ?? (places.length === 1 ? places[0]!.id : null)
    if (!quarantineLocationId || !places.some((place) => place.id === quarantineLocationId)) {
      refuse([{ path: 'body/quarantineLocationId', message: places.length === 0 ? 'The site has no quarantine place: add one in the warehouse first, or do not ask for the move.' : 'Pick a quarantine place of the site.' }], 'The quarantine place is not one of the site.')
    }
  }

  const holdId = newId()
  const words = workOrderHoldReason(reason!.labelEn, reasonNote)
  // The work orders FIRST (their issue and gate locks, then ON_HOLD), then the hold's row (its trigger: the hold locks).
  const workOrdersHeld = input.subjectType === 'WorkOrder' ? await holdWorkOrders(tools, input.subjectIds, { id: holdId, reason: words, byId: placedById }) : []
  const hold = await tx.qualityHold.create({
    data: {
      id: holdId,
      companyId,
      siteId,
      subjectType: input.subjectType,
      subjectIds: [...input.subjectIds],
      reasonCode: input.reasonCode,
      reasonNote,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      placedAt: now,
      placedById,
      placedByWorkerId,
      ownerId: input.ownerId ?? null,
      expectedReleaseOn: input.expectedReleaseOn ? new Date(`${input.expectedReleaseOn}T00:00:00.000Z`) : null,
      quarantine: quarantineLocationId ? 'ASKED' : 'NOT_NEEDED',
      quarantineLocationId,
      note: input.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
      createdById: placedById,
    },
    select: HOLD_COLUMNS,
  })
  tools.audit({
    action: 'quality.placeHold',
    recordType: 'QualityHold',
    recordId: hold.id,
    companyId,
    siteId,
    after: { subjectType: hold.subjectType, subjectIds: hold.subjectIds, reasonCode: hold.reasonCode, reasonNote, sourceType: hold.sourceType, sourceId: hold.sourceId, ownerId: hold.ownerId, expectedReleaseOn: input.expectedReleaseOn ?? null, quarantine: hold.quarantine, quarantineLocationId, workOrdersHeld: workOrdersHeld.map((entry) => entry.id) },
    ...(reasonNote ? { reason: reasonNote } : {}),
  })
  tools.emit({
    type: 'quality.hold_placed',
    subject: hold.id,
    companyId,
    siteId,
    payload: {
      holdId: hold.id,
      subjectType: input.subjectType,
      subjectIds: [...hold.subjectIds],
      reasonCode: hold.reasonCode,
      sourceType: hold.sourceType,
      sourceId: hold.sourceId,
      placedBy: placedByKind(hold),
      quarantine: hold.quarantine,
      workOrdersHeld: workOrdersHeld.map((entry) => entry.id),
    },
  })
  return { hold, subjects, workOrdersHeld }
}

/** POST /quality/holds (office). */
export async function placeHold(caller: CommandCaller, body: PlaceHoldInput, idempotencyKey?: string) {
  officeOf(caller)
  const { result } = await command(caller, { name: 'quality.placeHold', idempotencyKey, input: body }, async (tools) => {
    const placed = await placeHoldInCommand(tools, body)
    return { hold: await detailOf(tools.tx, placed.hold, tools.now), workOrdersHeld: placed.workOrdersHeld.map((entry) => ({ id: entry.id, number: entry.number, from: entry.from })) }
  })
  return result
}

/**
 * command()'s record guard by hand on a hold: its row locked, ACTIVE (a released or closed hold never changes: the
 * guard would refuse the version bump itself), at the version the caller read.
 */
async function lockActiveHold(tools: CommandTools, holdId: string, expectedVersion: number): Promise<HoldRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; status: string }[]>`SELECT "version", "status"::text AS "status" FROM "QualityHold" WHERE "id" = ${holdId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Hold not found.')
  if (locked.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${locked.status.toLowerCase()}: a released or closed hold never changes.`)
  if (locked.version !== expectedVersion) throw new StaleVersionError('QualityHold', holdId, locked.version, expectedVersion)
  return (await readHold(tools.tx, holdId))!
}

// ---- change ---------------------------------------------------------------------------------------------------------

export interface EditHoldBody {
  readonly version: number
  readonly ownerId?: string | null | undefined
  readonly expectedReleaseOn?: string | null | undefined
  readonly note?: string | null | undefined
  readonly reasonNote?: string | null | undefined
}

/** PATCH /quality/holds/:holdId: owner, expected release, notes; while ACTIVE. */
export async function editHold(caller: CommandCaller, holdId: string, body: EditHoldBody, idempotencyKey?: string) {
  const row = await visibleHold(caller, holdId, QUALITY_HOLDS_PLACE)
  const problems: Issue[] = []
  if ((body.note ?? '').length > HOLD_LIMITS.note) problems.push({ path: 'body/note', message: `At most ${HOLD_LIMITS.note} characters.` })
  if ((body.reasonNote ?? '').length > HOLD_LIMITS.reasonNote) problems.push({ path: 'body/reasonNote', message: `At most ${HOLD_LIMITS.reasonNote} characters.` })
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  if (row.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${row.status.toLowerCase()}: a released or closed hold never changes.`)
  const { result } = await command(caller, { name: 'quality.editHold', idempotencyKey, input: { holdId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockActiveHold(tools, row.id, body.version)
    if (body.expectedReleaseOn && body.expectedReleaseOn < businessDate(now)) refuse([{ path: 'body/expectedReleaseOn', message: 'The expected release is today or later.' }], 'The expected release is in the past.')
    if (body.ownerId) {
      const owner = await tx.user.findUnique({ where: { id: body.ownerId }, select: { status: true } })
      if (!owner || owner.status !== 'ACTIVE') refuse([{ path: 'body/ownerId', message: 'The owner is an active person of the office.' }], 'The owner is not an active person.')
    }
    const data: Prisma.QualityHoldUpdateInput = { updatedAt: now, version: { increment: 1 } }
    const fields: ('ownerId' | 'expectedReleaseOn' | 'note' | 'reasonNote')[] = []
    if (body.ownerId !== undefined && body.ownerId !== current.ownerId) (data.ownerId = body.ownerId), fields.push('ownerId')
    const release = body.expectedReleaseOn === undefined ? undefined : body.expectedReleaseOn ? new Date(`${body.expectedReleaseOn}T00:00:00.000Z`) : null
    if (release !== undefined && release?.getTime() !== current.expectedReleaseOn?.getTime()) (data.expectedReleaseOn = release), fields.push('expectedReleaseOn')
    if (body.note !== undefined && (body.note?.trim() || null) !== current.note) (data.note = body.note?.trim() || null), fields.push('note')
    if (body.reasonNote !== undefined && (body.reasonNote?.trim() || null) !== current.reasonNote) (data.reasonNote = body.reasonNote?.trim() || null), fields.push('reasonNote')
    const after = await tx.qualityHold.update({ where: { id: current.id }, data, select: HOLD_COLUMNS })
    const pick = (hold: HoldRow) => Object.fromEntries(fields.map((field) => [field, field === 'expectedReleaseOn' ? (hold.expectedReleaseOn?.toISOString().slice(0, 10) ?? null) : hold[field]]))
    tools.audit({ recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: pick(current), after: pick(after) })
    if (fields.length > 0) tools.emit({ type: 'quality.hold_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { holdId: current.id, fields } })
    return { hold: await detailOf(tx, after, now) }
  })
  return result
}

// ---- release --------------------------------------------------------------------------------------------------------

/** The work orders whose garments a hold holds (a work order, its bundles, its serials). */
async function heldWorkOrders(db: Reader, hold: Pick<HoldRow, 'subjectType' | 'subjectIds'>): Promise<{ id: string; number: string }[]> {
  if (!GARMENT_SUBJECTS.includes(hold.subjectType as HoldSubjectType)) return []
  const subjects = await readSubjects(db, hold.subjectType as HoldSubjectType, hold.subjectIds)
  const ids = sortedIds(subjects.flatMap((subject) => (subject.workOrderId ? [subject.workOrderId] : [])))
  return db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true }, orderBy: { number: 'asc' } })
}

/** What must be true to release the hold, for this office person (the GateExplainer of qh-release). */
export async function releaseChecksFor(db: Reader, hold: HoldRow, releaser: { readonly userId: string }, notMakerStatement: boolean): Promise<ReleaseCheck[]> {
  const identity = await identityOf(db, { userId: releaser.userId, workerId: null })
  const placedByReleaser = hold.placedById !== null ? identity.userIds.has(hold.placedById) : hold.placedByWorkerId !== null && identity.workerIds.has(hold.placedByWorkerId)
  let madeBy: string[] | null = null
  let makersUnnamed = false
  if (GARMENT_SUBJECTS.includes(hold.subjectType as HoldSubjectType)) {
    madeBy = []
    for (const order of await heldWorkOrders(db, hold)) {
      const makers = await makersOf(db, order.id)
      if (madeAny(identity, makers)) madeBy.push(order.number)
      makersUnnamed ||= makers.unnamed
    }
  }
  let crViOpen: string[] | null = null
  if (hold.sourceType === 'LabResult' && (hold.subjectType === 'Lot' || hold.subjectType === 'Hide')) {
    const lotIds = hold.subjectType === 'Lot' ? hold.subjectIds : (await db.hide.findMany({ where: { id: { in: hold.subjectIds } }, select: { lotId: true } })).map((row) => row.lotId)
    crViOpen = (await db.lot.findMany({ where: { id: { in: sortedIds(lotIds) } }, select: { code: true, crViStatus: true }, orderBy: { code: 'asc' } })).filter((lot) => lot.crViStatus !== 'PASS').map((lot) => `${lot.code} ${lot.crViStatus}`)
  }
  let reinspectionOpen: string[] | null = null
  if (hold.sourceType === 'Inspection' && GARMENT_SUBJECTS.includes(hold.subjectType as HoldSubjectType)) {
    reinspectionOpen = []
    for (const order of await heldWorkOrders(db, hold)) {
      const passed = await db.inspection.findFirst({ where: { workOrderId: order.id, status: 'PASSED', decidedAt: { gt: hold.placedAt } }, select: { id: true } })
      if (!passed) reinspectionOpen.push(order.number)
    }
  }
  return releaseChecks({ status: hold.status as 'ACTIVE' | 'RELEASED' | 'CLOSED', subjectType: hold.subjectType as HoldSubjectType, placedByReleaser, madeBy, makersUnnamed, notMakerStatement, crViOpen, reinspectionOpen })
}

/** A release refused by its checks: a 409 with `release/<CHECK>` and its words. */
export class ReleaseRefusedError extends ConflictError {
  override name = 'ReleaseRefusedError'
  override readonly issues: readonly Issue[]
  constructor(checks: readonly ReleaseCheck[]) {
    const first = releaseRefusal(checks)!
    super(first.words)
    this.issues = checks.filter((check) => !check.ok).map((check) => ({ path: `release/${check.key}`, message: check.words }))
  }
}

export interface ReleaseHoldBody {
  readonly version: number
  readonly note?: string | null | undefined
  readonly notMakerStatement?: boolean | undefined
}

/** POST /quality/holds/:holdId/release (the route asks the office's step-up first). */
export async function releaseHold(caller: CommandCaller, holdId: string, body: ReleaseHoldBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = await visibleHold(caller, holdId, QUALITY_HOLDS_RELEASE)
  if ((body.note ?? '').length > HOLD_LIMITS.note) refuse([{ path: 'body/note', message: `At most ${HOLD_LIMITS.note} characters.` }], 'The note is too long.')
  if (row.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${row.status.toLowerCase()} already.`)
  const { result } = await command(caller, { name: 'quality.releaseHold', idempotencyKey, input: { holdId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockActiveHold(tools, row.id, body.version)
    const checks = await releaseChecksFor(tx, current, { userId: context.actorId }, body.notMakerStatement === true)
    if (!releasable(checks)) throw new ReleaseRefusedError(checks)
    const note = body.note?.trim() || null
    const signature = createHash('sha256')
      .update(releaseStatement({ holdId: current.id, subjectType: current.subjectType as HoldSubjectType, subjectIds: current.subjectIds, releasedBy: `user ${context.actorId}`, releasedAt: toUtcIso(now), checks, note }))
      .digest('hex')
    const after = await tx.qualityHold.update({
      where: { id: current.id },
      data: { status: 'RELEASED', releasedAt: now, releasedById: context.actorId, releaseNote: note, releaseSignatureSha256: signature, notMakerStatement: body.notMakerStatement === true, version: { increment: 1 }, updatedAt: now },
      select: HOLD_COLUMNS,
    })
    tools.audit({ recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'ACTIVE' }, after: { status: 'RELEASED', releaseSignatureSha256: signature, checks: checks.map((check) => check.words) }, ...(note ? { reason: note } : {}) })
    const lifted = await liftWorkOrders(tools, after, note ?? 'Hold released.')
    tools.emit({ type: 'quality.hold_released', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { holdId: current.id, subjectType: current.subjectType as HoldSubjectType, subjectIds: [...current.subjectIds], workOrdersLifted: lifted.map((entry) => entry.id) } })
    return { hold: await detailOf(tx, after, now), workOrdersLifted: lifted.map((entry) => ({ id: entry.id, number: entry.number, to: entry.to })), checks }
  })
  return result
}

// ---- close (the NCR's disposition, B-W2a-47) ------------------------------------------------------------------------

/**
 * Closes an ACTIVE hold INSIDE the NCR's command: decided in its NCR (rejected, reworked, scrapped). Sets the NCR (once)
 * and why; its work orders as at a release. The NCR's own rules (every decision done) are the NCR module's.
 */
export async function closeHoldInCommand(tools: CommandTools, input: { readonly holdId: string; readonly ncrId: string; readonly note: string; readonly closedById: string | null }) {
  const { tx, now } = tools
  const current = await readHold(tx, input.holdId)
  if (!current) throw new NotFoundError('Hold not found.')
  if (current.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${current.status.toLowerCase()} already.`)
  if (current.ncrId !== null && current.ncrId !== input.ncrId) throw new ConflictError('This hold is decided in another NCR.')
  if (!input.note.trim()) throw new ValidationError('Say how the NCR decided the goods.', [{ path: 'body/note', message: 'The closing note.' }])
  await lockActiveHold(tools, current.id, current.version)
  const after = await tx.qualityHold.update({
    where: { id: current.id },
    data: { status: 'CLOSED', ncrId: input.ncrId, closedAt: now, closedById: input.closedById, closeNote: input.note.trim(), version: { increment: 1 }, updatedAt: now },
    select: HOLD_COLUMNS,
  })
  tools.audit({ recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'ACTIVE', ncrId: current.ncrId }, after: { status: 'CLOSED', ncrId: input.ncrId }, reason: input.note.trim() })
  const lifted = await liftWorkOrders(tools, after, input.note.trim())
  return { hold: after, workOrdersLifted: lifted }
}
