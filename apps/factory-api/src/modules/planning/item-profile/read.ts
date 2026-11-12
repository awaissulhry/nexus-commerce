import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Allocation } from '@nexus/factory-domain/planning/allocation-priority/rank'
import { calculatedDelays, delayWords, usableDay, type DelayedPart } from '@nexus/factory-domain/planning/item-profile/delays'
import { itemProfile, type ProfileDemand, type ProfilePlanned, type ProfileReceipt } from '@nexus/factory-domain/planning/item-profile/profile'
import { lotRuleOf, lotsWords, needsOfPegging, plannedLots, type PlannedLot } from '@nexus/factory-domain/planning/lot-sizing/lots'
import { itemRuleWords, type LotSizing, type PlanLevel } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { pegMaterial, type DemandPart, type MaterialPegging } from '@nexus/factory-domain/planning/mrp/net'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { decimalOf, QUANTITY_SCALE } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { latestDoneRun, readReservations, withQualityHolds } from '../inputs'
import { livePlanOf, type LivePlan } from '../readiness/service'
import { lotFactsOf, readLots, readPurchases, readStock, type Reader, type SiteRow } from '../store'
import type { ItemProfileQuery } from './contract'
import { arrivalOf, delayCalendarsOf, leadTimeOf, materialPlanOf, onWorkingDayOf, type DelayCalendars, type MaterialPlan } from './facts'

/**
 * The item's requirement profile (PLN-084: GET /planning/item-profile) and the site's calculated delays (PLN-082: GET
 * /planning/delays), B-W2b-318: planning.view over the site; the plan of the site computed now (../readiness/service
 * `livePlanOf`), so a receipt posted or a purchase order sent this morning shows at once, with the latest plan's firm
 * planned orders as supply. Pure rules: factory-domain planning/item-profile (profile, delays), planning/lot-sizing (the
 * planned orders). One query after another on one read-only client.
 */

const DEFAULT_WEEKS = 13
const q = (value: { toString(): string }): string => decimalOf(value.toString()).toFixed(QUANTITY_SCALE)
const sum = (values: readonly string[]): string => q(values.reduce((total, value) => total.plus(decimalOf(value)), decimalOf('0')))

const siteView = (site: SiteRow) => ({ id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone })

const ITEM_VIEW = { id: true, code: true, name: true, kind: true, baseUom: true, companyId: true, colours: { select: { id: true, code: true, name: true } } } as const

/**
 * The material's plan and its open purchase lines; one the plan does not read (no demand, no firm order, no safety stock)
 * is read here on its own.
 */
async function planOfMaterial(db: Reader, live: LivePlan, itemId: string, itemColourId: string | null): Promise<{ plan: MaterialPlan; purchases: LivePlan['inputs']['purchases'] }> {
  const found = materialPlanOf(live, itemId, itemColourId)
  if (live.inputs.items.some((item) => item.id === itemId)) return { plan: found, purchases: live.inputs.purchases.filter((line) => line.itemId === itemId && line.itemColourId === itemColourId) }
  const read = await readStock(db, live.site.id, [itemId])
  const lotRows = await readLots(db, read.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))
  const { stock, lots } = await withQualityHolds(db, live.site.id, read, lotRows.map(lotFactsOf))
  const purchases = await readPurchases(db, live.site.id, [itemId])
  const reservations = await readReservations(db, live.site.id, [itemId])
  const lotOf = new Map(lots.map((lot) => [lot.id, lot]))
  const mine = purchases.filter((line) => line.itemColourId === itemColourId)
  const pegging = pegMaterial({ itemColourId, parts: [], stock, lotOf: (lotId) => lotOf.get(lotId), reservations, purchases: mine, runDate: live.today })
  return { plan: { ...found, peggings: [pegging] }, purchases: mine }
}

const orderOf = (part: DemandPart) => ({ id: part.orderId, number: part.orderNumber, rank: typeof part.rank === 'number' ? part.rank : null })
const workOrderOf = (part: DemandPart) => (part.workOrderId && part.workOrderNumber ? { id: part.workOrderId, number: part.workOrderNumber } : null)

/** The calculated delays of one material (its lines' coverage), with the facts of a new order placed today. */
function delaysOf(live: LivePlan, plan: MaterialPlan, calendars: DelayCalendars, label: string) {
  const action = plan.lines[0]?.requirement.action ?? 'BUY'
  const supplierId = plan.lines[0]?.requirement.supplierId ?? null
  const leadTimeDays = plan.lines[0] ? leadTimeOf(live, plan.lines[0].requirement, plan.rule) : (plan.rule?.buyLeadTimeDays ?? null)
  const delayDays = plan.rule?.delayDays ?? null
  const arrival = arrivalOf(live.today, action, supplierId, leadTimeDays, calendars)
  const onWorkingDay = onWorkingDayOf(calendars)
  const facts = { today: live.today, arrival, leadTimeDays, delayDays, onWorkingDay }
  const delayed = plan.peggings.flatMap((pegging) => calculatedDelays(pegging.coverage, facts))
  const usable = usableDay(facts, arrival)
  const words =
    leadTimeDays === null
      ? `No lead time on record: a new order counts as here today, usable on ${usable}.`
      : `Ordered today, it arrives on ${arrival} (${leadTimeDays} day${leadTimeDays === 1 ? '' : 's'}${action === 'BUY' ? ', the supplier’s closed days not counted' : ' to make'}) and is usable on ${usable}${delayDays ? ` (${delayDays} day${delayDays === 1 ? '' : 's'} between arrival and use)` : ''}.`
  return { action, supplierId, leadTimeDays, delayDays, arrival, usable, words, delayed: delayed.map((entry) => ({ entry, words: delayWords(entry, label, leadTimeDays) })) }
}

const delayViewOf = (entry: DelayedPart, words: string) => ({
  order: orderOf(entry.part),
  orderLine: { id: entry.part.orderLineId, seq: entry.part.lineSeq },
  size: entry.part.size,
  workOrder: workOrderOf(entry.part),
  needDate: entry.day,
  earliest: entry.usable,
  daysLate: entry.daysLate,
  source: entry.source,
  arrival: entry.arrival,
  words,
})

/** planning.view: the item's requirement profile, week by week (PLN-084). */
export async function readItemProfile(caller: CommandCaller, query: ItemProfileQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const asOf = serverClock.now()
  return caller.withClient(async (db) => {
    const item = await db.item.findUnique({ where: { id: query.itemId }, select: ITEM_VIEW })
    if (!item || (item.companyId !== null && item.companyId !== site.companyId)) throw new NotFoundError('Item not found.')
    const itemColourId = query.itemColourId === undefined || query.itemColourId === 'none' ? null : query.itemColourId
    const colour = itemColourId === null ? null : (item.colours.find((entry) => entry.id === itemColourId) ?? null)
    if (itemColourId !== null && !colour) throw new ValidationError('No such colour of this item.', [{ path: 'querystring/itemColourId', message: 'Choose one of the item’s colours, or none.' }])
    const live = await livePlanOf(db, site)
    const { plan, purchases } = await planOfMaterial(db, live, item.id, itemColourId)
    const label = [item.code, colour?.code].filter(Boolean).join(' ')
    const peggings: MaterialPegging[] = [...plan.peggings]

    // Demand: what each part still needs, on its day.
    const demand: ProfileDemand[] = peggings.flatMap((pegging) =>
      pegging.coverage.flatMap((entry) => {
        const need = decimalOf(entry.part.quantity).minus(decimalOf(entry.part.issued))
        if (!need.gt(0)) return []
        const part = entry.part
        return [{ day: entry.day, quantity: q(need), ref: { orderId: part.orderId, orderNumber: part.orderNumber, orderLineId: part.orderLineId, lineSeq: part.lineSeq, size: part.size, workOrderId: part.workOrderId, workOrderNumber: part.workOrderNumber, rank: typeof part.rank === 'number' ? part.rank : null } }]
      }),
    )
    // Receipts: every open purchase line on its due day, and the firm planned order(s) on their date.
    const receipts: ProfileReceipt[] = [
      ...purchases.map((line) => ({ kind: 'PURCHASE_ORDER' as const, day: line.dueDate, quantity: q(line.openQuantity), purchaseOrderLineId: line.purchaseOrderLineId, purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber, lineSeq: line.seq })),
      ...plan.lines.flatMap((line) => (line.netting.carried ? [{ kind: 'FIRM' as const, day: line.netting.carried.date, quantity: q(line.netting.carried.baseQuantity), requirementId: line.netting.carried.requirementId }] : [])),
    ]
    // The plan's orders still to place, by the item's lot sizing (after the firm planned order).
    const rule = lotRuleOf(plan.rule)
    const lots: PlannedLot[] = peggings.flatMap((pegging) => plannedLots(rule, needsOfPegging(pegging, 'UNCOVERED')))
    const planned: ProfilePlanned[] = lots.map((lot, index) => ({ seq: index + 1, day: lot.date, quantity: lot.quantity }))
    const profile = itemProfile({
      today: live.today,
      weeks: query.weeks ?? DEFAULT_WEEKS,
      onHand: sum(peggings.map((pegging) => pegging.usable)),
      safetyStock: plan.rule?.safetyStock ? q(plan.rule.safetyStock) : null,
      demand,
      receipts,
      planned,
    })

    const calendars = await delayCalendarsOf(db, live, plan.lines.flatMap((line) => (line.requirement.supplierId ? [line.requirement.supplierId] : [])), Math.max(0, ...plan.lines.map((line) => leadTimeOf(live, line.requirement, plan.rule) ?? 0)))
    const delays = delaysOf(live, plan, calendars, label)
    const latest = await latestDoneRun(db, site.id)
    const stored = latest
      ? await db.materialRequirement.findMany({ where: { runId: latest.id, itemId: item.id, itemColourId }, select: { id: true, runId: true, seq: true }, orderBy: { seq: 'asc' } })
      : []
    const allocation: Allocation = peggings.some((pegging) => pegging.allocation === 'PRIORITY') ? 'PRIORITY' : 'DATE'
    const row = plan.rule
    const rowValues = row
      ? itemRuleWords(
          { lotSizing: row.lotSizing as LotSizing, fixedLotQty: row.fixedLotQty ? q(row.fixedLotQty) : null, lotPeriodDays: row.lotPeriodDays, planLevel: (row.planLevel as PlanLevel | null) ?? null, scrapPct: row.scrapPct?.toString() ?? null, yieldPct: row.yieldPct?.toString() ?? null, delayDays: row.delayDays },
          { method: row.method, itemKind: item.kind, uom: item.baseUom, minOrderQty: row.minOrderQty ? q(row.minOrderQty) : null, orderMultiple: row.orderMultiple ? q(row.orderMultiple) : null, maxOrderQty: row.maxOrderQty ? q(row.maxOrderQty) : null },
        )
      : null
    return {
      site: siteView(site),
      asOf: toUtcIso(asOf),
      today: live.today,
      item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom },
      colour,
      uom: item.baseUom,
      parameters: row
        ? { itemPlanningId: row.id, method: row.method, lotSizing: row.lotSizing as LotSizing, safetyStock: row.safetyStock ? q(row.safetyStock) : null, delayDays: row.delayDays, words: { lotSizing: rowValues!.lotSizing, scrapYield: rowValues!.scrapYield, delay: rowValues!.delay } }
        : null,
      requirements: stored.map((line) => ({ runId: line.runId, id: line.id, seq: line.seq })),
      horizon: { from: profile.from, to: profile.to, weeks: profile.weeks },
      onHand: profile.onHand,
      safetyStock: profile.safetyStock,
      totals: profile.totals,
      rows: profile.rows.map((entry) => ({
        ...entry,
        demandRefs: entry.demandRefs.map((ref) => ({ order: { id: ref.orderId, number: ref.orderNumber, rank: ref.rank }, orderLine: { id: ref.orderLineId, seq: ref.lineSeq }, size: ref.size, workOrder: ref.workOrderId && ref.workOrderNumber ? { id: ref.workOrderId, number: ref.workOrderNumber } : null, day: ref.day, quantity: ref.quantity })),
        receiptRefs: entry.receiptRefs.map((ref) => ({
          kind: ref.kind,
          day: ref.day,
          quantity: ref.quantity,
          purchaseOrder: ref.kind === 'PURCHASE_ORDER' ? { id: ref.purchaseOrderId!, number: ref.purchaseOrderNumber!, lineId: ref.purchaseOrderLineId!, lineSeq: ref.lineSeq! } : null,
          requirementId: ref.kind === 'FIRM' ? (ref.requirementId ?? null) : null,
        })),
        plannedRefs: [...entry.plannedRefs],
      })),
      firstShort: profile.firstShort,
      firstBelowSafety: profile.firstBelowSafety,
      net: sum(peggings.map((pegging) => pegging.net)),
      uncovered: sum(peggings.map((pegging) => pegging.uncovered)),
      allocation,
      lots: { words: lotsWords(rule, lots, item.baseUom), list: lots.map((lot, index) => ({ ...lot, seq: index + 1 })) },
      earliest: { leadTimeDays: delays.leadTimeDays, delayDays: delays.delayDays, arrival: delays.arrival, usable: delays.usable, words: delays.words },
      delays: delays.delayed.map(({ entry, words }) => delayViewOf(entry, words)),
    }
  })
}

/** planning.view: every demand of the site whose material cannot be there in time, the latest first (PLN-082). */
export async function readDelays(caller: CommandCaller, query: { readonly siteId: string }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const asOf = serverClock.now()
  return caller.withClient(async (db) => {
    const live = await livePlanOf(db, site)
    const materials = [...new Map(live.plan.requirements.map((line) => [`${line.itemId}|${line.itemColourId ?? '-'}`, { itemId: line.itemId, itemColourId: line.itemColourId }])).values()]
    const plans = materials.map((material) => materialPlanOf(live, material.itemId, material.itemColourId))
    const leads = plans.map((plan) => leadTimeOf(live, plan.lines[0]!.requirement, plan.rule) ?? 0)
    const calendars = await delayCalendarsOf(db, live, plans.flatMap((plan) => plan.lines.flatMap((line) => (line.requirement.supplierId ? [line.requirement.supplierId] : []))), Math.max(0, ...leads))
    const itemIds = [...new Set(materials.map((material) => material.itemId))]
    const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: ITEM_VIEW })
    const colourIds = [...new Set(materials.flatMap((material) => (material.itemColourId ? [material.itemColourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
    const itemOf = new Map(items.map((item) => [item.id, item]))
    const colourOf = new Map(colours.map((entry) => [entry.id, entry]))
    const materialView = (itemId: string, itemColourId: string | null) => {
      const item = itemOf.get(itemId)!
      return { item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom }, colour: itemColourId ? (colourOf.get(itemColourId) ?? null) : null }
    }
    const perMaterial = plans.map((plan) => {
      const view = materialView(plan.itemId, plan.itemColourId)
      const label = [view.item.code, view.colour?.code].filter(Boolean).join(' ')
      return { plan, view, delays: delaysOf(live, plan, calendars, label) }
    })
    // Per demand (order line, size, work order): the material that makes it latest sets the day.
    const byDemand = new Map<string, { worst: { entry: DelayedPart; words: string; view: ReturnType<typeof materialView> }; all: { entry: DelayedPart; view: ReturnType<typeof materialView> }[] }>()
    for (const material of perMaterial) {
      for (const delayed of material.delays.delayed) {
        const key = [delayed.entry.part.orderLineId, delayed.entry.part.size ?? '-', delayed.entry.part.workOrderId ?? '-'].join('|')
        const found = byDemand.get(key)
        const candidate = { entry: delayed.entry, words: delayed.words, view: material.view }
        if (!found) byDemand.set(key, { worst: candidate, all: [{ entry: delayed.entry, view: material.view }] })
        else {
          found.all.push({ entry: delayed.entry, view: material.view })
          if (delayed.entry.usable > found.worst.entry.usable) found.worst = candidate
        }
      }
    }
    const demands = [...byDemand.values()]
      .map(({ worst, all }) => ({
        ...delayViewOf(worst.entry, worst.words),
        setBy: worst.view,
        materials: all.sort((a, b) => b.entry.daysLate - a.entry.daysLate).map(({ entry, view }) => ({ ...view, earliest: entry.usable, daysLate: entry.daysLate, source: entry.source })),
      }))
      .sort((a, b) => b.daysLate - a.daysLate || (a.needDate < b.needDate ? -1 : a.needDate > b.needDate ? 1 : 0) || (a.order.number < b.order.number ? -1 : a.order.number > b.order.number ? 1 : a.orderLine.seq - b.orderLine.seq))
    return {
      site: siteView(site),
      asOf: toUtcIso(asOf),
      today: live.today,
      tiles: {
        delayedDemands: demands.length,
        delayedOrders: new Set(demands.map((entry) => entry.order.id)).size,
        materials: perMaterial.filter((material) => material.delays.delayed.length > 0).length,
        mostDaysLate: demands[0]?.daysLate ?? null,
      },
      demands,
      materials: perMaterial
        .filter((material) => material.delays.delayed.length > 0)
        .map((material) => ({ ...material.view, action: material.delays.action, leadTimeDays: material.delays.leadTimeDays, delayDays: material.delays.delayDays, arrival: material.delays.arrival, usable: material.delays.usable, delayed: material.delays.delayed.length })),
    }
  })
}

