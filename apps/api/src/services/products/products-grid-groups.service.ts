/**
 * Group rows for the products grid — over the SAME scope as the flat list.
 *
 * AG's Server-Side Row Model with row grouping asks for a LEVEL: "the groups of <column> inside
 * <path>", with the aggregates the operator chose. `resolveProductsScope` decides which products
 * the filters admit (identically for a group and for a flat row — it is the same function), and
 * the database then groups, aggregates, orders and pages.
 *
 * TWO WAYS TO ANSWER, ONE SCOPE
 *
 * The common level — group keys, product counts, and at most a price aggregate — is ONE
 * `groupBy` over the scope's `where`: Postgres groups, orders and pages, and only the page of
 * groups crosses the wire. No product id is ever read into the process.
 *
 * A level that carries a ROLL-UP aggregate — Available (the stock-level roll-up over a product
 * and its variations), Sales or Units (the windowed roll-up of orders) — cannot come from a
 * column, because none of those is a column: they are CTEs over an id set, the same CTEs that
 * sort and filter the flat list. That path reads the scope's ids and hands them to one SQL
 * statement, exactly as `listProducts` does for a stock or sales sort. The id read is the cost of
 * a roll-up, paid only when a roll-up is asked for.
 */
import { Prisma } from '@prisma/client'
import {
  GRID_VALUE_COLUMNS,
  NULL_GROUP_KEY,
  type AggFunc,
  type GridGroupColumnId,
  type GridValueColumnId,
  type ProductGroupRow,
} from '@nexus/shared/products-grid'

import prisma from '../../db.js'
import { resolveProductsScope, stockRollupCte, type ProductListQuery } from './list-products.service.js'

export interface GroupingRequest {
  /** The column whose distinct values are this level's groups. */
  groupColId: GridGroupColumnId
  /** Aggregations the operator asked for, by value column. */
  aggregations: Array<{ colId: GridValueColumnId; func: AggFunc }>
  /** `'key'` orders by the group's own value; a value column id orders by its aggregate. */
  sort: { by: 'key' | GridValueColumnId; dir: 'asc' | 'desc' }
}

export interface GroupLevelResult {
  rows: ProductGroupRow[]
  rowCount: number
}

/** The measures that are roll-ups over an id set rather than columns of the product row. */
const ROLLUP_COLUMNS: ReadonlySet<GridValueColumnId> = new Set(['available', 'sales', 'units'])

/** Every requested aggregate once — `<colId>_<func>` names the answer column. */
const dedupe = (aggs: GroupingRequest['aggregations']) =>
  aggs.filter((a, i, all) => all.findIndex((x) => x.colId === a.colId && x.func === a.func) === i)

/**
 * Does this level need the roll-up CTEs? A count needs no measure at all, and a price aggregate
 * is a column aggregate; only Available / Sales / Units summed, averaged or bounded do.
 */
export function needsRollup(g: GroupingRequest): boolean {
  return g.aggregations.some((a) => a.func !== 'count' && ROLLUP_COLUMNS.has(a.colId))
}

export async function listProductGroups(q: ProductListQuery, g: GroupingRequest): Promise<GroupLevelResult> {
  return needsRollup(g) ? listGroupsWithRollups(q, g) : listGroupsFromColumns(q, g)
}

/** A group's key as it travels: `NULL_GROUP_KEY` for "no value", the string otherwise. */
const wireKey = (raw: unknown): string => (raw == null || raw === '' ? NULL_GROUP_KEY : String(raw))
const num = (v: unknown): number | undefined => (v == null ? undefined : Number(String(v)))

// ── the common level: one groupBy, nothing but groups crosses the wire ─────────────────────

async function listGroupsFromColumns(q: ProductListQuery, g: GroupingRequest): Promise<GroupLevelResult> {
  const { where, cacheWhere, useCache, page, limit } = await resolveProductsScope(q)
  const key = g.groupColId
  const scope = useCache ? cacheWhere : where
  // The read cache and the product table carry the same three group columns and `basePrice`.
  const model = (useCache ? prisma.productReadCache : prisma.product) as unknown as { groupBy: (args: unknown) => Promise<Array<Record<string, unknown>>> }
  const aggregations = dedupe(g.aggregations)
  const priceAggs = aggregations.filter((a) => a.colId === 'price' && a.func !== 'count')

  const select: Record<string, unknown> = { _count: { _all: true } }
  for (const a of priceAggs) select[`_${a.func}`] = { basePrice: true }

  // `status` is never null; brand and product type are, and a null group sorts last as the SQL
  // path orders it (`NULLS LAST`), so the two paths page identically.
  const keyOrder = (dir: 'asc' | 'desc') => (key === 'status' ? { [key]: dir } : { [key]: { sort: dir, nulls: 'last' } })
  const sortAgg = g.sort.by === 'key' ? null : aggregations.find((a) => a.colId === g.sort.by)
  const orderBy: unknown[] = !sortAgg
    ? [keyOrder(g.sort.dir)]
    : [sortAgg.func === 'count' ? { _count: { id: g.sort.dir } } : { [`_${sortAgg.func}`]: { basePrice: g.sort.dir } }, keyOrder('asc')]

  const [rows, all] = await Promise.all([
    model.groupBy({ by: [key], where: scope, ...select, orderBy, skip: (page - 1) * limit, take: limit }),
    model.groupBy({ by: [key], where: scope, _count: { _all: true } }),
  ])

  const groupRows: ProductGroupRow[] = rows.map((r) => {
    const groupKey = wireKey(r[key])
    const row: ProductGroupRow = {
      id: `group:${key}:${groupKey}`,
      __group: true,
      groupColId: key,
      groupKey,
      childCount: Number((r._count as { _all: number })._all),
      [key]: groupKey,
    }
    const priceAgg = priceAggs[0]
    if (priceAgg) {
      const price = num((r[`_${priceAgg.func}`] as { basePrice?: unknown } | undefined)?.basePrice)
      if (price !== undefined) row.basePrice = price
    }
    return row
  })
  return { rows: groupRows, rowCount: all.length }
}

// ── a level with roll-ups: the scope's ids, one SQL statement over them ────────────────────

/** The SQL each measure aggregates over — `b` the product row, `s` its sales roll-up, `st` its stock roll-up. */
const MEASURE_SQL: Record<GridValueColumnId, Prisma.Sql> = {
  available: Prisma.sql`st.qty`,
  price: Prisma.sql`b."basePrice"`,
  sales: Prisma.sql`s.revenue`,
  units: Prisma.sql`s.units`,
}
const GROUP_KEY_SQL: Record<GridGroupColumnId, Prisma.Sql> = {
  brand: Prisma.sql`b.brand`,
  productType: Prisma.sql`b."productType"`,
  status: Prisma.sql`b.status::text`,
}

const aggSql = (func: AggFunc, measure: Prisma.Sql): Prisma.Sql => {
  switch (func) {
    case 'sum': return Prisma.sql`SUM(${measure})::float`
    case 'avg': return Prisma.sql`AVG(${measure})::float`
    case 'min': return Prisma.sql`MIN(${measure})::float`
    case 'max': return Prisma.sql`MAX(${measure})::float`
    case 'count': return Prisma.sql`COUNT(*)::float`
  }
}

async function listGroupsWithRollups(q: ProductListQuery, g: GroupingRequest): Promise<GroupLevelResult> {
  const { where, cacheWhere, useCache, page, limit, salesDays } = await resolveProductsScope(q)
  const candidates: Array<{ id: string }> = useCache
    ? await prisma.productReadCache.findMany({ where: cacheWhere, select: { id: true } })
    : await prisma.product.findMany({ where, select: { id: true } })
  if (candidates.length === 0) return { rows: [], rowCount: 0 }
  const ids = candidates.map((c) => c.id)
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - salesDays)

  // Every requested aggregate as its own column, named `<colId>_<func>` so the row can be read back.
  const aggregations = dedupe(g.aggregations)
  const aggColumns = aggregations.map((a) => Prisma.sql`${aggSql(a.func, MEASURE_SQL[a.colId])} AS ${Prisma.raw(`"${a.colId}_${a.func}"`)}`)
  const selectAggs = aggColumns.length ? Prisma.sql`, ${Prisma.join(aggColumns, ', ')}` : Prisma.empty
  const keySql = GROUP_KEY_SQL[g.groupColId]
  const dir = g.sort.dir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`
  const sortAgg = g.sort.by === 'key' ? null : aggregations.find((a) => a.colId === g.sort.by)
  const orderBy = sortAgg
    ? Prisma.sql`${Prisma.raw(`"${sortAgg.colId}_${sortAgg.func}"`)} ${dir} NULLS LAST, ${keySql} ASC NULLS LAST`
    : Prisma.sql`${keySql} ${dir} NULLS LAST`

  const rows = await prisma.$queryRaw<Array<Record<string, unknown> & { key: string | null; child_count: number; total_groups: number }>>`
    WITH base AS (
      SELECT p.id, p.brand, p."productType", p.status, p."basePrice"
      FROM unnest(${ids}::text[]) AS own(id)
      JOIN "Product" p ON p.id = own.id
    ),
    ${stockRollupCte(ids)},
    sales AS (
      SELECT own.id,
             COALESCE(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity * oi.price END), 0) AS revenue,
             COALESCE(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity END), 0) AS units
      FROM unnest(${ids}::text[]) AS own(id)
      LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id
      LEFT JOIN "OrderItem" oi ON oi."productId" = c.id
      LEFT JOIN "Order" o ON o.id = oi."orderId"
        AND o."createdAt" >= ${since}
        AND o.status <> 'CANCELLED'
      GROUP BY own.id
    )
    SELECT ${keySql} AS key,
           COUNT(*)::int AS child_count,
           COUNT(*) OVER ()::int AS total_groups
           ${selectAggs}
    FROM base b
    LEFT JOIN sales s ON s.id = b.id
    LEFT JOIN stockq st ON st.id = b.id
    GROUP BY ${keySql}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${(page - 1) * limit}
  `

  const groupRows: ProductGroupRow[] = rows.map((r) => {
    const key = wireKey(r.key)
    const row: ProductGroupRow = {
      id: `group:${g.groupColId}:${key}`,
      __group: true,
      groupColId: g.groupColId,
      groupKey: key,
      childCount: Number(r.child_count),
      [g.groupColId]: key,
    }
    const read = (colId: GridValueColumnId): number | undefined => {
      const a = aggregations.find((x) => x.colId === colId)
      if (!a) return undefined
      return num(r[`${colId}_${a.func}`])
    }
    const stock = read('available')
    if (stock !== undefined) row.totalStock = stock
    const price = read('price')
    if (price !== undefined) row.basePrice = price
    const revenue = read('sales')
    const units = read('units')
    // Revenue aggregates are in EUR (the SUM of quantity × price); the cells read cents.
    if (revenue !== undefined) row.sales = { revenueCents: Math.round(revenue * 100), units: units ?? 0, days: salesDays }
    if (units !== undefined) row.units = units
    return row
  })
  return { rows: groupRows, rowCount: rows.length ? Number(rows[0].total_groups) : 0 }
}

// Referenced so the shared table and this file cannot drift apart silently.
void GRID_VALUE_COLUMNS
