/**
 * The products grid's server contract — AG Grid's own request in, the list query out.
 *
 * ONE translator, on the server. The grid posts its `IServerSideGetRowsRequest` verbatim plus the
 * page's context (search, KPI tile, the filter accordion as the operator sees it: tag names,
 * family codes, stage codes). Everything about what a column id sorts by, how a tile narrows the
 * list, and which id a name resolves to lives here — the client keeps no mapping table, so a
 * column the server cannot order by cannot exist on the client by accident. Anything the server
 * still cannot express is returned in `unsupported`, never dropped.
 *
 * `gridRequestToListQuery` is pure (tested); `resolveGridLookups` is the one database touch.
 */
import {
  AGG_FUNCS,
  GRID_FILTER_COLUMNS,
  GRID_GROUP_COLUMNS,
  GRID_VALUE_COLUMNS,
  NULL_GROUP_KEY,
  PRODUCT_COLUMN_ID,
  type AggFunc,
  type GridFilterModelEntry,
  type GridGroupColumnId,
  type GridValueColumnId,
  type ProductsGridContext,
  type ProductsGridRequest,
  type ProductsGridResponse,
} from '@nexus/shared/products-grid'

import prisma from '../../db.js'
import type { ProductListQuery } from './list-products.service.js'
import type { GroupingRequest } from './products-grid-groups.service.js'

export type { ProductsGridContext, ProductsGridRequest, ProductsGridResponse } from '@nexus/shared/products-grid'

/** Names and codes the accordion uses → the ids the list filters by. */
export interface GridLookups {
  tagIdsByName: ReadonlyMap<string, string>
  familyIdsByCode: ReadonlyMap<string, string>
  /** A stage code can exist in several workflows; every matching id is meant. */
  stageIdsByCode: ReadonlyMap<string, string[]>
}

/**
 * Grid column id → the list's sort field. The client sends the Product column under
 * `PRODUCT_COLUMN_ID` whatever AG calls it internally. `sales` / `units` / `totalStock` are
 * ordered in SQL by `listProducts` (windowed roll-ups).
 */
export const GRID_SORT_FIELD: Readonly<Record<string, string>> = {
  [PRODUCT_COLUMN_ID]: 'name',
  name: 'name',
  sku: 'sku',
  available: 'totalStock',
  price: 'basePrice',
  status: 'status',
  brand: 'brand',
  productType: 'productType',
  updated: 'updatedAt',
  photos: 'photos',
  channels: 'channels',
  variants: 'variants',
  sales: 'sales',
  units: 'units',
}

/**
 * The inline family preview: ten variations, in the GRID'S order. The Owner's rule (2026-08-28):
 * a family's variations are not all shown inline — the preview is capped and the footer under it
 * opens the family as its own page for the rest — and the ten follow whatever sort the operator
 * has on the columns, so sorting by Price shows a family's ten cheapest (or dearest).
 */
export const VARIATION_PREVIEW_CAP = 10

const EMPTY_CONTEXT = { stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [] }

/** A number filter's bounds as the list's min/max strings; `null` bounds are "no bound". */
const numberBounds = (m: Extract<GridFilterModelEntry, { filterType: 'number' }>): { min?: string; max?: string } => {
  const lo = m.filter == null ? undefined : String(m.filter)
  const hi = m.filterTo == null ? undefined : String(m.filterTo)
  switch (m.type) {
    case 'inRange': return { min: lo, max: hi }
    case 'greaterThanOrEqual': return { min: lo }
    case 'lessThanOrEqual': return { max: lo }
    case 'equals': return { min: lo, max: lo }
  }
}

export function gridRequestToListQuery(body: ProductsGridRequest | undefined, lookups: GridLookups): { query: ProductListQuery; unsupported: string[]; grouping?: GroupingRequest } {
  const req = body?.request ?? ({} as Partial<ProductsGridRequest['request']>)
  const ctx = body?.context
  const cf = { ...EMPTY_CONTEXT, ...(ctx?.filters ?? {}) }
  const fm = req.filterModel ?? {}
  const tile = ctx?.tile ?? null
  const unsupported: string[] = []
  const q: ProductListQuery = {
    includeCoverage: 'true',
    includeTags: 'true',
    includeSales: 'true',
    salesDays: String(Math.min(Math.max(Number(ctx?.salesDays ?? 90) || 90, 1), 365)),
  }
  const list = (key: keyof ProductListQuery, values: readonly string[]) => {
    if (values.length) (q as Record<string, string>)[key] = values.join(',')
  }

  // ── paging: AG's [startRow, endRow) → page/limit. Every level pages the same way. ────────
  const startRow = Math.max(0, req.startRow ?? 0)
  const size = Math.max(1, (req.endRow ?? startRow + 100) - startRow)
  q.limit = String(size)
  q.page = String(Math.floor(startRow / size) + 1)

  // ── sort: the grid's sort model, applied at every level ──────────────────────────────────
  const sorts: string[] = []
  for (const s of req.sortModel ?? []) {
    const field = GRID_SORT_FIELD[s.colId]
    if (!field) { unsupported.push(`sort:${s.colId}`); continue }
    sorts.push(`${field}:${s.sort === 'desc' ? 'desc' : 'asc'}`)
  }
  if (sorts.length) q.sorts = sorts.join(',')

  // ── row grouping: `groupKeys` is a group PATH, not a family ─────────────────────────────
  const groupKeys = req.groupKeys ?? []
  const groupCols: GridGroupColumnId[] = []
  for (const col of req.rowGroupCols ?? []) {
    if (col.id in GRID_GROUP_COLUMNS) groupCols.push(col.id as GridGroupColumnId)
    else unsupported.push(`group:${col.id}`)
  }
  const grouped = groupCols.length > 0
  let grouping: GroupingRequest | undefined
  if (grouped) {
    const aggregations: GroupingRequest['aggregations'] = []
    for (const col of req.valueCols ?? []) {
      const func = (col.aggFunc ?? '') as AggFunc
      if (!(col.id in GRID_VALUE_COLUMNS)) { unsupported.push(`value:${col.id}`); continue }
      if (!AGG_FUNCS.includes(func)) { unsupported.push(`value:${col.id}:${col.aggFunc ?? 'none'}`); continue }
      aggregations.push({ colId: col.id as GridValueColumnId, func })
    }
    if (groupKeys.length < groupCols.length) {
      const groupColId = groupCols[groupKeys.length]
      const lead = (req.sortModel ?? [])[0]
      const sort: GroupingRequest['sort'] =
        !lead ? { by: 'key', dir: 'asc' }
        : lead.colId === groupColId || lead.colId === PRODUCT_COLUMN_ID ? { by: 'key', dir: lead.sort === 'desc' ? 'desc' : 'asc' }
        : aggregations.some((a) => a.colId === lead.colId) ? { by: lead.colId as GridValueColumnId, dir: lead.sort === 'desc' ? 'desc' : 'asc' }
        : { by: 'key', dir: 'asc' }
      grouping = { groupColId, aggregations, sort }
    }
  }

  // ── a family's inline preview: the first ten in the grid's sort; the filters do not apply ──
  // The sort (`q.sorts`, set above) is the operator's column sort, so the ten are the ten that
  // sort first. The filters do NOT narrow a family's children: the parent row is what matched
  // them, and an opened family shows what it holds. (Viewing ONE family as the page —
  // `context.familyId` — is different: there the variations ARE the top level, paged, sorted
  // and filtered like the catalogue.)
  if (!grouped && groupKeys.length) {
    q.parentId = String(groupKeys[groupKeys.length - 1])
    q.limit = String(VARIATION_PREVIEW_CAP)
    q.page = '1'
    return { query: q, unsupported }
  }
  if (ctx?.familyId) q.parentId = ctx.familyId

  // ── column filters: AG's filterModel, each entry against the column that owns it ─────────
  const set = (colId: string): string[] => {
    const m = fm[colId]
    return m && m.filterType === 'set' ? m.values.filter((v) => typeof v === 'string') : []
  }
  for (const [colId, m] of Object.entries(fm)) {
    const kind = (GRID_FILTER_COLUMNS as Record<string, string>)[colId]
    if (!kind) { unsupported.push(`filter:${colId}`); continue }
    if (m.filterType !== kind) { unsupported.push(`filter:${colId}:${m.filterType}`); continue }
  }
  const text = fm[PRODUCT_COLUMN_ID]
  if (text && text.filterType === 'text') {
    const search = text.filter.trim()
    if (search) q.search = search
  }
  // A KPI tile is a filter the operator clicked, so it narrows the status list rather than
  // adding to it: "Active" tile + "Draft" in the column filter is an empty set, not a union.
  const status = set('status')
  if (tile === 'active' && status.length && !status.includes('ACTIVE')) q.status = '__none__'
  else list('status', tile === 'active' ? ['ACTIVE'] : status)
  list('channels', set('channels'))
  list('brands', set('brand'))
  list('productTypes', set('productType'))
  const tagIds: string[] = []
  for (const name of set('tags')) {
    const id = lookups.tagIdsByName.get(name)
    if (id) tagIds.push(id)
    else unsupported.push(`tag:${name}`)
  }
  list('tags', tagIds)
  const price = fm.price
  if (price && price.filterType === 'number') {
    const b = numberBounds(price)
    if (b.min !== undefined) q.priceMin = b.min
    if (b.max !== undefined) q.priceMax = b.max
  }
  const available = fm.available
  if (available && available.filterType === 'number') {
    const b = numberBounds(available)
    if (b.min !== undefined) q.stockMin = b.min
    if (b.max !== undefined) q.stockMax = b.max
  }

  // ── page context: the dimensions that are not columns ───────────────────────────────────
  list('stockLevels', tile === 'out-of-stock' ? ['out'] : cf.stock)
  list('fulfillment', cf.fulfillment)
  list('missingChannels', cf.missingChannels)
  const familyIds: string[] = []
  for (const code of cf.families) {
    if (code === 'null') { familyIds.push('null'); continue }
    const id = lookups.familyIdsByCode.get(code)
    if (id) familyIds.push(id)
    else unsupported.push(`family:${code}`)
  }
  list('families', familyIds)
  const stageIds: string[] = []
  for (const code of cf.workflowStages) {
    if (code === 'null') { stageIds.push('null'); continue }
    const ids = lookups.stageIdsByCode.get(code)
    if (ids?.length) stageIds.push(...ids)
    else unsupported.push(`stage:${code}`)
  }
  list('workflowStages', stageIds)
  if (tile === 'attention') q.photos = 'none'

  // ── the opened group path narrows the list to that group, over everything above ────────
  if (grouped) {
    groupKeys.slice(0, groupCols.length).forEach((key, i) => {
      const param = GRID_GROUP_COLUMNS[groupCols[i]]
      ;(q as Record<string, string>)[param] = key === NULL_GROUP_KEY ? NULL_GROUP_KEY : key
    })
  }

  return { query: q, unsupported, grouping }
}

/** Three small lookups, only for the names and codes the request actually carries. */
export async function resolveGridLookups(body: ProductsGridRequest | undefined): Promise<GridLookups> {
  const f = body?.context?.filters
  const tagsModel = body?.request?.filterModel?.tags
  const tagNames = tagsModel && tagsModel.filterType === 'set' ? tagsModel.values.filter((v) => typeof v === 'string' && v) : []
  const familyCodes = (f?.families ?? []).filter((c) => c && c !== 'null')
  const stageCodes = (f?.workflowStages ?? []).filter((c) => c && c !== 'null')
  const [tags, families, stages] = await Promise.all([
    tagNames.length ? prisma.tag.findMany({ where: { name: { in: tagNames } }, select: { id: true, name: true } }) : [],
    familyCodes.length ? prisma.productFamily.findMany({ where: { code: { in: familyCodes } }, select: { id: true, code: true } }) : [],
    stageCodes.length ? prisma.workflowStage.findMany({ where: { code: { in: stageCodes } }, select: { id: true, code: true } }) : [],
  ])
  const stageIdsByCode = new Map<string, string[]>()
  for (const s of stages) stageIdsByCode.set(s.code, [...(stageIdsByCode.get(s.code) ?? []), s.id])
  return {
    tagIdsByName: new Map(tags.map((t): [string, string] => [t.name, t.id])),
    familyIdsByCode: new Map(families.map((x): [string, string] => [x.code, x.id])),
    stageIdsByCode,
  }
}
