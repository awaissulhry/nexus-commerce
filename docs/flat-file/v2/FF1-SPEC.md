# FF1 — Export Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task ends with an independently-testable deliverable; at execution every task runs the red → green → commit cycle.
>
> **STATUS: FF1 GATE — written spec awaiting Owner approval. No code is written until this plan is approved (FF v2 double-gate protocol).**

**Goal:** Generate a deterministic, multi-sheet, multi-market, Excel-proof workbook of the entire catalog — built from a shared field registry, plugged into the existing `ExportJob` lifecycle — with byte-identical reproducibility proven in CI.

**Architecture:** A new server-side `flat-file` service module builds a channel-agnostic **WorkbookModel** (sheets → field definitions) from a shared **registry**, fills it from live `Product` + `ChannelListing` data (per approved FFD9), resolves per-market follow-master values into effective-value + follow-flag columns (per approved FFD10-A), and renders it through an Excel-proof cell writer into a deterministic `exceljs` workbook (README + data sheets + hidden `_meta` with per-row fingerprints). It is wired into the current `ExportJob` `create/run/download` spine as a new `workbook` format — **the job lifecycle is extended, never forked** — and large artifacts move to a real `ArtifactStore` (closes FF0-FINDINGS F8).

**Tech Stack:** TypeScript (Node, `apps/api`), Prisma (`packages/database`), `exceljs` (already a dependency, resolves from root), Vitest (existing test runner — see `*.vitest.test.ts` siblings), `node:crypto` for fingerprints.

## Global Constraints

Copied verbatim from the FF v2 spec + FF0 gate decisions. Every task's requirements implicitly include these.

- **Read-only-to-the-grid:** FF1 modifies **no** file under `apps/web/src/app/products/amazon-flat-file/**` or `apps/web/src/app/products/ebay-flat-file/**` (untouchable) and, in fact, touches **no `apps/web` file at all**. Grid behavior is unchanged by construction.
- **Data foundation (FFD9):** the workbook is built on **`Product`** (parent + child rows) for SHARED data + **`ChannelListing`** (per `productId × channel × marketplace`) for MARKET-SCOPED data. `ProductVariation` / `VariantChannelListing` are **excluded** from the round-trip.
- **Resolver (FFD10-A):** every governed per-market field exports as an **effective-value column** (`price@IT`) **plus a follow-flag column** (`price_follows_master@IT`).
- **Determinism (Contract §1):** identical DB state + identical options ⇒ **byte-identical file** (excluding `_meta` timestamps, which are injected params in tests). Stable sheet/column/row order. No volatile values in data areas.
- **Excel-proofing (Contract §5):** identifier columns forced to text (`numFmt='@'`, value as string); dates ISO strings; decimals locale-safe (export uses `.`); enum dropdowns honor `strict`/`open`.
- **Markets discovered, never hardcoded** (FF0-MARKET-DISCOVERY §4.1): channel sheet markets = *(DISTINCT live listing markets)* ∪ *(active `Marketplace` rows)*, keyed on `code`, sorted IT-first then alpha.
- **No new unguarded mutation routes** (export is read-only); reversible migrations with rollback commands; never print secrets/`DATABASE_URL`; no fake data presented as real.
- **Task codes:** commit subjects prefixed `feat(flat-file): FF1.N — …`.

## File Structure

All new runtime code under `apps/api/src/services/flat-file/` (one responsibility per file; headless — no React, no HTTP):

| File | Responsibility |
|---|---|
| `registry/types.ts` | `FieldDefinition`, `FieldClass`, `FieldScope`, `SheetDefinition`, `WorkbookModel` types (the shared schema — Contract §8) |
| `registry/master-fields.ts` | `Products` sheet field set from `Product` (census §2) |
| `registry/channel-fields.ts` | per-market `ChannelListing` field set + follow-flag/override model (census §3, FFD10-A) |
| `registry/amazon-provider.ts` | adapts the live Amazon manifest (`generateManifest`) → `FieldDefinition[]` (already single-source with the grid) |
| `registry/ebay-provider.ts` | eBay channel field set, drift-guarded against `ebay-columns.ts` golden |
| `registry/index.ts` | `buildWorkbookModel(opts) → WorkbookModel` |
| `market-discovery.ts` | `discoverMarkets(channel) → string[]` |
| `resolver.ts` | `resolveEffective(listing, field) → { value, followsMaster }` |
| `fingerprint.ts` | `rowFingerprint(sku, scope, fields) → string` |
| `xlsx-cell.ts` | Excel-proof typed cell writer (`writeText/writeDecimal/writeDate/writeEnum`) |
| `fetch.ts` | data layer: `fetchCatalog(filters) → WorkbookData` (Product+children, ChannelListing) |
| `workbook-generator.ts` | deterministic `exceljs` builder (README, Products, channel sheets, Images, `_meta`) |
| `artifact-store.ts` | `ArtifactStore` interface + `fs`/object impls (FFD14) |
| `workbook.service.ts` | orchestrator: `generateWorkbook(opts) → { bytes, snapshotId, marketList }` |

Modified (surgical):
- `apps/api/src/services/export/renderers.ts` — add a `workbook` branch delegating to `workbook.service` (extend `renderExport`, do not fork).
- `apps/api/src/services/export-wizard.service.ts` — accept `format:'workbook'` + `targetEntity:'catalog'`; persist `snapshotId`/`marketList`; route artifacts through `ArtifactStore`.
- `packages/database/prisma/schema.prisma` — `ExportJob.snapshotId String?`, `ExportJob.marketList Json?` (reversible migration).

Tests under `apps/api/src/services/flat-file/__tests__/` (Vitest): `xlsx-cell`, `market-discovery`, `resolver`, `workbook-generator`, `determinism`, `census-coverage`, `ebay-registry-drift`.

Golden fixtures under `apps/api/src/services/flat-file/__tests__/fixtures/`.

---

## Task 1: Shared registry types + census-coverage guard

**Files:**
- Create: `apps/api/src/services/flat-file/registry/types.ts`
- Create: `apps/api/src/services/flat-file/registry/master-fields.ts`
- Create: `apps/api/src/services/flat-file/registry/channel-fields.ts`
- Test: `apps/api/src/services/flat-file/__tests__/census-coverage.vitest.test.ts`

**Interfaces — Produces:**
```ts
// registry/types.ts
export type FieldClass = 'IDENTITY' | 'EDITABLE' | 'READONLY_SYNCED' | 'DERIVED' | 'SYSTEM'
export type FieldScope = 'SHARED' | 'MARKET_SCOPED'
export type FieldKind = 'text' | 'longtext' | 'number' | 'decimal' | 'date' | 'enum' | 'boolean' | 'array'

export interface FieldDefinition {
  id: string                     // canonical column id, e.g. 'base_price' (no @MKT suffix here)
  label: string
  kind: FieldKind
  cls: FieldClass
  scope: FieldScope
  channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ALL'
  source: { model: 'Product' | 'ChannelListing'; column: string }  // where the value comes from
  forcedText?: boolean           // identifiers → numFmt '@'
  decimals?: number              // for kind 'decimal' (e.g. 2)
  enumOptions?: string[]
  enumMode?: 'open' | 'strict'
  maxLength?: number
  maxUtf8ByteLength?: number
  arrayDelimiter?: string        // for kind 'array' (default ' | ')
  followMaster?: {               // FFD10-A: governed per-market field
    followColumn: string         // e.g. 'followMasterPrice'
    overrideColumn: string       // e.g. 'priceOverride'
    masterCacheColumn: string    // e.g. 'masterPrice'
  }
  width?: number                 // presentation hint only (grid overlay lives elsewhere)
}

export interface SheetDefinition {
  name: 'Products' | 'Amazon' | 'eBay' | 'Shopify' | 'Images'
  channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  sharedFields: FieldDefinition[]     // no @MKT suffix
  marketFields: FieldDefinition[]     // expanded to field@MKT per discovered market
}

export interface WorkbookModel {
  markets: Record<'AMAZON' | 'EBAY' | 'SHOPIFY', string[]>
  sheets: SheetDefinition[]
}
```

**Approach:** `master-fields.ts` exports `MASTER_FIELDS: FieldDefinition[]` — one entry per row of FF0-FIELD-CENSUS §2, `scope:'SHARED'`, `source.model:'Product'`. `channel-fields.ts` exports `CHANNEL_SHARED_FIELDS` and `CHANNEL_MARKET_FIELDS: FieldDefinition[]` per census §3, `scope` as documented, with `followMaster` set on title/description/price/quantity/bullets. Legacy/duplicate columns (F15) are omitted; readonly/derived are `cls:'READONLY_SYNCED'|'DERIVED'`.

**Key code (representative — census-driven entries):**
```ts
// master-fields.ts (excerpt)
export const MASTER_FIELDS: FieldDefinition[] = [
  { id: 'sku', label: 'SKU', kind: 'text', cls: 'IDENTITY', scope: 'SHARED', source: { model: 'Product', column: 'sku' }, forcedText: true, width: 22 },
  { id: 'parent_sku', label: 'Parent SKU', kind: 'text', cls: 'IDENTITY', scope: 'SHARED', source: { model: 'Product', column: 'parentId' }, forcedText: true, width: 18 },
  { id: 'ean', label: 'EAN', kind: 'text', cls: 'IDENTITY', scope: 'SHARED', source: { model: 'Product', column: 'ean' }, forcedText: true, width: 16 },
  { id: 'base_price', label: 'Base Price', kind: 'decimal', cls: 'EDITABLE', scope: 'SHARED', source: { model: 'Product', column: 'basePrice' }, decimals: 2, width: 11 },
  { id: 'bullet_points', label: 'Bullet Points', kind: 'array', cls: 'EDITABLE', scope: 'SHARED', source: { model: 'Product', column: 'bulletPoints' }, arrayDelimiter: ' | ', width: 34 },
  { id: 'status', label: 'Status', kind: 'enum', cls: 'EDITABLE', scope: 'SHARED', source: { model: 'Product', column: 'status' }, enumOptions: ['DRAFT','ACTIVE','INACTIVE'], enumMode: 'strict', width: 10 },
  // … full census §2 set …
]
// channel-fields.ts (governed field excerpt)
export const CHANNEL_MARKET_FIELDS: FieldDefinition[] = [
  { id: 'price', label: 'Price', kind: 'decimal', cls: 'EDITABLE', scope: 'MARKET_SCOPED', source: { model: 'ChannelListing', column: 'price' }, decimals: 2,
    followMaster: { followColumn: 'followMasterPrice', overrideColumn: 'priceOverride', masterCacheColumn: 'masterPrice' } },
  { id: 'status', label: 'Status', kind: 'enum', cls: 'READONLY_SYNCED', scope: 'MARKET_SCOPED', source: { model: 'ChannelListing', column: 'listingStatus' }, enumOptions: ['DRAFT','ACTIVE','INACTIVE','ENDED','ERROR'] },
  // … full census §3 set …
]
```

**Test (gate-critical — proves Contract §3/§8 no-gap + no-collision):**
```ts
import { describe, it, expect } from 'vitest'
import { MASTER_FIELDS } from '../registry/master-fields'
import { CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS } from '../registry/channel-fields'

describe('census coverage', () => {
  it('every field id is unique within its group', () => {
    for (const group of [MASTER_FIELDS, CHANNEL_SHARED_FIELDS, CHANNEL_MARKET_FIELDS]) {
      const ids = group.map(f => f.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
  it('every identifier is forcedText', () => {
    for (const f of [...MASTER_FIELDS, ...CHANNEL_MARKET_FIELDS])
      if (f.cls === 'IDENTITY') expect(f.forcedText, f.id).toBe(true)
  })
  it('every governed field declares its follow/override/master columns', () => {
    for (const f of CHANNEL_MARKET_FIELDS)
      if (f.followMaster) {
        expect(f.followMaster.followColumn).toMatch(/^followMaster/)
        expect(f.followMaster.overrideColumn).toBeTruthy()
        expect(f.followMaster.masterCacheColumn).toBeTruthy()
      }
  })
  it('excludes the deprecated chain and duplicate columns (F15)', () => {
    const cols = [...MASTER_FIELDS, ...CHANNEL_MARKET_FIELDS].map(f => f.source.column)
    expect(cols).not.toContain('parentAsin')       // dup of amazonAsin
    expect(cols).not.toContain('fulfillmentChannel')// dup of fulfillmentMethod
    expect(cols).not.toContain('currentPrice')      // VariantChannelListing dup (excluded chain)
  })
})
```

**Done when:** the census-coverage test passes; every EDITABLE census field has exactly one registry entry; identifiers are forced-text; governed fields declare their resolver columns.

---

## Task 2: Excel-proof cell writer

**Files:**
- Create: `apps/api/src/services/flat-file/xlsx-cell.ts`
- Test: `apps/api/src/services/flat-file/__tests__/xlsx-cell.vitest.test.ts`

**Interfaces — Produces:**
```ts
import type { Cell } from 'exceljs'
export function writeCell(cell: Cell, field: FieldDefinition, value: unknown): void
// dispatches on field.kind; applies forcedText, decimals, ISO dates, array join, enum validation elsewhere
export function isoDate(d: Date | string | null): string   // → 'YYYY-MM-DD' | ''
export function joinArray(a: unknown, delim: string): string
```

**Approach:** `writeCell` is the ONLY place values become cells (replaces `renderXlsx`'s raw `readPath` write, F9). Rules: `forcedText` → `cell.value = String(v); cell.numFmt = '@'`. `decimal` → `cell.value = Number(v); cell.numFmt = '0.'+'0'.repeat(field.decimals ?? 2)`. `date` → `writeCell` uses `isoDate` and stores as text (`numFmt='@'`). `array` → `joinArray` with delimiter. `boolean` → `'true'/'false'`. Empty/null → `cell.value = ''` (blank = no-change semantics preserved for round-trip).

**Key code:**
```ts
export function isoDate(d) { if (!d) return ''; const dt = d instanceof Date ? d : new Date(d); return dt.toISOString().slice(0, 10) }
export function joinArray(a, delim) { return Array.isArray(a) ? a.map(x => String(x).replaceAll(delim.trim(), '/')).join(delim) : (a == null ? '' : String(a)) }
export function writeCell(cell, field, value) {
  if (value == null || value === '') { cell.value = ''; if (field.forcedText) cell.numFmt = '@'; return }
  switch (field.kind) {
    case 'decimal': cell.value = Number(value); cell.numFmt = '0.' + '0'.repeat(field.decimals ?? 2); break
    case 'number': cell.value = Number(value); break
    case 'date': cell.value = isoDate(value as any); cell.numFmt = '@'; break
    case 'array': cell.value = joinArray(value, field.arrayDelimiter ?? ' | '); break
    case 'boolean': cell.value = value ? 'true' : 'false'; break
    default: cell.value = String(value); if (field.forcedText) cell.numFmt = '@'
  }
}
```

**Test (gate-critical — Excel-proofing):**
```ts
import ExcelJS from 'exceljs'
import { writeCell, isoDate, joinArray } from '../xlsx-cell'
it('forces identifiers to text and preserves leading zeros', () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('t'); const c = ws.getCell('A1')
  writeCell(c, { id: 'ean', kind: 'text', forcedText: true } as any, '08054323310123')
  expect(c.value).toBe('08054323310123'); expect(c.numFmt).toBe('@')
})
it('writes decimals with fixed format, dates as ISO text, arrays joined', () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('t')
  const p = ws.getCell('A1'); writeCell(p, { kind: 'decimal', decimals: 2 } as any, 189.9)
  expect(p.value).toBe(189.9); expect(p.numFmt).toBe('0.00')
  expect(isoDate('2026-07-05T10:00:00Z')).toBe('2026-07-05')
  expect(joinArray(['a','b'], ' | ')).toBe('a | b')
})
```

**Done when:** the cell-writer test passes — identifiers text, decimals formatted, dates ISO, arrays joined.

---

## Task 3: Market discovery

**Files:**
- Create: `apps/api/src/services/flat-file/market-discovery.ts`
- Test: `apps/api/src/services/flat-file/__tests__/market-discovery.vitest.test.ts`

**Interfaces — Produces:** `export async function discoverMarkets(prisma, channel: 'AMAZON'|'EBAY'|'SHOPIFY'): Promise<string[]>`

**Approach:** implements FF0-MARKET-DISCOVERY §4.1 exactly — union of DISTINCT live `ChannelListing.marketplace` and active `Marketplace.code` for the channel, sorted `sortMarkets` (primary IT first, then alphabetical). Keyed on `code`, avoiding the BE/PL id conflict (F3).

**Key code:**
```ts
const PRIMARY = 'IT'
export function sortMarkets(codes: string[]): string[] {
  const uniq = [...new Set(codes.filter(Boolean))]
  return uniq.sort((a, b) => (a === PRIMARY ? -1 : b === PRIMARY ? 1 : a.localeCompare(b)))
}
export async function discoverMarkets(prisma, channel) {
  const [present, configured] = await Promise.all([
    prisma.channelListing.findMany({ where: { channel }, select: { marketplace: true }, distinct: ['marketplace'] }),
    prisma.marketplace.findMany({ where: { channel, isActive: true }, select: { code: true } }),
  ])
  return sortMarkets([...present.map(p => p.marketplace), ...configured.map(c => c.code)])
    .filter(m => m && m !== 'DEFAULT' && m !== 'GLOBAL' || channel === 'SHOPIFY') // GLOBAL only for single-store channels
}
```

**Test:**
```ts
it('unions live + configured markets, IT first then alpha, dedup', async () => {
  const prisma = { channelListing: { findMany: async () => [{ marketplace: 'DE' }, { marketplace: 'IT' }, { marketplace: 'UK' }] },
                   marketplace:   { findMany: async () => [{ code: 'IT' }, { code: 'FR' }] } }
  expect(await discoverMarkets(prisma as any, 'AMAZON')).toEqual(['IT', 'DE', 'FR', 'UK'])
})
```

**Done when:** discovery returns the deterministic union; a newly-present market appears without code change.

---

## Task 4: Follow-master resolver (FFD10-A)

**Files:**
- Create: `apps/api/src/services/flat-file/resolver.ts`
- Test: `apps/api/src/services/flat-file/__tests__/resolver.vitest.test.ts`

**Interfaces — Produces:** `export function resolveEffective(listing: Record<string, unknown>, field: FieldDefinition): { value: unknown; followsMaster: boolean }`

**Approach:** for a governed field, read `followMaster.followColumn` (default `true`). If following → value = `masterCacheColumn` (the cached resolved master, e.g. `masterPrice`). If not following → value = `overrideColumn` ?? base `source.column`. For non-governed fields, value = base `source.column`, `followsMaster:false`. (Documented FF3 refinement: pinned `ChannelListingOverride` / `FieldLinkGroup` layers are not read here — the `master*` cache already reflects the resolved master for the common case; FF3 fuzzing validates the edge.)

**Key code:**
```ts
export function resolveEffective(listing, field) {
  const fm = field.followMaster
  if (!fm) return { value: listing[field.source.column] ?? '', followsMaster: false }
  const followsMaster = listing[fm.followColumn] !== false   // default true
  const value = followsMaster
    ? (listing[fm.masterCacheColumn] ?? '')
    : (listing[fm.overrideColumn] ?? listing[field.source.column] ?? '')
  return { value, followsMaster }
}
```

**Test (gate-critical — closes F2):**
```ts
const priceField = { source: { column: 'price' }, followMaster: { followColumn: 'followMasterPrice', overrideColumn: 'priceOverride', masterCacheColumn: 'masterPrice' } } as any
it('follows master → effective is the master cache', () => {
  expect(resolveEffective({ followMasterPrice: true, masterPrice: 189.9, priceOverride: 999 }, priceField))
    .toEqual({ value: 189.9, followsMaster: true })
})
it('not following → effective is the override', () => {
  expect(resolveEffective({ followMasterPrice: false, masterPrice: 189.9, priceOverride: 199.9 }, priceField))
    .toEqual({ value: 199.9, followsMaster: false })
})
```

**Done when:** resolver returns effective value + correct follow-flag for both branches.

---

## Task 5: Registry providers + `buildWorkbookModel`

**Files:**
- Create: `apps/api/src/services/flat-file/registry/amazon-provider.ts`
- Create: `apps/api/src/services/flat-file/registry/ebay-provider.ts`
- Create: `apps/api/src/services/flat-file/registry/index.ts`
- Create: `apps/api/src/services/flat-file/__tests__/fixtures/ebay-fields.golden.json`
- Test: `apps/api/src/services/flat-file/__tests__/ebay-registry-drift.vitest.test.ts`

**Interfaces:**
- Consumes: `MASTER_FIELDS`, `CHANNEL_*_FIELDS` (Task 1); `discoverMarkets` (Task 3).
- Produces: `export async function buildWorkbookModel(prisma, opts: { channels: Channel[] }): Promise<WorkbookModel>`

**Approach:** `amazon-provider` maps the live Amazon manifest (`flatFileService.generateManifest`) columns → `FieldDefinition[]`, guaranteeing the Amazon channel sheet's field set is the **same source the grid uses** (Contract §8, already single-source). `ebay-provider` returns the eBay `FieldDefinition[]` derived from the census; a **drift-guard golden** (`ebay-fields.golden.json`, extracted once from `ebay-columns.ts`) is asserted equal in the test — if the untouchable `ebay-columns.ts` changes, the test fails, signalling a needed sync. `buildWorkbookModel` assembles: `Products` sheet (MASTER_FIELDS), one channel sheet per requested channel (`CHANNEL_SHARED_FIELDS` + provider fields as shared, `CHANNEL_MARKET_FIELDS` as market), with `markets` from `discoverMarkets`.

> **Scope boundary (stated for the gate):** full migration of the *grid* onto this registry — especially the bespoke Amazon grid and the untouchable eBay page — is **out of FF1** (it edits untouchable surfaces). FF1 makes the **file** consume the registry; Amazon is already single-source via `generateManifest`; eBay is drift-guarded. A later, approval-gated phase migrates the grid.

**Test:**
```ts
import golden from './fixtures/ebay-fields.golden.json'
import { EBAY_FIELDS } from '../registry/ebay-provider'
it('eBay registry has not drifted from the untouchable ebay-columns golden', () => {
  const shape = EBAY_FIELDS.map(f => ({ id: f.id, kind: f.kind, enumMode: f.enumMode ?? null }))
  expect(shape).toEqual(golden)
})
```

**Done when:** `buildWorkbookModel` returns a model with the right sheets + discovered markets; eBay drift-guard passes.

---

## Task 6: Data fetch layer

**Files:**
- Create: `apps/api/src/services/flat-file/fetch.ts`
- Test: `apps/api/src/services/flat-file/__tests__/fetch.vitest.test.ts` (mocked prisma)

**Interfaces:**
- Produces:
```ts
export interface WorkbookData {
  products: Array<Record<string, unknown>>                       // Product rows (parent + child), incl. resolved parent_sku
  listings: Record<'AMAZON'|'EBAY'|'SHOPIFY', Array<Record<string, unknown>>> // ChannelListing rows joined to product SKU
}
export async function fetchCatalog(prisma, filters: CatalogFilters): Promise<WorkbookData>
export interface CatalogFilters { skuIn?: string[]; status?: string; brand?: string; productType?: string; channels: Channel[] }
```

**Approach:** query `product.findMany` (soft-delete filtered `deletedAt: null`, include `parent: { select: { sku: true } }`), ordered `sku asc`; map `parentId → parent.sku` into a `parent_sku` field. Query `channelListing.findMany({ where: { channel: { in }, product: <same filter> }, include: { product: { select: { sku: true } } } })`. Bucket listings by channel. Subset export = pass `skuIn` (Task 8).

**Key code (shape):**
```ts
export async function fetchCatalog(prisma, filters) {
  const where = { deletedAt: null, ...(filters.skuIn ? { sku: { in: filters.skuIn } } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.brand ? { brand: filters.brand } : {}), ...(filters.productType ? { productType: filters.productType } : {}) }
  const products = (await prisma.product.findMany({ where, include: { parent: { select: { sku: true } } }, orderBy: { sku: 'asc' } }))
    .map(p => ({ ...p, parent_sku: p.parent?.sku ?? '' }))
  const rows = await prisma.channelListing.findMany({ where: { channel: { in: filters.channels }, product: where }, include: { product: { select: { sku: true } } }, orderBy: [{ product: { sku: 'asc' } }, { marketplace: 'asc' }] })
  const listings = { AMAZON: [], EBAY: [], SHOPIFY: [] }
  for (const r of rows) (listings[r.channel] ??= []).push({ ...r, sku: r.product.sku })
  return { products, listings }
}
```

**Done when:** fetch returns SKU-keyed products (with `parent_sku`) + channel-bucketed listings; ordering deterministic.

---

## Task 7: Deterministic workbook generator

**Files:**
- Create: `apps/api/src/services/flat-file/fingerprint.ts`
- Create: `apps/api/src/services/flat-file/workbook-generator.ts`
- Test: `apps/api/src/services/flat-file/__tests__/workbook-generator.vitest.test.ts`

**Interfaces:**
- Consumes: `WorkbookModel` (Task 5), `WorkbookData` (Task 6), `writeCell` (Task 2), `resolveEffective` (Task 4).
- Produces:
```ts
export async function generateWorkbook(model: WorkbookModel, data: WorkbookData, meta: { snapshotId: string; exportedAt: string }): Promise<Uint8Array>
export function rowFingerprint(sku: string, scope: string, fields: Record<string, unknown>): string
```

**Approach:** mirrors the FF0 sample generator (already proven byte-identical), now data-driven from `model`/`data`:
1. Deterministic ordering: rows sorted parent-SKU then child-SKU (products already `sku asc`; group children under parents); columns in registry order then `field@MKT` groups in `model.markets` order.
2. Per sheet: header row (bold, banded/greyed per class), `writeCell` for every cell; `field@MKT` columns use `resolveEffective` for governed fields (emit value + `field_follows_master@MKT`).
3. `README` sheet generated from `model` (legend, Action values, blank/`__CLEAR__`, `🔒`, market list).
4. `_meta` (veryHidden): `snapshotId`, `schemaVersion`, `exportedAt`, per-channel market list, per-row fingerprints (`rowFingerprint`).
5. Set `wb.created = wb.modified = new Date(meta.exportedAt+'T00:00:00Z')` (zip determinism — proven).
6. Excel ergonomics: frozen `xSplit:2,ySplit:1`; enum `dataValidation`; forced-text via `writeCell`.

**Key code (fingerprint + determinism-critical bits):**
```ts
import { createHash } from 'node:crypto'
export function rowFingerprint(sku, scope, fields) {
  return createHash('sha256').update(`${sku}|${scope}|${JSON.stringify(fields, Object.keys(fields).sort())}`).digest('hex').slice(0, 16)
}
// generator: fixed timestamps, stable key order
wb.created = new Date(meta.exportedAt + 'T00:00:00Z'); wb.modified = wb.created
```

**Test (structure + resolver columns + fingerprint stability):**
```ts
it('emits Products/Amazon/_meta, forces EAN text, and value+follow-flag columns', async () => {
  const bytes = await generateWorkbook(model, data, { snapshotId: 'x', exportedAt: '2026-07-05' })
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes)
  expect(wb.worksheets.map(w => w.name)).toEqual(expect.arrayContaining(['README','Products','Amazon','_meta']))
  expect(wb.getWorksheet('_meta').state).toBe('veryHidden')
  const A = wb.getWorksheet('Amazon'); const h = headerMap(A)
  expect(h['price@IT']).toBeDefined(); expect(h['price_follows_master@IT']).toBeDefined()
})
it('rowFingerprint is stable regardless of key order', () => {
  expect(rowFingerprint('S', 'MASTER', { a: 1, b: 2 })).toBe(rowFingerprint('S', 'MASTER', { b: 2, a: 1 }))
})
```

**Done when:** generator produces the spec's sheet structure from real model/data, with resolver columns and fingerprints.

---

## Task 8: Determinism CI test (the FF1 gate proof)

**Files:**
- Test: `apps/api/src/services/flat-file/__tests__/determinism.vitest.test.ts`
- Create: `apps/api/src/services/flat-file/__tests__/fixtures/sample-model.ts`, `sample-data.ts`

**Interfaces:** Consumes `generateWorkbook` (Task 7).

**Approach:** build a fixed in-memory `WorkbookModel` + `WorkbookData` fixture (no DB), generate twice with identical `{snapshotId, exportedAt}`, assert `Buffer.compare(a, b) === 0`. Also generate with two different `snapshotId`s and assert **only** the `_meta` sheet differs (visible sheets byte-identical) — proving no volatile data leaks into data areas (Contract §1).

**Test:**
```ts
it('is byte-identical across two identical generations', async () => {
  const a = await generateWorkbook(model, data, { snapshotId: 's', exportedAt: '2026-07-05' })
  const b = await generateWorkbook(model, data, { snapshotId: 's', exportedAt: '2026-07-05' })
  expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
})
it('only _meta changes when snapshotId changes (no volatile data leakage)', async () => {
  const a = await loadSheetBytes(await generateWorkbook(model, data, { snapshotId: 's1', exportedAt: '2026-07-05' }), 'Products')
  const b = await loadSheetBytes(await generateWorkbook(model, data, { snapshotId: 's2', exportedAt: '2026-07-05' }), 'Products')
  expect(Buffer.compare(a, b)).toBe(0)
})
```

**Done when:** determinism test green — this is the hard gate for Contract §1 and blocks any future regression.

---

## Task 9: Artifact store (closes F8 / FFD14)

**Files:**
- Create: `apps/api/src/services/flat-file/artifact-store.ts`
- Modify: `apps/api/src/services/export-wizard.service.ts:168-206` (store + download paths)
- Test: `apps/api/src/services/flat-file/__tests__/artifact-store.vitest.test.ts`

**Interfaces — Produces:**
```ts
export interface ArtifactStore { put(key: string, bytes: Uint8Array, contentType: string): Promise<string>; get(url: string): Promise<Uint8Array | null> }
export function getArtifactStore(): ArtifactStore   // env-selected: object store in prod, fs in dev
```

**Approach:** replace the broken `artifactUrl: inline ? null : null` (F8). When `bytes > INLINE_PAYLOAD_LIMIT_BYTES`, `store.put()` and save the returned URL; `download()` uses `store.get(url)` for the artifact branch. Two impls: `FsArtifactStore` (writes under a configured dir; dev/CI) and an object-store impl (S3/Cloudinary — reuse the existing asset pipeline if present).

> **⚠ FFD14 — needs your confirmation before this task builds:** the production storage target (reuse existing Cloudinary/asset storage vs. a new S3 bucket vs. stream-from-route). The interface + fs impl land regardless; the prod impl follows your choice. This is the one external dependency in FF1.

**Test:** `FsArtifactStore.put` then `get` round-trips the bytes; `>1MB` path in a mocked wizard stores a URL not null.

**Done when:** a >1 MB export is downloadable end-to-end (the F8 data-loss bug is closed).

---

## Task 10: Orchestrator + subset/blank-template

**Files:**
- Create: `apps/api/src/services/flat-file/workbook.service.ts`
- Test: `apps/api/src/services/flat-file/__tests__/workbook.service.vitest.test.ts`

**Interfaces:**
- Consumes: `buildWorkbookModel`, `fetchCatalog`, `generateWorkbook`.
- Produces:
```ts
export async function generateWorkbook(prisma, opts: { channels: Channel[]; filters?: CatalogFilters; snapshotId: string; exportedAt: string; blankTemplate?: boolean }): Promise<{ bytes: Uint8Array; marketList: Record<string, string[]> }>
```

**Approach:** `buildWorkbookModel` → (`blankTemplate` ? empty `WorkbookData` : `fetchCatalog(filters)`) → `generateWorkbook`. Subset export = `filters.skuIn` from a grid selection. Blank template = same structure, zero data rows. `snapshotId`/`exportedAt` injected by the caller (Task 11) — in tests they're fixed.

**Test:** blank-template yields headers + README + `_meta` with zero data rows; subset with `skuIn:['A']` yields only A's rows.

**Done when:** orchestrator produces full, subset, and blank-template workbooks.

---

## Task 11: Wire into ExportJob lifecycle + scheduled exports

**Files:**
- Modify: `apps/api/src/services/export/renderers.ts` (add `workbook` branch)
- Modify: `apps/api/src/services/export-wizard.service.ts` (accept `format:'workbook'`, `targetEntity:'catalog'`; persist `snapshotId`/`marketList`)
- Modify: `packages/database/prisma/schema.prisma` (add `ExportJob.snapshotId String?`, `marketList Json?`) + migration
- Test: `apps/api/src/services/flat-file/__tests__/export-integration.vitest.test.ts`

**Interfaces:**
- Consumes: `workbook.service.generateWorkbook` (Task 10), `getArtifactStore` (Task 9).

**Approach:** in `renderExport`, add `case 'workbook':` delegating to the orchestrator (do **not** fork the job lifecycle — `create/run/download` unchanged). `export-wizard.create()` accepts the new format/entity; `run()` generates a `snapshotId` (stored on the `ExportJob` + `_meta`) and `exportedAt` from job `createdAt`; stores bytes via `ArtifactStore`. Scheduled exports reuse this automatically via `fireOnce()`. Migration is reversible:

```prisma
model ExportJob {
  // … existing …
  snapshotId String?
  marketList Json?
}
```
Rollback: `prisma migrate resolve` / down-migration dropping the two nullable columns (documented in the migration file).

**Test:** a `create({ format:'workbook', targetEntity:'catalog', runImmediately:true })` job reaches `COMPLETED`, stores a `snapshotId`, and `download()` returns a valid multi-sheet workbook.

**Done when:** the workbook format runs through the existing job spine (inline + scheduled), grid untouched, migration reversible.

---

## Verification (FF1 build-gate click-through)

Run in order; each must pass:

```bash
# Unit + integration + gate tests
cd apps/api && npx vitest run src/services/flat-file
# Determinism gate (byte-identity) — must print no failures
npx vitest run src/services/flat-file/__tests__/determinism.vitest.test.ts
# Census coverage (zero-gap) + eBay drift guard
npx vitest run src/services/flat-file/__tests__/census-coverage.vitest.test.ts src/services/flat-file/__tests__/ebay-registry-drift.vitest.test.ts
# Type + schema validity
cd ../.. && npx tsc -p apps/api/tsconfig.json --noEmit && npx prisma validate --schema packages/database/prisma/schema.prisma
# Grid non-regression: prove NO web files changed
git diff --name-only | grep -E '^apps/web/' && echo 'REGRESSION: web changed' || echo 'grid untouched ✓'
```

Plus the **live smoke** (post-approval, on prod per project convention): create a `workbook` export of a small SKU set → download → open in Excel → confirm sheets, forced-text EAN, `field@MKT` groups, `_meta` hidden; export the same set twice and `cmp` the visible sheets.

## Findings / risks carried into FF1

- **F8 / FFD14** (dependency): artifact storage target must be confirmed (Task 9) — the one external decision.
- **F2 resolver depth** (accepted limitation): FF1 exports effective-value from the listing's own follow/override/master-cache columns; pinned `ChannelListingOverride` + `FieldLinkGroup` layers are deferred to FF3 fuzzing validation. Stated, not hidden.
- **Grid unification boundary:** FF1 achieves single-source for the *file* (Amazon via `generateManifest`, eBay via drift-guarded registry); migrating the *grid* onto the registry is a separate approval-gated phase (untouchable surfaces).
- **F3 BE/PL** (out of scope, flagged): discovery keys on `code` to avoid the id conflict; the `marketplace-code.ts` map fix remains a standalone task.

---

## Self-review (against Part V FF1 + FF0 decisions)

- **"Deterministic multi-sheet workbook … all channels × all discovered markets, Excel-proof, README + _meta + fingerprints, stable ordering"** → Tasks 2,3,5,7,8. ✓
- **"Shared field registry extracted (grid + file single source) — grid behavior unchanged (snapshot-verified)"** → Tasks 1,5; grid unchanged by construction (no web edits) + eBay drift-guard; full grid-migration explicitly scoped out with rationale. ✓ (boundary stated)
- **"Subset/filtered export from grids; blank-template generation"** → Task 10. ✓
- **"Integration into the existing W9 export wizard and scheduled exports (extend renderers — do not fork)"** → Task 11 (adds a `case`, reuses `create/run/download`, scheduled via `fireOnce`). ✓
- **"Gate verification: export twice → diff bytes → identical"** → Task 8 + Verification block. ✓
- **FFD9** (Product + ChannelListing; legacy excluded) → Tasks 1,6 + census-coverage test asserts exclusions. ✓
- **FFD10-A** (effective value + follow-flag) → Tasks 1,4,7 + resolver test. ✓
- **Placeholder scan:** every task has exact paths, interfaces, real code, and a concrete test. Dependency (FFD14) explicitly flagged, not hand-waved. ✓
- **Type consistency:** `FieldDefinition`/`WorkbookModel`/`WorkbookData`/`generateWorkbook`/`resolveEffective`/`discoverMarkets` names are consistent across Tasks 1–11. ✓

**Residual open item:** FFD14 storage target (Task 9) — the only thing needing your input before this task can build; all other tasks are fully specified.
