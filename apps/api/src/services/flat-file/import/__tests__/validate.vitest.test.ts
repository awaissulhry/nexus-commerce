/**
 * FF2.2 — validateWorkbook TDD tests.
 *
 * Written BEFORE the implementation (TDD).
 * All fixtures are hand-built ParsedWorkbook objects — no real xlsx needed.
 *
 * Headers in import files use field IDs (e.g. 'sku', 'status', 'title@IT'),
 * not the human-readable labels used in the exported workbook. Special headers
 * are 'Action', 'sku', and '<base>_follows_master@<MKT>' controls.
 */

import { describe, it, expect } from 'vitest'
import { validateWorkbook } from '../validate.js'
import type { ParsedWorkbook, ParsedRow } from '../parse.js'

// ── Fixture builder ───────────────────────────────────────────────────────────

/**
 * Build a minimal ParsedWorkbook from an array of plain row objects.
 * Each object's key is the column header (field ID or special header).
 * All values are strings (matching normalized ParsedCell output).
 */
function makeWorkbook(
  sheetName: string,
  rows: Array<Record<string, string>>,
): ParsedWorkbook {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : []
  const parsedRows: ParsedRow[] = rows.map((r, idx) => ({
    sheet: sheetName,
    rowNumber: idx + 2, // row 1 = header; data starts at 2
    cells: Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, { raw: v, value: v }])
    ),
  }))
  return {
    sheets: {
      [sheetName]: { headers, rows: parsedRows },
    },
    meta: {},
    parseWarnings: [],
  }
}

// ── Suite 1: sku validation ───────────────────────────────────────────────────

describe('validateWorkbook — sku validation', () => {
  it('blank sku on ADD row → error "missing sku"', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: '' }])
    const issues = validateWorkbook(wb)
    const skuErr = issues.find(i => i.column === 'sku' && i.level === 'error')
    expect(skuErr).toBeDefined()
    expect(skuErr!.message).toContain('missing sku')
  })

  it('blank sku on update row (Action:"") → no sku error', () => {
    // Blank = no-change; on an update row sku is not required
    const wb = makeWorkbook('Products', [{ Action: '', sku: '' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'sku' && i.level === 'error')).toHaveLength(0)
  })

  it('non-blank sku on ADD → no sku error', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'XYZ-001' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'sku')).toHaveLength(0)
  })
})

// ── Suite 2: Action column validation ────────────────────────────────────────

describe('validateWorkbook — Action column', () => {
  it('Action = "FROB" → error "invalid Action"', () => {
    const wb = makeWorkbook('Products', [{ Action: 'FROB', sku: 'X' }])
    const issues = validateWorkbook(wb)
    const actionErr = issues.find(i => i.column === 'Action' && i.level === 'error')
    expect(actionErr).toBeDefined()
    expect(actionErr!.message).toContain('invalid Action')
  })

  it('Action = "ADD" → no Action error', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'Action')).toHaveLength(0)
  })

  it('Action = "" (blank) → no Action error', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'Action')).toHaveLength(0)
  })

  it('Action = "DELETE" → no Action error', () => {
    const wb = makeWorkbook('Products', [{ Action: 'DELETE', sku: 'X' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'Action')).toHaveLength(0)
  })

  it('Action = "IGNORE" → no Action error', () => {
    const wb = makeWorkbook('Products', [{ Action: 'IGNORE', sku: 'X' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'Action')).toHaveLength(0)
  })
})

// ── Suite 3: Enum validation ──────────────────────────────────────────────────

describe('validateWorkbook — enum validation', () => {
  it('strict-enum "status" = "BOGUS" → error "not an allowed value"', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X', status: 'BOGUS' }])
    const issues = validateWorkbook(wb)
    const err = issues.find(i => i.column === 'status' && i.level === 'error')
    expect(err).toBeDefined()
    expect(err!.message).toContain('not an allowed value')
  })

  it('strict-enum "status" = "ACTIVE" → no enum issue', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X', status: 'ACTIVE' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'status')).toHaveLength(0)
  })

  it('open-enum "review_status" with unlisted value → warn (not error)', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X', review_status: 'NEEDS_APPROVAL' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'review_status' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('not a listed value')
    // Must NOT be an error
    expect(issues.find(i => i.column === 'review_status' && i.level === 'error')).toBeUndefined()
  })

  it('open-enum "review_status" with listed value → no issue', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X', review_status: 'APPROVED' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'review_status')).toHaveLength(0)
  })

  it('strict-enum on channel field pricing_rule@IT = "BOGUS" → error', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'pricing_rule@IT': 'BOGUS' }])
    const issues = validateWorkbook(wb)
    const err = issues.find(i => i.column === 'pricing_rule@IT' && i.level === 'error')
    expect(err).toBeDefined()
  })
})

// ── Suite 4: maxUtf8ByteLength ────────────────────────────────────────────────

describe('validateWorkbook — UTF-8 byte length', () => {
  it('title@IT over maxUtf8ByteLength → error containing "UTF-8 bytes"', () => {
    // 'à' = U+00E0 → 2 UTF-8 bytes. 101 repetitions = 202 bytes > 200-byte limit.
    const longTitle = 'à'.repeat(101)
    expect(new TextEncoder().encode(longTitle).length).toBe(202)

    const wb = makeWorkbook('Amazon', [{ Action: 'ADD', sku: 'X', 'title@IT': longTitle }])
    const issues = validateWorkbook(wb)
    const err = issues.find(i => i.column === 'title@IT' && i.level === 'error')
    expect(err).toBeDefined()
    expect(err!.message).toContain('UTF-8 bytes')
  })

  it('title@IT within maxUtf8ByteLength → no byte-length error', () => {
    // 99 ASCII chars = 99 bytes, well under 200
    const shortTitle = 'a'.repeat(99)
    const wb = makeWorkbook('Amazon', [{ Action: 'ADD', sku: 'X', 'title@IT': shortTitle }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'title@IT' && i.level === 'error')).toHaveLength(0)
  })

  it('title@DE exactly at maxUtf8ByteLength (200 ASCII chars = 200 bytes) → no error', () => {
    const atLimit = 'x'.repeat(200) // 200 bytes exactly
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'Y', 'title@DE': atLimit }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'title@DE' && i.level === 'error')).toHaveLength(0)
  })
})

// ── Suite 5: Readonly columns ─────────────────────────────────────────────────

describe('validateWorkbook — readonly columns', () => {
  it('buybox_price (READONLY_SYNCED) with non-blank value → warn "readonly"', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X', buybox_price: '99.99' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'buybox_price' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('readonly')
  })

  it('buybox_price with blank value → no issue (blank = no-change, not a write)', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X', buybox_price: '' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'buybox_price')).toHaveLength(0)
  })

  it('status@IT (ChannelListing READONLY_SYNCED) with value → warn "readonly"', () => {
    // Note: 'status' resolves to CHANNEL_MARKET_FIELDS status (READONLY_SYNCED),
    // NOT the MASTER_FIELDS status (EDITABLE), because it carries @IT suffix.
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'status@IT': 'ACTIVE' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'status@IT' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('readonly')
  })

  it('wac_cents (DERIVED) with value → warn "readonly"', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X', wac_cents: '5000' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'wac_cents' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('readonly')
  })
})

// ── Suite 6: Unknown columns ──────────────────────────────────────────────────

describe('validateWorkbook — unknown columns', () => {
  it('unknown header "wat" → warn "unknown column"', () => {
    const wb = makeWorkbook('Products', [{ Action: 'ADD', sku: 'X', wat: 'anything' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'wat' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('unknown column')
    expect(warn!.message).toContain("'wat'")
  })

  it('unknown @MKT header "foo@IT" → warn "unknown column"', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'foo@IT': 'bar' }])
    const issues = validateWorkbook(wb)
    const warn = issues.find(i => i.column === 'foo@IT' && i.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('unknown column')
  })
})

// ── Suite 7: follows_master control columns ───────────────────────────────────

describe('validateWorkbook — follows_master control columns', () => {
  it('price_follows_master@IT = "true" → no issue', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'price_follows_master@IT': 'true' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'price_follows_master@IT')).toHaveLength(0)
  })

  it('price_follows_master@IT = "false" → no issue', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'price_follows_master@IT': 'false' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'price_follows_master@IT')).toHaveLength(0)
  })

  it('price_follows_master@IT = "" (blank) → no issue', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'price_follows_master@IT': '' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'price_follows_master@IT')).toHaveLength(0)
  })

  it('price_follows_master@IT = "maybe" → error', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'price_follows_master@IT': 'maybe' }])
    const issues = validateWorkbook(wb)
    const err = issues.find(i => i.column === 'price_follows_master@IT' && i.level === 'error')
    expect(err).toBeDefined()
  })
})

// ── Suite 8: blank / __CLEAR__ skip further validation ───────────────────────

describe('validateWorkbook — blank and __CLEAR__ semantics', () => {
  it('blank strict-enum status → no issue (blank = no-change)', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X', status: '' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'status')).toHaveLength(0)
  })

  it('__CLEAR__ on strict-enum status → no enum error (explicit clear)', () => {
    const wb = makeWorkbook('Products', [{ Action: '', sku: 'X', status: '__CLEAR__' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'status')).toHaveLength(0)
  })

  it('__CLEAR__ on a byte-length-checked field → no byte error', () => {
    const wb = makeWorkbook('Amazon', [{ Action: '', sku: 'X', 'title@IT': '__CLEAR__' }])
    const issues = validateWorkbook(wb)
    expect(issues.filter(i => i.column === 'title@IT' && i.level === 'error')).toHaveLength(0)
  })
})

// ── Suite 9: Clean row ────────────────────────────────────────────────────────

describe('validateWorkbook — clean row', () => {
  it('a valid Products row with known fields and valid values → zero issues', () => {
    const wb = makeWorkbook('Products', [
      {
        Action: 'ADD',
        sku: 'XYZ-001',
        status: 'ACTIVE',
        fulfillment_method: 'FBA',
        name: 'Test Product',
      },
    ])
    const issues = validateWorkbook(wb)
    expect(issues).toHaveLength(0)
  })

  it('a valid channel row with @MKT fields → zero issues', () => {
    const wb = makeWorkbook('Amazon', [
      {
        Action: '',
        sku: 'XYZ-001',
        'title@IT': 'Prodotto di Test',
        'price@IT': '99.99',
        'price_follows_master@IT': 'false',
      },
    ])
    const issues = validateWorkbook(wb)
    expect(issues).toHaveLength(0)
  })
})

// ── Suite 10: Multi-sheet workbooks ──────────────────────────────────────────

describe('validateWorkbook — multi-sheet', () => {
  it('issues are attributed to the correct sheet and row', () => {
    const wb: ParsedWorkbook = {
      sheets: {
        Products: {
          headers: ['Action', 'sku', 'status'],
          rows: [
            {
              sheet: 'Products',
              rowNumber: 2,
              cells: {
                Action: { raw: 'ADD', value: 'ADD' },
                sku: { raw: 'P1', value: 'P1' },
                status: { raw: 'BOGUS', value: 'BOGUS' },
              },
            },
          ],
        },
        Amazon: {
          headers: ['Action', 'sku', 'wat@IT'],
          rows: [
            {
              sheet: 'Amazon',
              rowNumber: 2,
              cells: {
                Action: { raw: '', value: '' },
                sku: { raw: 'P1', value: 'P1' },
                'wat@IT': { raw: 'ignored', value: 'ignored' },
              },
            },
          ],
        },
      },
      meta: {},
      parseWarnings: [],
    }

    const issues = validateWorkbook(wb)

    const prodIssue = issues.find(i => i.sheet === 'Products' && i.column === 'status')
    expect(prodIssue).toBeDefined()
    expect(prodIssue!.rowNumber).toBe(2)
    expect(prodIssue!.level).toBe('error')

    const amazonIssue = issues.find(i => i.sheet === 'Amazon' && i.column === 'wat@IT')
    expect(amazonIssue).toBeDefined()
    expect(amazonIssue!.rowNumber).toBe(2)
    expect(amazonIssue!.level).toBe('warn')
  })
})
