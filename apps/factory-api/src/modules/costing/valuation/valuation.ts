import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { isProvisional, type CostingMethod } from '@nexus/factory-domain/costing/ledger/entries'
import type { ValuationAnswer, ValuationQuery, ValuationRowView } from '@nexus/factory-domain/costing/valuation/contracts'
import {
  areaM2,
  basisWords,
  categoryOfKind,
  dependsOnMethod,
  totalsOf,
  unitCostOf,
  valuationMethodWords,
  valuationRows,
  VALUATION_CATEGORIES,
  wipRows,
  type KeyBalance,
  type ValuationCategory,
} from '@nexus/factory-domain/costing/valuation/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import type { ValuationMethod } from '@nexus/factory-domain/inventory/ledger/valuation'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../../inventory/ledger/access'
import { unique, type Reader } from '../actual/store'
import { methodInForce } from '../method/method'

/**
 * Stock valuation at any date (B-W2a-29; FIN-039; design finance.reports "Stock valuation"): value on hand by category,
 * site, item, colour and lot (hides rolled into their lot and counted), and the work in progress of every work order, as
 * the ledgers record them up to the date. Office reads with inventory.stock.view over the site's company and site (the
 * design's planner and warehouse see the quantities; values only with the cost grain, dropped by the grain filter).
 *
 * `valueStockAsOf` is the one function the year-end pack (B-W2a-39) reads as of 31 December: the stock ledger's values
 * (StockValuation) of the moves up to the date, never recomputed, and the cost ledger's WIP; each figure says what it
 * rests on and whether the company's costing method (the accountant's) could value it differently.
 */

const ROW_LIMIT = 5_000
const SITE_SCOPE = { company: 'companyId', site: 'id' } as const
const DONE = new Set(['COMPLETED', 'CLOSED', 'CANCELLED'])

/** The last instant of a Europe/Rome day: every move up to its end. */
export const endOfDay = (day: BusinessDate): Date => new Date(businessDayRange(day).end.getTime() - 1)

/** What to value; the caller's scope is already in `siteIds`. */
export interface StockValuationFilters {
  /** The sites to value; null: every site of the tenant (the system's year-end pack). */
  readonly siteIds: readonly string[] | null
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly lotId?: string | undefined
  readonly categories?: readonly ValuationCategory[] | undefined
  readonly q?: string | undefined
}

/** The sites a valuation reads: the caller's, narrowed to the one asked for. */
const sitesIn = (filters: StockValuationFilters): string[] | null =>
  filters.siteIds === null ? (filters.siteId ? [filters.siteId] : null) : filters.siteIds.filter((id) => !filters.siteId || id === filters.siteId)

interface RawBalance {
  companyId: string
  siteId: string
  itemId: string
  itemColourId: string | null
  lotId: string | null
  hideId: string | null
  quantity: string
  valuedQuantity: string
  value: string
  unvaluedMoves: number
  methods: string[]
  currencies: string[]
}

/** The stock keys' balances and values up to `at` (one GROUP BY over the moves and their valuations; RLS keeps the tenant). */
export async function keyBalances(db: Reader, filters: StockValuationFilters, at: Date | null): Promise<KeyBalance[]> {
  const siteIds = sitesIn(filters)
  if (siteIds !== null && siteIds.length === 0) return []
  const rows = await db.$queryRaw<RawBalance[]>`
    SELECT m."companyId" AS "companyId", m."siteId" AS "siteId", m."itemId" AS "itemId", m."itemColourId" AS "itemColourId",
           m."lotId" AS "lotId", m."hideId" AS "hideId",
           SUM(CASE WHEN m."toLocationId" IS NULL THEN -m."baseQuantity" ELSE m."baseQuantity" END)::text AS quantity,
           COALESCE(SUM(v."quantity"), 0)::text AS "valuedQuantity",
           COALESCE(SUM(v."valueAmount"), 0)::text AS value,
           (COUNT(*) FILTER (WHERE v.id IS NULL))::int AS "unvaluedMoves",
           COALESCE(ARRAY_AGG(DISTINCT v.method::text) FILTER (WHERE v.id IS NOT NULL), ARRAY[]::text[]) AS methods,
           COALESCE(ARRAY_AGG(DISTINCT v.currency) FILTER (WHERE v.id IS NOT NULL), ARRAY[]::text[]) AS currencies
      FROM "StockMove" m
      LEFT JOIN "StockValuation" v ON v."tenantId" = m."tenantId" AND v."siteId" = m."siteId" AND v."moveId" = m.id
     WHERE (m."fromLocationId" IS NULL) <> (m."toLocationId" IS NULL)
       AND (${siteIds}::uuid[] IS NULL OR m."siteId" = ANY(${siteIds}::uuid[]))
       AND (${filters.companyId ?? null}::uuid IS NULL OR m."companyId" = ${filters.companyId ?? null}::uuid)
       AND (${filters.itemId ?? null}::uuid IS NULL OR m."itemId" = ${filters.itemId ?? null}::uuid)
       AND (${filters.lotId ?? null}::uuid IS NULL OR m."lotId" = ${filters.lotId ?? null}::uuid)
       AND (${at}::timestamptz IS NULL OR m."occurredAt" <= ${at}::timestamptz)
     GROUP BY m."companyId", m."siteId", m."itemId", m."itemColourId", m."lotId", m."hideId"`
  return rows.map((row) => ({
    ...row,
    value: Number.parseInt(row.value, 10),
    methods: row.methods as ValuationMethod[],
  }))
}

/** The costing method of each company, with its words. */
export async function methodsOf(db: Reader, companyIds: readonly string[]) {
  const out = new Map<string, { companyId: string; method: CostingMethod; provisional: boolean; words: string }>()
  for (const companyId of [...companyIds].sort()) {
    const { method } = await methodInForce(db, companyId)
    out.set(companyId, { companyId, method, provisional: isProvisional(method), words: valuationMethodWords(method) })
  }
  return out
}

const CATEGORY_ORDER = new Map(VALUATION_CATEGORIES.map((category, index) => [category, index]))

/**
 * The stock as the ledgers value it at `at` (null: now), in the shape of GET /costing/valuation (values marked with the
 * cost grain). B-W2a-39's year-end pack calls it with `endOfDay('2026-12-31')` and the company.
 */
export async function valueStockAsOf(db: Reader, filters: StockValuationFilters, at: Date | null): Promise<Omit<ValuationAnswer, 'truncated'> & { readonly rows: ValuationRowView[] }> {
  const wanted = new Set(filters.categories && filters.categories.length > 0 ? filters.categories : VALUATION_CATEGORIES)
  const { rows: stockRows, residues } = valuationRows(await keyBalances(db, filters, at))
  const items = new Map(
    (await db.item.findMany({ where: { id: { in: unique([...stockRows, ...residues].map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, kind: true, baseUom: true, tracking: true } })).map((row) => [row.id, row]),
  )
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique(stockRows.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(stockRows.map((row) => row.lotId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))

  // WIP: every work order's cost entries up to the date (none when an item or a lot is asked for).
  const withWip = wanted.has('WIP') && !filters.itemId && !filters.lotId
  const siteIds = sitesIn(filters)
  const wipGroups =
    withWip && (siteIds === null || siteIds.length > 0)
      ? await db.workOrderCostEntry.groupBy({
          by: ['workOrderId', 'companyId', 'siteId', 'currency'],
          where: { AND: [siteIds === null ? {} : { siteId: { in: [...siteIds] } }, filters.companyId ? { companyId: filters.companyId } : {}, at ? { occurredAt: { lte: at } } : {}] },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : []
  const workOrders = new Map(
    (await db.workOrder.findMany({ where: { id: { in: unique(wipGroups.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true, completedAt: true, closedAt: true, cancelledAt: true } })).map((row) => [row.id, row]),
  )
  const doneBy = (row: { status: string; completedAt: Date | null; closedAt: Date | null; cancelledAt: Date | null }): boolean =>
    at === null ? DONE.has(row.status) : [row.completedAt, row.closedAt, row.cancelledAt].some((when) => when !== null && when.getTime() <= at.getTime())
  const sites = new Map(
    (await db.site.findMany({ where: { id: { in: unique([...stockRows.map((row) => row.siteId), ...wipGroups.map((row) => row.siteId)]) } }, select: { id: true, code: true } })).map((row) => [row.id, row]),
  )
  const methods = await methodsOf(db, unique([...stockRows.map((row) => row.companyId), ...wipGroups.map((row) => row.companyId), ...residues.map((row) => row.companyId)]))
  const methodOf = (companyId: string): CostingMethod => methods.get(companyId)?.method ?? 'UNDECIDED'
  const needle = filters.q?.toLowerCase() ?? null

  const rows: ValuationRowView[] = []
  for (const row of stockRows) {
    const item = items.get(row.itemId)!
    const category = categoryOfKind(item.kind)
    if (!wanted.has(category)) continue
    const lot = row.lotId ? (lots.get(row.lotId) ?? { id: row.lotId, code: '' }) : null
    if (needle && ![item.code, item.name, lot?.code ?? ''].some((text) => text.toLowerCase().includes(needle))) continue
    const depends = dependsOnMethod(methodOf(row.companyId), row.methods)
    const currency = row.currency ?? costingCurrency(null)
    const area = areaM2(row.quantity, item.baseUom as Uom)
    rows.push({
      category,
      companyId: row.companyId,
      site: sites.get(row.siteId) ?? { id: row.siteId, code: '' },
      item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom, tracking: item.tracking },
      colour: row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null,
      lot,
      workOrder: null,
      quantity: quantityText(row.quantity),
      uom: item.baseUom,
      hides: row.hides,
      areaM2: category === 'LEATHER' && area !== null ? quantityText(area) : null,
      value: asMoney('cost', row.value),
      unitCost: asMoney('cost', row.valued === 'FULL' ? unitCostOf(row.value, row.quantity, currency) : unitCostOf(row.value, row.valuedQuantity, currency)),
      currency: row.currency,
      methods: [...row.methods],
      valued: row.valued,
      unvaluedMoves: row.unvaluedMoves,
      dependsOnMethod: depends,
      words: `${basisWords(row.methods, row.valued, row.unvaluedMoves)}${depends ? ' It depends on the costing method.' : ''}`,
    })
  }
  for (const group of wipRows(wipGroups.map((row) => ({ workOrderId: row.workOrderId, value: row._sum.amount ?? 0, entries: row._count._all })))) {
    const source = wipGroups.find((row) => row.workOrderId === group.workOrderId)!
    const workOrder = workOrders.get(group.workOrderId)!
    if (needle && !workOrder.number.toLowerCase().includes(needle)) continue
    const done = doneBy(workOrder)
    rows.push({
      category: 'WIP',
      companyId: source.companyId,
      site: sites.get(source.siteId) ?? { id: source.siteId, code: '' },
      item: null,
      colour: null,
      lot: null,
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, done },
      quantity: null,
      uom: null,
      hides: 0,
      areaM2: null,
      value: asMoney('cost', group.value),
      unitCost: asMoney('cost', null),
      currency: source.currency,
      methods: [],
      valued: 'FULL',
      unvaluedMoves: 0,
      dependsOnMethod: dependsOnMethod(methodOf(source.companyId), []),
      words: done
        ? `${workOrder.number} is done: what is left on its cost ledger (${group.entries} entries) is its variance, written off when it is closed (W2b). It depends on the costing method.`
        : `Work in progress: what ${workOrder.number} took on (material issued, labour earned, overhead) less what moved to finished goods, as its cost ledger records it (${group.entries} entries). It depends on the costing method.`,
    })
  }
  rows.sort(
    (a, b) =>
      CATEGORY_ORDER.get(a.category)! - CATEGORY_ORDER.get(b.category)! ||
      a.site.code.localeCompare(b.site.code) ||
      (a.item?.code ?? a.workOrder?.number ?? '').localeCompare(b.item?.code ?? b.workOrder?.number ?? '') ||
      (a.colour?.code ?? '').localeCompare(b.colour?.code ?? '') ||
      (a.lot?.code ?? '').localeCompare(b.lot?.code ?? ''),
  )

  const valueOf = (row: ValuationRowView) => ({ value: row.value as number, currency: row.currency })
  const categories = VALUATION_CATEGORIES.filter((category) => wanted.has(category)).map((category) => {
    const mine = rows.filter((row) => row.category === category)
    const total = totalsOf(mine.map(valueOf))
    return { category, rows: mine.length, value: asMoney('cost', total.value), currency: total.currency }
  })
  const shownResidues = residues.filter((row) => wanted.has(categoryOfKind(items.get(row.itemId)!.kind)) && !needle)
  const total = totalsOf(rows.map(valueOf))
  const residue = totalsOf(shownResidues.map((row) => ({ value: row.value, currency: row.currency })))
  const unvaluedMoves = rows.reduce((sum, row) => sum + row.unvaluedMoves, 0)
  const methodViews = [...methods.values()]
  const words = [
    at === null ? 'The stock as the ledgers hold it now.' : `The stock at the end of ${businessDate(at)} (Europe/Rome): every move up to then.`,
    'Each value is the stock ledger\'s: the sum of what its moves were valued at (receipts at their purchase order price, issues at their lot\'s average cost, opening stock, untracked items and finished garments at the standard cost), never recomputed; work in progress is the work orders\' cost ledger.',
    unvaluedMoves > 0 ? `${unvaluedMoves} move(s) have no cost yet: their stock is counted but not valued.` : null,
    residue.value ? 'The residue is value left on stock that is gone (the rounding of lot costs): the rows and the residue add up to the ledger.' : null,
    ...new Set(methodViews.map((row) => row.words)),
    total.words,
  ]
    .filter((text): text is string => text !== null)
    .join(' ')
  return {
    asOf: at === null ? null : toUtcIso(at),
    asOfDay: at === null ? null : businessDate(at),
    rows,
    categories,
    value: asMoney('cost', total.value),
    currency: total.currency,
    residue: asMoney('cost', residue.value),
    unvaluedMoves,
    methods: methodViews,
    words,
  }
}

/** The sites the caller may see the stock of (a company or a site asked for narrows them). */
export async function visibleSites(caller: CommandCaller, db: Reader, filters: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }): Promise<string[]> {
  const context = officeContextOf(caller)
  const sites = await db.site.findMany({
    where: { AND: [scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SITE_SCOPE) as Prisma.SiteWhereInput, filters.companyId ? { companyId: filters.companyId } : {}, filters.siteId ? { id: filters.siteId } : {}] },
    select: { id: true },
  })
  return sites.map((row) => row.id)
}

/** GET /costing/valuation: the report for the caller's sites. */
export async function stockValuation(caller: CommandCaller, query: ValuationQuery): Promise<ValuationAnswer> {
  const at = query.asOf ? endOfDay(query.asOf) : null
  return caller.withClient(async (db) => {
    const siteIds = await visibleSites(caller, db, query)
    const answer = await valueStockAsOf(db, { siteIds, companyId: query.companyId, itemId: query.itemId, lotId: query.lotId, categories: query.category, q: query.q }, at)
    return { ...answer, rows: answer.rows.slice(0, ROW_LIMIT), truncated: answer.rows.length > ROW_LIMIT }
  })
}
