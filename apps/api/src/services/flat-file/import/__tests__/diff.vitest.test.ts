/**
 * FF2.4 — computeDiff tests (conformed to the verbatim contract).
 *
 * Contract shape under test:
 *   ImportDiff = { changes, masterChanges, deletes, stats }
 *   CellChange = { sku, sheet, channel?, market?, column, base, from, to, kind, note? }
 *   ChangeKind = 'add'|'update'|'delete'|'no-change'|'conflict'|'out-of-scope'
 *
 * Fixture topology:
 *   Products sheet : Action | sku | brand | status
 *   Amazon sheet   : Action | sku | price@IT | price_follows_master@IT | price@DE | title@IT | fulfillment@IT
 *
 * DB state (current):
 *   GALE-M (product): brand='Xavia', status='ACTIVE'
 *   GALE-M (AMAZON IT listing): followMasterPrice=true, masterPrice=189.9,
 *                                 followMasterTitle=true, masterTitle='GALE Jacket Medium',
 *                                 fulfillmentMethod='FBA'
 *   GALE-M (AMAZON DE listing): followMasterPrice=true, masterPrice=189.9
 *
 * Suites:
 *   1. No-change cases (blank, matching, __CLEAR__ on empty)
 *   2. Update cases (differs, resolver-aware, follows_master)
 *   3. Conflict cases (fingerprint mismatch + file change)
 *   4. Out-of-scope cases (wrong market, master-off)
 *   5. Add cases (action=ADD and new SKU)
 *   6. Delete cases (Action=DELETE → deletes bucket, no cell diffs; __CLEAR__ cell)
 *   7. Stats accuracy
 *   8. masterChanges bucket (Products sheet → masterChanges)
 *   9. Sheet + base stamping on every CellChange
 *  10. Round-trip identity — REAL export→parse→diff (zero add/update, deletes empty)
 *  11. IGNORE action skips entire row
 */

import { describe, it, expect } from 'vitest'
import { computeDiff } from '../diff.js'
import { classifyColumns, defaultScope } from '../scope.js'
import type { ParsedWorkbook, ParsedRow, ParsedCell } from '../parse.js'
import type { WorkbookData } from '../../fetch.js'
import type { CellChange } from '../diff.js'
// Real export→parse pipeline (for the round-trip identity contract test)
import { generateWorkbook } from '../../workbook-generator.js'
import { parseWorkbook } from '../parse.js'
import { MASTER_FIELDS } from '../../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../../registry/channel-fields.js'
import type { WorkbookModel } from '../../registry/types.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCell(value: string): ParsedCell {
  return { raw: value, value }
}

function blankCell(): ParsedCell {
  return { raw: '', value: '' }
}

/** Build a minimal ParsedWorkbook with an Amazon sheet + optional Products sheet. */
function makeWb(
  amazonRows: ParsedRow[],
  productsRows: ParsedRow[] = [],
): ParsedWorkbook {
  const sheets: ParsedWorkbook['sheets'] = {
    Amazon: {
      headers: ['Action', 'sku', 'price@IT', 'price_follows_master@IT', 'price@DE', 'title@IT', 'fulfillment@IT'],
      rows: amazonRows,
    },
  }
  if (productsRows.length > 0) {
    sheets['Products'] = {
      headers: ['Action', 'sku', 'brand', 'status'],
      rows: productsRows,
    }
  }
  return {
    sheets,
    meta: { markets: { AMAZON: ['IT', 'DE'] } },
    parseWarnings: [],
  }
}

/** Build a single Amazon sheet row. */
function amazonRow(
  sku: string,
  action: string,
  cells: Partial<Record<'price@IT' | 'price_follows_master@IT' | 'price@DE' | 'title@IT' | 'fulfillment@IT', string>>,
): ParsedRow {
  const allCells: Record<string, ParsedCell> = {
    Action: makeCell(action),
    sku: makeCell(sku),
    'price@IT': blankCell(),
    'price_follows_master@IT': blankCell(),
    'price@DE': blankCell(),
    'title@IT': blankCell(),
    'fulfillment@IT': blankCell(),
  }
  for (const [k, v] of Object.entries(cells)) {
    if (v !== undefined) allCells[k] = makeCell(v)
  }
  return { sheet: 'Amazon', rowNumber: 2, cells: allCells }
}

/** Build a single Products sheet row. */
function productsRow(
  sku: string,
  action: string,
  cells: Partial<Record<'brand' | 'status', string>>,
): ParsedRow {
  const allCells: Record<string, ParsedCell> = {
    Action: makeCell(action),
    sku: makeCell(sku),
    brand: blankCell(),
    status: blankCell(),
  }
  for (const [k, v] of Object.entries(cells)) {
    if (v !== undefined) allCells[k] = makeCell(v)
  }
  return { sheet: 'Products', rowNumber: 2, cells: allCells }
}

// ── Current DB fixture ─────────────────────────────────────────────────────────

const CURRENT: WorkbookData = {
  products: [
    {
      sku: 'GALE-M',
      parent_sku: '',
      brand: 'Xavia',
      status: 'ACTIVE',
      isParent: false,
    },
  ],
  listings: {
    AMAZON: [
      {
        sku: 'GALE-M',
        marketplace: 'IT',
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
        followMasterTitle: true,
        masterTitle: 'GALE Jacket Medium',
        titleOverride: null,
        fulfillmentMethod: 'FBA',
      },
      {
        sku: 'GALE-M',
        marketplace: 'DE',
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
      },
    ],
    EBAY: [],
    SHOPIFY: [],
  },
}

// Helper: run diff with AMAZON IT scope (default, master-off)
function diff(
  amazonRows: ParsedRow[],
  productsRows: ParsedRow[] = [],
  opts: { fingerprints?: Record<string, string> } = {},
) {
  const wb = makeWb(amazonRows, productsRows)
  const scope = defaultScope({ channel: 'AMAZON', market: 'IT' })
  const scoped = classifyColumns(wb, scope)
  return computeDiff(wb, scoped, CURRENT, scope, opts)
}

// Helper: find a specific CellChange
function findChange(
  result: ReturnType<typeof computeDiff>,
  column: string,
  sku = 'GALE-M',
): CellChange | undefined {
  return [...result.changes, ...result.masterChanges].find(
    c => c.sku === sku && c.column === column,
  )
}

// ── Suite 1: No-change cases ──────────────────────────────────────────────────

describe('computeDiff — no-change cases', () => {
  it('blank price@IT cell → no change emitted', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '' })])
    expect(result.changes).toHaveLength(0)
    expect(result.stats).toMatchObject({ updates: 0, adds: 0 })
  })

  it('price@IT matching DB effective value (189.9) → no change', () => {
    // DB: followMasterPrice=true, masterPrice=189.9 → effective='189.9'
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '189.9' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeUndefined()
    expect(result.stats.updates).toBe(0)
  })

  it('title@IT matching master value → no change', () => {
    // DB: followMasterTitle=true, masterTitle='GALE Jacket Medium'
    const result = diff([amazonRow('GALE-M', '', { 'title@IT': 'GALE Jacket Medium' })])
    const change = findChange(result, 'title@IT')
    expect(change).toBeUndefined()
  })

  it('price_follows_master@IT matching DB follow flag (true) → no change', () => {
    // DB: followMasterPrice=true → 'true'; file has 'true'
    const result = diff([amazonRow('GALE-M', '', { 'price_follows_master@IT': 'true' })])
    const change = findChange(result, 'price_follows_master@IT')
    expect(change).toBeUndefined()
  })

  it('__CLEAR__ on an already-empty DB field → no-change (not emitted)', () => {
    // price@IT for NEW-SKU has no DB listing → fromValue=undefined → fromStr=''
    // __CLEAR__ on empty → no-change
    const result = diff([
      amazonRow('NEW-SKU', 'ADD', { 'price@IT': '__CLEAR__' }),
    ])
    const change = findChange(result, 'price@IT', 'NEW-SKU')
    expect(change).toBeUndefined()
  })

  it('all-blank row produces zero changes', () => {
    const result = diff([amazonRow('GALE-M', '', {})])
    expect(result.changes).toHaveLength(0)
    expect(result.masterChanges).toHaveLength(0)
  })
})

// ── Suite 2: Update cases ─────────────────────────────────────────────────────

describe('computeDiff — update cases', () => {
  it('changed price@IT → update with from=masterPrice value (resolver-aware)', () => {
    // DB: followMasterPrice=true, masterPrice=189.9 → effective 189.9
    // File: 199.9 (operator override)
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '199.9' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    expect(String(change!.from)).toBe('189.9') // from = effective master price
    expect(change!.to).toBe('199.9')
    expect(change!.market).toBe('IT')
    expect(change!.channel).toBe('AMAZON')
  })

  it('changed title@IT → update with from=masterTitle value', () => {
    const result = diff([amazonRow('GALE-M', '', { 'title@IT': 'GALE Jacket M' })])
    const change = findChange(result, 'title@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    expect(change!.from).toBe('GALE Jacket Medium')
    expect(change!.to).toBe('GALE Jacket M')
  })

  it('flipping price_follows_master@IT from true to false → update', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price_follows_master@IT': 'false' })])
    const change = findChange(result, 'price_follows_master@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    expect(change!.from).toBe('true')
    expect(change!.to).toBe('false')
    // base has the _follows_master suffix stripped
    expect(change!.base).toBe('price')
  })

  it('changed fulfillment@IT → update', () => {
    // DB: fulfillmentMethod='FBA'
    const result = diff([amazonRow('GALE-M', '', { 'fulfillment@IT': 'FBM' })])
    const change = findChange(result, 'fulfillment@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    expect(change!.from).toBe('FBA')
    expect(change!.to).toBe('FBM')
  })

  it('multiple changed cells → one update record per cell', () => {
    const result = diff([amazonRow('GALE-M', '', {
      'price@IT': '199.9',
      'title@IT': 'New Title',
    })])
    const priceChange = findChange(result, 'price@IT')
    const titleChange = findChange(result, 'title@IT')
    expect(priceChange?.kind).toBe('update')
    expect(titleChange?.kind).toBe('update')
    expect(result.stats.updates).toBe(2)
  })
})

// ── Suite 3: Conflict cases ───────────────────────────────────────────────────

describe('computeDiff — conflict detection', () => {
  it('file change + stale snapshot fingerprint → conflict', () => {
    // Pass a snapshot fingerprint that doesn't match the current DB fingerprint
    // (simulates: row changed in DB since the file was exported)
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9' })],
      [],
      { fingerprints: { 'Amazon|GALE-M': 'stale-hash-that-wont-match' } },
    )
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('conflict')
    expect(change!.note).toContain('Row changed in DB since export')
    expect(String(change!.from)).toBe('189.9')
    expect(change!.to).toBe('199.9')
    expect(result.stats.conflicts).toBe(1)
    expect(result.stats.updates).toBe(0)
  })

  it('file change + matching fingerprint → update (not conflict)', () => {
    // When no fingerprints are provided, no conflict can occur.
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9' })],
      [],
      {}, // no fingerprints → no conflict possible
    )
    const change = findChange(result, 'price@IT')
    expect(change!.kind).toBe('update') // not conflict
    expect(result.stats.conflicts).toBe(0)
  })

  it('no file change + stale fingerprint → no-change (not conflict)', () => {
    // File matches DB → no change regardless of fingerprint
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '189.9' })], // matches DB effective
      [],
      { fingerprints: { 'Amazon|GALE-M': 'stale-hash' } },
    )
    const change = findChange(result, 'price@IT')
    expect(change).toBeUndefined()
    expect(result.stats.conflicts).toBe(0)
  })

  it('stale fingerprint + multiple changed cells → conflict for each', () => {
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9', 'title@IT': 'New Title' })],
      [],
      { fingerprints: { 'Amazon|GALE-M': 'stale' } },
    )
    expect(result.stats.conflicts).toBe(2)
    const priceChange = findChange(result, 'price@IT')
    const titleChange = findChange(result, 'title@IT')
    expect(priceChange!.kind).toBe('conflict')
    expect(titleChange!.kind).toBe('conflict')
  })
})

// ── Suite 4: Out-of-scope cases ───────────────────────────────────────────────

describe('computeDiff — out-of-scope', () => {
  it('price@DE change with AMAZON IT scope → out-of-scope (not update)', () => {
    // Scope = AMAZON IT → DE is out of scope
    const result = diff([amazonRow('GALE-M', '', { 'price@DE': '155.0' })])
    const change = findChange(result, 'price@DE')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('out-of-scope')
    expect(change!.market).toBe('DE')
    expect(String(change!.from)).toBe('189.9') // DB effective for DE
    // canon('155.0', priceField) → canonicalizeDecimal → Number('155.0')=155 → '155'
    expect(change!.to).toBe('155')
    expect(result.stats.outOfScope).toBe(1)
    expect(result.stats.updates).toBe(0)
  })

  it('price@DE matching DB → not emitted (no meaningful out-of-scope change)', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@DE': '189.9' })])
    const change = findChange(result, 'price@DE')
    expect(change).toBeUndefined()
    expect(result.stats.outOfScope).toBe(0)
  })

  it('blank price@DE → not emitted (blank = no-change, even out-of-scope)', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@DE': '' })])
    const change = findChange(result, 'price@DE')
    expect(change).toBeUndefined()
  })

  it('master column brand with includeMaster=false → out-of-scope when changed', () => {
    // Default scope has includeMaster=false → Products sheet columns are out-of-scope
    const wb = makeWb([], [productsRow('GALE-M', '', { brand: 'NewBrand' })])
    const scope = defaultScope({ channel: 'AMAZON', market: 'IT' })
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    const change = result.masterChanges.find(c => c.column === 'brand')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('out-of-scope')
    expect(change!.from).toBe('Xavia')
    expect(change!.to).toBe('NewBrand')
    expect(result.stats.outOfScope).toBe(1)
  })

  it('master column brand with includeMaster=true → update (in-scope)', () => {
    const wb = makeWb([], [productsRow('GALE-M', '', { brand: 'NewBrand' })])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    const change = result.masterChanges.find(c => c.column === 'brand')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    expect(result.stats.updates).toBe(1)
    expect(result.stats.outOfScope).toBe(0)
  })
})

// ── Suite 5: Add cases ────────────────────────────────────────────────────────

describe('computeDiff — add cases', () => {
  it('action=ADD for an existing SKU → add kind (not update)', () => {
    const result = diff([amazonRow('GALE-M', 'ADD', { 'price@IT': '199.9' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('add')
    expect(result.stats.adds).toBe(1)
    expect(result.stats.updates).toBe(0)
  })

  it('new SKU not in DB → add kind (blank action)', () => {
    const result = diff([amazonRow('NEW-SKU', '', { 'price@IT': '99.9' })])
    const change = findChange(result, 'price@IT', 'NEW-SKU')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('add')
    expect(result.stats.adds).toBe(1)
  })

  it('new SKU action=ADD → add kind', () => {
    const result = diff([amazonRow('BRAND-NEW', 'ADD', { 'price@IT': '50.0', 'title@IT': 'New Product' })])
    const priceC = findChange(result, 'price@IT', 'BRAND-NEW')
    const titleC = findChange(result, 'title@IT', 'BRAND-NEW')
    expect(priceC!.kind).toBe('add')
    expect(titleC!.kind).toBe('add')
    expect(result.stats.adds).toBe(2)
  })

  it('new SKU with blank cells → only non-blank cells emitted as add', () => {
    const result = diff([amazonRow('NEW-SKU', 'ADD', { 'price@IT': '99.9' /* title blank */ })])
    const titleChange = findChange(result, 'title@IT', 'NEW-SKU')
    expect(titleChange).toBeUndefined() // blank → no-change
    expect(result.stats.adds).toBe(1) // only price@IT
  })
})

// ── Suite 6: Delete cases ─────────────────────────────────────────────────────

describe('computeDiff — delete cases', () => {
  it('Action=DELETE records the row in the deletes bucket (one entry per row)', () => {
    const result = diff([amazonRow('GALE-M', 'DELETE', {})])
    // scope = AMAZON IT → delete is in-scope; markets carries the scope's markets array
    expect(result.deletes).toContainEqual({ sku: 'GALE-M', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] })
    expect(result.deletes).toHaveLength(1)
    expect(result.stats.deletes).toBe(1)
  })

  it('Action=DELETE emits NO per-cell CellChanges (cell diffing skipped)', () => {
    // Even when cells carry values, a DELETE row produces zero cell changes.
    const result = diff([amazonRow('GALE-M', 'DELETE', { 'price@IT': '199.9', 'title@IT': 'X' })])
    expect(result.changes).toHaveLength(0)
    expect(result.masterChanges).toHaveLength(0)
    // The row is only surfaced via the deletes bucket.
    expect(result.deletes).toContainEqual({ sku: 'GALE-M', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] })
    expect(findChange(result, 'price@IT')).toBeUndefined()
  })

  it('delete record carries sku + sheet + channel + markets', () => {
    const result = diff([amazonRow('GALE-M', 'DELETE', {})])
    const entry = result.deletes.find(d => d.sku === 'GALE-M')
    expect(entry).toBeDefined()
    expect(entry).toEqual({ sku: 'GALE-M', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] })
  })

  it('__CLEAR__ on non-empty field → delete CellChange (distinct from Action=DELETE)', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '__CLEAR__' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('delete')
    expect(change!.to).toBe('')
    expect(change!.note).toBe('__CLEAR__')
    expect(result.stats.deletes).toBe(1)
    // __CLEAR__ is a cell op, not a row op → deletes bucket stays empty
    expect(result.deletes).toHaveLength(0)
  })

  it('__CLEAR__ on already-empty DB field → no-change (not emitted)', () => {
    // No listing for NEW-SKU → effective price = '' (empty)
    const result = diff([amazonRow('NEW-SKU', '', { 'price@IT': '__CLEAR__' })])
    const change = findChange(result, 'price@IT', 'NEW-SKU')
    expect(change).toBeUndefined()
    expect(result.stats.deletes).toBe(0)
  })
})

// ── Suite 7: Stats accuracy ───────────────────────────────────────────────────

describe('computeDiff — stats', () => {
  it('stats reflect the correct counts across kinds', () => {
    const result = diff([
      // One update (GALE-M price)
      // One out-of-scope (GALE-M price DE)
      amazonRow('GALE-M', '', { 'price@IT': '199.9', 'price@DE': '155.0' }),
    ])
    expect(result.stats.updates).toBe(1) // price@IT
    expect(result.stats.outOfScope).toBe(1) // price@DE
    expect(result.stats.adds).toBe(0)
    expect(result.stats.deletes).toBe(0)
    expect(result.stats.conflicts).toBe(0)
  })

  it('adds, updates, deletes (cell-level), conflicts, outOfScope sum to CellChange count', () => {
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9', 'price@DE': '155.0' })],
      [],
      { fingerprints: { 'Amazon|GALE-M': 'stale' } },
    )
    // price@IT → conflict (stale fingerprint + file change)
    // price@DE → out-of-scope
    // No Action=DELETE rows here, so every counted stat maps to a CellChange.
    expect(result.stats.conflicts).toBe(1)
    expect(result.stats.outOfScope).toBe(1)
    expect(result.stats.updates).toBe(0)
    const total =
      result.stats.adds +
      result.stats.updates +
      result.stats.deletes +
      result.stats.conflicts +
      result.stats.outOfScope
    expect(total).toBe([...result.changes, ...result.masterChanges].length)
  })

  it('stats.deletes counts both __CLEAR__ cells and Action=DELETE rows', () => {
    const result = diff([
      amazonRow('GALE-M', '', { 'price@IT': '__CLEAR__' }), // cell-level delete
      amazonRow('GALE-L', 'DELETE', {}),                     // row-level delete
    ])
    expect(result.stats.deletes).toBe(2)
    expect(result.deletes).toContainEqual({ sku: 'GALE-L', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] })
  })
})

// ── Suite 8: masterChanges bucket ────────────────────────────────────────────

describe('computeDiff — masterChanges bucket', () => {
  it('Products-sheet change goes to masterChanges, not changes', () => {
    const wb = makeWb([], [productsRow('GALE-M', '', { brand: 'NewBrand' })])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    expect(result.masterChanges.length).toBeGreaterThan(0)
    const brandChange = result.masterChanges.find(c => c.column === 'brand')
    expect(brandChange).toBeDefined()
    expect(brandChange!.sheet).toBe('Products')
    // Must NOT be in changes
    expect(result.changes.find(c => c.column === 'brand')).toBeUndefined()
  })

  it('Amazon-sheet change goes to changes, not masterChanges', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '199.9' })])
    const priceChange = result.changes.find(c => c.column === 'price@IT')
    expect(priceChange).toBeDefined()
    expect(priceChange!.sheet).toBe('Amazon')
    expect(result.masterChanges.find(c => c.column === 'price@IT')).toBeUndefined()
  })

  it('stats count masterChanges AND changes together', () => {
    const wb = makeWb(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9' })],
      [productsRow('GALE-M', '', { brand: 'NewBrand' })],
    )
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    // price@IT update + brand update = 2 updates
    expect(result.stats.updates).toBe(2)
  })
})

// ── Suite 9: sheet + base stamping ────────────────────────────────────────────

describe('computeDiff — sheet + base fields on every CellChange', () => {
  it('channel change carries sheet=Amazon and base=field id', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '199.9' })])
    const change = findChange(result, 'price@IT')
    expect(change!.sheet).toBe('Amazon')
    expect(change!.base).toBe('price')
    expect(change!.column).toBe('price@IT')
  })

  it('out-of-scope change carries sheet + base', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@DE': '155.0' })])
    const change = findChange(result, 'price@DE')
    expect(change!.sheet).toBe('Amazon')
    expect(change!.base).toBe('price')
    expect(change!.market).toBe('DE')
  })

  it('master change carries sheet=Products and base=column', () => {
    const wb = makeWb([], [productsRow('GALE-M', '', { brand: 'NewBrand' })])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    const change = result.masterChanges.find(c => c.column === 'brand')
    expect(change!.sheet).toBe('Products')
    expect(change!.base).toBe('brand')
  })
})

// ── Suite 10: Round-trip identity (REAL export→parse→diff) ────────────────────

describe('computeDiff — round-trip identity (real export→parse→diff)', () => {
  // A real WorkbookModel: Products + Amazon (IT, DE) from the shared registry.
  const RT_MODEL: WorkbookModel = {
    markets: { AMAZON: ['IT', 'DE'], EBAY: [], SHOPIFY: [] },
    sheets: [
      { name: 'Products', sharedFields: MASTER_FIELDS, marketFields: [] },
      { name: 'Amazon', channel: 'AMAZON', sharedFields: [], marketFields: CHANNEL_MARKET_FIELDS },
    ],
  }

  it('an unedited exported workbook re-imports as pure no-ops', async () => {
    // 1. Export the CURRENT catalog through the REAL byte-generator.
    const bytes = await generateWorkbook(RT_MODEL, CURRENT, {
      snapshotId: 'rt',
      exportedAt: '2026-07-06',
    })
    // 2. Parse those xlsx bytes back through the REAL parser.
    const parsed = await parseWorkbook(bytes)
    // 3. Classify with the WIDEST scope so EVERY cell exercises the in-scope
    //    no-change path (not the out-of-scope short-circuit).
    const rtScope = { channel: 'AMAZON' as const, markets: ['IT', 'DE'] as string[], includeMaster: true }
    const scoped = classifyColumns(parsed, rtScope)
    // 4. Diff against the SAME catalog state the workbook was generated from.
    const result = computeDiff(parsed, scoped, CURRENT, rtScope, {})

    // THE contract guarantee: an unedited export applies nothing.
    expect(result.stats.adds).toBe(0)
    expect(result.stats.updates).toBe(0)
    expect(result.deletes).toEqual([])
    // Stronger: the entire diff is empty — every cell resolves to no-change.
    expect(result.changes).toEqual([])
    expect(result.masterChanges).toEqual([])
    expect(result.stats).toEqual({ adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 })
  })
})

// ── Suite 11: IGNORE action ────────────────────────────────────────────────────

describe('computeDiff — IGNORE action', () => {
  it('Action=IGNORE skips all cells even with non-blank values', () => {
    const result = diff([
      amazonRow('GALE-M', 'IGNORE', {
        'price@IT': '999.9',
        'title@IT': 'Something Completely Different',
        'fulfillment@IT': 'FBM',
      }),
    ])
    expect(result.changes).toHaveLength(0)
    expect(result.masterChanges).toHaveLength(0)
    expect(result.deletes).toHaveLength(0)
    expect(result.stats).toEqual({ adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 })
  })

  it('IGNORE row with out-of-scope column → still no changes (IGNORE wins)', () => {
    const result = diff([
      amazonRow('GALE-M', 'IGNORE', { 'price@DE': '155.0' }),
    ])
    expect(result.stats.outOfScope).toBe(0)
  })
})

// ── Suite 12: C1 round-trip — array element containing delimiter char ──────────
//
// Contract §2 violation caught by C1: any bullet/keyword element whose text
// contains the ' | ' delimiter char caused a FALSE kind:'update' on round-trip
// because toStr did a raw .join(delim) while the generator's joinArray escapes
// the inner delimiter.  This test MUST fail before the C1 fix and pass after.

describe('computeDiff — C1 round-trip: pipe-containing array element', () => {
  // Products-only model — no channel sheets needed for this case.
  const PIPE_MODEL: WorkbookModel = {
    markets: { AMAZON: [], EBAY: [], SHOPIFY: [] },
    sheets: [
      { name: 'Products', sharedFields: MASTER_FIELDS, marketFields: [] },
    ],
  }

  // A product whose bullet_points array has an element containing the '|' char.
  const PIPE_CURRENT: WorkbookData = {
    products: [
      {
        sku: 'PIPE-SKU',
        parent_sku: '',
        isParent: false,
        bulletPoints: ['Resistente | impermeabile', 'CE Level 2'],
        brand: 'Xavia',
        status: 'ACTIVE',
      },
    ],
    listings: { AMAZON: [], EBAY: [], SHOPIFY: [] },
  }

  it('bullet_points with pipe-containing element round-trips as no-change (C1 fix)', async () => {
    // 1. Export — the real generator's joinArray escapes the inner '|' → '/'.
    const bytes = await generateWorkbook(PIPE_MODEL, PIPE_CURRENT, {
      snapshotId: 'c1-rt',
      exportedAt: '2026-07-06',
    })
    // 2. Parse the xlsx bytes back through the real parser.
    const parsed = await parseWorkbook(bytes)
    // 3. Classify with includeMaster=true so the Products sheet is in-scope.
    const pipeScope = { channel: 'AMAZON' as const, markets: [] as string[], includeMaster: true }
    const scoped = classifyColumns(parsed, pipeScope)
    // 4. Diff against the identical catalog state used for generation.
    const result = computeDiff(parsed, scoped, PIPE_CURRENT, pipeScope, {})

    // Key assertion: no false update on bullet_points (round-trip identity).
    const bulletChange = result.masterChanges.find(c => c.column === 'bullet_points')
    expect(bulletChange).toBeUndefined()
    // Whole diff must be clean.
    expect(result.stats.updates).toBe(0)
    expect(result.stats.adds).toBe(0)
    expect(result.stats).toMatchObject({ adds: 0, updates: 0, conflicts: 0 })
  })
})

// ── Suite 13: C1 — curly-quote round-trip identity ─────────────────────────────
//
// DB value has a curly right-single-quote (U+2019, e.g. "L'Aquila Giacca").
// The xlsx generator emits the curly quote verbatim. The parser normalises it
// to a straight quote (U+0027). Without the symmetric DB-side canonicalisation
// in diff.ts the string comparison sees:
//   fileValue   = "L'Aquila Giacca"  (straight, from parser)
//   fromStr/old = "L’Aquila Giacca"  (curly, raw DB value)
// → not equal → FALSE update.
// With canon() applied to both sides the test resolves to no-change (MUST fail
// before the C1 fix, MUST pass after).

describe('computeDiff — C1: curly-quote DB value round-trips as no-change', () => {
  const CURLY_MODEL: WorkbookModel = {
    markets: { AMAZON: [], EBAY: [], SHOPIFY: [] },
    sheets: [
      { name: 'Products', sharedFields: MASTER_FIELDS, marketFields: [] },
    ],
  }

  // U+2019 RIGHT SINGLE QUOTATION MARK in the product name (Italian possessive).
  const CURLY_CURRENT: WorkbookData = {
    products: [
      {
        sku: 'CURLY-SKU',
        parent_sku: '',
        isParent: false,
        name: 'L’Aquila Giacca',   // curly right single quote
        brand: 'Xavia',
        status: 'ACTIVE',
      },
    ],
    listings: { AMAZON: [], EBAY: [], SHOPIFY: [] },
  }

  it('name with curly-quote DB value round-trips as no-change (C1 fix)', async () => {
    // 1. Export — generator writes "L’Aquila Giacca" verbatim into the xlsx cell.
    const bytes = await generateWorkbook(CURLY_MODEL, CURLY_CURRENT, {
      snapshotId: 'c1-curly',
      exportedAt: '2026-07-06',
    })
    // 2. Parse — normalizeCell converts U+2019 → U+0027 (straight quote).
    //    So parsed cell value = "L'Aquila Giacca" (straight).
    const parsed = await parseWorkbook(bytes)
    // 3. Classify with includeMaster=true so the Products sheet is in-scope.
    const curlyScope = { channel: 'AMAZON' as const, markets: [] as string[], includeMaster: true }
    const scoped = classifyColumns(parsed, curlyScope)
    // 4. Diff against the original (curly-quote) catalog state.
    const result = computeDiff(parsed, scoped, CURLY_CURRENT, curlyScope, {})

    // Key assertion: no false update on `name` (round-trip identity).
    // Without C1 fix: "L'Aquila Giacca" !== "L’Aquila Giacca" → update.
    // With C1 fix: canon() normalises both to "L'Aquila Giacca" → no update.
    const nameChange = result.masterChanges.find(c => c.column === 'name')
    expect(nameChange).toBeUndefined()
    // Whole diff must be clean.
    expect(result.stats).toMatchObject({ adds: 0, updates: 0, conflicts: 0 })
  })
})

// ── Suite 14: I1 + I2 — decimal canonicalisation ──────────────────────────────
//
// I1: IT comma-decimal format in the file (e.g. '189,90') must compare equal to
//     the DB effective value '189.9'. A genuinely different value ('199,90')
//     must still emit an update with `to` normalised to '199.9'.
//
// I2: Trailing-zero padded decimal from DB (e.g. '189.90', as a Prisma.Decimal
//     stringifies) must compare equal to the file value '189.9'.

describe('computeDiff — I1 + I2: decimal canonicalisation', () => {
  // I1: file has '189,90' — IT locale; DB effective is 189.9 (number).
  it('I1 — file "189,90" vs DB 189.9 → no update (canonical match)', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '189,90' })])
    const change = findChange(result, 'price@IT')
    // Without I1 fix: '189,90' !== '189.9' → false update.
    // With fix: canonicalizeDecimal('189,90') = '189.9'; match → no update.
    expect(change).toBeUndefined()
    expect(result.stats.updates).toBe(0)
  })

  it('I1 — file "199,90" vs DB 189.9 → update with to:"199.9"', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '199,90' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('update')
    // to is the clean canonical form, not the raw comma-decimal.
    expect(change!.to).toBe('199.9')
    expect(result.stats.updates).toBe(1)
  })

  // I2: DB value serialised with trailing zero (simulates Prisma.Decimal.toString()).
  it('I2 — file "189.9" vs DB "189.90" (padded) → no update (canonical match)', () => {
    // Simulate a Prisma.Decimal that serialises to "189.90" by using a string
    // value in the listing fixture. toStr/canon sees String("189.90") = "189.90".
    const paddedCurrent: WorkbookData = {
      ...CURRENT,
      listings: {
        ...CURRENT.listings,
        AMAZON: [
          {
            ...CURRENT.listings.AMAZON[0],
            // Override masterPrice with string "189.90" to simulate Prisma.Decimal
            // toString() producing a padded decimal representation.
            masterPrice: '189.90' as any,
          },
          CURRENT.listings.AMAZON[1],
        ],
      },
    }
    const wb = makeWb([amazonRow('GALE-M', '', { 'price@IT': '189.9' })])
    const scope = defaultScope({ channel: 'AMAZON', market: 'IT' })
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, paddedCurrent, scope, {})
    const change = result.changes.find(c => c.column === 'price@IT')
    // Without I2 fix: '189.9' !== '189.90' → false update.
    // With fix: canonicalizeDecimal('189.9') = '189.9' === canonicalizeDecimal('189.90') = '189.9'.
    expect(change).toBeUndefined()
    expect(result.stats.updates).toBe(0)
  })
})

// ── Suite 15: C2 — scope-aware deletes ────────────────────────────────────────
//
// A DELETE row must only be recorded when it is actionable for the import scope:
//   Channel sheet DELETE: only if SHEET_CHANNEL[sheet] === scope.channel.
//   Products sheet DELETE: only if scope.includeMaster === true.
//
// Out-of-scope deletes are silently skipped (no entry, no stats.deletes bump).

describe('computeDiff — C2: scope-aware deletes', () => {
  /** Build a minimal workbook that contains a Products sheet + both Amazon + eBay sheets. */
  function makeMixedWb(
    amazonRows: ParsedRow[],
    ebayRows: ParsedRow[],
    productsRows: ParsedRow[] = [],
  ): ParsedWorkbook {
    const sheets: ParsedWorkbook['sheets'] = {
      Amazon: {
        headers: ['Action', 'sku', 'price@IT'],
        rows: amazonRows,
      },
      eBay: {
        headers: ['Action', 'sku', 'price@IT'],
        rows: ebayRows,
      },
    }
    if (productsRows.length > 0) {
      sheets['Products'] = { headers: ['Action', 'sku', 'brand'], rows: productsRows }
    }
    return { sheets, meta: { markets: { AMAZON: ['IT'], EBAY: ['IT'] } }, parseWarnings: [] }
  }

  function makeEbayRow(sku: string, action: string): ParsedRow {
    return {
      sheet: 'eBay',
      rowNumber: 2,
      cells: { Action: makeCell(action), sku: makeCell(sku), 'price@IT': blankCell() },
    }
  }

  // C2a: DELETE on eBay sheet while scope=AMAZON → NOT recorded.
  it('C2a — eBay DELETE with scope.channel=AMAZON → not in deletes, stats.deletes=0', () => {
    const wb = makeMixedWb(
      [],
      [makeEbayRow('GALE-M', 'DELETE')],  // eBay sheet
    )
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: false }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    expect(result.deletes).toHaveLength(0)
    expect(result.stats.deletes).toBe(0)
  })

  // C2b-false: DELETE on Products sheet with includeMaster=false → NOT recorded.
  it('C2b — Products DELETE with includeMaster=false → not in deletes', () => {
    const pr = {
      sheet: 'Products',
      rowNumber: 2,
      cells: { Action: makeCell('DELETE'), sku: makeCell('GALE-M'), brand: blankCell() },
    }
    const wb = makeMixedWb([], [], [pr])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: false }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    expect(result.deletes).toHaveLength(0)
    expect(result.stats.deletes).toBe(0)
  })

  // C2b-true: DELETE on Products sheet with includeMaster=true → IS recorded.
  it('C2b — Products DELETE with includeMaster=true → in deletes (no channel/markets)', () => {
    const pr = {
      sheet: 'Products',
      rowNumber: 2,
      cells: { Action: makeCell('DELETE'), sku: makeCell('GALE-M'), brand: blankCell() },
    }
    const wb = makeMixedWb([], [], [pr])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    expect(result.deletes).toHaveLength(1)
    expect(result.deletes[0]).toEqual({ sku: 'GALE-M', sheet: 'Products' })
    expect(result.stats.deletes).toBe(1)
    // Products delete has no channel or markets (whole-product op)
    expect(result.deletes[0]).not.toHaveProperty('channel')
    expect(result.deletes[0]).not.toHaveProperty('markets')
  })

  // C2c: in-scope Amazon DELETE → recorded with markets = scope.markets.
  it('C2c — Amazon DELETE with scope.channel=AMAZON → in deletes with markets=scope.markets', () => {
    const wb = makeMixedWb(
      [amazonRow('GALE-M', 'DELETE', {})],  // Amazon sheet, in-scope
      [],
    )
    const scope = { channel: 'AMAZON' as const, markets: ['IT', 'DE'] as string[], includeMaster: false }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, scope, {})
    expect(result.deletes).toHaveLength(1)
    expect(result.deletes[0]).toEqual({
      sku: 'GALE-M',
      sheet: 'Amazon',
      channel: 'AMAZON',
      markets: ['IT', 'DE'],
    })
    expect(result.stats.deletes).toBe(1)
  })
})
