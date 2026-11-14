import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CogsWaitingView } from '@nexus/factory-domain/costing/cost-of-sales/contracts'
import { amountOf, cogsKeys, COGS_WAIT_WORDS, splitByStandard, type CogsAmounts, type CogsWait } from '@nexus/factory-domain/costing/cost-of-sales/rules'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { frozenStandards, standardFor, unique, type Reader } from '../actual/store'
import { ownedLots } from '../valuation/customer-owned'

/**
 * Cost of goods sold at shipment (B-W2b-407; FIN-043): ONE planner per shipment, read only (planShipment), and ONE writer
 * inside the caller's command (writeEntries), used by the worker's handler (./handlers.ts) and the catch-up route (POST
 * /costing/cost-of-sales/post). Each line of a shipment that left gets one entry, unless one is live (a correction is a
 * reversal and a new key `:<n>`): its garments from stock at their SHIPMENT moves' valuations, the rest at the FROZEN
 * standard of the cell's finished item on the day it left, split by that standard's parts (factory-domain
 * costing/cost-of-sales). A customer's own goods cost nothing (never valued: FIN-045). What cannot be costed waits, in
 * words, and is posted later by the route.
 */

const ENTRY_COLUMNS = { id: true, shipmentLineId: true, reversalOfId: true } as const satisfies Prisma.CostOfSalesEntrySelect

export interface CogsDraft extends CogsAmounts {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly siteId: string
  readonly shipmentLineId: string
  readonly stockMoveId: string | null
  readonly quantity: string
  readonly currency: string
  readonly idempotencyKey: string
}

export interface CogsPlan {
  readonly shipmentId: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  /** SHIPPED or DELIVERED: the goods left. */
  readonly ready: boolean
  readonly status: string
  readonly day: BusinessDate
  readonly drafts: CogsDraft[]
  readonly waiting: CogsWaitingView[]
}

/** The finished item of each (style, colourway, size): the SKU's FINISHED item (none when it never went into stock). */
async function finishedItems(db: Reader, cells: readonly { readonly styleId: string; readonly colourwayId: string; readonly size: string }[]): Promise<Map<string, string>> {
  if (cells.length === 0) return new Map()
  const variants = await db.variant.findMany({
    where: { styleId: { in: unique(cells.map((cell) => cell.styleId)) }, colourwayId: { in: unique(cells.map((cell) => cell.colourwayId)) }, size: { in: unique(cells.map((cell) => cell.size)) } },
    select: { id: true, styleId: true, colourwayId: true, size: true },
  })
  const items = variants.length === 0 ? [] : await db.item.findMany({ where: { variantId: { in: variants.map((row) => row.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } })
  const itemOf = new Map(items.map((row) => [row.variantId!, row.id]))
  return new Map(variants.flatMap((row) => (itemOf.has(row.id) ? [[`${row.styleId}|${row.colourwayId}|${row.size}`, itemOf.get(row.id)!] as const] : [])))
}

/** A shipment's cost of goods sold: one draft per line with nothing live, and the lines that wait with why. */
export async function planShipment(db: Reader, shipmentId: string, ids: () => string = newId, now: Date = new Date()): Promise<CogsPlan | null> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true, shippedAt: true } })
  if (!shipment) return null
  const day = businessDate(shipment.shippedAt ?? now)
  const ready = shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED'
  const lines = await db.shipmentLine.findMany({ where: { shipmentId }, select: { id: true, siteId: true, partyId: true, quantity: true, size: true, salesOrderLineId: true }, orderBy: { id: 'asc' } })
  const plan = { shipmentId, number: shipment.number, companyId: shipment.companyId, partyId: shipment.partyId, ready, status: shipment.status, day }
  if (!ready || lines.length === 0) return { ...plan, drafts: [], waiting: lines.map((line) => wait(line, 'NOT_LEFT')) }

  const entries = await db.costOfSalesEntry.findMany({ where: { shipmentLineId: { in: lines.map((line) => line.id) } }, select: ENTRY_COLUMNS })
  const reversed = new Set(entries.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const taken = new Map<string, { count: number; live: boolean }>()
  for (const row of entries.filter((entry) => entry.reversalOfId === null)) {
    const seen = taken.get(row.shipmentLineId!) ?? { count: 0, live: false }
    taken.set(row.shipmentLineId!, { count: seen.count + 1, live: seen.live || !reversed.has(row.id) })
  }
  const moves = await db.stockMove.findMany({ where: { shipmentLineId: { in: lines.map((line) => line.id) }, reason: 'SHIPMENT', reversalOfId: null }, select: { id: true, shipmentLineId: true, lotId: true, baseQuantity: true }, orderBy: { id: 'asc' } })
  const values = new Map((await db.stockValuation.findMany({ where: { moveId: { in: moves.map((move) => move.id) } }, select: { moveId: true, valueAmount: true, currency: true } })).map((row) => [row.moveId, row]))
  const owned = await ownedLots(db, moves.map((move) => move.lotId))
  const orderLines = new Map((await db.salesOrderLine.findMany({ where: { id: { in: unique(lines.map((line) => line.salesOrderLineId)) } }, select: { id: true, styleId: true, colourwayId: true } })).map((row) => [row.id, row]))
  const cells = lines.flatMap((line) => {
    const orderLine = orderLines.get(line.salesOrderLineId)
    return orderLine ? [{ styleId: orderLine.styleId, colourwayId: orderLine.colourwayId, size: line.size }] : []
  })
  const items = await finishedItems(db, cells)
  const currency = costingCurrency((await db.company.findUnique({ where: { id: shipment.companyId }, select: { currency: true } }))?.currency ?? null)
  const standards = await frozenStandards(db, [shipment.companyId], [...new Set(items.values())])

  const drafts: CogsDraft[] = []
  const waiting: CogsWaitingView[] = []
  for (const line of lines) {
    const seen = taken.get(line.id)
    if (seen?.live) {
      waiting.push(wait(line, 'TAKEN'))
      continue
    }
    const orderLine = orderLines.get(line.salesOrderLineId)
    const itemId = orderLine ? (items.get(`${orderLine.styleId}|${orderLine.colourwayId}|${line.size}`) ?? null) : null
    const standard = itemId ? standardFor(standards, shipment.companyId, itemId, day, currency) : null
    const mine = moves.filter((move) => move.shipmentLineId === line.id)
    let fromStock = 0
    let moved = new Dec(0)
    let blocked: CogsWait | null = null
    for (const move of mine) {
      moved = moved.plus(move.baseQuantity.toString())
      if (move.lotId && owned.has(move.lotId)) continue
      const value = values.get(move.id)
      if (!value) blocked ??= 'NOT_VALUED'
      else if (value.currency !== currency) blocked ??= 'CURRENCY'
      else fromStock += -value.valueAmount
    }
    const rest = Dec.max(new Dec(line.quantity).minus(moved), new Dec(0))
    if (!blocked && rest.greaterThan(0)) blocked = !itemId ? 'NO_ITEM' : !standard ? 'NO_STANDARD' : null
    if (blocked) {
      waiting.push(wait(line, blocked))
      continue
    }
    const amount = fromStock + (rest.greaterThan(0) ? amountOf(rest.toFixed(4), standard!.unitCost, currency) : 0)
    drafts.push({
      id: ids(),
      companyId: shipment.companyId,
      partyId: line.partyId,
      siteId: line.siteId,
      shipmentLineId: line.id,
      stockMoveId: mine.length === 1 ? mine[0]!.id : null,
      quantity: new Dec(line.quantity).toFixed(4),
      ...splitByStandard(Math.max(amount, 0), standard),
      currency,
      idempotencyKey: cogsKeys.shipmentLine(line.id, (seen?.count ?? 0) + 1),
    })
  }
  return { ...plan, drafts, waiting }
}

function wait(line: { readonly id: string; readonly size: string }, code: CogsWait): CogsWaitingView {
  return { lineId: line.id, size: line.size, code, words: COGS_WAIT_WORDS[code] }
}

/** Writes a plan's drafts inside the caller's command, with its audit row and event; returns the ids written. */
export async function writeEntries(tools: CommandTools, plan: CogsPlan): Promise<string[]> {
  if (plan.drafts.length === 0) return []
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tools.tx.costOfSalesEntry.createMany({ data: plan.drafts.map((draft) => ({ ...draft, postedAt: tools.now, createdAt: tools.now, createdById })) })
  tools.audit({
    action: 'costing.postCostOfSales',
    recordType: 'Shipment',
    recordId: plan.shipmentId,
    companyId: plan.companyId,
    after: { number: plan.number, entries: plan.drafts.map((draft) => ({ id: draft.id, key: draft.idempotencyKey, quantity: draft.quantity, amount: markMoney('cost', draft.amount) })), waiting: plan.waiting.map((row) => row.code) },
  })
  tools.emit({ type: 'cost_of_sales.posted', subject: plan.shipmentId, companyId: plan.companyId, payload: { shipmentId: plan.shipmentId, number: plan.number, entryIds: plan.drafts.map((draft) => draft.id), reversals: 0 } })
  return plan.drafts.map((draft) => draft.id)
}
