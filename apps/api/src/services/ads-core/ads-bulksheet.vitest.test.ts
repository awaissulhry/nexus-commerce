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
  buildRowKey, computeBaseline, baselineConflicts, baselineDrift, ENTITIES_BY_PRODUCT, parseRowKey, rowKeyMatchesEntity } from '@nexus/shared/ads-bulksheet'

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

  it('matches the 53-column Sponsored Products layout of a real download', () => {
    expect(COLUMNS).toHaveLength(53)
    // Amazon's informational columns are read-only by definition.
    for (const c of COLUMNS) {
      if (/\(Informational only\)$/.test(c.header)) expect(c.editable, c.header).toBe(false)
    }
    // Performance columns are Amazon's OWN, not our additions, and read-only.
    for (const h of ['Impressions', 'Clicks', 'Spend', 'Sales', 'ACOS', 'CPC', 'ROAS']) {
      expect(resolveColumn(h)!.editable, h).toBe(false)
    }
    // ...and excluded from the baseline, or 60 days of restatement would read as conflicts.
    const a = computeBaseline('Keyword', (h) => (h === 'Bid' ? '0.31' : h === 'ACOS' ? '0.20' : ''))
    const b = computeBaseline('Keyword', (h) => (h === 'Bid' ? '0.31' : h === 'ACOS' ? '0.99' : ''))
    expect(a).toBe(b)
  })

  it('stores ratios as fractions, the way Amazon does', () => {
    expect(resolveColumn('ACOS')!.type).toBe('ratio')
    expect(NUM_FMT.ratio).toBe('0.00%')
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
  it('accepts the real placement and bidding-strategy spellings, including the en dash', () => {
    // Amazon writes "Dynamic bids – down only" with U+2013, and placements as
    // "Placement top" — our earlier guesses appear nowhere in a real file.
    expect(parseVocabulary('biddingStrategy', 'Dynamic bids \u2013 down only')).toBe('Dynamic bids \u2013 down only')
    expect(parseVocabulary('biddingStrategy', 'Dynamic bids - down only')).toBe('Dynamic bids \u2013 down only')
    expect(parseVocabulary('biddingStrategy', 'LEGACY_FOR_SALES')).toBe('Dynamic bids \u2013 down only')
    expect(parseVocabulary('placement', 'Placement top')).toBe('Placement top')
    expect(parseVocabulary('placement', 'PLACEMENT_TOP')).toBe('Placement top')
    expect(parseVocabulary('targetingType', 'AUTO')).toBe('Auto')
  })

  it('knows which entities are legal on which sheet', () => {
    // Verified per ad product: Sponsored Display has no keywords at all.
    expect(ENTITIES_BY_PRODUCT['Sponsored Display']).not.toContain('Keyword')
    expect(ENTITIES_BY_PRODUCT['Sponsored Display']).toContain('Contextual targeting')
    expect(ENTITIES_BY_PRODUCT['Sponsored Brands']).toContain('Draft campaign')
    expect(ENTITIES_BY_PRODUCT['Sponsored Products']).toContain('Campaign negative keyword')
  })

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

  it('accepts Amazon YYYYMMDD and ISO, normalising to Amazon form', () => {
    // Verified against two real downloads: Amazon writes 20260612, not ISO.
    expect(parseDate('20260728')).toEqual({ value: '20260728' })
    expect(parseDate('2026-07-28')).toEqual({ value: '20260728' })
    expect('error' in parseDate('20260231')).toBe(true) // Feb 31st
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
    // Product ad still has no apply path — it previews, it does not write.
    const v = validateRow(rowGet({ Entity: 'Product ad', Operation: 'Update', 'Ad ID': 'a1' }))
    expect(v.ok).toBe(true)
    expect(v.previewOnly).toBe(true)

    const applied = validateRow(rowGet({ Entity: 'Campaign', Operation: 'Update', 'Campaign ID': '123' }))
    expect(applied.previewOnly).toBe(false)

    // AX-IE.2 — Portfolio moved to applicable once we emitted Amazon's real
    // sheet and built the write path. It was the previewOnly example here.
    const portfolio = validateRow(rowGet({ Entity: 'Portfolio', Operation: 'Update', 'Portfolio ID': 'p1' }))
    expect(portfolio.previewOnly).toBe(false)
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

  it('changes the baseline when the entity\'s own state changes', () => {
    const before = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.31' } as Record<string, string>)[h])
    const after = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.42' } as Record<string, string>)[h])
    expect(after).not.toBe(before)
  })

  it('IGNORES Operation — the operator filling it in is the whole point', () => {
    // Regression: hashing Operation made every edited row conflict with itself.
    // The first end-to-end preview returned 57 CONFLICTs out of 57 rows.
    const a = computeBaseline('Campaign', (h) => ({ State: 'enabled', Operation: '' } as Record<string, string>)[h])
    const b = computeBaseline('Campaign', (h) => ({ State: 'enabled', Operation: 'Update' } as Record<string, string>)[h])
    expect(b).toBe(a)
  })

  it('ignores columns the entity does not own', () => {
    // A keyword row carries a Campaign name for readability; a campaign rename
    // must not read as a keyword conflict.
    const a = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.31', 'Campaign name': 'OLD' } as Record<string, string>)[h])
    const b = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.31', 'Campaign name': 'NEW' } as Record<string, string>)[h])
    expect(b).toBe(a)
  })

  it('does NOT change when only read-only performance context changes', () => {
    // Amazon restates performance for 60 days. If that moved the fingerprint,
    // every re-upload would look like a conflict.
    const a = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.31', ACOS: '0.20' } as Record<string, string>)[h])
    const b = computeBaseline('Keyword', (h) => ({ State: 'enabled', Bid: '0.31', ACOS: '0.99' } as Record<string, string>)[h])
    expect(b).toBe(a)
  })

  it('treats a missing baseline as unverifiable, not as a conflict', () => {
    // Hand-authored files, and files Numbers has stripped, must stay usable.
    expect(baselineConflicts('', 'State:abcd')).toBe(false)
  })

  it('reports drift PER FIELD, not for the whole row', () => {
    const was = computeBaseline('Campaign', (h) => ({ State: 'enabled', 'Daily budget': '100', 'Campaign name': 'A', 'Bidding strategy': 'MANUAL' } as Record<string, string>)[h])
    const now = computeBaseline('Campaign', (h) => ({ State: 'enabled', 'Daily budget': '100', 'Campaign name': 'A', 'Bidding strategy': 'LEGACY_FOR_SALES' } as Record<string, string>)[h])
    expect(baselineDrift(was, now)).toEqual(['Bidding strategy'])
  })

  it('only CONFLICTS when the drift collides with what the operator edited', () => {
    // Real case: the settings-sync cron moved Bidding strategy between an export
    // and its preview. The operator had only touched Daily budget, so blocking
    // them would have been noise — and noise trains people to click through.
    const was = computeBaseline('Campaign', (h) => ({ State: 'enabled', 'Daily budget': '100', 'Bidding strategy': 'MANUAL' } as Record<string, string>)[h])
    const now = computeBaseline('Campaign', (h) => ({ State: 'enabled', 'Daily budget': '100', 'Bidding strategy': 'LEGACY_FOR_SALES' } as Record<string, string>)[h])
    expect(baselineConflicts(was, now, ['Daily budget'])).toBe(false)
    expect(baselineConflicts(was, now, ['Bidding strategy'])).toBe(true)
  })

  it('normalises through the schema so both sides agree on format', () => {
    // The exporter has the raw DB value, the preview has what it read back.
    // 100 vs "100.00", LEGACY_FOR_SALES vs "Dynamic bids – down only".
    const raw = computeBaseline('Campaign', (h) => ({ 'Daily budget': 100, 'Bidding strategy': 'LEGACY_FOR_SALES' } as Record<string, unknown>)[h])
    const read = computeBaseline('Campaign', (h) => ({ 'Daily budget': '100.00', 'Bidding strategy': 'Dynamic bids – down only' } as Record<string, unknown>)[h])
    expect(read).toBe(raw)
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

describe('AX-ZD.7 — an entity must be legal for its ad product', () => {
  const row = (vals: Record<string, string>) => (h: string) => vals[h] ?? ''

  it('rejects a Keyword on Sponsored Display', () => {
    // SD has no keyword targeting. Before this, the row validated cleanly and
    // applied as if it were Sponsored Products.
    const v = validateRow(row({
      Entity: 'Keyword', Operation: 'Update', Product: 'Sponsored Display',
      'Keyword ID': 'k1', Bid: '0.50',
    }))
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.column === 'Entity' && /not a valid entity for Sponsored Display/.test(i.message))).toBe(true)
  })

  it('accepts a Keyword on Sponsored Products', () => {
    const v = validateRow(row({
      Entity: 'Keyword', Operation: 'Update', Product: 'Sponsored Products',
      'Keyword ID': 'k1', Bid: '0.50',
    }))
    expect(v.issues.some((i) => /not a valid entity/.test(i.message))).toBe(false)
  })

  it('accepts Contextual targeting on Sponsored Display', () => {
    const v = validateRow(row({
      Entity: 'Contextual targeting', Operation: 'Update', Product: 'Sponsored Display',
    }))
    expect(v.issues.some((i) => /not a valid entity/.test(i.message))).toBe(false)
  })

  it('a blank Product is not an error — the column is optional in a hand-edited file', () => {
    // Rejecting on absence would break sheets that were valid before this check.
    const v = validateRow(row({ Entity: 'Keyword', Operation: 'Update', 'Keyword ID': 'k1', Bid: '0.50' }))
    expect(v.issues.some((i) => /not a valid entity/.test(i.message))).toBe(false)
  })

  it('an unrecognised Product does not silently pass the entity check', () => {
    // It fails on the Product vocabulary instead — the row is still rejected,
    // just for the accurate reason.
    const v = validateRow(row({ Entity: 'Keyword', Operation: 'Update', Product: 'Sponsored Nonsense', 'Keyword ID': 'k1', Bid: '0.5' }))
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.column === 'Product')).toBe(true)
  })
})

describe('AX-ZD.9 — _row_key is a real join key, not an echo', () => {
  it('round-trips a normal key', () => {
    const key = buildRowKey({ entity: 'Campaign', externalId: '204054550849397', localId: 'clx123' })
    expect(parseRowKey(key)).toEqual({ entity: 'campaign', externalId: '204054550849397', localId: 'clx123' })
  })

  it('recovers the local id even when the external id contains a colon', () => {
    // Bidding adjustment builds externalId as `${campaignId}:${placement}`.
    // Splitting on every colon would take "PLACEMENT_TOP" as the local id and
    // resolve nothing — or worse, something else.
    const key = buildRowKey({
      entity: 'Bidding adjustment', externalId: '204054550849397:PLACEMENT_TOP', localId: 'clxABC',
    })
    const p = parseRowKey(key)!
    expect(p.localId).toBe('clxABC')
    expect(p.externalId).toBe('204054550849397:PLACEMENT_TOP')
  })

  it('survives the Excel failure the ID column does not', () => {
    // A 15-digit Amazon id round-trips through a spreadsheet as 2.04055E+14.
    // The ID column is then useless; the row key still carries the local id.
    const key = buildRowKey({ entity: 'Campaign', externalId: '204054550849397', localId: 'clx123' })
    const mangled = '2.04055E+14'
    expect(mangled).not.toBe('204054550849397')
    expect(parseRowKey(key)!.localId).toBe('clx123')
  })

  it('a local-only entity reports no external id rather than the literal "local"', () => {
    const key = buildRowKey({ entity: 'Keyword', externalId: null, localId: 'clxNEW' })
    const p = parseRowKey(key)!
    expect(p.externalId).toBeNull()
    expect(p.localId).toBe('clxNEW')
  })

  it('refuses malformed keys instead of guessing', () => {
    for (const bad of ['', '   ', 'campaign', 'campaign:', ':x:y', 'campaign:ext:']) {
      expect(parseRowKey(bad), bad).toBeNull()
    }
  })

  it('a key minted for one entity never matches another', () => {
    // Guards cross-entity resolution: an ad group's key on a Campaign row must
    // not resolve, or the diff would compare fields the record does not own.
    const key = buildRowKey({ entity: 'Ad group', externalId: 'x', localId: 'clx1' })
    expect(rowKeyMatchesEntity(key, 'Ad group')).toBe(true)
    expect(rowKeyMatchesEntity(key, 'Campaign')).toBe(false)
    expect(rowKeyMatchesEntity('', 'Campaign')).toBe(false)
  })
})
