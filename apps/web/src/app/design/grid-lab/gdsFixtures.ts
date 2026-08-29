/**
 * GDS lab fixtures — frozen data for every scenario in the spec (docs/…-gds.md §6). No API: the
 * ads console cannot be verified locally and the lab must render the same on a laptop, on Vercel
 * and on prod. Deterministic: the same row is the same row on every load, so a measurement taken
 * today is comparable with one taken next month.
 */
import type { IServerSideDatasource, IServerSideGetRowsParams } from '@/design-system/grid'

/* ── a catalogue: families with variations ────────────────────────────────────────────────── */

export interface CatalogueRow {
  id: string
  parentId: string | null
  sku: string
  name: string
  brand: string
  status: 'ACTIVE' | 'DRAFT' | 'INACTIVE'
  tags: Array<{ id: string; name: string; color: string | null; icon?: string | null }>
  stock: number | null
  priceCents: number
  salesCents: number | null
  units: number | null
  updatedAt: string
  childCount: number
}

const BRANDS = ['XAVIA', 'Nordwind', 'Ferro', 'Aurelia']
const WORDS = ['Giacca Da Moto', 'Casco Integrale', 'Guanti Estivi', 'Stivali Touring', 'Pantaloni Cordura', 'Paraschiena', 'Sottocasco', 'Copriscarpe']
const TAGS = [
  { id: 't1', name: 'Bestseller', color: '#f59e0b', icon: 'star' },
  { id: 't2', name: 'Clearance', color: '#ef4444', icon: 'percent' },
  { id: 't3', name: 'New', color: '#3b82f6', icon: 'sparkles' },
  { id: 't4', name: 'Seasonal', color: '#10b981', icon: 'leaf' },
]

const seeded = (seed: number) => {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

export function makeCatalogue(parents = 40, seed = 7): CatalogueRow[] {
  const rnd = seeded(seed)
  const rows: CatalogueRow[] = []
  for (let i = 0; i < parents; i++) {
    const kids = i % 3 === 0 ? 0 : 2 + Math.floor(rnd() * 12)
    const brand = BRANDS[i % BRANDS.length]
    const name = `${brand} ${WORDS[i % WORDS.length]} ${['Uomo', 'Donna', 'Unisex'][i % 3]} – ${['Nero', 'Blu', 'Rosso', 'Grigio'][i % 4]}`
    const status = (['ACTIVE', 'ACTIVE', 'DRAFT', 'INACTIVE'] as const)[i % 4]
    const measured = i % 5 !== 4
    const parent: CatalogueRow = {
      id: `p${i}`,
      parentId: null,
      sku: `${brand.slice(0, 3).toUpperCase()}-${String(1000 + i)}`,
      name,
      brand,
      status,
      tags: TAGS.filter((_, k) => (i + k) % 3 === 0),
      stock: i % 7 === 6 ? null : Math.floor(rnd() * 400),
      priceCents: 1995 + Math.floor(rnd() * 40000),
      salesCents: measured ? (i % 4 === 1 ? 0 : Math.floor(rnd() * 900000)) : null,
      units: measured ? (i % 4 === 1 ? 0 : Math.floor(rnd() * 300)) : null,
      updatedAt: new Date(Date.UTC(2026, 6, 1 + (i % 28))).toISOString(),
      childCount: kids,
    }
    rows.push(parent)
    for (let k = 0; k < kids; k++) {
      rows.push({
        ...parent,
        id: `p${i}c${k}`,
        parentId: parent.id,
        sku: `${parent.sku}-${['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXS', 'M-T', 'L-T'][k % 12]}`,
        name: `${parent.name} · ${['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXS', 'M-T', 'L-T'][k % 12]}`,
        tags: [],
        stock: Math.floor(rnd() * 60),
        salesCents: measured ? Math.floor(rnd() * 50000) : null,
        units: measured ? Math.floor(rnd() * 20) : null,
        childCount: 0,
      })
    }
  }
  return rows
}

export const CATALOGUE = makeCatalogue()
export const CATALOGUE_PARENTS = CATALOGUE.filter((r) => r.parentId === null)
export const isFamilyParent = (r: CatalogueRow) => r.childCount > 0

/**
 * A server, in memory: verbatim `IServerSideGetRowsRequest` in, `{rows, rowCount}` out. Top level
 * = parents (sorted per `sortModel`); a `groupKeys` path = that family's variations, capped like the
 * product does (10 in the grid's sort, the footer says so). `familyId` scopes the top level to one
 * family's children — the family page.
 */
export function createCatalogueDatasource(opts: { familyId?: string | null; delayMs?: number; cap?: number } = {}): IServerSideDatasource<CatalogueRow> {
  const cap = opts.cap ?? 10
  return {
    getRows: (params: IServerSideGetRowsParams<CatalogueRow>) => {
      const { request } = params
      const parentId = request.groupKeys.length ? String(request.groupKeys[request.groupKeys.length - 1]) : opts.familyId ?? null
      let rows = parentId ? CATALOGUE.filter((r) => r.parentId === parentId) : CATALOGUE_PARENTS
      const sort = request.sortModel[0]
      if (sort) {
        const key = sort.colId === 'ag-Grid-AutoColumn' ? 'name' : sort.colId
        const dir = sort.sort === 'desc' ? -1 : 1
        rows = [...rows].sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[key] as number | string | null
          const bv = (b as unknown as Record<string, unknown>)[key] as number | string | null
          if (av == null && bv == null) return 0
          if (av == null) return 1 // blanks sink both ways
          if (bv == null) return -1
          return (av < bv ? -1 : av > bv ? 1 : 0) * dir
        })
      }
      const total = rows.length
      const capped = request.groupKeys.length ? rows.slice(0, cap) : rows
      const start = request.startRow ?? 0
      const end = request.endRow ?? capped.length
      const page = capped.slice(start, end)
      const finish = () => params.success({ rowData: page, rowCount: request.groupKeys.length ? Math.min(total, cap) : total })
      if (opts.delayMs) setTimeout(finish, opts.delayMs)
      else finish()
    },
  }
}

/* ── ads reporting: read-only metrics with a totals row ──────────────────────────────────── */

export interface ReportRow {
  id: string
  campaign: string
  kind: 'SP' | 'SB' | 'SD'
  targeting: 'A' | 'M'
  live: boolean
  spendCents: number
  salesCents: number
  acos: number | null
  impressions: number
  clicks: number
  ctr: number | null
  orders: number
  bidCents: number
}

export function makeReport(n = 24, seed = 11): ReportRow[] {
  const rnd = seeded(seed)
  return Array.from({ length: n }, (_, i) => {
    const spend = Math.floor(rnd() * 90000)
    const sales = i % 6 === 5 ? 0 : Math.floor(rnd() * 400000)
    const impressions = Math.floor(rnd() * 200000)
    const clicks = Math.floor(impressions * (0.005 + rnd() * 0.02))
    return {
      id: `c${i}`,
      campaign: `${['SP', 'SB', 'SD'][i % 3]} | ${['Brand Defense', 'Category Broad', 'Competitor ASINs', 'Long Tail', 'Retargeting', 'Store Spotlight'][i % 6]} | ${['Exact', 'Phrase', 'Broad'][i % 3]}`,
      kind: (['SP', 'SB', 'SD'] as const)[i % 3],
      targeting: i % 4 === 0 ? 'A' : 'M',
      live: i % 5 !== 4,
      spendCents: spend,
      salesCents: sales,
      acos: sales === 0 ? null : Math.round((spend / sales) * 10000) / 10000,
      impressions,
      clicks,
      ctr: impressions === 0 ? null : clicks / impressions,
      orders: Math.floor(clicks * 0.08),
      bidCents: 50 + Math.floor(rnd() * 400),
    }
  })
}

export const REPORT = makeReport()

export const reportTotals = (rows: ReportRow[]): ReportRow => ({
  id: '__total',
  campaign: 'Total',
  kind: 'SP',
  targeting: 'M',
  live: false,
  spendCents: rows.reduce((a, r) => a + r.spendCents, 0),
  salesCents: rows.reduce((a, r) => a + r.salesCents, 0),
  acos: null,
  impressions: rows.reduce((a, r) => a + r.impressions, 0),
  clicks: rows.reduce((a, r) => a + r.clicks, 0),
  ctr: null,
  orders: rows.reduce((a, r) => a + r.orders, 0),
  bidCents: 0,
})

/* ── a matrix: variations × locations ─────────────────────────────────────────────────────── */

export interface MatrixRow {
  id: string
  sku: string
  name: string
  cells: Record<string, { onHand: number; reserved: number }>
}

export const LOCATIONS = [
  { id: 'fba', code: 'AMAZON-EU-FBA', editable: false },
  { id: 'it', code: 'IT-MAIN', editable: true },
  { id: 'de', code: 'DE-OUTLET', editable: true },
]

export function makeMatrix(n = 12, seed = 5): MatrixRow[] {
  const rnd = seeded(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    sku: `XAV-AIREON-${['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXS', 'M-T', 'L-T'][i]}`,
    name: `XAVIA AIREON Giacca Da Moto Da Uomo · ${['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXS', 'M-T', 'L-T'][i]}`,
    cells: Object.fromEntries(LOCATIONS.map((l) => [l.id, { onHand: Math.floor(rnd() * 120), reserved: Math.floor(rnd() * 8) }])),
  }))
}

export const MATRIX = makeMatrix()

/* ── volume and edge cases ────────────────────────────────────────────────────────────────── */

export const BIG = makeReport(10000, 3)
export const LONG_TEXT: ReportRow[] = makeReport(6, 9).map((r, i) => ({
  ...r,
  campaign: `${r.campaign} — ${'a campaign name long enough to overflow any column an operator would leave at its default width, '.repeat(1 + (i % 3))}and it must ellipsise, never wrap the row taller`,
}))
