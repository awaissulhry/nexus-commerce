import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency, type CostingMaterial } from '@nexus/factory-domain/costing/inputs'
import { COSTING_STANDARDS_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { cellView, exactCell, missingView, prepareSheet } from '@nexus/factory-domain/costing/sheet'
import type {
  CreateStandardBody,
  PrepareStandardsBody,
  StandardCostRecordView,
  StandardCostView,
  StandardsQuery,
  UpdateStandardBody,
} from '@nexus/factory-domain/costing/standards/contracts'
import {
  costText,
  freezePlan,
  partsProblems,
  periodProblems,
  STANDARD_PARTS,
  unitCostOf,
  type StandardCostChange,
  type StandardParts,
} from '@nexus/factory-domain/costing/standards/rules'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { decimalOf, decimalText, QUANTITY_SCALE, roundTo } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { LEDGER_SELECT, valueMovesInCommand } from '../../inventory/ledger/post-moves'
import { finishedItemFor } from '../../inventory/finished/post'
import { REVISION_COLUMNS } from '../../product/bom/store'
import { contextOf } from '../../product/materials/store'
import { postCostsInCommand } from '../actual/post'
import { frozenStandards, lockedPeriods, romeDay, standardFor, unique, type Reader } from '../actual/store'
import { dayOf } from '../inputs'
import { loadCostFacts, STYLE_COLUMNS } from '../store'

/**
 * Standard costs (B-W2a-21; FIN-024; design finance.costing "Standard cost per item"): what one base unit of an item should
 * cost in a period, per company (factory-db StandardCost; rules in factory-domain costing/standards). Reads need
 * costing.view over the company; writes costing.standards.manage, and a figure sent the cost grain (the grain filter
 * refuses it otherwise). Every write is one command with its audit rows (figures marked cost) and events.
 *
 *   prepare   DRAFTs for a period: a finished garment from its style's released revision's cost sheet cell (ROLLUP: the
 *             materials at the company's frozen standards of the first day, else their standard purchase price; the
 *             labour rates in force that day; the overhead now), a material from its standard purchase price (PURCHASE)
 *   create    a DRAFT typed by finance (MANUAL) or from a supplier's price (PURCHASE)
 *   update    a DRAFT corrected; discard: a DRAFT deleted
 *   freeze    DRAFT → FROZEN (who, when): the open frozen standard before it is ended on the day before its first day
 *             (refused in words when another frozen one would overlap, or its first day is in a locked period); a
 *             finished item's stock moves that had no value yet (B-W2a-12 values a receipt, B-W2a-43 a customer return
 *             put back into stock, at the standard in force on their day: inventory/finished/post.ts standardCostFor)
 *             are valued at it now when their day is in its period and not locked, and the receipts' work orders'
 *             COMPLETION entries are posted in the same command.
 * Freezing does NOT write the W1 Item.standardCost: an item is tenant-wide or of one company while a standard is per
 * company and period; the cost sheet and quotes keep reading Item.standardCost, and the receipts, the ledger and the
 * variance read the frozen standard first.
 */

const STANDARD_COLUMNS = {
  id: true,
  companyId: true,
  itemId: true,
  validFrom: true,
  validTo: true,
  status: true,
  source: true,
  currency: true,
  materialCost: true,
  labourCost: true,
  subcontractCost: true,
  overheadCost: true,
  unitCost: true,
  labourMinutes: true,
  breakdown: true,
  note: true,
  frozenAt: true,
  frozenById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StandardCostSelect
type StandardRow = Prisma.StandardCostGetPayload<{ select: typeof STANDARD_COLUMNS }>

const ITEM_COLUMNS = { id: true, code: true, name: true, kind: true, baseUom: true, companyId: true, standardCost: true, currency: true, variantId: true } as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The standard cost is not valid.', issues)
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const minutesText = (value: { toString(): string }): string => decimalText(roundTo(value.toString(), { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }))

function viewOf(row: StandardRow, item: ItemRow, today: string): StandardCostView {
  const validFrom = dayOf(row.validFrom)
  const validTo = row.validTo ? dayOf(row.validTo) : null
  return {
    id: row.id,
    companyId: row.companyId,
    item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom },
    validFrom,
    validTo,
    status: row.status,
    source: row.source,
    currency: row.currency,
    materialCost: asMoney('cost', text(row.materialCost)),
    labourCost: asMoney('cost', text(row.labourCost)),
    subcontractCost: asMoney('cost', text(row.subcontractCost)),
    overheadCost: asMoney('cost', text(row.overheadCost)),
    unitCost: asMoney('cost', text(row.unitCost)),
    labourMinutes: row.labourMinutes === null ? null : text(row.labourMinutes),
    note: row.note,
    inForce: row.status === 'FROZEN' && validFrom <= today && (validTo === null || validTo >= today),
    frozenAt: row.frozenAt ? toUtcIso(row.frozenAt) : null,
    frozenById: row.frozenById,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

async function viewsOf(db: Reader, rows: readonly StandardRow[]): Promise<StandardCostRecordView[]> {
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(rows.map((row) => row.itemId)) } }, select: ITEM_COLUMNS })).map((row) => [row.id, row]))
  const today = businessDate(serverClock.now())
  return rows.map((row) => ({ ...viewOf(row, items.get(row.itemId)!, today), breakdown: asMoney('cost', (row.breakdown ?? null) as unknown) }))
}

const strip = ({ breakdown: _breakdown, ...view }: StandardCostRecordView): StandardCostView => view

// ---- reads ---------------------------------------------------------------------------------------------------------------

/** GET /costing/standards: newest first, in pages. */
export async function listStandards(caller: CommandCaller, query: StandardsQuery): Promise<{ standards: StandardCostView[]; nextCursor: string | null }> {
  const actor = actorOf(contextOf(caller))
  const on = query.on ? dateOf(query.on) : null
  const where: Prisma.StandardCostWhereInput = {
    AND: [
      scopeWhere(actor, COSTING_VIEW, { company: 'companyId' }) as Prisma.StandardCostWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.itemId ? { itemId: query.itemId } : {},
      query.status ? { status: query.status } : {},
      on ? { status: 'FROZEN', validFrom: { lte: on }, OR: [{ validTo: null }, { validTo: { gte: on } }] } : {},
      query.kind === 'FINISHED' ? { item: { kind: 'FINISHED' } } : query.kind === 'MATERIAL' ? { item: { kind: { not: 'FINISHED' } } } : {},
      query.q ? { item: { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.standardCost.findMany({ where, select: STANDARD_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { standards: (await viewsOf(db, page)).map(strip), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

async function readStandard(caller: CommandCaller, standardId: string): Promise<StandardRow> {
  const actor = actorOf(contextOf(caller))
  const row = isUuid(standardId) ? await caller.withClient((db) => db.standardCost.findUnique({ where: { id: standardId }, select: STANDARD_COLUMNS })) : null
  if (!row || !can(actor, COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Standard cost not found.')
  return row
}

/** GET /costing/standards/:standardId: one standard with how it was built. */
export async function standardRecord(caller: CommandCaller, standardId: string): Promise<StandardCostRecordView> {
  const row = await readStandard(caller, standardId)
  return caller.withClient(async (db) => (await viewsOf(db, [row]))[0]!)
}

// ---- writes ----------------------------------------------------------------------------------------------------------

function assertManage(caller: CommandCaller, companyId: string): void {
  if (!can(actorOf(contextOf(caller)), COSTING_STANDARDS_MANAGE, { companyId })) throw new ForbiddenError()
}

/** The company the standard is for (costing.view, else not found), with the currency its standards are kept in. */
async function companyFor(caller: CommandCaller, companyId: string): Promise<{ id: string; currency: string }> {
  const row = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true, currency: true } })) : null
  if (!row || !can(actorOf(contextOf(caller)), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return { id: row.id, currency: costingCurrency(row.currency) }
}

const fromAnotherCompany = (item: ItemRow, companyId: string): boolean => item.companyId !== null && item.companyId !== companyId

const taken = (code: string, day: string) => new ConflictError(`A standard of ${code} from ${day} exists already for this company: correct that one, or choose another first day.`)

const change = (tools: Pick<CommandTools, 'emit'>, row: Pick<StandardRow, 'id' | 'itemId' | 'companyId' | 'validFrom' | 'status'>, kind: StandardCostChange) =>
  tools.emit({ type: 'standard_cost.changed', subject: row.id, companyId: row.companyId, payload: { standardId: row.id, itemId: row.itemId, validFrom: dayOf(row.validFrom), status: row.status, change: kind } })

const auditedParts = (parts: StandardParts & { unitCost: string }) => Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, markMoney('cost', value)]))

/** costing.createStandard: a DRAFT typed by finance (parts not sent are 0; at least one is sent). */
export async function createStandard(caller: CommandCaller, body: CreateStandardBody, idempotencyKey?: string): Promise<StandardCostRecordView> {
  assertManage(caller, body.companyId)
  const company = await companyFor(caller, body.companyId)
  const sent = STANDARD_PARTS.filter((part) => body[part] !== undefined)
  if (sent.length === 0) throw invalid([{ path: 'body/materialCost', message: "Send the standard's costs (material, labour, subcontract, overhead per base unit)." }])
  const parts = Object.fromEntries(STANDARD_PARTS.map((part) => [part, body[part] === undefined ? '0' : costText(body[part] as string)])) as StandardParts
  const problems = [...partsProblems(parts), ...periodProblems(body.validFrom, body.validTo ?? null)]
  if (problems.length > 0) throw invalid(problems)
  const item = isUuid(body.itemId) ? await caller.withClient((db) => db.item.findUnique({ where: { id: body.itemId }, select: ITEM_COLUMNS })) : null
  if (!item) throw invalid([{ path: 'body/itemId', message: 'No such item.' }])
  if (fromAnotherCompany(item, company.id)) throw invalid([{ path: 'body/itemId', message: 'This item belongs to another company.' }])
  const { result } = await command(caller, { name: 'costing.createStandard', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const id = newId()
    const unitCost = unitCostOf(parts)
    const labourMinutes = body.labourMinutes === undefined || body.labourMinutes === null ? null : minutesText(body.labourMinutes)
    const data = { companyId: company.id, itemId: item.id, validFrom: dateOf(body.validFrom), validTo: body.validTo ? dateOf(body.validTo) : null, source: body.source ?? 'MANUAL', currency: company.currency, ...parts, unitCost, labourMinutes, note: body.note ?? null }
    await tx.standardCost.create({ data: { id, ...data, breakdown: { basis: data.source, typedBy: 'finance' }, createdAt: now, updatedAt: now, createdById: officeActor(tools) }, select: { id: true } })
    tools.audit({ recordType: 'StandardCost', recordId: id, companyId: company.id, after: { itemId: item.id, validFrom: body.validFrom, validTo: body.validTo ?? null, source: data.source, currency: company.currency, ...auditedParts({ ...parts, unitCost }), labourMinutes, status: 'DRAFT' } })
    const row = await tx.standardCost.findUniqueOrThrow({ where: { id }, select: STANDARD_COLUMNS })
    change(tools, row, 'prepared')
    return (await viewsOf(tx, [row]))[0]!
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw taken(item.code, body.validFrom)
    throw error
  })
  return result
}

const officeActor = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** costing.updateStandard: a DRAFT corrected (only the fields sent change). */
export async function updateStandard(caller: CommandCaller, standardId: string, body: UpdateStandardBody, idempotencyKey?: string): Promise<StandardCostRecordView> {
  const seen = await readStandard(caller, standardId)
  assertManage(caller, seen.companyId)
  if (seen.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen for its period: prepare a standard for the next period instead.')
  const problems = partsProblems(Object.fromEntries(STANDARD_PARTS.flatMap((part) => (body[part] === undefined ? [] : [[part, body[part] as string]]))))
  if (problems.length > 0) throw invalid(problems)
  const { result } = await command(
    caller,
    { name: 'costing.updateStandard', idempotencyKey, input: { standardId, ...body }, record: { type: 'StandardCost', id: standardId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.standardCost.findUniqueOrThrow({ where: { id: standardId }, select: STANDARD_COLUMNS })
      if (row.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen for its period: prepare a standard for the next period instead.')
      const before = Object.fromEntries(STANDARD_PARTS.map((part) => [part, text(row[part])])) as StandardParts
      const parts = Object.fromEntries(STANDARD_PARTS.map((part) => [part, body[part] === undefined ? before[part] : costText(body[part] as string)])) as StandardParts
      const validFrom = body.validFrom ?? dayOf(row.validFrom)
      const validTo = body.validTo === undefined ? (row.validTo ? dayOf(row.validTo) : null) : body.validTo
      const period = periodProblems(validFrom, validTo)
      if (period.length > 0) throw invalid(period)
      const unitCost = unitCostOf(parts)
      await tx.standardCost.update({
        where: { id: standardId },
        data: {
          ...parts,
          unitCost,
          validFrom: dateOf(validFrom),
          validTo: validTo ? dateOf(validTo) : null,
          ...(body.source ? { source: body.source } : {}),
          ...(body.labourMinutes === undefined ? {} : { labourMinutes: body.labourMinutes === null ? null : minutesText(body.labourMinutes) }),
          ...(body.note === undefined ? {} : { note: body.note }),
          updatedAt: now,
        },
        select: { id: true },
      })
      tools.audit({
        recordType: 'StandardCost',
        recordId: standardId,
        companyId: row.companyId,
        before: { validFrom: dayOf(row.validFrom), validTo: row.validTo ? dayOf(row.validTo) : null, ...auditedParts({ ...before, unitCost: text(row.unitCost) }) },
        after: { validFrom, validTo, ...auditedParts({ ...parts, unitCost }), ...(body.note === undefined ? {} : { note: body.note }) },
      })
      const next = await tx.standardCost.findUniqueOrThrow({ where: { id: standardId }, select: STANDARD_COLUMNS })
      change(tools, next, 'updated')
      return (await viewsOf(tx, [next]))[0]!
    },
  ).catch(async (error: unknown) => {
    if (isUniqueViolation(error)) throw taken((await caller.withClient((db) => db.item.findUnique({ where: { id: seen.itemId }, select: { code: true } })))?.code ?? 'this item', body.validFrom ?? dayOf(seen.validFrom))
    throw error
  })
  return result
}

/** costing.discardStandard: a DRAFT deleted (a frozen one never is). */
export async function discardStandard(caller: CommandCaller, standardId: string, version: number, idempotencyKey?: string): Promise<{ id: string; discarded: true }> {
  const seen = await readStandard(caller, standardId)
  assertManage(caller, seen.companyId)
  if (seen.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen: it is never deleted (the next period gets its own).')
  const { result } = await command(
    caller,
    { name: 'costing.discardStandard', idempotencyKey, input: { standardId, version }, record: { type: 'StandardCost', id: standardId, expectedVersion: version } },
    async (tools) => {
      const row = await tools.tx.standardCost.findUniqueOrThrow({ where: { id: standardId }, select: STANDARD_COLUMNS })
      if (row.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen: it is never deleted (the next period gets its own).')
      await tools.tx.standardCost.delete({ where: { id: standardId }, select: { id: true } })
      tools.audit({ action: 'costing.discardStandard', recordType: 'StandardCost', recordId: standardId, companyId: row.companyId, before: { status: 'DRAFT', validFrom: dayOf(row.validFrom), unitCost: markMoney('cost', text(row.unitCost)) } })
      change(tools, row, 'discarded')
      return { id: standardId, discarded: true as const }
    },
  )
  return result
}

/**
 * costing.freezeStandard: DRAFT → FROZEN; the open frozen standard before it ends the day before; the finished item's stock
 * moves that waited for a value are valued at it (inside its period, outside a locked one) and the receipts' COMPLETION
 * entries posted.
 */
export async function freezeStandard(caller: CommandCaller, standardId: string, version: number, idempotencyKey?: string) {
  const seen = await readStandard(caller, standardId)
  assertManage(caller, seen.companyId)
  if (seen.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen already.')
  const { result } = await command(
    caller,
    { name: 'costing.freezeStandard', idempotencyKey, input: { standardId, version }, record: { type: 'StandardCost', id: standardId, expectedVersion: version } },
    async (tools) => {
      const { tx, now } = tools
      if (!('tenantId' in tools.context)) throw new ForbiddenError()
      // The trigger's own lock (factory_money_lock 'standard-cost'): two freezes of the company never cross.
      await tx.$executeRaw`SELECT "factory_money_lock"('standard-cost', ${tools.context.tenantId}::uuid, ${seen.companyId}::uuid)`
      const row = await tx.standardCost.findUniqueOrThrow({ where: { id: standardId }, select: STANDARD_COLUMNS })
      if (row.status !== 'DRAFT') throw new InvalidStateError('This standard is frozen already.')
      const target = { id: row.id, validFrom: dayOf(row.validFrom), validTo: row.validTo ? dayOf(row.validTo) : null }
      const lock = (await lockedPeriods(tx, row.companyId)).find((period) => period.periodStart <= target.validFrom && target.validFrom <= period.periodEnd)
      if (lock) throw new ConflictError(`${target.validFrom} is in the locked period ${lock.periodStart} to ${lock.periodEnd}: a standard is frozen from a day after it.`)
      const others = await tx.standardCost.findMany({ where: { companyId: row.companyId, itemId: row.itemId, status: 'FROZEN' }, select: STANDARD_COLUMNS })
      const plan = freezePlan(target, others.map((other) => ({ id: other.id, status: other.status, validFrom: dayOf(other.validFrom), validTo: other.validTo ? dayOf(other.validTo) : null, currency: other.currency })))
      if (plan.problem) throw new ConflictError(plan.problem)
      const actorId = officeActor(tools)
      if (!actorId) throw new ForbiddenError()
      let ended: StandardRow | null = null
      if (plan.end) {
        await tx.standardCost.update({ where: { id: plan.end.id }, data: { validTo: dateOf(plan.end.validTo), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        ended = await tx.standardCost.findUniqueOrThrow({ where: { id: plan.end.id }, select: STANDARD_COLUMNS })
        tools.audit({ action: 'costing.endStandard', recordType: 'StandardCost', recordId: ended.id, companyId: ended.companyId, before: { validTo: null }, after: { validTo: plan.end.validTo }, reason: `The standard from ${target.validFrom} takes over.` })
        change(tools, ended, 'ended')
      }
      await tx.standardCost.update({ where: { id: standardId }, data: { status: 'FROZEN', frozenAt: now, frozenById: actorId, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'StandardCost', recordId: standardId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'FROZEN', validFrom: target.validFrom, validTo: target.validTo, unitCost: markMoney('cost', text(row.unitCost)) } })
      const frozen = await tx.standardCost.findUniqueOrThrow({ where: { id: standardId }, select: STANDARD_COLUMNS })
      change(tools, frozen, 'frozen')
      const valued = await valueWaitingMoves(tools, frozen)
      const [view, endedView] = await viewsOf(tx, ended ? [frozen, ended] : [frozen])
      return { standard: view!, ended: endedView ? strip(endedView) : null, valued }
    },
  )
  return result
}

/**
 * The finished item's stock moves at the company's sites that have no value yet and fall in the standard's period, with
 * their reversals: valued now at the standard (STANDARD_COST), as inventory/finished/post.ts standardCostFor would have
 * valued them on their day had the standard been frozen then: its production receipts (B-W2a-12), the customer returns put
 * back into stock (B-W2a-43: RESTOCK, SECOND_QUALITY, QUARANTINE, ADJUSTMENT in) and whatever else moved the garment in or
 * out of stock meanwhile (a shipment taken from stock, a count, a write-off). Then the receipts' work orders' COMPLETION
 * entries are posted. A move of a locked month, or an item kept in another currency than the standard's, stays as it is
 * (said in words). A transfer between two places changes no stock value and is not valued.
 */
async function valueWaitingMoves(tools: CommandTools, standard: StandardRow) {
  const { tx } = tools
  const item = await tx.item.findUniqueOrThrow({ where: { id: standard.itemId }, select: { kind: true, currency: true } })
  const out = { moves: 0, workOrders: [] as { id: string; number: string }[], skipped: [] as { moveId: string; reason: string }[] }
  if (item.kind !== 'FINISHED') return out
  const from = dateOf(dayOf(standard.validFrom))
  const sites = (await tx.site.findMany({ where: { companyId: standard.companyId }, select: { id: true } })).map((site) => site.id)
  const waiting = await tx.stockMove.findMany({
    where: {
      itemId: standard.itemId,
      siteId: { in: sites },
      reversalOfId: null,
      valuations: { none: {} },
      occurredAt: { gte: new Date(from.getTime() - 2 * 86_400_000) },
      OR: [
        { fromLocationId: null, NOT: { toLocationId: null } },
        { toLocationId: null, NOT: { fromLocationId: null } },
      ],
    },
    select: LEDGER_SELECT,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  const validTo = standard.validTo ? dayOf(standard.validTo) : null
  const inPeriod = waiting.filter((move) => romeDay(move.occurredAt) >= dayOf(standard.validFrom) && (validTo === null || romeDay(move.occurredAt) <= validTo))
  if (inPeriod.length === 0) return out
  const locks = await lockedPeriods(tx, standard.companyId)
  const open = inPeriod.filter((move) => {
    const day = romeDay(move.occurredAt)
    const lock = locks.find((period) => period.periodStart <= day && day <= period.periodEnd)
    if (lock) out.skipped.push({ moveId: move.id, reason: `Its day ${day} is in the locked period ${lock.periodStart} to ${lock.periodEnd}: it stays unvalued.` })
    else if (item.currency !== standard.currency) out.skipped.push({ moveId: move.id, reason: `The item is kept in ${item.currency}, the standard in ${standard.currency}: no exchange rates.` })
    return !lock && item.currency === standard.currency
  })
  if (open.length === 0) return out
  const reversals = await tx.stockMove.findMany({ where: { reversalOfId: { in: open.map((move) => move.id) }, valuations: { none: {} } }, select: LEDGER_SELECT })
  const cost = { method: 'STANDARD_COST' as const, unitCost: text(standard.unitCost) }
  const moves = [...open, ...reversals].map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() }))
  const done = await valueMovesInCommand(tools, moves, moves.map((move) => ({ cost: move.reversalOfId ? null : cost })))
  out.moves = done.size
  const workOrderIds = unique(open.filter((move) => done.has(move.id) && move.reason === 'PRODUCTION_RECEIPT').map((move) => move.workOrderId))
  // planCosts reads only the work order's own moves among these.
  for (const workOrderId of workOrderIds) await postCostsInCommand(tools, workOrderId, { moveIds: moves.map((move) => move.id) })
  const numbers = await tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } })
  out.workOrders = numbers
  return out
}

// ---- prepare -----------------------------------------------------------------------------------------------------------

interface Prepared {
  readonly itemId: string
  readonly source: 'ROLLUP' | 'PURCHASE'
  readonly parts: StandardParts
  readonly labourMinutes: string | null
  readonly breakdown: Prisma.InputJsonValue
}

/**
 * costing.prepareStandards: DRAFTs for a period, one per item asked (a finished garment's SKU or FINISHED item: its cost
 * sheet cell; a material: its standard purchase price). What cannot be prepared is answered as skipped, in words.
 */
export async function prepareStandards(caller: CommandCaller, body: PrepareStandardsBody, idempotencyKey?: string) {
  assertManage(caller, body.companyId)
  const company = await companyFor(caller, body.companyId)
  const period = periodProblems(body.validFrom, body.validTo ?? null)
  if (period.length > 0) throw invalid(period)
  const { result } = await command(caller, { name: 'costing.prepareStandards', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const prepared: StandardRow[] = []
    const skipped: { index: number; itemId: string | null; variantId: string | null; code: string | null; reason: string; missing: string[] }[] = []
    for (const [index, asked] of body.items.entries()) {
      const skip = (reason: string, code: string | null = null, missing: string[] = []) => skipped.push({ index, itemId: asked.itemId ?? null, variantId: asked.variantId ?? null, code, reason, missing })
      const outcome = await prepareOne(tools, company, body.validFrom, asked)
      if ('skip' in outcome) {
        skip(outcome.skip, outcome.code, outcome.missing)
        continue
      }
      const { item, draft } = outcome
      const existing = await tx.standardCost.findFirst({ where: { companyId: company.id, itemId: item.id, validFrom: dateOf(body.validFrom) }, select: STANDARD_COLUMNS })
      if (existing?.status === 'FROZEN') {
        skip(`A standard of ${item.code} from ${body.validFrom} is frozen already.`, item.code)
        continue
      }
      const unitCost = unitCostOf(draft.parts)
      const data = {
        validTo: body.validTo ? dateOf(body.validTo) : null,
        source: draft.source,
        currency: company.currency,
        ...draft.parts,
        unitCost,
        labourMinutes: draft.labourMinutes,
        breakdown: draft.breakdown,
        note: body.note ?? null,
        updatedAt: now,
      }
      const id = existing?.id ?? newId()
      if (existing) await tx.standardCost.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
      else await tx.standardCost.create({ data: { id, companyId: company.id, itemId: item.id, validFrom: dateOf(body.validFrom), ...data, createdAt: now, createdById: officeActor(tools) }, select: { id: true } })
      tools.audit({
        action: 'costing.prepareStandard',
        recordType: 'StandardCost',
        recordId: id,
        companyId: company.id,
        ...(existing ? { before: auditedParts({ ...(Object.fromEntries(STANDARD_PARTS.map((part) => [part, text(existing[part])])) as StandardParts), unitCost: text(existing.unitCost) }) } : {}),
        after: { itemId: item.id, validFrom: body.validFrom, source: draft.source, ...auditedParts({ ...draft.parts, unitCost }), status: 'DRAFT' },
      })
      const row = await tx.standardCost.findUniqueOrThrow({ where: { id }, select: STANDARD_COLUMNS })
      change(tools, row, existing ? 'updated' : 'prepared')
      prepared.push(row)
    }
    if (prepared.length === 0) tools.audit({ action: 'costing.prepareStandards', recordType: 'Company', recordId: company.id, companyId: company.id, after: { prepared: 0, skipped: skipped.length } })
    return { prepared: await viewsOf(tx, prepared), skipped }
  })
  return result
}

type PrepareOutcome = { item: ItemRow; draft: Prepared } | { skip: string; code: string | null; missing: string[] }

async function prepareOne(tools: CommandTools, company: { id: string; currency: string }, validFrom: string, asked: { itemId?: string | undefined; variantId?: string | undefined }): Promise<PrepareOutcome> {
  const { tx, now } = tools
  let item = asked.itemId ? await tx.item.findUnique({ where: { id: asked.itemId }, select: ITEM_COLUMNS }) : null
  if (asked.itemId && !item) return { skip: 'No such item.', code: null, missing: [] }
  const variantId = asked.variantId ?? item?.variantId ?? null
  if (item && item.kind !== 'FINISHED') {
    // A material: its standard purchase price.
    if (fromAnotherCompany(item, company.id)) return { skip: `${item.code} belongs to another company.`, code: item.code, missing: [] }
    if (item.standardCost === null) return { skip: `${item.code} has no standard purchase price: type the standard instead.`, code: item.code, missing: [] }
    if (item.currency !== company.currency) return { skip: `${item.code} is priced in ${item.currency}; the company keeps its costs in ${company.currency} (no exchange rates).`, code: item.code, missing: [] }
    const materialCost = costText(item.standardCost.toString())
    return { item, draft: { itemId: item.id, source: 'PURCHASE', parts: { materialCost, labourCost: '0', subcontractCost: '0', overheadCost: '0' }, labourMinutes: null, breakdown: { basis: 'PURCHASE', from: 'the item standard purchase price', on: validFrom } } }
  }
  // A finished garment: its SKU's cost sheet cell.
  const variant = variantId ? await tx.variant.findUnique({ where: { id: variantId }, select: { id: true, sku: true, styleId: true, colourwayId: true, size: true } }) : null
  if (!variant) return { skip: 'No such SKU.', code: item?.code ?? null, missing: [] }
  const style = await tx.style.findUnique({ where: { id: variant.styleId }, select: { ...STYLE_COLUMNS, garmentTracking: true } })
  if (!style) return { skip: 'No such style.', code: variant.sku, missing: [] }
  if (style.companyId !== null && style.companyId !== company.id) return { skip: `${variant.sku}'s style belongs to another company.`, code: variant.sku, missing: [] }
  const revision = await tx.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, orderBy: { revision: 'desc' }, select: REVISION_COLUMNS })
  if (!revision) return { skip: `${style.code} has no released revision to cost.`, code: variant.sku, missing: [] }
  const loaded = await loadCostFacts(tx, style, revision, { id: company.id, currency: company.currency }, now)
  if (!loaded.facts.colourwayIds.includes(variant.colourwayId)) return { skip: `${variant.sku}'s colourway is not an active one of ${style.code}.`, code: variant.sku, missing: [] }
  if (!loaded.facts.sizes.includes(variant.size)) return { skip: `${variant.sku}'s size is not in ${style.code}'s range.`, code: variant.sku, missing: [] }
  // The materials at the company's frozen standards of the first day (else their standard purchase price), the rates of that day.
  const standards = await frozenStandards(tx, [company.id], [...loaded.facts.materials.keys()])
  const materials = new Map<string, CostingMaterial>()
  const used: { itemId: string; standardId: string | null; unitCost: string | null }[] = []
  for (const [id, material] of loaded.facts.materials) {
    const frozen = standardFor(standards, company.id, id, validFrom, company.currency)
    materials.set(id, frozen ? { ...material, standardCost: frozen.unitCost, currency: frozen.currency } : material)
    used.push({ itemId: id, standardId: frozen?.id ?? null, unitCost: frozen?.unitCost ?? material.standardCost })
  }
  const sheet = prepareSheet({ ...loaded.facts, on: validFrom, materials })
  const cell = exactCell(sheet, variant.colourwayId, variant.size)
  if (cell.missing.length > 0) return { skip: `${variant.sku}'s cost sheet is not complete: freeze a standard only from a complete one.`, code: variant.sku, missing: missingView(sheet, [cell]).map((row) => row.message) }
  if (!item) {
    const colourway = await tx.colourway.findUniqueOrThrow({ where: { id: variant.colourwayId }, select: { name: true } })
    const itemId = await finishedItemFor(tools, { variantId: variant.id, sku: variant.sku, colourwayId: variant.colourwayId, size: variant.size, itemId: null, itemCurrency: null }, {
      styleName: style.name,
      colourwayName: colourway.name,
      garmentTracking: style.garmentTracking,
      companyId: style.companyId,
    })
    item = await tx.item.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_COLUMNS })
  }
  const parts: StandardParts = { materialCost: costText(cell.material), labourCost: costText(cell.labourCost), subcontractCost: '0', overheadCost: costText(cell.overhead?.amount ?? decimalOf('0')) }
  return {
    item,
    draft: {
      itemId: item.id,
      source: 'ROLLUP',
      parts,
      labourMinutes: minutesText(cell.minutes),
      breakdown: JSON.parse(JSON.stringify({ basis: 'ROLLUP', styleId: style.id, revisionId: revision.id, revision: revision.revision, colourwayId: variant.colourwayId, size: variant.size, on: validFrom, materials: used, cell: cellView(cell) })) as Prisma.InputJsonValue,
    },
  }
}

