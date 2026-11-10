import type { Prisma } from '@nexus/factory-db'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { cleanList, type RegisterConcern } from '@nexus/factory-domain/compliance/register/rules'
import type { TraceView } from '@nexus/factory-domain/compliance/register/trace'
import { draftPublicNotice } from '@nexus/factory-domain/compliance/recall/drafts'
import { RECALL_MANAGE, RECALL_SEND } from '@nexus/factory-domain/compliance/recall/permissions'
import {
  cleanCodes,
  noticeOnlyGrows,
  progressProblems,
  progressSummary,
  publicNoticeProblems,
  RECALL_LAW,
  scopeProblems,
  scopeWidensOnly,
  startingProgress,
  stillOutOf,
  toldCount,
  widenScope,
  type PublicNotice,
  type PublicNoticeWords,
  type RecallKind,
  type RecallScope,
  type RecallStatus,
} from '@nexus/factory-domain/compliance/recall/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { unholdableWords, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { placeHoldInCommand } from '../../quality/holds/holds'
import { readSubjects } from '../../quality/holds/store'
import { ENTRY_SCOPE } from '../register/register'
import { readEntry, type EntryRecord } from '../register/store'
import { traceOf } from '../register/trace'
import type { RecallDetail, RecallRow } from './contract'
import { assertMay, entryScope, guarded, mayOn, namesFor, officeOf, settings, textOrNull, uuidOr404, visibleEntry, type Reader } from './common'
import { draftFactsOf } from './notices'

/**
 * The recall and withdrawal workflow (B-W2b-260; PRD-388; PPE Reg. (EU) 2016/425 art. 8(8); GPSR (EU) 2023/988 art. 35-36;
 * design compliance.register › pop:rg-recall "Recall or withdrawal": 1 scope from the trace, 2 block stock (holds), 3
 * customers and notices, 4 returns, remedy and disposal tracking). On a register entry:
 *
 *   draft     the kind (RECALL | WITHDRAWAL), numbered from the company's RECALL series (RCL-…), its scope from the entry
 *             (its batches, serials, work orders, shipments, and the work orders its material lots went to) or as given,
 *             or the whole style; the public notice drafted per language.
 *   holds     what is still here is held through quality/holds (placeHoldInCommand, sourceType RecallAction): the work
 *             orders with garments not gone, the named serials still made or released, the shipments not left; one hold
 *             per kind and site; what another hold holds already stays as it is. No second hold of our own.
 *   start     DRAFT → ACTIVE by a person; one progress row per shipment that left with garments of the scope (sent = what
 *             it carried, all still out).
 *   widen     once started a scope only widens (what is given is added).
 *   publish   the public notice (compliance.recall.send, step-up) while ACTIVE: first on the public DoC page of the style's
 *             batches it reaches; a language may be added later, the words never change; taken down once.
 *   progress  per customer (and shipment): returned, repaired, destroyed, still out (sent = the four).
 *   close     ACTIVE → CLOSED with how it ended; a DRAFT is cancelled with why.
 *
 * Every write is ONE command (audit row, event recall.changed / recall.progress_changed, Idempotency-Key, the version the
 * caller read); the database's own refusal (B-W2b-222's guards) answers 409 in words.
 */

export const RECALL_NOT_FOUND = 'Recall or withdrawal not found.'

const PROGRESS_SELECT = { id: true, partyId: true, shipmentId: true, unitsSent: true, unitsReturned: true, unitsRepaired: true, unitsDestroyed: true, unitsStillOut: true, note: true, version: true } as const satisfies Prisma.RecallProgressSelect

const RECALL_SELECT = {
  id: true,
  companyId: true,
  registerEntryId: true,
  number: true,
  kind: true,
  styleId: true,
  wholeStyle: true,
  batchNumbers: true,
  serials: true,
  workOrderIds: true,
  shipmentIds: true,
  publicNotice: true,
  noticePublishedAt: true,
  noticePublishedById: true,
  noticeWithdrawnAt: true,
  status: true,
  startedAt: true,
  startedById: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  registerEntry: { select: { id: true, reference: true, kind: true, risk: true, status: true, partyId: true } },
  style: { select: { id: true, code: true, name: true } },
  progress: { select: PROGRESS_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.RecallActionSelect
export type RecallRecord = Prisma.RecallActionGetPayload<{ select: typeof RECALL_SELECT }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

export const scopeOfRecall = (row: Pick<RecallRecord, 'wholeStyle' | 'batchNumbers' | 'serials' | 'workOrderIds' | 'shipmentIds'>): RecallScope => ({
  wholeStyle: row.wholeStyle,
  batchNumbers: [...row.batchNumbers],
  serials: [...row.serials],
  workOrderIds: [...row.workOrderIds],
  shipmentIds: [...row.shipmentIds],
})

/** A recall's public notice as stored (null: none written). */
export function noticeOf(value: unknown): PublicNotice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, PublicNoticeWords> = {}
  for (const [language, words] of Object.entries(value as Record<string, unknown>)) {
    const w = words as Partial<Record<keyof PublicNoticeWords, unknown>> | null
    if (w && typeof w.title === 'string' && typeof w.problem === 'string' && typeof w.action === 'string' && typeof w.contact === 'string') {
      out[language] = { title: w.title, problem: w.problem, action: w.action, contact: w.contact }
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The recalls hanging on the entries the caller may view. */
export const recallReach = (context: OfficeContext): Prisma.RecallActionWhereInput => ({ registerEntry: scopeWhere(actorOf(context), REGISTER_VIEW, ENTRY_SCOPE) as Prisma.PpeRegisterEntryWhereInput })

export async function recallRows(db: Reader, rows: readonly RecallRecord[]): Promise<RecallRow[]> {
  const people = await namesFor(db, rows.flatMap((row) => [row.noticePublishedById, row.startedById, row.closedById]))
  return rows.map((row) => {
    const notice = noticeOf(row.publicNotice)
    return {
      id: row.id,
      companyId: row.companyId,
      number: row.number,
      kind: row.kind,
      status: row.status,
      entryId: row.registerEntryId,
      entry: { id: row.registerEntry.id, reference: row.registerEntry.reference, kind: row.registerEntry.kind, risk: row.registerEntry.risk, status: row.registerEntry.status },
      style: { id: row.style.id, code: row.style.code, name: row.style.name },
      scope: { wholeStyle: row.wholeStyle, batchNumbers: [...row.batchNumbers], serialCount: row.serials.length, workOrderCount: row.workOrderIds.length, shipmentCount: row.shipmentIds.length },
      notice: { languages: notice ? Object.keys(notice) : [], publishedAt: iso(row.noticePublishedAt), publishedBy: people(row.noticePublishedById), withdrawnAt: iso(row.noticeWithdrawnAt), live: row.noticePublishedAt !== null && row.noticeWithdrawnAt === null },
      progress: progressSummary(row.progress),
      startedAt: iso(row.startedAt),
      startedBy: people(row.startedById),
      closedAt: iso(row.closedAt),
      closedBy: people(row.closedById),
      closeNote: row.closeNote,
      cancelledAt: iso(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}

async function readRecall(db: Reader, context: OfficeContext, recallId: string): Promise<RecallRecord> {
  uuidOr404(recallId, RECALL_NOT_FOUND)
  const row = await db.recallAction.findFirst({ where: { AND: [{ id: recallId }, recallReach(context)] }, select: RECALL_SELECT })
  if (!row) throw new NotFoundError(RECALL_NOT_FOUND)
  return row
}

/** The concern the register's trace follows for a scope: the whole style is every live work order of the style of the company. */
async function concernOf(db: Reader, companyId: string, styleId: string, scope: RecallScope): Promise<RegisterConcern & { styleRevisionId: null }> {
  const all = scope.wholeStyle
    ? (await db.workOrder.findMany({ where: { companyId, styleId, status: { notIn: ['CANCELLED'] } }, select: { id: true }, take: 1000 })).map((row) => row.id)
    : []
  return { styleId, styleRevisionId: null, batchNumbers: [...scope.batchNumbers], serials: [...scope.serials], lotIds: [], workOrderIds: [...new Set([...scope.workOrderIds, ...all])], shipmentIds: [...scope.shipmentIds] }
}

export async function traceOfRecall(db: Reader, row: Pick<RecallRecord, 'companyId' | 'styleId' | 'wholeStyle' | 'batchNumbers' | 'serials' | 'workOrderIds' | 'shipmentIds'>): Promise<TraceView> {
  return traceOf(db, row.companyId, await concernOf(db, row.companyId, row.styleId, scopeOfRecall(row)))
}

// ---- what can still be held -------------------------------------------------------------------------------------------------

interface HoldPick {
  readonly subjectType: HoldSubjectType
  readonly id: string
  readonly siteId: string
}

/**
 * What of the scope is still here and not on hold: the work orders whose garments have not all left (not closed or
 * cancelled), the named serials still made or released, the shipments not left. Records another ACTIVE hold names stay out
 * (`alreadyHeld`).
 */
async function holdPlan(db: Reader, row: RecallRecord, trace: TraceView): Promise<{ picks: HoldPick[]; alreadyHeld: number }> {
  const candidates: { type: HoldSubjectType; ids: string[] }[] = []
  // Work orders the scope reaches whole (by batch, lot or name) with garments not gone; one reached only through serials or
  // shipments is held through those.
  const here = trace.workOrders.filter((order) => order.styleId === row.styleId && order.reach === 'WHOLE' && order.cells.reduce((sum, cell) => sum + cell.concerned - cell.shipped + cell.returned, 0) > 0)
  candidates.push({ type: 'WorkOrder', ids: here.map((order) => order.id) })
  if (row.serials.length > 0) {
    const serials = await db.garmentSerial.findMany({ where: { serial: { in: [...row.serials] }, workOrderSize: { workOrder: { companyId: row.companyId, styleId: row.styleId } } }, select: { id: true } })
    candidates.push({ type: 'GarmentSerial', ids: serials.map((serial) => serial.id) })
  }
  candidates.push({ type: 'Shipment', ids: trace.shipments.filter((shipment) => !shipment.left && (shipment.status === 'DRAFT' || shipment.status === 'PACKED')).map((shipment) => shipment.id) })
  const picks: HoldPick[] = []
  let alreadyHeld = 0
  for (const { type, ids } of candidates) {
    if (ids.length === 0) continue
    const held = new Set((await db.qualityHold.findMany({ where: { status: 'ACTIVE', subjectType: type, subjectIds: { hasSome: ids } }, select: { subjectIds: true } })).flatMap((hold) => hold.subjectIds))
    for (const subject of await readSubjects(db, type, ids)) {
      if (held.has(subject.id) || (type === 'WorkOrder' && subject.state === 'ON_HOLD')) {
        alreadyHeld += 1
        continue
      }
      if (unholdableWords(type, subject) !== null) continue
      picks.push({ subjectType: type, id: subject.id, siteId: subject.siteId })
    }
  }
  return { picks, alreadyHeld }
}

// ---- views ------------------------------------------------------------------------------------------------------------------

async function recallDetailOf(db: Reader, context: OfficeContext, row: RecallRecord): Promise<RecallDetail> {
  const [base] = await recallRows(db, [row])
  const trace = await traceOfRecall(db, row)
  const workOrders = row.workOrderIds.length ? await db.workOrder.findMany({ where: { id: { in: [...row.workOrderIds] } }, select: { id: true, number: true, batchNumber: true, status: true }, orderBy: [{ number: 'asc' }] }) : []
  const shipments = row.shipmentIds.length ? await db.shipment.findMany({ where: { id: { in: [...row.shipmentIds] } }, select: { id: true, number: true, status: true, partyId: true }, orderBy: [{ number: 'asc' }] }) : []
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(row.progress.map((entry) => entry.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
  const progressShipmentIds = [...new Set(row.progress.map((entry) => entry.shipmentId).filter((id): id is string => id !== null))]
  const progressShipments = new Map((progressShipmentIds.length ? await db.shipment.findMany({ where: { id: { in: progressShipmentIds } }, select: { id: true, number: true } }) : []).map((shipment) => [shipment.id, shipment.number]))
  const holds = await db.qualityHold.findMany({ where: { sourceType: 'RecallAction', sourceId: row.id }, select: { id: true, number: true, status: true, subjectType: true, subjectIds: true, siteId: true }, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
  const plan = row.status === 'DRAFT' || row.status === 'ACTIVE' ? await holdPlan(db, row, trace) : { picks: [], alreadyHeld: 0 }
  const notices = await db.distributorNotice.findMany({ where: { registerEntryId: row.registerEntryId }, select: { partyId: true, status: true } })
  const scope = { companyId: row.companyId, partyId: row.registerEntry.partyId }
  const manage = mayOn(context, RECALL_MANAGE, scope)
  const send = mayOn(context, RECALL_SEND, scope)
  const live = row.noticePublishedAt !== null && row.noticeWithdrawnAt === null
  const running = row.status === 'DRAFT' || row.status === 'ACTIVE'
  return {
    ...base!,
    serials: [...row.serials],
    workOrders,
    shipments,
    publicNotice: noticeOf(row.publicNotice),
    progressRows: row.progress.map((entry) => {
      const party = parties.get(entry.partyId)
      return {
        id: entry.id,
        party: { id: entry.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
        shipment: entry.shipmentId ? { id: entry.shipmentId, number: progressShipments.get(entry.shipmentId) ?? '' } : null,
        unitsSent: entry.unitsSent,
        unitsReturned: entry.unitsReturned,
        unitsRepaired: entry.unitsRepaired,
        unitsDestroyed: entry.unitsDestroyed,
        unitsStillOut: entry.unitsStillOut,
        note: entry.note,
        version: entry.version,
      }
    }),
    trace: {
      counts: { ...trace.counts },
      customers: trace.customers.map((customer) => ({ partyId: customer.partyId, code: customer.code, name: customer.name, garments: customer.garments, shipmentNumbers: [...customer.shipmentNumbers] })),
      problems: trace.problems.map((problem) => ({ ...problem })),
    },
    holds: holds.map((hold) => ({ id: hold.id, number: hold.number, status: hold.status, subjectType: hold.subjectType as HoldSubjectType, subjects: hold.subjectIds.length, siteId: hold.siteId })),
    holdable: {
      workOrders: plan.picks.filter((pick) => pick.subjectType === 'WorkOrder').length,
      serials: plan.picks.filter((pick) => pick.subjectType === 'GarmentSerial').length,
      shipments: plan.picks.filter((pick) => pick.subjectType === 'Shipment').length,
    },
    distributors: toldCount(trace.customers.map((customer) => customer.partyId), notices),
    law: { correctiveAction: RECALL_LAW.correctiveAction, publicNotice: RECALL_LAW.publicNotice, distributors: RECALL_LAW.distributors },
    may: {
      edit: manage && row.status !== 'CANCELLED' && row.status !== 'CLOSED',
      start: manage && row.status === 'DRAFT' && row.registerEntry.status === 'OPEN',
      hold: manage && running && plan.picks.length > 0,
      publish: send && row.status === 'ACTIVE' && row.noticePublishedAt === null,
      withdrawNotice: manage && live,
      progress: manage && running,
      close: manage && row.status === 'ACTIVE',
      cancel: manage && row.status === 'DRAFT',
    },
  }
}

async function recallAnswer(caller: CommandCaller, recallId: string): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ recall: await recallDetailOf(db, context, await readRecall(db, context, recallId)) }))
}

type Change = 'DRAFTED' | 'EDITED' | 'WIDENED' | 'STARTED' | 'HOLDS_PLACED' | 'NOTICE_PUBLISHED' | 'NOTICE_WITHDRAWN' | 'CLOSED' | 'CANCELLED'
function emitRecall(tools: Pick<CommandTools, 'emit'>, row: { id: string; number: string; companyId: string; registerEntryId: string; kind: RecallKind; styleId: string; status: RecallStatus }, change: Change): void {
  tools.emit({ type: 'recall.changed', subject: row.id, companyId: row.companyId, payload: { recallId: row.id, number: row.number, entryId: row.registerEntryId, kind: row.kind, styleId: row.styleId, status: row.status, change } })
}
const EMIT_SELECT = { id: true, number: true, companyId: true, registerEntryId: true, kind: true, styleId: true, status: true } as const satisfies Prisma.RecallActionSelect

const auditScope = (scope: RecallScope) => ({ wholeStyle: scope.wholeStyle, batchNumbers: [...scope.batchNumbers], serials: scope.serials.length, workOrderIds: [...scope.workOrderIds], shipmentIds: [...scope.shipmentIds] })

// ---- reads ------------------------------------------------------------------------------------------------------------------

export interface RecallQuery {
  readonly status?: RecallStatus | undefined
  readonly kind?: RecallKind | undefined
  readonly entryId?: string | undefined
  readonly styleId?: string | undefined
  readonly companyId?: string | undefined
  readonly q?: string | undefined
  readonly limit: number
}

/** GET /compliance/recalls: recalls and withdrawals with the tiles (in progress, drafts, notices live, units still out). */
export async function listRecalls(caller: CommandCaller, query: RecallQuery) {
  const context = officeOf(caller)
  const reach = recallReach(context)
  return caller.withClient(async (db) => {
    const rows = await db.recallAction.findMany({
      where: {
        AND: [
          reach,
          query.status ? { status: query.status } : {},
          query.kind ? { kind: query.kind } : {},
          query.entryId ? { registerEntryId: query.entryId } : {},
          query.styleId ? { styleId: query.styleId } : {},
          query.companyId ? { companyId: query.companyId } : {},
          query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { registerEntry: { reference: { contains: query.q, mode: 'insensitive' } } }, { batchNumbers: { has: query.q } }] } : {},
        ],
      },
      select: RECALL_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: query.limit,
    })
    const stillOut = await db.recallProgress.aggregate({ where: { recallAction: { AND: [reach, { status: 'ACTIVE' }] } }, _sum: { unitsStillOut: true } })
    const tiles = {
      active: await db.recallAction.count({ where: { AND: [reach, { status: 'ACTIVE' }] } }),
      drafts: await db.recallAction.count({ where: { AND: [reach, { status: 'DRAFT' }] } }),
      noticesLive: await db.recallAction.count({ where: { AND: [reach, { noticePublishedAt: { not: null }, noticeWithdrawnAt: null }] } }),
      unitsStillOut: stillOut._sum.unitsStillOut ?? 0,
    }
    return { recalls: await recallRows(db, rows), tiles }
  })
}

export const getRecall = (caller: CommandCaller, recallId: string) => recallAnswer(caller, recallId)

export async function recallsOfEntry(db: Reader, entryId: string): Promise<RecallRow[]> {
  return recallRows(db, await db.recallAction.findMany({ where: { registerEntryId: entryId }, select: RECALL_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
}

// ---- the scope's records -----------------------------------------------------------------------------------------------------

/** The work orders (of the company and style) and shipments (of the company) a scope names exist; 400 in words otherwise. */
async function checkScope(db: Reader, companyId: string, styleId: string, scope: RecallScope): Promise<void> {
  const problems: Issue[] = scopeProblems(scope)
  if (scope.workOrderIds.length) {
    const found = new Set((await db.workOrder.findMany({ where: { id: { in: [...scope.workOrderIds] }, companyId, styleId }, select: { id: true } })).map((row) => row.id))
    scope.workOrderIds.forEach((id, index) => found.has(id) || problems.push({ path: `body/workOrderIds/${index}`, message: "Not a work order of this company and the entry's style." }))
  }
  if (scope.shipmentIds.length) {
    const found = new Set((await db.shipment.findMany({ where: { id: { in: [...scope.shipmentIds] }, companyId }, select: { id: true } })).map((row) => row.id))
    scope.shipmentIds.forEach((id, index) => found.has(id) || problems.push({ path: `body/shipmentIds/${index}`, message: 'Not a shipment of this company.' }))
  }
  if (problems.length > 0) throw new ValidationError('The scope is not valid.', problems)
}

interface ScopeInput {
  readonly wholeStyle?: boolean | undefined
  readonly batchNumbers?: readonly string[] | undefined
  readonly serials?: readonly string[] | undefined
  readonly workOrderIds?: readonly string[] | undefined
  readonly shipmentIds?: readonly string[] | undefined
}
const scopeGiven = (input: ScopeInput): boolean =>
  input.wholeStyle !== undefined || input.batchNumbers !== undefined || input.serials !== undefined || input.workOrderIds !== undefined || input.shipmentIds !== undefined

/** The scope as given (left-out lists empty). */
const scopeFrom = (input: ScopeInput): RecallScope => ({
  wholeStyle: input.wholeStyle === true,
  batchNumbers: cleanCodes(input.batchNumbers),
  serials: cleanCodes(input.serials),
  workOrderIds: [...new Set(input.workOrderIds ?? [])],
  shipmentIds: [...new Set(input.shipmentIds ?? [])],
})

/** The work orders of the entry's style the material lots went to (the register's trace: their ISSUE moves). */
async function lotWorkOrders(db: Reader, entry: EntryRecord, lotIds: readonly string[]): Promise<string[]> {
  const lots = [...new Set(lotIds)]
  if (lots.length === 0) return []
  const trace = await traceOf(db, entry.companyId, { styleId: entry.styleId, batchNumbers: [], serials: [], lotIds: lots, workOrderIds: [], shipmentIds: [] })
  return trace.workOrders.filter((order) => order.styleId === entry.styleId).map((order) => order.id)
}

/** The entry's own concern as a scope, its material lots followed to the work orders they went to (the trace). */
async function scopeOfEntry(db: Reader, entry: EntryRecord, lotIds: readonly string[]): Promise<RecallScope> {
  const lotOrders = await lotWorkOrders(db, entry, [...entry.lotIds, ...lotIds])
  return {
    wholeStyle: false,
    batchNumbers: cleanList(entry.batchNumbers),
    serials: cleanList(entry.serials),
    workOrderIds: [...new Set([...entry.workOrderIds, ...lotOrders])],
    shipmentIds: [...new Set(entry.shipmentIds)],
  }
}

// ---- draft -------------------------------------------------------------------------------------------------------------------

export interface DraftRecallBody extends ScopeInput {
  readonly kind: RecallKind
  readonly lotIds?: readonly string[] | undefined
  readonly publicNotice?: PublicNotice | undefined
  readonly noticeLanguages?: readonly string[] | undefined
  readonly note?: string | undefined
}

/** POST /compliance/register/:entryId/recalls: a DRAFT recall or withdrawal of the entry's style, numbered RCL-…. */
export async function draftRecall(caller: CommandCaller, entryId: string, body: DraftRecallBody, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const entry = await caller.withClient((db) => visibleEntry(db, context, entryId))
  assertMay(context, RECALL_MANAGE, entryScope(entry), 'Drafting a recall or withdrawal')
  if (entry.status !== 'OPEN') throw new ConflictError(`Register entry ${entry.reference} is closed: a recall or withdrawal is drafted while it is open.`)
  const { scope, notice } = await caller.withClient(async (db) => {
    const scope = scopeGiven(body) ? widenScope(scopeFrom(body), { workOrderIds: await lotWorkOrders(db, entry, body.lotIds ?? []) }) : await scopeOfEntry(db, entry, body.lotIds ?? [])
    await checkScope(db, entry.companyId, entry.styleId, scope)
    const notice = body.publicNotice ?? draftPublicNotice(await draftFactsOf(db, entry, { wholeStyle: scope.wholeStyle, batchNumbers: scope.batchNumbers, serialCount: scope.serials.length }), body.kind, body.noticeLanguages ?? [])
    return { scope, notice }
  })
  const problems = publicNoticeProblems(notice, 'body/publicNotice')
  if (problems.length > 0) throw new ValidationError('The public notice is not valid.', problems)
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.draft', idempotencyKey: key, input: { entryId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        const id = newId()
        const issued = await allocateNumber(tools, { companyId: entry.companyId, kind: 'RECALL' }, { type: 'RecallAction', id })
        const row = await tx.recallAction.create({
          data: {
            id,
            companyId: entry.companyId,
            registerEntryId: entry.id,
            number: issued.formatted,
            kind: body.kind,
            styleId: entry.styleId,
            wholeStyle: scope.wholeStyle,
            batchNumbers: [...scope.batchNumbers],
            serials: [...scope.serials],
            workOrderIds: [...scope.workOrderIds],
            shipmentIds: [...scope.shipmentIds],
            publicNotice: notice as unknown as Prisma.InputJsonObject,
            note: textOrNull(body.note),
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
          select: EMIT_SELECT,
        })
        audit({ recordType: 'RecallAction', recordId: id, companyId: entry.companyId, after: { number: issued.formatted, entryId: entry.id, kind: body.kind, styleId: entry.styleId, scope: auditScope(scope), noticeLanguages: Object.keys(notice), status: 'DRAFT' } })
        emitRecall(tools, row, 'DRAFTED')
        return { id }
      },
      settings(),
    ),
  )
  return recallAnswer(caller, result.id)
}

// ---- edit and widen -----------------------------------------------------------------------------------------------------------

export interface EditRecallBody extends ScopeInput {
  readonly version: number
  readonly publicNotice?: PublicNotice | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/recalls/:recallId: a DRAFT's scope and words; once started the scope only widens and a published notice only gains languages. */
export async function editRecall(caller: CommandCaller, recallId: string, body: EditRecallBody, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Editing a recall or withdrawal')
  const finished = before.status === 'CLOSED' || before.status === 'CANCELLED'
  if (finished && (scopeGiven(body) || body.publicNotice !== undefined)) throw new ConflictError(`${before.number} is ${before.status}: only its note changes.`)
  const old = scopeOfRecall(before)
  const scope = !scopeGiven(body) ? old : before.status === 'DRAFT' ? scopeFrom({ ...old, ...body }) : widenScope(old, scopeFrom(body))
  if (before.status === 'ACTIVE' && !scopeWidensOnly(old, scope)) throw new ConflictError('A started recall only widens its scope.')
  if (scopeGiven(body)) await caller.withClient((db) => checkScope(db, before.companyId, before.styleId, scope))
  const oldNotice = noticeOf(before.publicNotice)
  let notice: PublicNotice | null = oldNotice
  if (body.publicNotice !== undefined) {
    notice = before.noticePublishedAt !== null ? { ...(oldNotice ?? {}), ...body.publicNotice } : body.publicNotice
    if (before.noticePublishedAt !== null && oldNotice && !noticeOnlyGrows(oldNotice, notice)) {
      throw new ConflictError('The public notice was published: its words stay as they are; a language may be added.')
    }
    const problems = publicNoticeProblems(notice, 'body/publicNotice')
    if (problems.length > 0) throw new ValidationError('The public notice is not valid.', problems)
  }
  const widened = before.status === 'ACTIVE' && JSON.stringify(scope) !== JSON.stringify(old)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.edit', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await tx.recallAction.update({
          where: { id: recallId },
          data: {
            ...(scopeGiven(body) ? { wholeStyle: scope.wholeStyle, batchNumbers: [...scope.batchNumbers], serials: [...scope.serials], workOrderIds: [...scope.workOrderIds], shipmentIds: [...scope.shipmentIds] } : {}),
            ...(body.publicNotice !== undefined && notice ? { publicNotice: notice as unknown as Prisma.InputJsonObject } : {}),
            ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}),
            updatedAt: now,
          },
          select: EMIT_SELECT,
        })
        audit({
          recordType: 'RecallAction',
          recordId: recallId,
          companyId: before.companyId,
          before: { scope: auditScope(old), noticeLanguages: oldNotice ? Object.keys(oldNotice) : [], note: before.note },
          after: { scope: auditScope(scope), noticeLanguages: notice ? Object.keys(notice) : [], note: body.note !== undefined ? textOrNull(body.note) : before.note },
        })
        emitRecall(tools, row, widened ? 'WIDENED' : 'EDITED')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

// ---- start --------------------------------------------------------------------------------------------------------------------

/** POST /compliance/recalls/:recallId/start: DRAFT → ACTIVE by the person; a progress row per shipment that left with garments of the scope. */
export async function startRecall(caller: CommandCaller, recallId: string, body: { readonly version: number }, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Starting a recall or withdrawal')
  if (before.status !== 'DRAFT') throw new ConflictError(`${before.number} is ${before.status}: only a draft starts.`)
  if (before.registerEntry.status !== 'OPEN') throw new ConflictError(`Register entry ${before.registerEntry.reference} is closed: a recall starts while it is open.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.start', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const row = await tx.recallAction.update({ where: { id: recallId }, data: { status: 'ACTIVE', startedAt: now, startedById: context.actorId, updatedAt: now }, select: EMIT_SELECT })
        const trace = await traceOfRecall(tx, before)
        const rows = startingProgress(trace.shipments.map((shipment) => ({ shipmentId: shipment.id, partyId: shipment.partyId, garments: shipment.garments, left: shipment.left })), before.progress)
        for (const entry of rows) {
          const progressId = newId()
          await tx.recallProgress.create({ data: { id: progressId, recallActionId: recallId, partyId: entry.partyId, shipmentId: entry.shipmentId, unitsSent: entry.unitsSent, unitsStillOut: entry.unitsSent, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
          emit({ type: 'recall.progress_changed', subject: recallId, companyId: before.companyId, payload: { recallId, progressId, partyId: entry.partyId, shipmentId: entry.shipmentId, unitsSent: entry.unitsSent, unitsStillOut: entry.unitsSent, change: 'ADDED' } })
        }
        audit({ recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, before: { status: 'DRAFT' }, after: { status: 'ACTIVE', startedAt: toUtcIso(now), startedById: context.actorId, progressRows: rows.length, garmentsOut: rows.reduce((sum, entry) => sum + entry.unitsSent, 0) } })
        emitRecall(tools, row, 'STARTED')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

// ---- holds on what is still here ------------------------------------------------------------------------------------------

export interface HoldBody {
  readonly version: number
  readonly reasonCode: string
  readonly reasonNote?: string | undefined
  readonly ownerId?: string | undefined
  readonly note?: string | undefined
}

/**
 * POST /compliance/recalls/:recallId/holds: holds on what of the scope is still here, through quality/holds (sourceType
 * RecallAction): one hold per kind of record and site (at most 100 records each), in ONE command with the recall's own audit
 * row. The person needs quality.holds.place at each site (403 in words from the hold).
 */
export async function holdRecall(caller: CommandCaller, recallId: string, body: HoldBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Holding what a recall calls back')
  if (before.status !== 'DRAFT' && before.status !== 'ACTIVE') throw new ConflictError(`${before.number} is ${before.status}: its holds are kept as they are.`)
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.hold', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, audit } = tools
        const trace = await traceOfRecall(tx, before)
        const { picks, alreadyHeld } = await holdPlan(tx, before, trace)
        if (picks.length === 0) throw new DomainError('conflict', alreadyHeld > 0 ? 'Everything of it still here is on hold already.' : 'Nothing it calls back is still here to hold: what left is followed per customer.', [{ path: 'problem/NOTHING_TO_HOLD', message: 'Nothing to hold.' }])
        const groups = new Map<string, HoldPick[]>()
        for (const pick of picks) groups.set(`${pick.subjectType}:${pick.siteId}`, [...(groups.get(`${pick.subjectType}:${pick.siteId}`) ?? []), pick])
        const placed: { id: string; number: string | null; subjectType: HoldSubjectType; subjects: number; siteId: string }[] = []
        for (const group of groups.values()) {
          for (let start = 0; start < group.length; start += 100) {
            const chunk = group.slice(start, start + 100)
            const { hold } = await placeHoldInCommand(tools, {
              subjectType: chunk[0]!.subjectType,
              subjectIds: chunk.map((pick) => pick.id),
              reasonCode: body.reasonCode,
              reasonNote: body.reasonNote ?? `${before.kind === 'RECALL' ? 'Recall' : 'Withdrawal'} ${before.number}`,
              sourceType: 'RecallAction',
              sourceId: recallId,
              ownerId: body.ownerId ?? null,
              note: body.note ?? null,
            })
            placed.push({ id: hold.id, number: hold.number, subjectType: hold.subjectType as HoldSubjectType, subjects: hold.subjectIds.length, siteId: hold.siteId })
          }
        }
        audit({ action: 'compliance.recall.hold', recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, after: { holds: placed.map((hold) => hold.id), records: picks.length, alreadyHeld } })
        emitRecall(tools, { ...before, status: before.status as RecallStatus, kind: before.kind as RecallKind }, 'HOLDS_PLACED')
        return { placed, alreadyHeld }
      },
      settings(),
    ),
  )
  return { ...(await recallAnswer(caller, recallId)), placed: result.placed, alreadyHeld: result.alreadyHeld }
}

// ---- the public notice ------------------------------------------------------------------------------------------------------

/** POST /compliance/recalls/:recallId/notice/publish (compliance.recall.send, step-up): while ACTIVE, by the person. */
export async function publishNotice(caller: CommandCaller, recallId: string, body: { readonly version: number; readonly publicNotice?: PublicNotice | undefined }, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | null | undefined }): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_SEND, { companyId: before.companyId, partyId: before.registerEntry.partyId }, "Publishing a recall's public notice")
  options.stepUp()
  if (before.status !== 'ACTIVE') throw new ConflictError(before.status === 'DRAFT' ? `Start ${before.number} first: its notice is published while it runs.` : `${before.number} is ${before.status}: its notice is not published any more.`)
  if (before.noticePublishedAt !== null) throw new ConflictError(`The notice of ${before.number} was published on ${toUtcIso(before.noticePublishedAt)}.`)
  const notice = body.publicNotice ?? noticeOf(before.publicNotice)
  const problems = publicNoticeProblems(notice, 'body/publicNotice')
  if (problems.length > 0) throw new ValidationError('The public notice is not valid.', problems)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.publishNotice', idempotencyKey: options.idempotencyKey, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await tx.recallAction.update({ where: { id: recallId }, data: { publicNotice: notice as unknown as Prisma.InputJsonObject, noticePublishedAt: now, noticePublishedById: context.actorId, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, before: { noticePublishedAt: null }, after: { noticePublishedAt: toUtcIso(now), noticePublishedById: context.actorId, languages: Object.keys(notice!) } })
        emitRecall(tools, row, 'NOTICE_PUBLISHED')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

/** POST /compliance/recalls/:recallId/notice/withdraw: the public notice taken down (also after the close), once. */
export async function withdrawNotice(caller: CommandCaller, recallId: string, body: { readonly version: number; readonly note?: string | undefined }, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, "Taking down a recall's public notice")
  if (before.noticePublishedAt === null) throw new ConflictError(`The notice of ${before.number} was never published.`)
  if (before.noticeWithdrawnAt !== null) throw new ConflictError(`The notice of ${before.number} was taken down already.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.withdrawNotice', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await tx.recallAction.update({ where: { id: recallId }, data: { noticeWithdrawnAt: now, ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}), updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, before: { noticeWithdrawnAt: null }, after: { noticeWithdrawnAt: toUtcIso(now) }, ...(body.note ? { reason: body.note } : {}) })
        emitRecall(tools, row, 'NOTICE_WITHDRAWN')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

// ---- progress per customer ------------------------------------------------------------------------------------------------

export interface AddProgressBody {
  readonly partyId: string
  readonly shipmentId?: string | undefined
  readonly unitsSent: number
  readonly unitsReturned?: number | undefined
  readonly unitsRepaired?: number | undefined
  readonly unitsDestroyed?: number | undefined
  readonly note?: string | undefined
}

/** POST /compliance/recalls/:recallId/progress: a customer (and shipment) the start did not find, with what it got. */
export async function addProgress(caller: CommandCaller, recallId: string, body: AddProgressBody, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Following a recall per customer')
  if (before.status !== 'DRAFT' && before.status !== 'ACTIVE') throw new ConflictError(`${before.number} is ${before.status}: its progress stays as it ended.`)
  const counts = { unitsSent: body.unitsSent, unitsReturned: body.unitsReturned ?? 0, unitsRepaired: body.unitsRepaired ?? 0, unitsDestroyed: body.unitsDestroyed ?? 0 }
  const problems = progressProblems(counts)
  if (problems.length > 0) throw new ValidationError('The counts are not valid.', problems)
  const sameCustomer = before.progress.filter((entry) => entry.partyId === body.partyId)
  if (sameCustomer.some((entry) => (entry.shipmentId ?? null) === (body.shipmentId ?? null))) throw new ConflictError('This customer (and shipment) has its row already: record its counts there.')
  if (body.shipmentId === undefined ? sameCustomer.length > 0 : sameCustomer.some((entry) => entry.shipmentId === null)) {
    throw new ConflictError('A customer is followed either as a whole or per shipment, not both: record the counts on its rows.')
  }
  await caller.withClient(async (db) => {
    const party = await db.party.findUnique({ where: { id: body.partyId }, select: { companyId: true } })
    if (!party || (party.companyId !== null && party.companyId !== before.companyId)) throw new ValidationError('The customer is not a party of this company.', [{ path: 'body/partyId', message: 'Choose a party of this company (or of every company).' }])
    if (body.shipmentId) {
      const shipment = await db.shipment.findUnique({ where: { id: body.shipmentId }, select: { companyId: true, partyId: true } })
      if (!shipment || shipment.companyId !== before.companyId || shipment.partyId !== body.partyId) throw new ValidationError('The shipment is not one of this company to this customer.', [{ path: 'body/shipmentId', message: 'Choose a shipment of this company to this customer.' }])
    }
  })
  await guarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.recall.addProgress', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId } },
        async (tools) => {
          const { tx, now, audit, emit } = tools
          const progressId = newId()
          const unitsStillOut = stillOutOf(counts)!
          await tx.recallProgress.create({ data: { id: progressId, recallActionId: recallId, partyId: body.partyId, shipmentId: body.shipmentId ?? null, ...counts, unitsStillOut, note: textOrNull(body.note), createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
          audit({ recordType: 'RecallProgress', recordId: progressId, companyId: before.companyId, after: { recallId, partyId: body.partyId, shipmentId: body.shipmentId ?? null, ...counts, unitsStillOut } })
          emit({ type: 'recall.progress_changed', subject: recallId, companyId: before.companyId, payload: { recallId, progressId, partyId: body.partyId, shipmentId: body.shipmentId ?? null, unitsSent: counts.unitsSent, unitsStillOut, change: 'ADDED' } })
          return {}
        },
        settings(),
      ),
    { taken: 'This customer (and shipment) has its row already.' },
  )
  return recallAnswer(caller, recallId)
}

export interface RecordProgressBody {
  readonly version: number
  readonly unitsSent?: number | undefined
  readonly unitsReturned?: number | undefined
  readonly unitsRepaired?: number | undefined
  readonly unitsDestroyed?: number | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/recalls/:recallId/progress/:progressId: what came back, was repaired or destroyed (still out follows). */
export async function recordProgress(caller: CommandCaller, recallId: string, progressId: string, body: RecordProgressBody, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Following a recall per customer')
  const row = before.progress.find((entry) => entry.id === progressId)
  if (!row) throw new NotFoundError('Progress row not found.')
  if (before.status !== 'DRAFT' && before.status !== 'ACTIVE') throw new ConflictError(`${before.number} is ${before.status}: its progress stays as it ended.`)
  const counts = {
    unitsSent: body.unitsSent ?? row.unitsSent,
    unitsReturned: body.unitsReturned ?? row.unitsReturned,
    unitsRepaired: body.unitsRepaired ?? row.unitsRepaired,
    unitsDestroyed: body.unitsDestroyed ?? row.unitsDestroyed,
  }
  const problems = progressProblems(counts)
  if (problems.length > 0) throw new ValidationError('The counts are not valid.', problems)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.recordProgress', idempotencyKey: key, input: { recallId, progressId, ...body }, record: { type: 'RecallProgress', id: progressId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const unitsStillOut = stillOutOf(counts)!
        await tx.recallProgress.update({ where: { id: progressId }, data: { ...counts, unitsStillOut, ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}), updatedAt: now }, select: { id: true } })
        audit({
          recordType: 'RecallProgress',
          recordId: progressId,
          companyId: before.companyId,
          before: { unitsSent: row.unitsSent, unitsReturned: row.unitsReturned, unitsRepaired: row.unitsRepaired, unitsDestroyed: row.unitsDestroyed, unitsStillOut: row.unitsStillOut },
          after: { ...counts, unitsStillOut },
        })
        emit({ type: 'recall.progress_changed', subject: recallId, companyId: before.companyId, payload: { recallId, progressId, partyId: row.partyId, shipmentId: row.shipmentId, unitsSent: counts.unitsSent, unitsStillOut, change: 'RECORDED' } })
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

// ---- close and cancel ------------------------------------------------------------------------------------------------------

/** POST /compliance/recalls/:recallId/close: ACTIVE → CLOSED with how it ended (units still out are said in the note). */
export async function closeRecall(caller: CommandCaller, recallId: string, body: { readonly version: number; readonly closeNote: string }, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Closing a recall or withdrawal')
  if (before.status !== 'ACTIVE') throw new ConflictError(before.status === 'DRAFT' ? `${before.number} never started: cancel it instead.` : `${before.number} is ${before.status} already.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.close', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const closeNote = body.closeNote.trim()
        const row = await tx.recallAction.update({ where: { id: recallId }, data: { status: 'CLOSED', closedAt: now, closedById: context.actorId, closeNote, updatedAt: now }, select: EMIT_SELECT })
        const summary = progressSummary(before.progress)
        audit({ recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, before: { status: 'ACTIVE' }, after: { status: 'CLOSED', closedAt: toUtcIso(now), closedById: context.actorId, unitsStillOut: summary.unitsStillOut }, reason: closeNote })
        emitRecall(tools, row, 'CLOSED')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

/** POST /compliance/recalls/:recallId/cancel: a DRAFT never started, with why. */
export async function cancelRecall(caller: CommandCaller, recallId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined): Promise<{ recall: RecallDetail }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readRecall(db, context, recallId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Cancelling a recall or withdrawal')
  if (before.status !== 'DRAFT') throw new ConflictError(before.status === 'ACTIVE' ? `${before.number} started: close it with how it ended.` : `${before.number} is ${before.status} already.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.cancel', idempotencyKey: key, input: { recallId, ...body }, record: { type: 'RecallAction', id: recallId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const reason = body.reason.trim()
        const row = await tx.recallAction.update({ where: { id: recallId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'RecallAction', recordId: recallId, companyId: before.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason })
        emitRecall(tools, row, 'CANCELLED')
        return {}
      },
      settings(),
    ),
  )
  return recallAnswer(caller, recallId)
}

/** The entry of a recall (the distributors' notices name it). */
export async function entryOfRecall(db: Reader, recallId: string): Promise<EntryRecord | null> {
  const row = await db.recallAction.findUnique({ where: { id: recallId }, select: { registerEntryId: true } })
  return row ? readEntry(db, row.registerEntryId) : null
}
