/**
 * FF2.4 — computeDiff TDD tests.
 *
 * Written in TDD style: all cases specified before implementation confirmed green.
 *
 * All fixtures are hand-built (no xlsx I/O) for speed and control.
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
 *   6. Delete cases (action=DELETE and __CLEAR__)
 *   7. Stats accuracy
 *   8. masterChanges bucket (Products sheet → masterChanges)
 *   9. actionRows collection
 *  10. Round-trip identity (all no-change — zero changes emitted)
 *  11. IGNORE action skips entire row
 */

import { describe, it, expect } from 'vitest'
import { computeDiff } from '../diff.js'
import { classifyColumns, defaultScope } from '../scope.js'
import type { ParsedWorkbook, ParsedRow, ParsedCell } from '../parse.js'
import type { WorkbookData } from '../../fetch.js'
import type { CellChange } from '../diff.js'

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
  opts: { snapshotId?: string; fingerprints?: Record<string, string> } = {},
) {
  const wb = makeWb(amazonRows, productsRows)
  const scope = defaultScope({ channel: 'AMAZON', market: 'IT' })
  const scoped = classifyColumns(wb, scope)
  return computeDiff(wb, scoped, CURRENT, opts)
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
    // priceOverride is null (DB), so effective value is 189.9 (from masterPrice)
    // But __CLEAR__ on price@IT where current effective is non-empty → delete
    // (this tests that __CLEAR__ on an empty DB field is a no-op)
    // We test a field that IS empty in DB: use a brand new SKU with no listing
    const result = diff([
      amazonRow('NEW-SKU', 'ADD', { 'price@IT': '__CLEAR__' }),
    ])
    // price@IT for NEW-SKU has no DB listing → fromValue=undefined → fromStr=''
    // __CLEAR__ on empty → no-change
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
    // If the fingerprint matches the current DB, no conflict
    // We can't easily compute the real fingerprint in tests, but we can
    // verify: when no fingerprints are provided, no conflict occurs
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
    expect(change!.to).toBe('155.0')
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
    const result = computeDiff(wb, scoped, CURRENT, {})
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
    const result = computeDiff(wb, scoped, CURRENT, {})
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
  it('action=DELETE emits per-cell delete for each populated DB field', () => {
    const result = diff([amazonRow('GALE-M', 'DELETE', {})])
    // price@IT has DB value (189.9 via master) → delete
    const priceDelete = findChange(result, 'price@IT')
    expect(priceDelete).toBeDefined()
    expect(priceDelete!.kind).toBe('delete')
    expect(String(priceDelete!.from)).toBe('189.9')
    expect(priceDelete!.to).toBe('')
    expect(result.stats.deletes).toBeGreaterThan(0)
  })

  it('action=DELETE carries sku, channel, market on each delete record', () => {
    const result = diff([amazonRow('GALE-M', 'DELETE', {})])
    const priceDelete = findChange(result, 'price@IT')
    expect(priceDelete!.sku).toBe('GALE-M')
    expect(priceDelete!.channel).toBe('AMAZON')
    expect(priceDelete!.market).toBe('IT')
  })

  it('__CLEAR__ on non-empty field → delete', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '__CLEAR__' })])
    const change = findChange(result, 'price@IT')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('delete')
    expect(change!.to).toBe('')
    expect(change!.note).toBe('__CLEAR__')
    expect(result.stats.deletes).toBe(1)
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

  it('adds, updates, deletes, conflicts, outOfScope sum correctly', () => {
    const result = diff(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9', 'price@DE': '155.0' })],
      [],
      { fingerprints: { 'Amazon|GALE-M': 'stale' } },
    )
    // price@IT → conflict (stale fingerprint + file change)
    // price@DE → out-of-scope
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
})

// ── Suite 8: masterChanges bucket ────────────────────────────────────────────

describe('computeDiff — masterChanges bucket', () => {
  it('Products-sheet change goes to masterChanges, not changes', () => {
    const wb = makeWb([], [productsRow('GALE-M', '', { brand: 'NewBrand' })])
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, {})
    expect(result.masterChanges.length).toBeGreaterThan(0)
    const brandChange = result.masterChanges.find(c => c.column === 'brand')
    expect(brandChange).toBeDefined()
    // Must NOT be in changes
    expect(result.changes.find(c => c.column === 'brand')).toBeUndefined()
  })

  it('Amazon-sheet change goes to changes, not masterChanges', () => {
    const result = diff([amazonRow('GALE-M', '', { 'price@IT': '199.9' })])
    const priceChange = result.changes.find(c => c.column === 'price@IT')
    expect(priceChange).toBeDefined()
    expect(result.masterChanges.find(c => c.column === 'price@IT')).toBeUndefined()
  })

  it('stats count masterChanges AND changes together', () => {
    const wb = makeWb(
      [amazonRow('GALE-M', '', { 'price@IT': '199.9' })],
      [productsRow('GALE-M', '', { brand: 'NewBrand' })],
    )
    const scope = { channel: 'AMAZON' as const, markets: ['IT'] as string[], includeMaster: true }
    const scoped = classifyColumns(wb, scope)
    const result = computeDiff(wb, scoped, CURRENT, {})
    // price@IT update + brand update = 2 updates
    expect(result.stats.updates).toBe(2)
  })
})

// ── Suite 9: actionRows ────────────────────────────────────────────────────────

describe('computeDiff — actionRows', () => {
  it('records sku and action for each data row processed', () => {
    const result = diff([
      amazonRow('GALE-M', 'ADD', { 'price@IT': '199.9' }),
    ])
    const entry = result.actionRows.find(r => r.sku === 'GALE-M')
    expect(entry).toBeDefined()
    expect(entry!.action).toBe('ADD')
  })

  it('multiple rows → multiple actionRow entries', () => {
    const result = diff([
      amazonRow('GALE-M', '', { 'price@IT': '199.9' }),
      amazonRow('GALE-L', 'ADD', { 'price@IT': '199.9' }),
    ])
    expect(result.actionRows.length).toBe(2)
    expect(result.actionRows.map(r => r.sku)).toContain('GALE-M')
    expect(result.actionRows.map(r => r.sku)).toContain('GALE-L')
  })

  it('IGNORE row is in actionRows but produces zero changes', () => {
    const result = diff([amazonRow('GALE-M', 'IGNORE', { 'price@IT': '199.9' })])
    const entry = result.actionRows.find(r => r.sku === 'GALE-M')
    expect(entry!.action).toBe('IGNORE')
    // No changes emitted for IGNORE rows
    expect(result.changes).toHaveLength(0)
    expect(result.stats.updates).toBe(0)
  })
})

// ── Suite 10: Round-trip identity ─────────────────────────────────────────────

describe('computeDiff — round-trip identity (unit-level)', () => {
  it('untouched file values matching DB → zero changes, zero stats', () => {
    // All cells either blank or matching current effective DB values
    // price@IT effective = '189.9'; title@IT effective = 'GALE Jacket Medium'
    // follows_master@IT = 'true'; fulfillment@IT = 'FBA'
    const result = diff([
      amazonRow('GALE-M', '', {
        'price@IT': '189.9',
        'price_follows_master@IT': 'true',
        'title@IT': 'GALE Jacket Medium',
        'fulfillment@IT': 'FBA',
        // price@DE left blank (out-of-scope + blank = skip)
      }),
    ])
    expect(result.changes).toHaveLength(0)
    expect(result.masterChanges).toHaveLength(0)
    expect(result.stats).toEqual({ adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 })
  })

  it('round-trip with all blank row → zero changes', () => {
    const result = diff([amazonRow('GALE-M', '', {})])
    expect(result.changes).toHaveLength(0)
    expect(result.masterChanges).toHaveLength(0)
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
    expect(result.stats).toEqual({ adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 })
  })

  it('IGNORE row with out-of-scope column → still no changes (IGNORE wins)', () => {
    const result = diff([
      amazonRow('GALE-M', 'IGNORE', { 'price@DE': '155.0' }),
    ])
    expect(result.stats.outOfScope).toBe(0)
  })
})
