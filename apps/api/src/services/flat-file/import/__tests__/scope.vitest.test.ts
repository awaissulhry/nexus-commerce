/**
 * FF2.3 — Scope resolver TDD tests.
 *
 * Written BEFORE the implementation. Tests cover:
 *   1. defaultScope returns the correct single-market shape.
 *   2. classifyColumns: control columns always in scope.
 *   3. classifyColumns: Products (master) sheet — isMaster, inScope tied to includeMaster.
 *   4. classifyColumns: Amazon channel columns — market-gated inScope.
 *   5. classifyColumns: wrong-channel sheet → all inScope=false.
 *   6. classifyColumns: markets:'ALL' → every market in scope.
 *   7. classifyColumns: base parsing for _follows_master columns.
 *
 * Fixture (hand-built — no xlsx I/O; only .sheets with .headers required):
 *   Products → Action, sku, brand, ean
 *   Amazon   → Action, sku, price@IT, price_follows_master@IT, price@DE, status@IT
 *   eBay     → Action, sku, price@IT
 */

import { describe, it, expect } from 'vitest'
import type { ParsedWorkbook } from '../parse.js'
import { defaultScope, classifyColumns } from '../scope.js'
import type { ImportScope } from '../scope.js'

// ── Fixture ────────────────────────────────────────────────────────────────────

const FIXTURE: ParsedWorkbook = {
  sheets: {
    Products: {
      headers: ['Action', 'sku', 'brand', 'ean'],
      rows: [],
    },
    Amazon: {
      headers: ['Action', 'sku', 'price@IT', 'price_follows_master@IT', 'price@DE', 'status@IT'],
      rows: [],
    },
    eBay: {
      headers: ['Action', 'sku', 'price@IT'],
      rows: [],
    },
  },
  meta: {},
  parseWarnings: [],
}

// Scope under test in most cases
const SCOPE_AMAZON_IT: ImportScope = defaultScope({ channel: 'AMAZON', market: 'IT' })

// Helper: find a ScopedColumn by sheet + column name
function find(cols: ReturnType<typeof classifyColumns>, sheet: string, column: string) {
  return cols.find(c => c.sheet === sheet && c.column === column)
}

// ── Suite 1: defaultScope ─────────────────────────────────────────────────────

describe('defaultScope', () => {
  it('returns channel, single-element markets array, and includeMaster:false', () => {
    const scope = defaultScope({ channel: 'AMAZON', market: 'IT' })
    expect(scope).toEqual({ channel: 'AMAZON', markets: ['IT'], includeMaster: false })
  })

  it('reflects the provided channel and market verbatim', () => {
    const scope = defaultScope({ channel: 'EBAY', market: 'DE' })
    expect(scope.channel).toBe('EBAY')
    expect(scope.markets).toEqual(['DE'])
    expect(scope.includeMaster).toBe(false)
  })
})

// ── Suite 2: Control columns ──────────────────────────────────────────────────

describe('classifyColumns — control columns', () => {
  it('Action on Amazon sheet → isControl=true, inScope=true', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'Action')
    expect(col).toBeDefined()
    expect(col!.isControl).toBe(true)
    expect(col!.inScope).toBe(true)
    expect(col!.isMaster).toBe(false)
  })

  it('sku on Amazon sheet → isControl=true, inScope=true', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'sku')
    expect(col!.isControl).toBe(true)
    expect(col!.inScope).toBe(true)
  })

  it('Action on eBay sheet → isControl=true, inScope=true (never blocked by scope)', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'eBay', 'Action')
    expect(col!.isControl).toBe(true)
    expect(col!.inScope).toBe(true)
  })

  it('sku on Products sheet → isControl=true, inScope=true', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Products', 'sku')
    expect(col!.isControl).toBe(true)
    expect(col!.inScope).toBe(true)
    // control overrides isMaster even on Products sheet
    expect(col!.isMaster).toBe(false)
  })

  it('control columns carry base=column and market=undefined', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'Action')
    expect(col!.base).toBe('Action')
    expect(col!.market).toBeUndefined()
  })
})

// ── Suite 3: Products (master) sheet ─────────────────────────────────────────

describe('classifyColumns — Products (master) sheet', () => {
  it('brand is isMaster=true, inScope=false when includeMaster=false', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Products', 'brand')
    expect(col!.isMaster).toBe(true)
    expect(col!.inScope).toBe(false)
    expect(col!.isControl).toBe(false)
    expect(col!.market).toBeUndefined()
    expect(col!.base).toBe('brand')
  })

  it('ean is isMaster=true, inScope=false when includeMaster=false', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Products', 'ean')
    expect(col!.isMaster).toBe(true)
    expect(col!.inScope).toBe(false)
  })

  it('brand becomes inScope=true when includeMaster:true', () => {
    const scope: ImportScope = { channel: 'AMAZON', markets: ['IT'], includeMaster: true }
    const cols = classifyColumns(FIXTURE, scope)
    const col = find(cols, 'Products', 'brand')
    expect(col!.isMaster).toBe(true)
    expect(col!.inScope).toBe(true)
  })
})

// ── Suite 4: Amazon channel — market-gated inScope ────────────────────────────

describe('classifyColumns — Amazon channel columns', () => {
  it('price@IT is inScope=true (market matches scope)', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'price@IT')
    expect(col!.inScope).toBe(true)
    expect(col!.base).toBe('price')
    expect(col!.market).toBe('IT')
    expect(col!.isMaster).toBe(false)
    expect(col!.isControl).toBe(false)
  })

  it('price@DE is inScope=false (market out of scope)', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'price@DE')
    expect(col!.inScope).toBe(false)
    expect(col!.base).toBe('price')
    expect(col!.market).toBe('DE')
  })

  it('price_follows_master@IT → base=price, market=IT, inScope=true', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'price_follows_master@IT')
    expect(col!.base).toBe('price')
    expect(col!.market).toBe('IT')
    expect(col!.inScope).toBe(true)
    expect(col!.isMaster).toBe(false)
    expect(col!.isControl).toBe(false)
  })

  it('status@IT is inScope=true (AMAZON scope, market IT)', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'status@IT')
    expect(col!.inScope).toBe(true)
    expect(col!.base).toBe('status')
    expect(col!.market).toBe('IT')
  })
})

// ── Suite 5: Wrong-channel sheet ──────────────────────────────────────────────

describe('classifyColumns — eBay sheet with AMAZON scope', () => {
  it('eBay price@IT is inScope=false (wrong channel)', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'eBay', 'price@IT')
    expect(col!.inScope).toBe(false)
    // base + market are still parsed correctly
    expect(col!.base).toBe('price')
    expect(col!.market).toBe('IT')
    expect(col!.isMaster).toBe(false)
    expect(col!.isControl).toBe(false)
  })
})

// ── Suite 6: markets:'ALL' ────────────────────────────────────────────────────

describe('classifyColumns — markets:ALL', () => {
  it('price@DE becomes inScope=true when markets is ALL', () => {
    const scope: ImportScope = { channel: 'AMAZON', markets: 'ALL', includeMaster: false }
    const cols = classifyColumns(FIXTURE, scope)
    const col = find(cols, 'Amazon', 'price@DE')
    expect(col!.inScope).toBe(true)
  })

  it('price@IT also inScope=true when markets is ALL', () => {
    const scope: ImportScope = { channel: 'AMAZON', markets: 'ALL', includeMaster: false }
    const cols = classifyColumns(FIXTURE, scope)
    const col = find(cols, 'Amazon', 'price@IT')
    expect(col!.inScope).toBe(true)
  })

  it('eBay price@IT still inScope=false even when markets is ALL (wrong channel)', () => {
    const scope: ImportScope = { channel: 'AMAZON', markets: 'ALL', includeMaster: false }
    const cols = classifyColumns(FIXTURE, scope)
    const col = find(cols, 'eBay', 'price@IT')
    expect(col!.inScope).toBe(false)
  })
})

// ── Suite 7: Base parsing edge cases ─────────────────────────────────────────

describe('classifyColumns — base parsing', () => {
  it('price_follows_master@IT strips _follows_master suffix to yield base=price', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'price_follows_master@IT')
    expect(col!.base).toBe('price')
    expect(col!.market).toBe('IT')
  })

  it('price@IT does not strip anything — base=price', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const col = find(cols, 'Amazon', 'price@IT')
    expect(col!.base).toBe('price')
  })

  it('every column in the fixture produces exactly one ScopedColumn entry', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    // Fixture total: Products(4) + Amazon(6) + eBay(3) = 13
    expect(cols.length).toBe(13)
  })

  it('each ScopedColumn carries the correct sheet name', () => {
    const cols = classifyColumns(FIXTURE, SCOPE_AMAZON_IT)
    const amazonCols = cols.filter(c => c.sheet === 'Amazon')
    expect(amazonCols.length).toBe(6)
    const ebayCols = cols.filter(c => c.sheet === 'eBay')
    expect(ebayCols.length).toBe(3)
    const productsCols = cols.filter(c => c.sheet === 'Products')
    expect(productsCols.length).toBe(4)
  })
})
