import type { FactoryClient, Prisma, StockMoveReason } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  balancesFromSums,
  changesSiteStock,
  foldBalances,
  locatedKeyOf,
  quantityText,
  stockCard,
  type Balance,
  type LedgerMove,
} from '@nexus/factory-domain/inventory/ledger/moves'
import { lotUnitCost, stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { figuresOf, itemTotals, reconcileBalances, type LotQualityStatus } from '@nexus/factory-domain/inventory/stock/overview'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, seesCost, siteFor } from '../ledger/access'

/**
 * The stock overview, the stock card and the ledger check (SCM-190, SCM-191, SCM-198, SCM-258, SCM-280, QHS-073; A2
 * SCR-060, SCR-064; PLAN §4.7 end check), office reads. Balances are sums of the ledger (StockMove, indexed per stock
 * key), never a stored figure: on hand per site, location, item, colour, lot and hide; held = the stock of a lot that is
 * not RELEASED; available = on hand − held. Values only for a caller with the cost grain: a lot's stock at the lot's cost
 * (its valuations' moving average), other stock at the item's standard cost.
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const
const ROW_LIMIT = 5_000
type GroupRow = { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; _sum: { baseQuantity: Prisma.Decimal | null } }

/** The balances of the moves matching `where`, per location and stock key (two GROUP BYs, folded by the domain). */
async function sumBalances(client: FactoryClient, where: Prisma.StockMoveWhereInput, keepZero = false): Promise<Balance[]> {
  const [into, outOf] = await Promise.all([
    client.stockMove.groupBy({ by: ['toLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { AND: [where, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
    client.stockMove.groupBy({ by: ['fromLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { AND: [where, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
  ])
  const side = (row: GroupRow, locationId: string) => ({ ...row, locationId, quantity: row._sum.baseQuantity?.toString() ?? '0' })
  return balancesFromSums(
    into.map((row) => side(row, row.toLocationId!)),
    outOf.map((row) => side(row, row.fromLocationId!)),
    { keepZero },
  )
}

export interface OverviewQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly locationId?: string | undefined
  /** Only held stock (a lot not RELEASED). */
  readonly held?: boolean | undefined
}

/** SCR-060: the stock the caller may see, per location and stock key, with the totals per item and colour. */
export async function stockOverview(caller: CommandCaller, query: OverviewQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.StockMoveWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.StockMoveWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.itemId ? { itemId: query.itemId } : {},
      query.itemColourId ? { itemColourId: query.itemColourId } : {},
      query.lotId ? { lotId: query.lotId } : {},
      query.hideId ? { hideId: query.hideId } : {},
      query.locationId ? { OR: [{ toLocationId: query.locationId }, { fromLocationId: query.locationId }] } : {},
    ],
  }
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    let balances = await sumBalances(client, where)
    if (query.locationId) balances = balances.filter((balance) => balance.locationId === query.locationId)
    const lotIds = [...new Set(balances.flatMap((balance) => (balance.lotId ? [balance.lotId] : [])))]
    const [items, colours, lots, hides, locations, sites, valuations] = await Promise.all([
      client.item.findMany({
        where: { id: { in: [...new Set(balances.map((balance) => balance.itemId))] } },
        select: { id: true, code: true, name: true, baseUom: true, tracking: true, currency: true, ...(withCost ? { standardCost: true } : {}) },
      }),
      client.itemColour.findMany({ where: { id: { in: [...new Set(balances.flatMap((balance) => (balance.itemColourId ? [balance.itemColourId] : [])))] } }, select: { id: true, code: true, name: true } }),
      client.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, code: true, qualityStatus: true } }),
      client.hide.findMany({ where: { id: { in: [...new Set(balances.flatMap((balance) => (balance.hideId ? [balance.hideId] : [])))] } }, select: { id: true, code: true } }),
      client.location.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.locationId))] } }, select: { id: true, code: true, name: true } }),
      client.site.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.siteId))] } }, select: { id: true, code: true } }),
      withCost && lotIds.length > 0 ? client.stockValuation.findMany({ where: { lotId: { in: lotIds } }, select: { siteId: true, lotId: true, quantity: true, unitCost: true } }) : Promise.resolve([]),
    ])
    const itemOf = new Map(items.map((item) => [item.id, item]))
    const lotOf = new Map(lots.map((lot) => [lot.id, lot]))
    const named = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))
    const colourOf = named(colours)
    const hideOf = named(hides)
    const locationOf = named(locations)
    const siteOf = named(sites)
    const statusOf = (lotId: string) => lotOf.get(lotId)?.qualityStatus as LotQualityStatus | undefined
    const shown = query.held ? balances.filter((balance) => balance.lotId && statusOf(balance.lotId) !== 'RELEASED') : balances

    const lotCosts = new Map<string, Decimal | null>()
    const unitCostOf = (balance: Balance): Decimal | null => {
      if (balance.lotId) {
        const key = `${balance.siteId}|${balance.lotId}`
        if (!lotCosts.has(key)) {
          lotCosts.set(key, lotUnitCost(valuations.filter((row) => row.siteId === balance.siteId && row.lotId === balance.lotId).map((row) => ({ quantity: row.quantity.toString(), unitCost: row.unitCost.toString() }))))
        }
        const lot = lotCosts.get(key)
        if (lot) return lot
      }
      const standard = (itemOf.get(balance.itemId) as { standardCost?: Prisma.Decimal | null } | undefined)?.standardCost
      return standard ? new Dec(standard.toString()) : null
    }
    const valueOf = (balance: Balance) => {
      const unitCost = unitCostOf(balance)
      const item = itemOf.get(balance.itemId)!
      return unitCost ? { unitCost: unitCost.toFixed(6), value: stockValue(balance.onHand, unitCost, item.currency) } : null
    }

    const rows = shown.slice(0, ROW_LIMIT).map((balance) => {
      const item = itemOf.get(balance.itemId)!
      const lot = balance.lotId ? lotOf.get(balance.lotId) : undefined
      const figures = figuresOf(balance.onHand, lot?.qualityStatus as LotQualityStatus | undefined)
      const value = withCost ? valueOf(balance) : null
      return {
        siteId: balance.siteId,
        siteCode: siteOf.get(balance.siteId)?.code ?? '',
        location: locationOf.get(balance.locationId) ?? { id: balance.locationId, code: '', name: '' },
        item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking },
        colour: balance.itemColourId ? (colourOf.get(balance.itemColourId) ?? null) : null,
        lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus } : null,
        hide: balance.hideId ? (hideOf.get(balance.hideId) ?? null) : null,
        onHand: quantityText(figures.onHand),
        held: quantityText(figures.held),
        available: quantityText(figures.available),
        ...(withCost ? { unitCost: asMoney('cost', value?.unitCost ?? null), value: asMoney('cost', value?.value ?? null) } : {}),
      }
    })
    const perItem = itemTotals(shown, statusOf).map((total) => {
      const item = itemOf.get(total.itemId)!
      const value = withCost
        ? shown
            .filter((balance) => balance.itemId === total.itemId && balance.itemColourId === total.itemColourId)
            .reduce<number | null>((sum, balance) => {
              const one = valueOf(balance)
              return one === null || sum === null ? null : sum + one.value
            }, 0)
        : null
      return {
        ...total,
        item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking },
        colour: total.itemColourId ? (colourOf.get(total.itemColourId) ?? null) : null,
        ...(withCost ? { value: asMoney('cost', value), currency: item.currency } : {}),
      }
    })
    return { rows, items: perItem, truncated: shown.length > ROW_LIMIT }
  })
}

// ---- the stock card (SCM-191) ------------------------------------------------------------------------------------------

export interface CardQuery {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  /** The card of one location; default the whole site (transfers inside it move nothing). */
  readonly locationId?: string | undefined
  readonly limit: number
}

/**
 * "Why is it this number" (SCM-191): the moves of an item at a site (narrowed to a colour, lot, hide or location), oldest
 * first, each with its effect and the balance after it; at most `limit`, the latest ones, from the balance before them.
 */
export async function stockCardOf(caller: CommandCaller, query: CardQuery) {
  officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'query/siteId')
  const where: Prisma.StockMoveWhereInput = {
    siteId: site.id,
    itemId: query.itemId,
    ...(query.itemColourId ? { itemColourId: query.itemColourId } : {}),
    ...(query.lotId ? { lotId: query.lotId } : {}),
    ...(query.hideId ? { hideId: query.hideId } : {}),
    ...(query.locationId ? { OR: [{ toLocationId: query.locationId }, { fromLocationId: query.locationId }] } : {}),
  }
  return caller.withClient(async (client) => {
    const latest = await client.stockMove.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        siteId: true,
        reason: true,
        itemId: true,
        itemColourId: true,
        lotId: true,
        hideId: true,
        fromLocationId: true,
        toLocationId: true,
        quantity: true,
        uom: true,
        baseQuantity: true,
        reference: true,
        note: true,
        reversalOfId: true,
        occurredAt: true,
        createdAt: true,
        createdById: true,
      },
    })
    const shown = latest.slice(0, query.limit).reverse()
    let opening: Decimal = ZERO
    if (latest.length > query.limit) {
      const before = await client.stockMove.findMany({ where: { AND: [where, { id: { lt: shown[0]!.id } }] }, select: { fromLocationId: true, toLocationId: true, baseQuantity: true } })
      opening = before.reduce<Decimal>((sum, move) => {
        const quantity = new Dec(move.baseQuantity.toString())
        if (query.locationId) return move.toLocationId === query.locationId ? sum.plus(quantity) : move.fromLocationId === query.locationId ? sum.minus(quantity) : sum
        return changesSiteStock(move) ? (move.toLocationId ? sum.plus(quantity) : sum.minus(quantity)) : sum
      }, ZERO)
    }
    const ledger = shown.map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() }) satisfies LedgerMove & { reason: StockMoveReason })
    const lines = stockCard(opening, ledger, query.locationId ?? null)
    return {
      siteId: site.id,
      itemId: query.itemId,
      locationId: query.locationId ?? null,
      opening: quantityText(opening),
      closing: quantityText(lines.at(-1)?.balance ?? opening),
      complete: latest.length <= query.limit,
      lines: lines.map(({ move, delta, balance }) => ({
        moveId: move.id,
        reason: move.reason,
        itemColourId: move.itemColourId,
        lotId: move.lotId,
        hideId: move.hideId,
        fromLocationId: move.fromLocationId,
        toLocationId: move.toLocationId,
        quantity: move.quantity.toFixed(4),
        uom: move.uom,
        baseQuantity: quantityText(move.baseQuantity),
        reference: move.reference,
        note: move.note,
        reversalOfId: move.reversalOfId,
        occurredAt: toUtcIso(move.occurredAt),
        createdAt: toUtcIso(move.createdAt),
        createdById: move.createdById,
        delta: quantityText(delta),
        balance: quantityText(balance),
      })),
    }
  })
}

// ---- the ledger check (PLAN §4.7 end check) ----------------------------------------------------------------------------

const PAGE = 5_000

export interface Check {
  readonly name: 'balances' | 'not_below_zero' | 'reversals' | 'valuations'
  /** error: the ledger does not reconcile; warning: something to look at. */
  readonly severity: 'error' | 'warning'
  readonly ok: boolean
  readonly message: string
  readonly details: string[]
}

/**
 * The stock ledger reconciles: per site the caller may see, the balances folded move by move (the domain) equal the
 * database's sums (what the overview shows), no balance is below zero, every reversal mirrors its original (and a move
 * has at most one); warning: moves that enter or leave the site's stock without a value yet. `ok` = no error.
 */
export async function reconcile(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeContextOf(caller)
  if (query.siteId) await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'query/siteId')
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where: { AND: [scope, query.siteId ? { id: query.siteId } : {}] }, select: { id: true, code: true, companyId: true }, orderBy: { code: 'asc' } })
    const results = []
    for (const site of sites) {
      const moves: (LedgerMove & { id: string; reason: StockMoveReason; reversalOfId: string | null })[] = []
      for (let cursor: string | undefined; ; ) {
        const page = await client.stockMove.findMany({
          where: { siteId: site.id, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: PAGE,
          select: { id: true, siteId: true, reason: true, itemId: true, itemColourId: true, lotId: true, hideId: true, fromLocationId: true, toLocationId: true, baseQuantity: true, reversalOfId: true },
        })
        for (const move of page) moves.push({ ...move, baseQuantity: move.baseQuantity.toString() })
        if (page.length < PAGE) break
        cursor = page.at(-1)!.id
      }
      const folded = foldBalances(moves)
      const summed = await sumBalances(client, { siteId: site.id })
      const { mismatches, negative } = reconcileBalances(folded, summed)

      const byId = new Map(moves.map((move) => [move.id, move]))
      const reversalProblems: string[] = []
      const reversedOnce = new Map<string, number>()
      for (const move of moves.filter((entry) => entry.reversalOfId)) {
        const original = byId.get(move.reversalOfId!)
        reversedOnce.set(move.reversalOfId!, (reversedOnce.get(move.reversalOfId!) ?? 0) + 1)
        const mirrors =
          original &&
          !original.reversalOfId &&
          original.reason === move.reason &&
          locatedKeyOf({ ...original, locationId: '-' }) === locatedKeyOf({ ...move, locationId: '-' }) &&
          original.fromLocationId === move.toLocationId &&
          original.toLocationId === move.fromLocationId &&
          new Dec(original.baseQuantity).equals(new Dec(move.baseQuantity))
        if (!mirrors) reversalProblems.push(`Move ${move.id} does not mirror move ${move.reversalOfId}.`)
      }
      for (const [original, count] of reversedOnce) if (count > 1) reversalProblems.push(`Move ${original} has ${count} reversals.`)

      const changing = moves.filter((move) => changesSiteStock(move)).map((move) => move.id)
      const valued = new Set<string>()
      for (let index = 0; index < changing.length; index += PAGE) {
        const rows = await client.stockValuation.findMany({ where: { moveId: { in: changing.slice(index, index + PAGE) } }, select: { moveId: true } })
        for (const row of rows) valued.add(row.moveId)
      }
      const unvalued = changing.filter((id) => !valued.has(id))

      const checks: Check[] = [
        {
          name: 'balances',
          severity: 'error',
          ok: mismatches.length === 0,
          message: mismatches.length === 0 ? 'The balances folded move by move equal the sums the overview shows.' : `${mismatches.length} balance(s) differ between the moves and the sums.`,
          details: mismatches.slice(0, 50).map((entry) => `${entry.key}: moves ${entry.folded}, sums ${entry.summed}`),
        },
        {
          name: 'not_below_zero',
          severity: 'error',
          ok: negative.length === 0,
          message: negative.length === 0 ? 'No balance is below zero.' : `${negative.length} balance(s) are below zero.`,
          details: negative.slice(0, 50),
        },
        {
          name: 'reversals',
          severity: 'error',
          ok: reversalProblems.length === 0,
          message: reversalProblems.length === 0 ? 'Every reversal mirrors its original, at most one per move.' : `${reversalProblems.length} reversal problem(s).`,
          details: reversalProblems.slice(0, 50),
        },
        {
          name: 'valuations',
          severity: 'warning',
          ok: unvalued.length === 0,
          message: unvalued.length === 0 ? 'Every move into or out of the site\'s stock has its value.' : `${unvalued.length} move(s) into or out of the site's stock have no value yet (a floor move the worker has not valued, or no cost basis).`,
          details: unvalued.slice(0, 50),
        },
      ]
      results.push({ siteId: site.id, siteCode: site.code, moves: moves.length, balances: summed.length, ok: checks.every((check) => check.ok || check.severity !== 'error'), checks })
    }
    if (query.siteId && results.length === 0) throw new ValidationError('The site is not valid.', [{ path: 'query/siteId', message: 'Not a site you may see.' }])
    return { ok: results.every((result) => result.ok), sites: results }
  })
}
