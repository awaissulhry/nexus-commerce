import { describe, expect, it } from 'vitest'

import {
  EMPTY_RAW, applyHeldReason, applyLabel, buildRequest, countSentence, currencySymbol, effectiveFilter, fieldDefaults, filterLines,
  footerStatus, groupSkipped, isIsoDate, lineFilterOptions, parseInput, previewPrompt, rawFromInput, requestKey, resolveInitial,
  skipGroupLine, type BulkRaw, type HeldInputs,
} from './dialogModel'
import type { BulkEditSource, BulkFieldSpec, BulkLine, BulkMarketOption } from './types'

/**
 * The Matrix bulk Edit dialog (Owner 2026-10-07): the rules the screen rests on. The dialog never writes and never
 * computes a number it shows; these are how it reads an entry, what it says, and when it lets Apply go.
 */
const raw = (over: Partial<BulkRaw>): BulkRaw => ({ ...EMPTY_RAW, ...over })
const money = (text: string) => parseInput('money', raw({ text }))
const percent = (text: string) => parseInput('percent', raw({ text }))
const integer = (text: string) => parseInput('integer', raw({ text }))
const sale = (text: string, start: string, end: string) => parseInput('sale', raw({ text, start, end }))

describe('parseInput — money', () => {
  it.each([['105', 105], ['99,75', 99.75], ['99.75', 99.75], [' 12.5 ', 12.5], ['0', 0], ['1 050,00', 1050]])('reads %j as %d', (text, amount) => {
    expect(money(text)).toMatchObject({ state: 'ok', input: { amount }, reason: null })
  })
  it('nothing typed waits without an error', () => {
    expect(money('')).toMatchObject({ state: 'empty', input: null })
    expect(money('   ').state).toBe('empty')
  })
  it('a number still being typed waits without an error', () => {
    expect(money('99,')).toMatchObject({ state: 'partial', input: null })
  })
  it('refuses below 0, more than 2 decimals and words, each with its own reason', () => {
    expect(money('-5')).toMatchObject({ state: 'invalid', reason: 'Enter 0 or more.' })
    expect(money('−5').state).toBe('invalid')
    expect(money('99.755')).toMatchObject({ state: 'invalid', reason: 'Use at most 2 decimals, like 99.75.' })
    expect(money('abc')).toMatchObject({ state: 'invalid', reason: 'Enter a number, like 99.75.' })
    expect(money('1.2.3').state).toBe('invalid')
  })
  it('never carries float noise into the request', () => {
    expect(money('0,29').input?.amount).toBe(0.29)
  })
})

describe('parseInput — percent', () => {
  it.each([['-5', -5], ['−5', -5], ['+10', 10], ['10', 10], ['2,5', 2.5], ['-2.5 %', -2.5], ['-99.99', -99.99]])('reads %j as %d', (text, value) => {
    expect(percent(text)).toMatchObject({ state: 'ok', input: { percent: value } })
  })
  it('0 changes nothing, so it is refused', () => {
    expect(percent('0')).toMatchObject({ state: 'invalid', reason: 'Enter a change other than 0.' })
    expect(percent('-0').state).toBe('invalid')
  })
  it('−100 or below would take a price to nothing', () => {
    expect(percent('-100')).toMatchObject({ state: 'invalid', reason: 'It cannot go down by 100 % or more.' })
    expect(percent('-150').state).toBe('invalid')
  })
  it('a lone sign or a trailing separator is still being typed', () => {
    expect(percent('-').state).toBe('partial')
    expect(percent('−').state).toBe('partial')
    expect(percent('-5,').state).toBe('partial')
  })
  it('empty waits; words are refused', () => {
    expect(percent('').state).toBe('empty')
    expect(percent('five').state).toBe('invalid')
  })
})

describe('parseInput — integer', () => {
  it('reads a whole number of 0 or more as the amount', () => {
    expect(integer('0')).toMatchObject({ state: 'ok', input: { amount: 0 } })
    expect(integer('12')).toMatchObject({ state: 'ok', input: { amount: 12 } })
  })
  it('refuses a negative, a decimal and a number too large to be exact', () => {
    expect(integer('-1')).toMatchObject({ state: 'invalid', reason: 'Enter 0 or more.' })
    expect(integer('2.5')).toMatchObject({ state: 'invalid', reason: 'Enter a whole number.' })
    expect(integer('99999999999999999999').reason).toBe('That number is too large.')
    expect(integer('').state).toBe('empty')
  })
})

describe('parseInput — choice, none', () => {
  const choices = [{ value: 'FBA', label: 'FBA' }, { value: 'FBM', label: 'FBM' }]
  it('reads an offered choice', () => {
    expect(parseInput('choice', raw({ choice: 'FBM' }), choices)).toMatchObject({ state: 'ok', input: { choice: 'FBM' } })
  })
  it('a choice no longer offered (the markets changed) is not read', () => {
    expect(parseInput('choice', raw({ choice: 'MCF' }), choices)).toMatchObject({ state: 'empty', input: null })
    expect(parseInput('choice', raw({}), choices).state).toBe('empty')
  })
  it('a mode that needs nothing is always read', () => {
    expect(parseInput('none', EMPTY_RAW)).toMatchObject({ state: 'ok', input: {} })
  })
})

describe('parseInput — sale', () => {
  it('reads a price and two dates', () => {
    expect(sale('79,90', '2026-11-01', '2026-11-30')).toMatchObject({ state: 'ok', input: { sale: { value: 79.9, start: '2026-11-01', end: '2026-11-30' } } })
  })
  it('a one-day sale starts and ends on the same day', () => {
    expect(sale('10', '2026-11-01', '2026-11-01').state).toBe('ok')
  })
  it('says which part is missing or wrong, on that part', () => {
    expect(sale('', '2026-11-01', '2026-11-30')).toMatchObject({ state: 'empty', reason: 'Enter a sale price.', at: 'value' })
    expect(sale('10', '', '2026-11-30')).toMatchObject({ state: 'empty', at: 'start' })
    expect(sale('10', '2026-11-01', '')).toMatchObject({ state: 'empty', at: 'end' })
    expect(sale('10', '2026-11-30', '2026-11-01')).toMatchObject({ state: 'invalid', reason: 'The sale ends before it starts.', at: 'end' })
    expect(sale('10', '2026-02-30', '2026-03-01')).toMatchObject({ state: 'invalid', at: 'start' })
  })
  it('isIsoDate knows the calendar', () => {
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('01/11/2026')).toBe(false)
  })
})

describe('rawFromInput — an opening value back on screen', () => {
  it('puts each kind of input in its field', () => {
    expect(rawFromInput('money', { amount: 99.75 }).text).toBe('99.75')
    expect(rawFromInput('integer', { amount: 4 }).text).toBe('4')
    expect(rawFromInput('percent', { percent: -5 }).text).toBe('-5')
    expect(rawFromInput('choice', { choice: 'FBM' }).choice).toBe('FBM')
    expect(rawFromInput('sale', { sale: { value: 9, start: '2026-11-01', end: '2026-11-02' } })).toEqual({ text: '9', choice: '', start: '2026-11-01', end: '2026-11-02' })
    expect(rawFromInput('money', undefined)).toEqual(EMPTY_RAW)
  })
})

describe('the words', () => {
  it('applyLabel counts with correct plurals', () => {
    expect(applyLabel({ changes: 10, skipped: 0 })).toBe('Apply 10 changes')
    expect(applyLabel({ changes: 10, skipped: 2 })).toBe('Apply 10 changes, skip 2')
    expect(applyLabel({ changes: 1, skipped: 1 })).toBe('Apply 1 change, skip 1')
    expect(applyLabel({ changes: 0, skipped: 3 })).toBe('Nothing to change')
    expect(applyLabel({ changes: 1200, skipped: 0 })).toBe('Apply 1,200 changes')
    expect(applyLabel(null)).toBe('Apply')
  })
  it('countSentence is the footer count', () => {
    expect(countSentence(10, 2)).toBe('10 changes · 2 skipped')
    expect(countSentence(1, 0)).toBe('1 change')
    expect(countSentence(0, 3)).toBe('No changes · 3 skipped')
    expect(countSentence(0, 0)).toBe('Nothing would change')
  })
  it('footerStatus: applying, else the counts on screen, else why Apply waits', () => {
    expect(footerStatus({ phase: 'applying', current: { changes: 3, skipped: 0 }, held: 'Applying…' })).toBe('Applying…')
    expect(footerStatus({ phase: 'form', current: { changes: 3, skipped: 1 }, held: 'Type FBM to confirm' })).toBe('3 changes · 1 skipped')
    expect(footerStatus({ phase: 'form', current: null, held: 'Tick at least one market' })).toBe('Tick at least one market')
  })
  it('currencySymbol', () => {
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('SEK')).toBe('SEK')
  })
})

describe('applyHeldReason — Apply is held, never silent, and says why', () => {
  const base: HeldInputs = {
    phase: 'form', field: { held: null, perMarket: true }, parsed: money('99'), ticked: 2, error: null,
    current: { changes: 4, confirmWord: null }, confirmed: false,
  }
  it('lets a matching preview with changes apply', () => {
    expect(applyHeldReason(base)).toBeNull()
  })
  it.each<[string, Partial<HeldInputs>, string]>([
    ['applying', { phase: 'applying' }, 'Applying…'],
    ['no field', { field: null }, 'Choose what to change'],
    ['a held field', { field: { held: 'Amazon manages FBA stock', perMarket: true } }, 'Amazon manages FBA stock'],
    ['nothing typed', { parsed: money('') }, 'Choose a value first'],
    ['a half-typed number', { parsed: money('99,') }, 'Finish the number.'],
    ['an unreadable entry', { parsed: money('-3') }, 'Enter 0 or more.'],
    ['no market ticked', { ticked: 0 }, 'Tick at least one market'],
    ['a failed preview', { error: 'boom' }, 'The changes could not be worked out'],
    ['the preview is not back', { current: null }, 'Working out the changes…'],
    ['nothing to change', { current: { changes: 0, confirmWord: null } }, 'Nothing would change'],
    ['a word to type', { current: { changes: 3, confirmWord: 'FBM' } }, 'Type FBM to confirm'],
  ])('%s', (_, over, reason) => {
    expect(applyHeldReason({ ...base, ...over })).toBe(reason)
  })
  it('a product-level field needs no market', () => {
    expect(applyHeldReason({ ...base, field: { held: null, perMarket: false }, ticked: 0 })).toBeNull()
  })
  it('the typed word arms it', () => {
    expect(applyHeldReason({ ...base, current: { changes: 3, confirmWord: 'FBM' }, confirmed: true })).toBeNull()
  })
})

const line = (id: string, sku: string, skipped: string | null): BulkLine =>
  ({ id, rowId: sku, sku, where: 'Amazon · IT', now: '€10.00', next: skipped ? null : '€12.00', note: null, skipped })

describe('the table', () => {
  const lines = [
    line('1', 'SKU-A', 'Amazon-managed'), line('2', 'SKU-B', null), line('3', 'SKU-C', 'No listing'),
    line('4', 'SKU-B', 'Amazon-managed'), line('5', 'SKU-D', 'Amazon-managed'), line('6', 'SKU-A', 'Amazon-managed'),
  ]
  it('groupSkipped: one line per reason, the largest first, each SKU named once', () => {
    const groups = groupSkipped(lines)
    expect(groups.map(skipGroupLine)).toEqual(['Amazon-managed (4): SKU-A, SKU-B, SKU-D', 'No listing (1): SKU-C'])
  })
  it('groupSkipped: ties keep the order they came in', () => {
    expect(groupSkipped([line('1', 'X', 'B'), line('2', 'Y', 'A')]).map((g) => g.reason)).toEqual(['B', 'A'])
  })
  it('the filter offers only segments that narrow the table', () => {
    expect(lineFilterOptions(lines).map((o) => o.label)).toEqual(['All · 6', 'Changes · 1', 'Skipped · 5'])
    expect(lineFilterOptions([line('1', 'A', null)])).toEqual([])
    expect(lineFilterOptions([line('1', 'A', 'x')])).toEqual([])
    expect(lineFilterOptions([])).toEqual([])
  })
  it('filterLines and effectiveFilter', () => {
    expect(filterLines(lines, 'changes').map((l) => l.id)).toEqual(['2'])
    expect(filterLines(lines, 'skipped')).toHaveLength(5)
    expect(filterLines(lines, 'all')).toHaveLength(6)
    expect(effectiveFilter(lines, 'skipped')).toBe('skipped')
    // A new preview with nothing skipped has no Skipped segment: the table falls back to All.
    expect(effectiveFilter([line('1', 'A', null)], 'skipped')).toBe('all')
  })
})

// ── What the dialog opens on ─────────────────────────────────────────────────────────────────────────────────────

const markets: Record<string, BulkMarketOption[]> = {
  price: [
    { key: 'AMAZON:IT', label: 'Amazon · IT', held: null },
    { key: 'AMAZON:DE', label: 'Amazon · DE', held: null },
    { key: 'EBAY:IT', label: 'eBay · IT', held: 'eBay prices follow the base price' },
  ],
  fulfilment: [{ key: 'AMAZON:IT', label: 'Amazon · IT', held: null }],
}
const fields: BulkFieldSpec[] = [
  { id: 'basePrice', label: 'Base price', group: 'Prices', perMarket: false, held: 'Only an owner can change the base price',
    modes: [{ id: 'set', label: 'Set to', input: 'money', hint: '' }] },
  { id: 'price', label: 'Price', group: 'Prices', perMarket: true, held: null, modes: [
    { id: 'set', label: 'Set to', input: 'money', hint: '' },
    { id: 'adjust', label: 'Change by %', input: 'percent', hint: '' },
  ] },
  { id: 'fulfilment', label: 'Fulfilment', group: 'Listing', perMarket: true, held: null,
    modes: [{ id: 'method', label: 'Method', input: 'choice', hint: '' }] },
]
const source: Pick<BulkEditSource, 'fields' | 'marketsFor' | 'defaultMarkets'> = {
  fields,
  marketsFor: (f) => markets[f] ?? [],
  defaultMarkets: (f) => (f === 'price' ? ['AMAZON:IT', 'EBAY:IT'] : ['AMAZON:IT']),
}

describe('resolveInitial', () => {
  it('no initial: the first field that is not held, its first mode, its default markets that can be ticked', () => {
    expect(resolveInitial(source)).toEqual({ field: 'price', mode: 'set', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
  })
  it('honours an offered initial field, mode, value and markets', () => {
    expect(resolveInitial(source, { field: 'price', mode: 'adjust', input: { percent: -5 }, coordinateKeys: ['AMAZON:DE'] }))
      .toEqual({ field: 'price', mode: 'adjust', markets: ['AMAZON:DE'], raw: { ...EMPTY_RAW, text: '-5' } })
  })
  it('ticks only the initial markets that are offered and not held; none left → the defaults', () => {
    expect(resolveInitial(source, { coordinateKeys: ['EBAY:IT', 'AMAZON:DE', 'SHOPIFY:GLOBAL'] }).markets).toEqual(['AMAZON:DE'])
    expect(resolveInitial(source, { coordinateKeys: ['SHOPIFY:GLOBAL'] }).markets).toEqual(['AMAZON:IT'])
  })
  it('a held initial field is not opened on; its value is not carried to another field', () => {
    expect(resolveInitial(source, { field: 'basePrice', input: { amount: 3 } })).toEqual({ field: 'price', mode: 'set', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
  })
  it('an unknown initial mode falls back to the first, without the value meant for the other mode', () => {
    expect(resolveInitial(source, { field: 'price', mode: 'copy', input: { amount: 3 } })).toMatchObject({ mode: 'set', raw: EMPTY_RAW })
  })
  it('every field held: opens on the first, which then says why', () => {
    const allHeld = { ...source, fields: fields.map((f) => ({ ...f, held: 'No' })) }
    expect(resolveInitial(allHeld).field).toBe('basePrice')
  })
  it('a product-level field has no markets; no source opens on nothing', () => {
    const onlyBase = { ...source, fields: [{ ...fields[0]!, held: null }] }
    expect(resolveInitial(onlyBase).markets).toEqual([])
    expect(resolveInitial(null)).toEqual({ field: null, mode: null, markets: [], raw: EMPTY_RAW })
  })
  it('fieldDefaults: changing the field resets mode, value and markets to that field', () => {
    expect(fieldDefaults(source, 'fulfilment')).toEqual({ field: 'fulfilment', mode: 'method', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
  })
})

describe('buildRequest and requestKey', () => {
  const price = fields[1]!
  it('builds the request on screen, or null while it cannot be sent', () => {
    expect(buildRequest(price, price.modes[0]!, money('12'), ['AMAZON:IT'])).toEqual({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['AMAZON:IT'] })
    expect(buildRequest(price, price.modes[0]!, money(''), ['AMAZON:IT'])).toBeNull()
    expect(buildRequest(price, price.modes[0]!, money('12'), [])).toBeNull()
    expect(buildRequest(fields[0]!, fields[0]!.modes[0]!, money('12'), [])).toBeNull() // held
    expect(buildRequest({ ...fields[0]!, held: null }, fields[0]!.modes[0]!, money('12'), ['AMAZON:IT'])?.coordinateKeys).toEqual([])
  })
  it('the key ignores the order markets were ticked in and the order input keys were written in', () => {
    const a = requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['B', 'A'] })
    const b = requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['A', 'B'] })
    expect(a).toBe(b)
    const s1 = requestKey({ field: 'salePrice', mode: 'sale-set', input: { sale: { value: 1, start: '2026-01-01', end: '2026-01-02' } }, coordinateKeys: [] })
    const s2 = requestKey({ field: 'salePrice', mode: 'sale-set', input: { sale: { end: '2026-01-02', start: '2026-01-01', value: 1 } }, coordinateKeys: [] })
    expect(s1).toBe(s2)
  })
  it('the key changes with anything that changes the answer', () => {
    const k = (over: object) => requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['A'], ...over })
    const base = k({})
    expect(k({ input: { amount: 13 } })).not.toBe(base)
    expect(k({ mode: 'adjust', input: { percent: 12 } })).not.toBe(base)
    expect(k({ coordinateKeys: ['A', 'B'] })).not.toBe(base)
    expect(k({ field: 'basePrice' })).not.toBe(base)
    expect(requestKey(null)).toBeNull()
  })
})

describe('previewPrompt — what the table area says before there is anything to preview', () => {
  const field = { held: null, perMarket: true }
  it('names the next step', () => {
    expect(previewPrompt({ field: null, kind: 'money', parsed: money(''), ticked: 0 })).toBe('Choose what to change.')
    expect(previewPrompt({ field: { held: 'Held here', perMarket: true }, kind: 'money', parsed: money('1'), ticked: 1 })).toBe('Held here')
    expect(previewPrompt({ field, kind: 'money', parsed: money(''), ticked: 1 })).toBe('Enter a value to see what would change.')
    expect(previewPrompt({ field, kind: 'choice', parsed: parseInput('choice', EMPTY_RAW), ticked: 1 })).toBe('Choose a value to see what would change.')
    expect(previewPrompt({ field, kind: 'money', parsed: money('1'), ticked: 0 })).toBe('Tick a market to see what would change.')
  })
})
