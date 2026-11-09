import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { compareSpecs, differsOf, differsWords, type Differs } from '@nexus/factory-domain/product/versions/compare'
import type { DriftRowView, FloorNewerSpecView, StyleDriftView, WorkOrderSpecView } from '@nexus/factory-domain/product/versions/contracts'
import { driftOf, driftWords, newerSpecOf, type Decision, type DocumentKind } from '@nexus/factory-domain/product/versions/drift'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { scanWorkOrder, systemView } from '../../production/scans/access'
import { officeWorkOrder } from '../../production/work-orders/work-orders'
import { costingCompanyOf, costLine, type SheetCache } from '../../sales/quotes/pricing'
import { contextOf, readStyleFor } from '../bom/store'
import { readSnapshots, REVISION_COLUMNS, type Db, type RevisionRow } from './read'

/**
 * Which spec quotes, orders and work orders are on (B-W2b-220; factory-domain product/versions/drift):
 *
 *   GET /product/styles/:styleId/versions/drift              PRD-194: the open quotes (DRAFT … SENT, their current version)
 *       and orders (CONFIRMED, IN_PRODUCTION, READY; a line not closed short whole) whose lines are on another revision than
 *       the one in force (a line's own revision, else its quote line's), how the two differ, and — cost grain — the line's
 *       cost as priced against its cost now on the revision in force (today's inputs). Rows only of the kinds the role
 *       reaches (quotes.view, orders.view over the record's company and party); the others are named in `held`.
 *   GET /production/work-orders/:workOrderId/spec/versions   PRD-195 and PRD-194 at release: the work order's revision, the
 *       one in force, the banner (a newer spec, and what a change order decided for it), how they differ, and its order lines
 *       quoted or ordered on another revision than the work order's, with the cost impact (cost grain)
 *   GET /production/work-orders/:workOrderId/spec/newer      the tablet's banner (floor at its own site, or the office with
 *       production.scan): no cost, no compare; the change order's decision is read in the tenant's system scope (the floor
 *       reads no change order)
 *
 * Reads: no command(), nothing written. A compare of two revisions is made once per request (`Differ`).
 */

const OPEN_QUOTES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] as const
const OPEN_ORDERS = ['CONFIRMED', 'IN_PRODUCTION', 'READY'] as const

/** The parts two revisions of one style differ in, compared once per pair. */
class Differ {
  private readonly cache = new Map<string, Promise<Differs[]>>()
  constructor(
    private readonly db: Db,
    private readonly range: readonly string[],
  ) {}

  of(a: RevisionRow, b: RevisionRow): Promise<Differs[]> {
    const key = `${a.id}:${b.id}`
    let entry = this.cache.get(key)
    if (!entry) {
      entry = readSnapshots(this.db, [a, b]).then(([left, right]) => differsOf(compareSpecs(left!, right!, this.range)))
      this.cache.set(key, entry)
    }
    return entry
  }
}

const refOf = (row: Pick<RevisionRow, 'id' | 'revision' | 'status'>) => ({ id: row.id, revision: row.revision, status: row.status })

async function revisionsById(db: Db, ids: readonly (string | null)[]): Promise<Map<string, RevisionRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.styleRevision.findMany({ where: { id: { in: wanted } }, select: REVISION_COLUMNS })).map((row) => [row.id, row]))
}

const releasedOf = (db: Db, styleId: string): Promise<RevisionRow | null> => db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: REVISION_COLUMNS })

/** One line to check: its document, its revision, what it costs and its pieces per size. */
interface LineToCheck {
  readonly kind: DocumentKind
  readonly documentId: string
  readonly number: string
  readonly status: string
  readonly companyId: string
  readonly lineId: string
  readonly seq: number
  readonly styleId: string
  readonly colourwayId: string
  readonly colourway: string | null
  readonly pieces: number
  readonly revisionId: string | null
  readonly unitCost: { toString(): string } | null
  readonly costAmount: number | null
  readonly sizes: readonly { size: string; quantity: number; unitPrice: null }[]
}

/** The rows of these lines against `against` (each line's revision compared with it), with the cost impact for the cost grain. */
async function rowsOf(db: Db, lines: readonly LineToCheck[], against: RevisionRow, againstWords: string, differ: Differ, withCost: boolean): Promise<DriftRowView[]> {
  const revisions = await revisionsById(db, lines.map((line) => line.revisionId))
  const sheets: SheetCache = new Map()
  const companies = new Map<string, Awaited<ReturnType<typeof costingCompanyOf>>>()
  const now = serverClock.now()
  const rows: DriftRowView[] = []
  for (const line of lines) {
    const pinned = line.revisionId ? (revisions.get(line.revisionId) ?? null) : null
    const state = driftOf(pinned, against)
    if (state !== 'DIFFERENT' || !pinned) continue
    const differs = await differ.of(pinned, against)
    let cost: DriftRowView['cost'] = undefined
    if (withCost) {
      let company = companies.get(line.companyId)
      if (!company) {
        company = await costingCompanyOf(db, line.companyId)
        companies.set(line.companyId, company)
      }
      const priced = await costLine(db, sheets, { styleId: line.styleId, styleRevisionId: against.id, colourwayId: line.colourwayId, sizes: line.sizes }, company, now)
      const thenUnit = line.unitCost === null ? null : line.unitCost.toString()
      const nowUnit = priced.cost.unitCost
      const unitChange = thenUnit !== null && nowUnit !== null ? subtract(nowUnit, thenUnit) : null
      const amountChange = line.costAmount !== null && priced.cost.amount !== null ? Number(priced.cost.amount) - line.costAmount : null
      cost = asMoney('cost', {
        currency: company.currency,
        complete: priced.cost.complete,
        unitCostThen: asMoney('cost', thenUnit === null ? null : trimDecimal(thenUnit)),
        unitCostNow: asMoney('cost', nowUnit),
        unitCostChange: asMoney('cost', unitChange),
        costAmountThen: asMoney('cost', line.costAmount),
        costAmountNow: asMoney('cost', priced.cost.amount === null ? null : Number(priced.cost.amount)),
        costAmountChange: asMoney('cost', amountChange),
      })
    }
    rows.push({
      kind: line.kind,
      documentId: line.documentId,
      number: line.number,
      status: line.status,
      lineId: line.lineId,
      seq: line.seq,
      colourway: line.colourway,
      pieces: line.pieces,
      revision: refOf(pinned),
      against: refOf(against),
      state,
      differs,
      words: driftWords(line.kind, line.number, line.kind === 'WORK_ORDER' ? null : line.seq, pinned.revision, against.revision, againstWords, differsWords(differs)),
      ...(cost === undefined ? {} : { cost }),
    })
  }
  return rows
}

/** "1.200000" → "1.2". */
function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

/** b − a of two decimal strings, exact (6 places at most, as unit costs are). */
function subtract(b: string, a: string): string {
  const scale = 6
  const scaled = (value: string) => {
    const negative = value.startsWith('-')
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
    const digits = BigInt(`${whole}${fraction.padEnd(scale, '0').slice(0, scale)}`)
    return negative ? -digits : digits
  }
  const d = scaled(b) - scaled(a)
  const negative = d < 0n
  const digits = (negative ? -d : d).toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${trimDecimal(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`)}`
}

const colourwayCodes = async (db: Db, ids: readonly string[]): Promise<Map<string, string>> => {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  return new Map((await db.colourway.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
}

/** The sizes a line is costed with: its size rows; a made-to-measure unit: its base size × 1. */
const sizesOfLine = (kind: string, baseSize: string | null, rows: readonly { size: string; quantity: number }[]) =>
  kind === 'MADE_TO_MEASURE' && rows.length === 0 && baseSize ? [{ size: baseSize, quantity: 1, unitPrice: null }] : rows.map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: null }))

/** The open quote lines of the style (their quote's current version), the caller may see. */
async function openQuoteLines(db: Db, context: OfficeContext, styleId: string): Promise<LineToCheck[]> {
  const lines = await db.quoteLine.findMany({
    where: { styleId },
    select: { id: true, versionId: true, seq: true, kind: true, styleId: true, styleRevisionId: true, colourwayId: true, baseSize: true, quantity: true, unitCost: true, costAmount: true },
    orderBy: [{ versionId: 'asc' }, { seq: 'asc' }],
  })
  if (lines.length === 0) return []
  const versions = await db.quoteVersion.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.versionId))] } }, select: { id: true, quoteId: true, revision: true } })
  const quotes = await db.quote.findMany({
    where: { id: { in: [...new Set(versions.map((version) => version.quoteId))] }, status: { in: [...OPEN_QUOTES] } },
    select: { id: true, number: true, status: true, companyId: true, partyId: true, currentRevision: true },
  })
  const quoteBy = new Map(quotes.map((quote) => [quote.id, quote]))
  const versionBy = new Map(versions.map((version) => [version.id, version]))
  const actor = actorOf(context)
  const open = lines.filter((line) => {
    const version = versionBy.get(line.versionId)
    const quote = version ? quoteBy.get(version.quoteId) : undefined
    return !!quote && version!.revision === quote.currentRevision && can(actor, 'quotes.view' as Permission, { companyId: quote.companyId, partyId: quote.partyId })
  })
  if (open.length === 0) return []
  const sizes = await db.quoteLineSize.findMany({ where: { lineId: { in: open.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true } })
  const codes = await colourwayCodes(db, open.map((line) => line.colourwayId))
  return open.map((line) => {
    const quote = quoteBy.get(versionBy.get(line.versionId)!.quoteId)!
    return {
      kind: 'QUOTE',
      documentId: quote.id,
      number: quote.number,
      status: quote.status,
      companyId: quote.companyId,
      lineId: line.id,
      seq: line.seq,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      colourway: codes.get(line.colourwayId) ?? null,
      pieces: line.quantity,
      revisionId: line.styleRevisionId,
      unitCost: line.unitCost,
      costAmount: line.costAmount,
      sizes: sizesOfLine(line.kind, line.baseSize, sizes.filter((row) => row.lineId === line.id)),
    }
  })
}

/** Order lines (of open orders, or the ones named), each on its own revision or its quote line's. */
async function orderLines(db: Db, context: OfficeContext, where: { styleId: string } | { ids: readonly string[] }, openOnly: boolean): Promise<LineToCheck[]> {
  const lines = await db.salesOrderLine.findMany({
    where: 'ids' in where ? { id: { in: [...where.ids] } } : { styleId: where.styleId },
    select: {
      id: true,
      orderId: true,
      seq: true,
      kind: true,
      quoteLineId: true,
      styleId: true,
      styleRevisionId: true,
      colourwayId: true,
      baseSize: true,
      quantity: true,
      unitCost: true,
      costAmount: true,
      closedShortQuantity: true,
    },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  if (lines.length === 0) return []
  const orders = await db.salesOrder.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.orderId))] }, ...(openOnly ? { status: { in: [...OPEN_ORDERS] } } : {}) },
    select: { id: true, number: true, status: true, companyId: true, partyId: true },
  })
  const orderBy = new Map(orders.map((order) => [order.id, order]))
  const actor = actorOf(context)
  const kept = lines.filter((line) => {
    const order = orderBy.get(line.orderId)
    if (!order || !can(actor, 'orders.view' as Permission, { companyId: order.companyId, partyId: order.partyId })) return false
    // A line closed short whole will not be made.
    return !(openOnly && line.closedShortQuantity !== null && line.closedShortQuantity >= line.quantity)
  })
  if (kept.length === 0) return []
  const quoteIds = [...new Set(kept.map((line) => line.quoteLineId).filter((id): id is string => id !== null))]
  const quoteLines = quoteIds.length ? new Map((await db.quoteLine.findMany({ where: { id: { in: quoteIds } }, select: { id: true, styleRevisionId: true } })).map((row) => [row.id, row.styleRevisionId])) : new Map<string, string | null>()
  const sizes = await db.salesOrderLineSize.findMany({ where: { lineId: { in: kept.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true } })
  const codes = await colourwayCodes(db, kept.map((line) => line.colourwayId))
  return kept.map((line) => {
    const order = orderBy.get(line.orderId)!
    return {
      kind: 'ORDER',
      documentId: order.id,
      number: order.number,
      status: order.status,
      companyId: order.companyId,
      lineId: line.id,
      seq: line.seq,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      colourway: codes.get(line.colourwayId) ?? null,
      pieces: line.quantity,
      revisionId: line.styleRevisionId ?? (line.quoteLineId ? (quoteLines.get(line.quoteLineId) ?? null) : null),
      unitCost: line.unitCost,
      costAmount: line.costAmount,
      sizes: sizesOfLine(line.kind, line.baseSize, sizes.filter((row) => row.lineId === line.id)),
    }
  })
}

const officeOf = (caller: CommandCaller): OfficeContext => contextOf(caller) as OfficeContext

/** GET /product/styles/:styleId/versions/drift (PRD-194). */
export async function styleDrift(caller: CommandCaller, styleId: string): Promise<StyleDriftView> {
  const style = await readStyleFor(caller, styleId)
  const context = officeOf(caller)
  const actor = actorOf(context)
  const withCost = heldGrains(actor).has('cost')
  const held: StyleDriftView['held'] = []
  if (!can(actor, 'quotes.view' as Permission)) held.push('QUOTE')
  if (!can(actor, 'orders.view' as Permission)) held.push('ORDER')
  return caller.withClient(async (client) => {
    const current = await releasedOf(client, styleId)
    if (!current) return { style: { id: style.id, code: style.code, name: style.name }, current: null, rows: [], held }
    const differ = new Differ(client, style.sizes)
    const lines = [...(held.includes('QUOTE') ? [] : await openQuoteLines(client, context, styleId)), ...(held.includes('ORDER') ? [] : await orderLines(client, context, { styleId }, true))]
    return { style: { id: style.id, code: style.code, name: style.name }, current: refOf(current), rows: await rowsOf(client, lines, current, 'the spec in force', differ, withCost), held }
  })
}

/** The change order's decision for this work order (an APPROVED or RELEASED order's work-in-progress line), newest first. */
async function decisionFor(db: Db, workOrderId: string): Promise<Decision | null> {
  const items = await db.changeOrderItem.findMany({ where: { workOrderId, kind: 'WORK_IN_PROGRESS', disposition: { not: null } }, select: { changeOrderId: true, disposition: true } })
  if (items.length === 0) return null
  const orders = await db.changeOrder.findMany({ where: { id: { in: items.map((item) => item.changeOrderId) }, status: { in: ['APPROVED', 'RELEASED'] } }, select: { id: true, number: true, decidedAt: true, releasedAt: true } })
  const newest = [...orders].sort((a, b) => (b.releasedAt ?? b.decidedAt ?? new Date(0)).getTime() - (a.releasedAt ?? a.decidedAt ?? new Date(0)).getTime())[0]
  if (!newest) return null
  const item = items.find((entry) => entry.changeOrderId === newest.id)!
  return { disposition: item.disposition!, changeOrder: newest.number }
}

const newerOf = (pinned: RevisionRow | null, released: RevisionRow | null, decision: Decision | null) => {
  const spec = newerSpecOf({ pinned: pinned ? refOf(pinned) : null, released: released ? refOf(released) : null, decision })
  const newer = spec.state === 'NEWER_RELEASED' && released ? { id: released.id, revision: released.revision, releasedOn: released.releasedAt ? businessDate(released.releasedAt) : null } : null
  return { ...spec, newer, decision: spec.state === 'NEWER_RELEASED' ? decision : null }
}

/** GET /production/work-orders/:workOrderId/spec/versions (office, workorders.view). */
export async function workOrderSpec(caller: CommandCaller, workOrderId: string): Promise<WorkOrderSpecView> {
  const workOrder = await officeWorkOrder(caller, workOrderId)
  const context = officeOf(caller)
  const withCost = heldGrains(actorOf(context)).has('cost')
  return caller.withClient(async (client) => {
    const style = await client.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, sizes: true } })
    if (!style) throw new NotFoundError('Style not found.')
    const pinned = workOrder.styleRevisionId ? await client.styleRevision.findUnique({ where: { id: workOrder.styleRevisionId }, select: REVISION_COLUMNS }) : null
    const released = await releasedOf(client, style.id)
    const differ = new Differ(client, style.sizes)
    const decision = await decisionFor(client, workOrder.id)
    const differs = pinned && released && pinned.id !== released.id ? await differ.of(pinned, released) : []
    // The drift at release (PRD-194): its order lines quoted or ordered on another revision than the work order's.
    const lineIds = [...new Set((await client.workOrderSize.findMany({ where: { workOrderId: workOrder.id }, select: { salesOrderLineId: true } })).map((cell) => cell.salesOrderLineId))]
    const orders = pinned && lineIds.length > 0 ? await rowsOf(client, await orderLines(client, context, { ids: lineIds }, false), pinned, "this work order's spec", differ, withCost) : []
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, styleId: style.id, styleCode: style.code },
      revision: pinned ? refOf(pinned) : null,
      released: released ? refOf(released) : null,
      newer: newerOf(pinned, released, decision),
      differs,
      words: differsWords(differs),
      orders,
    }
  })
}

/** GET /production/work-orders/:workOrderId/spec/newer (the tablet's banner; floor at its own site, or the office). */
export async function floorNewerSpec(caller: CommandCaller, workOrderId: string): Promise<FloorNewerSpecView> {
  const header = await scanWorkOrder(caller, workOrderId, 'production.scan' as Permission)
  const found = await caller.withClient(async (client) => {
    const row = await client.workOrder.findUnique({ where: { id: header.id }, select: { styleRevisionId: true } })
    const pinned = row?.styleRevisionId ? await client.styleRevision.findUnique({ where: { id: row.styleRevisionId }, select: REVISION_COLUMNS }) : null
    const released = await releasedOf(client, header.styleId)
    return { pinned, released }
  })
  // The floor reads no change order: its decision is read in the tenant's system scope (the disposition and number only).
  const decision = found.pinned && found.released && found.pinned.id !== found.released.id ? await systemView(caller).withClient((client) => decisionFor(client, header.id)) : null
  return {
    workOrder: { id: header.id, number: header.number },
    revision: found.pinned ? { revision: found.pinned.revision, status: found.pinned.status } : null,
    newer: newerOf(found.pinned, found.released, decision),
  }
}
