/**
 * AX-IE.2 — bulksheet schema tests.
 *
 * These cover the cases that were live corruption bugs before AX-IE.0, so they are
 * regression tests with teeth: every one of them used to "pass" by producing a
 * plausible wrong value instead of an error.
 */
import { describe, it, expect } from 'vitest'
import {
  COLUMNS, HEADERS, NUM_FMT, VOCABULARIES,
  resolveColumn, normHeader, normEnum, parseVocabulary,
  parseMoney, parseBid, parsePercent, parseDate,
  validateRow, entityRule, buildDictionaryRows, DICTIONARY_HEADERS,
  AMAZON_BID_FLOOR_EUR,
  buildRowKey, computeBaseline, baselineConflicts,
} from '@nexus/shared/ads-bulksheet'

/** Build a `get` accessor over a plain row object, as callers do. */
const rowGet = (r: Record<string, string>) => (h: string) => r[h] ?? ''

describe('columns', () => {
  it('starts with Amazon\'s structural invariant Product/Entity/Operation', () => {
    expect(HEADERS.slice(0, 3)).toEqual(['Product', 'Entity', 'Operation'])
  })

  it('has no duplicate headers', () => {
    expect(new Set(HEADERS).size).toBe(HEADERS.length)
  })

  it('pins every identity column to a text format so ids cannot become floats', () => {
    // The defence against a 19-digit Amazon id being re-read as a float64.
    for (const h of ['Campaign ID', 'Ad group ID', 'Keyword ID', 'SKU', 'ASIN']) {
      const c = resolveColumn(h)!
      expect(c.type, h).toBe('id')
      expect(NUM_FMT[c.type], h).toBe('@')
    }
  })

  it('types money columns as money, not text — the bug that caused silent €0.50 bids', () => {
    for (const h of ['Bid', 'Daily budget', 'Ad Group Default Bid']) {
      expect(resolveColumn(h)!.type, h).toBe('money')
    }
    expect(NUM_FMT.money).toBe('#,##0.00')
  })

  it('marks Targeting type read-only — it is observed from Amazon, never authored', () => {
    expect(resolveColumn('Targeting type')!.editable).toBe(false)
  })
})

describe('header resolution', () => {
  it('matches by name regardless of case and spacing, never by position', () => {
    expect(resolveColumn('campaign id')?.header).toBe('Campaign ID')
    expect(resolveColumn('  Campaign_ID ')?.header).toBe('Campaign ID')
    expect(normHeader('Ad Group Name')).toBe('adgroupname')
  })

  it('accepts documented aliases', () => {
    expect(resolveColumn('Budget')?.header).toBe('Daily budget')
    expect(resolveColumn('Targeting expression')?.header).toBe('Product targeting expression')
    expect(resolveColumn('Targeting ID')?.header).toBe('Product Targeting ID')
  })

  it('returns null for an unknown column rather than guessing', () => {
    expect(resolveColumn('My scratch column')).toBeNull()
  })
})

describe('vocabularies', () => {
  it('accepts canonical, cased, and it-IT match types', () => {
    expect(parseVocabulary('matchType', 'BROAD')).toBe('Broad')
    expect(parseVocabulary('matchType', 'broad')).toBe('Broad')
    expect(parseVocabulary('matchType', 'Generica')).toBe('Broad')
    expect(parseVocabulary('matchType', 'Esatta')).toBe('Exact')
    expect(parseVocabulary('matchType', 'negative_exact')).toBe('Negative exact')
  })

  it('REJECTS an unrecognised match type instead of collapsing it to Exact', () => {
    // The original bug: anything unknown became EXACT. Match type is immutable on
    // Amazon, so that silently bought an archive+recreate and lost all history.
    expect(parseVocabulary('matchType', 'Exakt')).toBeNull()
    expect(parseVocabulary('matchType', 'phrase-ish')).toBeNull()
    expect(parseVocabulary('matchType', '')).toBeNull()
  })

  it('normalises separators consistently', () => {
    expect(normEnum('Ad group')).toBe('ADGROUP')
    expect(normEnum('Top of search (page 1)')).toBe('TOPOFSEARCHPAGE1')
  })

  it('round-trips every value it emits', () => {
    for (const [name, v] of Object.entries(VOCABULARIES)) {
      for (const val of v.values) {
        expect(parseVocabulary(name as keyof typeof VOCABULARIES, val), `${name}:${val}`).toBe(val)
      }
    }
  })
})

describe('money parsing', () => {
  it('parses plain and it-IT decimals to the same number', () => {
    expect(parseMoney('1.25')).toEqual({ value: 1.25 })
    expect(parseMoney('1,25')).toEqual({ value: 1.25 })
    expect(parseMoney('20,00')).toEqual({ value: 20 })
    expect(parseMoney('€ 4,79')).toEqual({ value: 4.79 })
  })

  it('parses both thousands conventions', () => {
    expect(parseMoney('1.234,56')).toEqual({ value: 1234.56 })
    expect(parseMoney('1,234.56')).toEqual({ value: 1234.56 })
  })

  it('REJECTS the genuinely ambiguous 1,234 rather than guessing', () => {
    const r = parseMoney('1,234')
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain('ambiguous')
      expect(r.error).toContain('1.234')
      expect(r.error).toContain('1234')
    }
  })

  it('REJECTS unparseable input instead of defaulting — the €0.50 bug', () => {
    expect('error' in parseMoney('abc')).toBe(true)
    expect('error' in parseMoney('')).toBe(true)
    const bid = parseBid('abc')
    expect('error' in bid).toBe(true)
    if ('error' in bid) expect(bid.error).not.toContain('0.5')
  })

  it('enforces the Amazon bid floor', () => {
    expect(parseBid('0.02')).toEqual({ value: AMAZON_BID_FLOOR_EUR })
    const low = parseBid('0,01')
    expect('error' in low).toBe(true)
    if ('error' in low) expect(low.error).toContain('floor')
  })
})

describe('percent and date parsing', () => {
  it('accepts placement percentages in range and rejects outside it', () => {
    expect(parsePercent('50')).toEqual({ value: 50 })
    expect(parsePercent('900')).toEqual({ value: 900 })
    expect('error' in parsePercent('901')).toBe(true)
    expect('error' in parsePercent('-1')).toBe(true)
  })

  it('accepts ISO dates only, and explains why dd/mm is refused', () => {
    expect(parseDate('2026-07-28')).toEqual({ value: '2026-07-28' })
    const amb = parseDate('03/04/2026')
    expect('error' in amb).toBe(true)
    if ('error' in amb) expect(amb.error).toContain('ambiguous')
    expect('error' in parseDate('not a date')).toBe(true)
  })
})

describe('row validation', () => {
  it('treats a blank Operation as a read-only row', () => {
    const v = validateRow(rowGet({ Entity: 'Campaign', 'Campaign ID': '123' }))
    expect(v.readOnly).toBe(true)
    expect(v.ok).toBe(true)
  })

  it('requires an Entity and rejects an unknown one', () => {
    expect(validateRow(rowGet({})).ok).toBe(false)
    const v = validateRow(rowGet({ Entity: 'Widget', Operation: 'Update' }))
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.message).toContain('not recognised')
  })

  it('enforces per-entity required fields, including either/or alternatives', () => {
    const missing = validateRow(rowGet({ Entity: 'Keyword', Operation: 'Create', 'Keyword text': 'giacca', 'Match type': 'Broad' }))
    expect(missing.ok).toBe(false)
    expect(missing.issues.some((i) => i.message.includes('Campaign ID or Ad group ID'))).toBe(true)

    const satisfied = validateRow(rowGet({ Entity: 'Keyword', Operation: 'Create', 'Keyword text': 'giacca', 'Match type': 'Broad', 'Ad group ID': '42', Bid: '0,31' }))
    expect(satisfied.ok).toBe(true)
  })

  it('rejects bad VALUES even when every required field is present', () => {
    const v = validateRow(rowGet({ Entity: 'Keyword', Operation: 'Create', 'Keyword text': 'x', 'Match type': 'Exakt', 'Ad group ID': '42', Bid: 'abc' }))
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.column)).toEqual(expect.arrayContaining(['Match type', 'Bid']))
  })

  it('collects every issue rather than failing on the first', () => {
    const v = validateRow(rowGet({ Entity: 'Campaign', Operation: 'Create', State: 'nope', 'Daily budget': 'abc', 'Start date': '03/04/2026' }))
    expect(v.issues.length).toBeGreaterThanOrEqual(3)
  })

  it('flags entities we can validate but cannot yet apply', () => {
    const v = validateRow(rowGet({ Entity: 'Portfolio', Operation: 'Create', 'Portfolio name': 'Moto' }))
    expect(v.ok).toBe(true)
    expect(v.previewOnly).toBe(true)

    const applied = validateRow(rowGet({ Entity: 'Campaign', Operation: 'Update', 'Campaign ID': '123' }))
    expect(applied.previewOnly).toBe(false)
  })

  it('knows the entities the old client knew, so nothing regresses', () => {
    for (const e of ['Campaign', 'Ad group', 'Keyword', 'Product ad', 'Product targeting', 'Negative keyword', 'Bidding adjustment', 'Portfolio']) {
      expect(entityRule(e), e).not.toBeNull()
    }
  })
})

describe('round-trip identity', () => {
  it('builds a stable, unique row key per entity', () => {
    const a = buildRowKey({ entity: 'Keyword', externalId: '123', localId: 'abc' })
    expect(a).toBe(buildRowKey({ entity: 'Keyword', externalId: '123', localId: 'abc' }))
    expect(a).not.toBe(buildRowKey({ entity: 'Negative keyword', externalId: '123', localId: 'abc' }))
  })

  it('still produces a key when Amazon has issued no id', () => {
    const k = buildRowKey({ entity: 'Campaign', externalId: null, localId: 'local-1' })
    expect(k).toContain('local')
    expect(k).not.toBe(buildRowKey({ entity: 'Campaign', externalId: null, localId: 'local-2' }))
  })

  it('changes the baseline when an EDITABLE value changes', () => {
    const base = { Bid: '0.31', State: 'enabled' }
    const before = computeBaseline((h) => (base as Record<string, string>)[h])
    const after = computeBaseline((h) => ({ ...base, Bid: '0.42' } as Record<string, string>)[h])
    expect(after).not.toBe(before)
  })

  it('does NOT change when only read-only context changes', () => {
    // Amazon restates performance for 60 days. If drifting read-only metrics moved
    // the fingerprint, every re-upload would look like a conflict.
    const editable = { Bid: '0.31', State: 'enabled' }
    const a = computeBaseline((h) => ({ ...editable, 'Campaign ID': '111' } as Record<string, string>)[h])
    const b = computeBaseline((h) => ({ ...editable, 'Campaign ID': '999' } as Record<string, string>)[h])
    expect(a).toBe(b)
  })

  it('treats a missing baseline as unverifiable, not as a conflict', () => {
    // Hand-authored files, and files Numbers has stripped, must stay usable.
    expect(baselineConflicts('', 'abc123')).toBe(false)
    expect(baselineConflicts('abc123', 'abc123')).toBe(false)
    expect(baselineConflicts('abc123', 'def456')).toBe(true)
  })
})

describe('dictionary', () => {
  it('generates one row per column, in column order', () => {
    const rows = buildDictionaryRows()
    expect(rows).toHaveLength(COLUMNS.length)
    expect(rows[0]![0]).toBe('Product')
    expect(rows.map((r) => r[0])).toEqual([...HEADERS])
  })

  it('carries the allowed values for every enum column', () => {
    const rows = buildDictionaryRows()
    const i = HEADERS.indexOf('Match type')
    expect(rows[i]![DICTIONARY_HEADERS.indexOf('Allowed values')]).toContain('Broad')
  })

  it('gives every column a definition — the Dictionary is generated, never stubbed', () => {
    for (const c of COLUMNS) expect(c.definition.length, c.header).toBeGreaterThan(10)
  })
})
