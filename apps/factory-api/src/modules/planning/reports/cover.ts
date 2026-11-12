import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { demandHorizon } from '@nexus/factory-domain/planning/demand/rules'
import { itemProfile, type ProfileDemand, type ProfileReceipt } from '@nexus/factory-domain/planning/item-profile/profile'
import { PLANNING_REPORTS_VIEW } from '@nexus/factory-domain/planning/reports/permissions'
import { coverOf, coverOrder, PLANNING_REPORT_LIMITS } from '@nexus/factory-domain/planning/reports/rules'
import { decimalOf, QUANTITY_SCALE } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { materialPlanOf } from '../item-profile/facts'
import { livePlanOf } from '../readiness/service'
import type { CoverQuery } from './contract'

/**
 * Material cover and projected stock-outs (B-W2b-349; PLN-207; design planning.reports sec cover "Days of cover per material and
 * projected stock-out dates", columns material, days of cover, stock-out date, open POs): every material and colour the site's
 * plan computed now needs (../readiness/service `livePlanOf`: the same inputs and netting as a run, one plan read), each through
 * B-W2b-318's item profile (`materialPlanOf` + factory-domain `itemProfile`: on hand + open purchase lines and the firm planned
 * order − what the orders still need, nothing more ordered) and factory-domain planning/reports `coverOf`: the projected
 * stock-out day in the profile's first short week, the days of cover until it, the day it falls below the safety stock. A
 * material with no demand in the horizon and nothing below its safety stock is left out. Quantities in the material's base unit;
 * no money, no person (orders are counted, never named here).
 */

const q = (value: { toString(): string }): string => decimalOf(value.toString()).toFixed(QUANTITY_SCALE)
const sum = (values: readonly string[]): string => q(values.reduce((total, value) => total.plus(decimalOf(value)), decimalOf('0')))

/** GET /planning/reports/cover (sec cover): the materials by how soon they run out. */
export async function coverAnswer(caller: CommandCaller, query: CoverQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_REPORTS_VIEW)
  const asOf = serverClock.now()
  const weeks = query.weeks ?? PLANNING_REPORT_LIMITS.coverWeeks.default
  return caller.withClient(async (db) => {
    const live = await livePlanOf(db, site)
    const today = live.today
    const materials = [...new Map(live.plan.requirements.map((line) => [`${line.itemId}|${line.itemColourId ?? '-'}`, { itemId: line.itemId, itemColourId: line.itemColourId }])).values()]
    const itemIds = [...new Set(materials.map((material) => material.itemId))]
    const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } })
    const colourIds = [...new Set(materials.flatMap((material) => (material.itemColourId ? [material.itemColourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
    const itemOf = new Map(items.map((item) => [item.id, item]))
    const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
    const span = demandHorizon(today, weeks)
    const rows = materials.flatMap((material) => {
      const item = itemOf.get(material.itemId)
      if (!item) return []
      const colour = material.itemColourId ? (colourOf.get(material.itemColourId) ?? null) : null
      const plan = materialPlanOf(live, material.itemId, material.itemColourId)
      const purchases = live.inputs.purchases.filter((line) => line.itemId === material.itemId && line.itemColourId === material.itemColourId)
      // What each part still needs (less what is issued to its work order), on its day; the open purchase lines on their due day
      // and the firm planned order on its date — as the item profile counts them.
      const demand: ProfileDemand[] = plan.peggings.flatMap((pegging) =>
        pegging.coverage.flatMap((entry) => {
          const need = decimalOf(entry.part.quantity).minus(decimalOf(entry.part.issued))
          if (!need.gt(0)) return []
          const part = entry.part
          return [{ day: entry.day, quantity: q(need), ref: { orderId: part.orderId, orderNumber: part.orderNumber, orderLineId: part.orderLineId, lineSeq: part.lineSeq, size: part.size, workOrderId: part.workOrderId, workOrderNumber: part.workOrderNumber, rank: typeof part.rank === 'number' ? part.rank : null } }]
        }),
      )
      const receipts: ProfileReceipt[] = [
        ...purchases.map((line) => ({ kind: 'PURCHASE_ORDER' as const, day: line.dueDate, quantity: q(line.openQuantity), purchaseOrderLineId: line.purchaseOrderLineId, purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber, lineSeq: line.seq })),
        ...plan.lines.flatMap((line) => (line.netting.carried ? [{ kind: 'FIRM' as const, day: line.netting.carried.date, quantity: q(line.netting.carried.baseQuantity), requirementId: line.netting.carried.requirementId }] : [])),
      ]
      const profile = itemProfile({ today, weeks, onHand: sum(plan.peggings.map((pegging) => pegging.usable)), safetyStock: plan.rule?.safetyStock ? q(plan.rule.safetyStock) : null, demand, receipts, planned: [] })
      const cover = coverOf({ today, profile, demand, receipts })
      if (!decimalOf(cover.demand).gt(0) && cover.state === 'COVERED') return []
      const next = [...purchases].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.purchaseOrderNumber.localeCompare(b.purchaseOrderNumber) || a.seq - b.seq))[0]
      return [
        {
          label: [item.code, colour?.code].filter(Boolean).join(' '),
          item,
          colour,
          action: plan.lines[0]?.requirement.action ?? ('BUY' as const),
          onHand: profile.onHand,
          safetyStock: profile.safetyStock,
          ...cover,
          firstShort: profile.firstShort,
          uncovered: sum(plan.peggings.map((pegging) => pegging.uncovered)),
          openPurchases: {
            orders: new Set(purchases.map((line) => line.purchaseOrderId)).size,
            lines: purchases.length,
            quantity: sum(purchases.map((line) => q(line.openQuantity))),
            next: next ? { day: next.dueDate, purchaseOrderId: next.purchaseOrderId, number: next.purchaseOrderNumber, quantity: q(next.openQuantity) } : null,
          },
        },
      ]
    })
    rows.sort(coverOrder)
    const shown = rows.slice(0, PLANNING_REPORT_LIMITS.coverRows)
    const count = (state: (typeof rows)[number]['state']) => rows.filter((row) => row.state === state).length
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone },
      today,
      asOf: toUtcIso(asOf),
      horizon: { from: span.from, to: span.to, weeks, days: daysFrom(span.from, span.to) + 1 },
      counts: { materials: rows.length, shortNow: count('SHORT_NOW'), stockOut: count('STOCK_OUT'), belowSafety: count('BELOW_SAFETY'), covered: count('COVERED') },
      rows: shown.map(({ label: _label, ...row }) => row),
      more: Math.max(0, rows.length - shown.length),
    }
  })
}
