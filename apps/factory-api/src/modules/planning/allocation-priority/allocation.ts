import { toUtcIso } from '@nexus/factory-domain/core/time'
import { byPriority, rankWords } from '@nexus/factory-domain/planning/allocation-priority/rank'
import type { PartCoverage } from '@nexus/factory-domain/planning/mrp/net'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { decimalOf, QUANTITY_SCALE } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { latestDoneRun } from '../inputs'
import { livePlanOf } from '../readiness/service'
import type { AllocationQuery } from './contract'

/**
 * Who gets scarce material (B-W2b-318; PLN-088; ./contract): planning.view over the site; the site's plan computed now
 * (../readiness/service `livePlanOf`), each material's parts in the order the netting shared it out (factory-domain
 * planning/allocation-priority: by the backlog's rank when the material is short and an order is ranked, else by day).
 */

const ZERO = decimalOf('0')
const q = (value: { toString(): string }): string => decimalOf(value.toString()).toFixed(QUANTITY_SCALE)
const trim = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value)

/** What a part got, by kind of supply. */
function getsOf(entry: PartCoverage) {
  const of = (kind: string) => entry.supplies.filter((supply) => supply.kind === kind).reduce((sum, supply) => sum.plus(decimalOf(supply.quantity)), ZERO)
  return { issued: q(entry.part.issued), reserved: q(of('RESERVATION')), stock: q(of('STOCK')), purchaseOrders: q(of('PURCHASE_ORDER')), firm: q(of('FIRM')) }
}

function partWords(entry: PartCoverage, uom: string): string {
  const part = entry.part
  const gets = getsOf(entry)
  const need = decimalOf(part.quantity).minus(decimalOf(part.issued))
  const got = [
    decimalOf(gets.reserved).gt(0) ? `${trim(gets.reserved)} reserved for it` : null,
    decimalOf(gets.stock).gt(0) ? `${trim(gets.stock)} from stock` : null,
    decimalOf(gets.purchaseOrders).gt(0) ? `${trim(gets.purchaseOrders)} on purchase orders in time` : null,
    decimalOf(gets.firm).gt(0) ? `${trim(gets.firm)} from the firm planned order` : null,
  ].filter(Boolean)
  const who = `${part.orderNumber} (${rankWords(part.rank)}) line ${part.lineSeq}${part.size ? `, size ${part.size}` : ''}${part.workOrderNumber ? ` (${part.workOrderNumber})` : ''}`
  const short = decimalOf(entry.uncovered)
  return `${who} needs ${trim(q(need))} ${uom} on ${entry.day}; ${got.length > 0 ? `it gets ${got.join(', ')}` : 'it gets nothing yet'}${short.gt(0) ? `: short ${trim(q(short))}.` : ': covered.'}`
}

export async function readAllocationPriority(caller: CommandCaller, query: AllocationQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const asOf = serverClock.now()
  const scarceOnly = query.scarceOnly ?? true
  const colourFilter = query.itemColourId === undefined ? undefined : query.itemColourId === 'none' ? null : query.itemColourId
  return caller.withClient(async (db) => {
    const live = await livePlanOf(db, site)
    const chosen = live.plan.requirements
      .map((requirement, index) => ({ requirement, pegging: live.plan.netting[index]!.pegging }))
      .filter(({ requirement }) => (query.itemId === undefined || requirement.itemId === query.itemId) && (colourFilter === undefined || requirement.itemColourId === colourFilter))
      .filter(({ pegging }) => !scarceOnly || decimalOf(pegging.net).gt(0))
    const itemIds = [...new Set(chosen.map(({ requirement }) => requirement.itemId))]
    const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true, baseUom: true } })
    const colourIds = [...new Set(chosen.flatMap(({ requirement }) => (requirement.itemColourId ? [requirement.itemColourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
    const latest = await latestDoneRun(db, site.id)
    const stored = latest && itemIds.length > 0 ? await db.materialRequirement.findMany({ where: { runId: latest.id, itemId: { in: itemIds } }, select: { id: true, itemId: true, itemColourId: true, seq: true }, orderBy: { seq: 'asc' } }) : []
    const itemOf = new Map(items.map((item) => [item.id, item]))
    const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
    const ranked = new Set<string>()
    const materials = chosen.map(({ requirement, pegging }) => {
      const item = itemOf.get(requirement.itemId)!
      const allocation = pegging.allocation === 'PRIORITY' ? ('PRIORITY' as const) : ('DATE' as const)
      const open = pegging.coverage.map((entry, index) => ({ entry, part: entry.part, day: entry.day, index })).filter(({ entry }) => decimalOf(entry.part.quantity).minus(decimalOf(entry.part.issued)).gt(0))
      const walked = allocation === 'PRIORITY' ? [...open].sort(byPriority) : open
      const isRanked = open.some(({ part }) => typeof part.rank === 'number')
      if (decimalOf(pegging.net).gt(0)) for (const { part } of open) if (typeof part.rank === 'number') ranked.add(part.orderId)
      const orders = new Set(open.map(({ part }) => part.orderId)).size
      const words = !decimalOf(pegging.net).gt(0)
        ? `Enough for every order: nothing is short (${orders} order${orders === 1 ? '' : 's'}).`
        : allocation === 'PRIORITY'
          ? `Short ${trim(pegging.net)} ${item.baseUom}: shared by the backlog's rank, ranked orders first; the orders lower down are short.`
          : `Short ${trim(pegging.net)} ${item.baseUom}: shared by the day each order needs it${isRanked ? '' : ' (no order of it is ranked)'}.`
      return {
        item,
        colour: requirement.itemColourId ? (colourOf.get(requirement.itemColourId) ?? null) : null,
        requirementId: stored.find((line) => line.itemId === requirement.itemId && line.itemColourId === requirement.itemColourId)?.id ?? null,
        allocation,
        ranked: isRanked,
        gross: pegging.gross,
        usable: pegging.usable,
        onOrder: pegging.onOrder,
        net: pegging.net,
        uncovered: pegging.uncovered,
        parts: walked.map(({ entry }) => ({
          order: { id: entry.part.orderId, number: entry.part.orderNumber, rank: typeof entry.part.rank === 'number' ? entry.part.rank : null },
          orderLine: { id: entry.part.orderLineId, seq: entry.part.lineSeq },
          size: entry.part.size,
          workOrder: entry.part.workOrderId && entry.part.workOrderNumber ? { id: entry.part.workOrderId, number: entry.part.workOrderNumber } : null,
          day: entry.day,
          need: q(decimalOf(entry.part.quantity).minus(decimalOf(entry.part.issued))),
          gets: getsOf(entry),
          short: entry.uncovered,
          words: partWords(entry, item.baseUom),
        })),
        words,
      }
    })
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone },
      asOf: toUtcIso(asOf),
      today: live.today,
      tiles: { scarce: materials.filter((material) => decimalOf(material.net).gt(0)).length, byPriority: materials.filter((material) => material.allocation === 'PRIORITY').length, rankedOrders: ranked.size },
      materials,
    }
  })
}
