/**
 * D2 + Phase 6 invariant #1.
 *
 * The unit tests below check the mappings behave. The INVARIANT at the bottom
 * is the one that matters: it makes the whole bug class unrepeatable, which is
 * why it was pulled forward from Phase 6 rather than written after the fix.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIELD_MAP, FIELDS_BY_KIND, applyFields, NON_WRITABLE_REASONS } from './field-map.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('applyFields — campaign', () => {
  it('writes the three columns that used to be silently dropped', () => {
    const patch: Record<string, unknown> = {}
    const err = applyFields('campaign', patch, (c) =>
      ({ 'Campaign name': 'Summer Sale', 'Portfolio ID': 'pf_1', 'Daily budget': '25,50' }[c] ?? null))
    expect(err).toBeNull()
    expect(patch.name).toBe('Summer Sale')
    expect(patch.portfolioId).toBe('pf_1')
    expect(patch.dailyBudget).toBe(25.5) // it-IT decimal comma
  })

  it('an empty Portfolio ID detaches rather than erroring', () => {
    const patch: Record<string, unknown> = {}
    expect(applyFields('campaign', patch, (c) => (c === 'Portfolio ID' ? '' : null))).toBeNull()
    expect(patch.portfolioId).toBeNull()
  })

  it('a blank name is refused — it would erase the campaign name', () => {
    const patch: Record<string, unknown> = {}
    expect(applyFields('campaign', patch, (c) => (c === 'Campaign name' ? '   ' : null))).toMatch(/cannot be blank/)
  })

  it('an unwritable bidding strategy fails the row rather than silently skipping', () => {
    const patch: Record<string, unknown> = {}
    expect(applyFields('campaign', patch, (c) => (c === 'Bidding strategy' ? 'Telepathy' : null)))
      .toMatch(/is not one we can write/)
  })

  it('columns absent from the row are left untouched', () => {
    const patch: Record<string, unknown> = {}
    expect(applyFields('campaign', patch, () => null)).toBeNull()
    expect(Object.keys(patch)).toEqual([])
  })

  it('state maps through, case-insensitively', () => {
    const patch: Record<string, unknown> = {}
    applyFields('campaign', patch, (c) => (c === 'State' ? 'Paused' : null))
    expect(patch.status).toBe('PAUSED')
  })
})

describe('applyFields — ad group and target', () => {
  it('ad group name and default bid both write', () => {
    const patch: Record<string, unknown> = {}
    applyFields('adGroup', patch, (c) => ({ 'Ad group name': 'AG 1', 'Ad Group Default Bid': '1,25' }[c] ?? null))
    expect(patch.name).toBe('AG 1')
    expect(patch.defaultBidCents).toBe(125)
  })
  it('an ambiguous money value fails rather than defaulting', () => {
    const patch: Record<string, unknown> = {}
    // "1,234" is 1.234 in it-IT and 1234 in en-US — parseMoney refuses it.
    expect(applyFields('adTarget', patch, (c) => (c === 'Bid' ? '1,234' : null))).toMatch(/Bid:/)
  })
})

// ── THE INVARIANT ─────────────────────────────────────────────────────────
describe('Phase 6 invariant #1 — preview cannot promise what apply drops', () => {
  it('preview derives its field lists from the apply map, not its own copy', () => {
    const src = readFileSync(join(here, 'preview.ts'), 'utf8')
    // The literal arrays are what drifted. They must not come back.
    expect(src).toMatch(/CAMPAIGN_FIELDS\s*=\s*FIELDS_BY_KIND\.campaign/)
    expect(src).toMatch(/ADGROUP_FIELDS\s*=\s*FIELDS_BY_KIND\.adGroup/)
    expect(src).toMatch(/TARGET_FIELDS\s*=\s*FIELDS_BY_KIND\.adTarget/)
    expect(src).not.toMatch(/const CAMPAIGN_FIELDS\s*=\s*\[/)
    expect(src).not.toMatch(/const ADGROUP_FIELDS\s*=\s*\[/)
    expect(src).not.toMatch(/const TARGET_FIELDS\s*=\s*\[/)
  })

  it('every previewable field has an apply mapping', () => {
    for (const kind of ['campaign', 'adGroup', 'adTarget'] as const) {
      const mapped = new Set(FIELD_MAP[kind].map((f) => f.column))
      for (const col of FIELDS_BY_KIND[kind]) {
        expect(mapped.has(col), `${kind}.${col} is previewable with no apply mapping`).toBe(true)
      }
    }
  })

  it('every apply mapping actually mutates the patch — no silent no-ops', () => {
    // A mapping that parses and then forgets to assign would satisfy the list
    // check while still losing the edit, which is the original bug wearing a
    // different hat.
    const sample: Record<string, string> = {
      State: 'enabled', 'Daily budget': '10', 'Campaign name': 'X', 'Portfolio ID': 'p',
      'Bidding strategy': 'Fixed bid', 'Ad group name': 'G', 'Ad Group Default Bid': '1', Bid: '1',
    }
    for (const kind of ['campaign', 'adGroup', 'adTarget'] as const) {
      for (const f of FIELD_MAP[kind]) {
        const patch: Record<string, unknown> = {}
        const err = f.apply(patch, sample[f.column] ?? 'enabled')
        expect(err, `${kind}.${f.column} errored on a valid value: ${err}`).toBeNull()
        expect(Object.keys(patch).length, `${kind}.${f.column} parsed but wrote nothing`).toBeGreaterThan(0)
      }
    }
  })

  it('immutable Amazon fields are documented as non-writable, not quietly absent', () => {
    expect(NON_WRITABLE_REASONS['Keyword text']).toMatch(/Immutable on Amazon/)
    expect(NON_WRITABLE_REASONS['Match type']).toMatch(/archive \+ create/)
    for (const kind of ['campaign', 'adGroup', 'adTarget'] as const) {
      const cols = FIELDS_BY_KIND[kind]
      expect(cols).not.toContain('Keyword text')
      expect(cols).not.toContain('Match type')
    }
  })
})

describe('AX-IE.2 — portfolio fields', () => {
  it('maps every writable portfolio column Amazon actually offers', () => {
    const patch: Record<string, unknown> = {}
    const err = applyFields('portfolio', patch, (c) => ({
      'Portfolio name': 'Moto Core',
      'Budget amount': '250.00',
      'Budget currency code': 'EUR',
      'Budget policy': 'dateRange',
      'Budget start date': '2026-08-01',
      'Budget end date': '2026-08-31',
    }[c]))
    expect(err).toBeNull()
    expect(patch).toEqual({
      name: 'Moto Core',
      budgetAmount: 250,
      budgetCurrencyCode: 'EUR',
      budgetPolicy: 'dateRange',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })
  })

  it('does NOT offer State — Amazon marks it informational only', () => {
    // Offering it would invite an edit that can never apply. Amazon's own
    // Portfolios sheet labels the column "State (Informational only)".
    expect(FIELDS_BY_KIND.portfolio).not.toContain('State')
    expect(FIELDS_BY_KIND.portfolio).not.toContain('State (Informational only)')
    expect(FIELDS_BY_KIND.portfolio).not.toContain('In Budget (Informational only)')
  })

  it('uses Amazon’s header names, not the ones we invented', () => {
    // The old sheet said "Budget currency" / "Start date"; Amazon says
    // "Budget currency code" / "Budget start date". A mismatch here means the
    // column silently never resolves on import.
    expect(FIELDS_BY_KIND.portfolio).toContain('Budget currency code')
    expect(FIELDS_BY_KIND.portfolio).toContain('Budget start date')
    expect(FIELDS_BY_KIND.portfolio).not.toContain('Budget currency')
    expect(FIELDS_BY_KIND.portfolio).not.toContain('Start date')
  })
})
