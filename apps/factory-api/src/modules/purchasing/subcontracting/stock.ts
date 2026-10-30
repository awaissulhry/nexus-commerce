import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { balancesFromSums, quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { lotUnitCost, stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, seesCost } from '../store'
import { nameOf } from './store'

/**
 * Stock at each subcontractor (B-W2a-25; SCM-141; design purchasing.subcontracting "Stock at subcontractors"): every
 * workshop is a stock location of our site (kind SUBCONTRACTOR, owned by the workshop), so our material there is the
 * stock ledger's balance at its location, by material, colour, lot and hide; it stays ours and in our books. Values only
 * with the cost grain: a lot's stock at the lot's cost (its valuations' moving average, as the stock overview), other
 * stock at the item's standard cost. purchasing.view over the location's company, site and workshop. Office only.
 */

const ROW_LIMIT = 5_000

export interface StockQuery {
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly locationId?: string | undefined
  readonly itemId?: string | undefined
}

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

/** purchasing.view: our stock at the workshops the caller reaches. */
export async function subcontractorStock(caller: CommandCaller, query: StockQuery) {
  const context = officeContextOf(caller)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const locations = await client.location.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.LocationWhereInput,
          { kind: 'SUBCONTRACTOR' },
          query.siteId ? { siteId: query.siteId } : {},
          query.partyId ? { partyId: query.partyId } : {},
          query.locationId ? { id: query.locationId } : {},
        ],
      },
      select: { id: true, siteId: true, code: true, name: true, partyId: true },
      orderBy: { code: 'asc' },
    })
    const ids = locations.map((location) => location.id)
    if (ids.length === 0) return { rows: [], workshops: [], truncated: false }
    const item = query.itemId ? { itemId: query.itemId } : {}
    const by = ['siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'] as const
    // One query after another (a scoped client may be one transaction's connection).
    const into = await client.stockMove.groupBy({ by: ['toLocationId', ...by], where: { toLocationId: { in: ids }, ...item }, _sum: { baseQuantity: true }, _max: { occurredAt: true } })
    const outOf = await client.stockMove.groupBy({ by: ['fromLocationId', ...by], where: { fromLocationId: { in: ids }, ...item }, _sum: { baseQuantity: true } })
    const side = (row: { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; _sum: { baseQuantity: Prisma.Decimal | null } }, locationId: string) => ({
      siteId: row.siteId,
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      lotId: row.lotId,
      hideId: row.hideId,
      locationId,
      quantity: row._sum.baseQuantity?.toString() ?? '0',
    })
    const balances = balancesFromSums(
      into.map((row) => side(row, row.toLocationId!)),
      outOf.map((row) => side(row, row.fromLocationId!)),
    ).filter((balance) => balance.onHand.greaterThan(0))
    const lastIn = new Map(into.map((row) => [`${row.toLocationId}|${row.itemId}|${row.itemColourId}|${row.lotId}|${row.hideId}`, row._max.occurredAt]))
    const items = new Map(
      (await client.item.findMany({ where: { id: { in: unique(balances.map((balance) => balance.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true, currency: true, ...(withCost ? { standardCost: true } : {}) } })).map((row) => [row.id, row]),
    )
    const colours = new Map((await client.itemColour.findMany({ where: { id: { in: unique(balances.map((balance) => balance.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const lots = new Map((await client.lot.findMany({ where: { id: { in: unique(balances.map((balance) => balance.lotId)) } }, select: { id: true, code: true, qualityStatus: true } })).map((row) => [row.id, row]))
    const hides = new Map((await client.hide.findMany({ where: { id: { in: unique(balances.map((balance) => balance.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const sites = new Map((await client.site.findMany({ where: { id: { in: unique(locations.map((location) => location.siteId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const parties = new Map(
      (await client.party.findMany({ where: { id: { in: unique(locations.map((location) => location.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: nameOf(row) }]),
    )
    const valuations = withCost
      ? await client.stockValuation.findMany({ where: { lotId: { in: unique(balances.map((balance) => balance.lotId)) } }, select: { siteId: true, lotId: true, quantity: true, unitCost: true } })
      : []
    const locationOf = new Map(locations.map((location) => [location.id, location]))
    const lotCosts = new Map<string, Decimal | null>()
    const unitCostOf = (balance: (typeof balances)[number]): Decimal | null => {
      if (balance.lotId) {
        const key = `${balance.siteId}|${balance.lotId}`
        if (!lotCosts.has(key)) lotCosts.set(key, lotUnitCost(valuations.filter((row) => row.siteId === balance.siteId && row.lotId === balance.lotId).map((row) => ({ quantity: row.quantity.toString(), unitCost: row.unitCost.toString() }))))
        const lot = lotCosts.get(key)
        if (lot) return lot
      }
      const standard = (items.get(balance.itemId) as { standardCost?: Prisma.Decimal | null } | undefined)?.standardCost
      return standard ? new Dec(standard.toString()) : null
    }
    const rows = balances.slice(0, ROW_LIMIT).map((balance) => {
      const location = locationOf.get(balance.locationId)!
      const itemRow = items.get(balance.itemId)!
      const unitCost = withCost ? unitCostOf(balance) : null
      const at = lastIn.get(`${balance.locationId}|${balance.itemId}|${balance.itemColourId}|${balance.lotId}|${balance.hideId}`) ?? null
      return {
        site: sites.get(balance.siteId) ?? { id: balance.siteId, code: '' },
        workshop: parties.get(location.partyId ?? '') ?? { id: location.partyId ?? location.id, code: '', name: '' },
        location: { id: location.id, code: location.code, name: location.name },
        item: { id: itemRow.id, code: itemRow.code, name: itemRow.name, baseUom: itemRow.baseUom },
        colour: balance.itemColourId ? (colours.get(balance.itemColourId) ?? null) : null,
        lot: balance.lotId ? (lots.get(balance.lotId) ?? null) : null,
        hide: balance.hideId ? (hides.get(balance.hideId) ? { id: balance.hideId, code: hides.get(balance.hideId)!.code, name: hides.get(balance.hideId)!.code } : null) : null,
        onHand: quantityText(balance.onHand),
        lastSentAt: at ? toUtcIso(at) : null,
        unitCost: asMoney('cost', unitCost ? unitCost.toFixed(6) : null),
        value: asMoney('cost', unitCost ? stockValue(balance.onHand, unitCost, itemRow.currency) : null),
        currency: itemRow.currency,
      }
    })
    const workshops = locations
      .map((location) => {
        const mine = rows.filter((row) => row.location.id === location.id)
        const value = mine.reduce<number | null>((sum, row) => (sum === null || row.value === null ? null : sum + (row.value as number)), 0)
        return {
          workshop: parties.get(location.partyId ?? '') ?? { id: location.partyId ?? location.id, code: '', name: '' },
          location: { id: location.id, code: location.code, name: location.name },
          site: sites.get(location.siteId) ?? { id: location.siteId, code: '' },
          lines: mine.length,
          value: asMoney('cost', withCost ? value : null),
        }
      })
      .filter((entry) => entry.lines > 0 || query.locationId !== undefined || query.partyId !== undefined)
    return { rows, workshops, truncated: balances.length > ROW_LIMIT }
  })
}
