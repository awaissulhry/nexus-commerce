import { describe, expect, it } from 'vitest'

import {
  COPY_SOURCE_HELD, DOWN_BY_100, EMPTY_RAW, MORE_THAN_ZERO, NOT_UNDOABLE, NO_SIGN, addDays, adjustSign, applyHeldReason, applyLabel,
  buildRequest, copySource, countSentence, createTableKeys, currencySymbol, defaultModeFor, effectiveFilter, fieldDefaults,
  fieldGroups, fieldListOptions, filterLines, filterRows, footerStatus, groupSkipped, heldMarketsLine, isIsoDate, lineFilterOptions,
  localIsoDate, marketsShown, modeRaw, nextStep, noChoiceText, noticesFor, parseInput, rawFromInput, requestKey, requestMarkets,
  resolveInitial, saleDefaultDates, skipGroupLine, skippedSummary, skippedText, tableRows, TIERS_EMPTY, TIERS_UNFILLED, tierFieldProblems,
  type BulkRaw, type HeldInputs,
} from './dialogModel'
import type { BulkEditSource, BulkFieldSpec, BulkLine, BulkMarketOption, BulkModeSpec } from './types'

/**
 * The Matrix bulk Edit dialog (Owner 2026-10-07; v2 2026-10-12): the rules the screen rests on. The dialog never writes
 * and never computes a number it shows; these are how it reads an entry, what it says, and when it lets Apply go.
 */
const TODAY = '2026-10-12'
const raw = (over: Partial<BulkRaw>): BulkRaw => ({ ...EMPTY_RAW, ...over })
const money = (text: string) => parseInput('money', raw({ text }))
const adjust = (text: string, unit: BulkRaw['unit'], mode: 'raise' | 'lower') => parseInput('adjust', raw({ text, unit }), { mode })
const integer = (text: string) => parseInput('integer', raw({ text }))
const sale = (text: string, start: string, end: string) => parseInput('sale', raw({ text, start, end }))

describe('parseInput — money (a price: more than 0)', () => {
  it.each([['105', 105], ['99,75', 99.75], ['99.75', 99.75], [' 12.5 ', 12.5], ['0,01', 0.01], ['1 050,00', 1050]])('reads %j as %d', (text, amount) => {
    expect(money(text)).toMatchObject({ state: 'ok', input: { amount }, reason: null })
  })
  it('nothing typed waits without an error', () => {
    expect(money('')).toMatchObject({ state: 'empty', input: null })
    expect(money('   ').state).toBe('empty')
  })
  it('a number still being typed waits without an error', () => {
    expect(money('99,')).toMatchObject({ state: 'partial', input: null })
  })
  it('refuses 0 — every channel refuses a price of 0 — and below', () => {
    expect(money('0')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO })
    expect(money('0,00')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO })
    expect(money('-5')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO })
    expect(money('−5').state).toBe('invalid')
  })
  it('refuses more than 2 decimals and words, each with its own reason', () => {
    expect(money('99.755')).toMatchObject({ state: 'invalid', reason: 'Use at most 2 decimals, like 99.75.' })
    expect(money('abc')).toMatchObject({ state: 'invalid', reason: 'Enter a number, like 99.75.' })
    expect(money('1.2.3').state).toBe('invalid')
  })
  it('never carries float noise into the request', () => {
    expect(money('0,29').input?.amount).toBe(0.29)
  })
})

describe('parseInput — adjust (Raise · Lower: an unsigned number, the mode is the sign)', () => {
  it('a percentage: Raise is up, Lower is down', () => {
    expect(adjust('5', 'percent', 'raise')).toMatchObject({ state: 'ok', input: { percent: 5 } })
    expect(adjust('5', 'percent', 'lower')).toMatchObject({ state: 'ok', input: { percent: -5 } })
    expect(adjust('2,5 %', 'percent', 'lower').input).toEqual({ percent: -2.5 })
    expect(adjust('99.99', 'percent', 'lower').input).toEqual({ percent: -99.99 })
  })
  it('an amount in the currency: a signed delta, never a percentage', () => {
    expect(adjust('2', 'money', 'raise')).toMatchObject({ state: 'ok', input: { delta: 2 } })
    expect(adjust('2,50', 'money', 'lower').input).toEqual({ delta: -2.5 })
    expect(adjust('0,29', 'money', 'raise').input?.delta).toBe(0.29)
  })
  it('0 changes nothing, so it is refused', () => {
    expect(adjust('0', 'percent', 'raise')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO })
    expect(adjust('0.00', 'money', 'lower')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO })
  })
  it('Lower by 100 % or more would take a price to nothing; Raise by 100 % or more is fine', () => {
    expect(adjust('100', 'percent', 'lower')).toMatchObject({ state: 'invalid', reason: DOWN_BY_100 })
    expect(adjust('150', 'percent', 'lower').reason).toBe(DOWN_BY_100)
    expect(adjust('150', 'percent', 'raise').input).toEqual({ percent: 150 })
    // An amount of 100 or more is the server's to judge per line (it refuses a price that would reach 0).
    expect(adjust('100', 'money', 'lower').input).toEqual({ delta: -100 })
  })
  it('a sign is refused: Raise or Lower already says which way', () => {
    expect(adjust('-5', 'percent', 'raise')).toMatchObject({ state: 'invalid', reason: NO_SIGN })
    expect(adjust('+5', 'money', 'lower').reason).toBe(NO_SIGN)
    expect(adjust('−5', 'percent', 'lower').reason).toBe(NO_SIGN)
  })
  it('empty and half-typed wait; words and 3 decimals are refused', () => {
    expect(adjust('', 'percent', 'raise')).toMatchObject({ state: 'empty', reason: 'Enter a percentage.' })
    expect(adjust('', 'money', 'raise')).toMatchObject({ state: 'empty', reason: 'Enter an amount.' })
    expect(adjust('5,', 'percent', 'raise').state).toBe('partial')
    expect(adjust('five', 'percent', 'raise').state).toBe('invalid')
    expect(adjust('1.255', 'money', 'raise').reason).toBe('Use at most 2 decimals, like 2.50.')
    // A % typed after an amount is not read as a percentage.
    expect(adjust('5%', 'money', 'raise').state).toBe('invalid')
  })
  it('adjustSign: only Lower is down', () => {
    expect(adjustSign('lower')).toBe(-1)
    expect(adjustSign('raise')).toBe(1)
    expect(adjustSign(null)).toBe(1)
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

describe('parseInput — choice, none, handoff, locations', () => {
  const choices = [{ value: 'FBA', label: 'FBA' }, { value: 'FBM', label: 'FBM' }]
  it('reads an offered choice', () => {
    expect(parseInput('choice', raw({ choice: 'FBM' }), { choices })).toMatchObject({ state: 'ok', input: { choice: 'FBM' } })
  })
  it('a choice no longer offered (the markets changed) is not read', () => {
    expect(parseInput('choice', raw({ choice: 'MCF' }), { choices })).toMatchObject({ state: 'empty', input: null })
    expect(parseInput('choice', raw({}), { choices }).state).toBe('empty')
  })
  it('a mode that needs nothing — and a hand-off — is always read', () => {
    expect(parseInput('none', EMPTY_RAW)).toMatchObject({ state: 'ok', input: {} })
    expect(parseInput('handoff', EMPTY_RAW)).toMatchObject({ state: 'ok', input: {} })
  })
  it('Sells from: at least one warehouse ticked, read in sale order', () => {
    expect(parseInput('locations', EMPTY_RAW)).toMatchObject({ state: 'empty', input: null, reason: 'Tick at least one warehouse.' })
    expect(parseInput('locations', { ...EMPTY_RAW, codes: ['MI-3PL', 'IT-MAIN'] })).toMatchObject({ state: 'ok', input: { codes: ['MI-3PL', 'IT-MAIN'] } })
  })
})

describe('parseInput — sale', () => {
  it('reads a price and two dates', () => {
    expect(sale('79,90', '2026-11-01', '2026-11-30')).toMatchObject({ state: 'ok', input: { sale: { value: 79.9, start: '2026-11-01', end: '2026-11-30' } } })
  })
  it('a one-day sale starts and ends on the same day', () => {
    expect(sale('10', '2026-11-01', '2026-11-01').state).toBe('ok')
  })
  it('a sale price of 0 is refused like any price', () => {
    expect(sale('0', '2026-11-01', '2026-11-30')).toMatchObject({ state: 'invalid', reason: MORE_THAN_ZERO, at: 'value' })
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

describe('the sale dates the dialog fills in', () => {
  it('start = today, end = a week later, across a month and a year end', () => {
    expect(saleDefaultDates(TODAY)).toEqual({ start: '2026-10-12', end: '2026-10-19' })
    expect(saleDefaultDates('2026-10-28')).toEqual({ start: '2026-10-28', end: '2026-11-04' })
    expect(saleDefaultDates('2026-12-29').end).toBe('2027-01-05')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
  it('today is the local calendar day, not UTC', () => {
    // 23:30 on 12 October, local time, is still the 12th whatever UTC says.
    expect(localIsoDate(new Date(2026, 9, 12, 23, 30))).toBe('2026-10-12')
    expect(localIsoDate(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05')
  })
  it('a sale mode starts with the dates filled and parses on the price alone', () => {
    const r = modeRaw({ input: 'sale' }, TODAY)
    expect(r).toMatchObject({ start: '2026-10-12', end: '2026-10-19', text: '' })
    expect(parseInput('sale', { ...r, text: '79' })).toMatchObject({ state: 'ok', input: { sale: { value: 79, start: '2026-10-12', end: '2026-10-19' } } })
  })
  it('an adjust mode starts on its first unit; other modes start empty', () => {
    expect(modeRaw({ input: 'adjust', units: ['money', 'percent'] }, TODAY).unit).toBe('money')
    expect(modeRaw({ input: 'adjust', units: ['percent', 'money'] }, TODAY).unit).toBe('percent')
    expect(modeRaw({ input: 'money' }, TODAY)).toEqual(EMPTY_RAW)
    expect(modeRaw(null, TODAY)).toEqual(EMPTY_RAW)
  })
})

describe('rawFromInput — an opening value back on screen', () => {
  it('puts each kind of input in its controls', () => {
    expect(rawFromInput({ input: 'money' }, { amount: 99.75 }, TODAY).text).toBe('99.75')
    expect(rawFromInput({ input: 'integer' }, { amount: 4 }, TODAY).text).toBe('4')
    expect(rawFromInput({ input: 'choice' }, { choice: 'FBM' }, TODAY).choice).toBe('FBM')
    expect(rawFromInput({ input: 'sale' }, { sale: { value: 9, start: '2026-11-01', end: '2026-11-02' } }, TODAY))
      .toEqual({ ...EMPTY_RAW, text: '9', start: '2026-11-01', end: '2026-11-02' })
    expect(rawFromInput({ input: 'locations' }, { codes: ['MI-3PL', 'IT-MAIN'] }, TODAY).codes).toEqual(['MI-3PL', 'IT-MAIN'])
    expect(rawFromInput({ input: 'money' }, undefined, TODAY)).toEqual(EMPTY_RAW)
  })
  it('a signed percentage or delta shows unsigned, in its unit', () => {
    const units = ['percent', 'money'] as const
    expect(rawFromInput({ input: 'adjust', units }, { percent: -5 }, TODAY)).toMatchObject({ text: '5', unit: 'percent' })
    expect(rawFromInput({ input: 'adjust', units }, { delta: -2.5 }, TODAY)).toMatchObject({ text: '2.5', unit: 'money' })
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
    expect(footerStatus({ phase: 'form', current: null, held: 'Tick a market' })).toBe('Tick a market')
  })
  it('currencySymbol', () => {
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('SEK')).toBe('SEK')
  })
  it('a skipped line, the skipped disclosure, and an empty choice', () => {
    expect(skippedText('Amazon ships FBA orders')).toBe('Skipped — Amazon ships FBA orders')
    // The server's own `Refused — ` prefix is not said twice.
    expect(skippedText('Refused — an active FBA offer keeps the guard closed')).toBe('Skipped — An active FBA offer keeps the guard closed')
    expect(skipGroupLine({ reason: 'Refused — 2 FBA units reserved', count: 2, skus: ['A', 'B'] })).toBe('2 FBA units reserved (2): A, B')
    expect(skippedSummary(1)).toBe('Why 1 line is skipped')
    expect(skippedSummary(3)).toBe('Why 3 lines are skipped')
    // Never "nothing to choose" while markets are ticked.
    expect(noChoiceText('copy', 0)).toBe('Tick a market to see the choices.')
    expect(noChoiceText('copy', 3)).toBe('No market here has a price to copy.')
    expect(noChoiceText('status', 2)).toBe('The ticked markets do not take this.')
  })
})

// ── The next step ────────────────────────────────────────────────────────────────────────────────────────────────

const mode = (over: Partial<BulkModeSpec>): BulkModeSpec => ({ id: 'set', label: 'Set to', input: 'money', hint: '', ...over })

describe('nextStep — the ONE thing to do before anything can be previewed', () => {
  const field = { held: null, perMarket: true }
  const step = (m: BulkModeSpec | null, parsed = parseInput(m?.input ?? 'none', EMPTY_RAW, { mode: m?.id }), ticked = 1, f: typeof field | { held: string; perMarket: boolean } | null = field) =>
    nextStep({ field: f, mode: m, parsed, ticked })
  it('names what to enter, from the mode', () => {
    expect(step(mode({ inputLabel: 'New price' }))).toEqual({ short: 'Enter the new price', long: 'Enter the new price to see what changes.' })
    expect(step(mode({ input: 'integer', inputLabel: 'Quantity' }))?.long).toBe('Enter the quantity to see what changes.')
    expect(step(mode({ id: 'raise', input: 'adjust', inputLabel: 'Raise by', units: ['percent', 'money'] }))?.short).toBe('Enter how much')
    expect(step(mode({ id: 'status', input: 'choice', inputLabel: 'New status' }))?.short).toBe('Choose the new status')
    expect(step(mode({ id: 'copy', input: 'choice', inputLabel: 'Copy from' }))?.short).toBe('Choose a market to copy from')
    expect(step(mode({ id: 'sources', input: 'locations', inputLabel: 'Warehouses' }))?.short).toBe('Tick a warehouse')
    expect(step(mode({ id: 'sale-set', input: 'sale' }))?.short).toBe('Enter the sale price')
    expect(step(mode({ id: 'sale-set', input: 'sale' }), sale('10', '2026-11-01', ''))?.short).toBe('Choose the end date')
  })
  it('a field not chosen, or held, comes first', () => {
    expect(step(null, money(''), 1, null)).toEqual({ short: 'Choose what to change', long: 'Choose what to change.' })
    expect(step(mode({}), money(''), 1, { held: 'You do not have permission to edit products', perMarket: true }))
      .toEqual({ short: 'You do not have permission to edit products', long: 'You do not have permission to edit products' })
  })
  it('an unreadable entry points at its control (the reason is under it, never repeated); a half-typed number is named', () => {
    expect(step(mode({}), money('0'))).toEqual({ short: 'Correct the value', long: 'Correct the value to see what changes.' })
    expect(step(mode({}), money('99,'))).toEqual({ short: 'Finish the number', long: 'Finish the number to see what changes.' })
  })
  it('then a market; then nothing (the request is on screen); a hand-off has no step', () => {
    expect(step(mode({}), money('9'), 0)).toEqual({ short: 'Tick a market', long: 'Tick a market to see what changes.' })
    expect(step(mode({ id: 'follow', input: 'none' }), parseInput('none', EMPTY_RAW), 2)).toBeNull()
    expect(step(mode({}), money('9'), 0, { held: null, perMarket: false })).toBeNull()
    expect(step(mode({ id: 'open', input: 'handoff', inputLabel: 'Open case sizes…' }))).toBeNull()
  })
  it('the footer and the table line never say the same words', () => {
    const s = step(mode({ inputLabel: 'New price' }))!
    expect(s.short).not.toBe(s.long)
  })
})

describe('applyHeldReason — Apply is held, never silent, and says why', () => {
  const base: HeldInputs = {
    phase: 'form', field: { held: null, perMarket: true }, mode: mode({ inputLabel: 'New price' }), parsed: money('99'), ticked: 2, error: null,
    current: { changes: 4, confirmWord: null }, confirmed: false,
  }
  it('lets a matching preview with changes apply', () => {
    expect(applyHeldReason(base)).toBeNull()
  })
  it.each<[string, Partial<HeldInputs>, string]>([
    ['applying', { phase: 'applying' }, 'Applying…'],
    ['no field', { field: null }, 'Choose what to change'],
    ['a held field', { field: { held: 'Amazon manages FBA stock', perMarket: true } }, 'Amazon manages FBA stock'],
    ['nothing typed: the next step', { parsed: money('') }, 'Enter the new price'],
    ['nothing typed, no mode named', { parsed: money(''), mode: null }, 'Choose a value'],
    ['a half-typed number', { parsed: money('99,') }, 'Finish the number'],
    ['an unreadable entry (its reason is under the field)', { parsed: money('-3') }, 'Correct the value'],
    ['no market ticked', { ticked: 0 }, 'Tick a market'],
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

// ── Notices ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('noticesFor — the banners above the table', () => {
  it('keeps each notice once with its tone, and never repeats the hint', () => {
    const hint = 'Saved in Nexus now. Publish sends it to each market.'
    expect(noticesFor({
      notices: [
        { text: 'Saved in Nexus now. Publish sends it to each market', tone: 'info' },
        { text: 'Amazon EU: this covers IT DE FR ES', tone: 'info' },
        { text: 'Amazon EU: this covers IT DE FR ES.', tone: 'info' },
        { text: 'Holding the stock sync also holds price changes', tone: 'warning' },
      ],
      undoable: true,
    }, hint)).toEqual([
      { text: 'Amazon EU: this covers IT DE FR ES', tone: 'info' },
      { text: 'Holding the stock sync also holds price changes', tone: 'warning' },
    ])
  })
  it('says once that it cannot be undone, as info', () => {
    expect(noticesFor({ notices: [], undoable: false }, null)).toEqual([{ text: NOT_UNDOABLE, tone: 'info' }])
    expect(noticesFor({ notices: [{ text: NOT_UNDOABLE, tone: 'warning' }], undoable: false }, null)).toEqual([{ text: NOT_UNDOABLE, tone: 'warning' }])
  })
  it('a bare string from an older runner is info', () => {
    expect(noticesFor({ notices: ['Sent in about 30 seconds'] as never, undoable: true }, null)).toEqual([{ text: 'Sent in about 30 seconds', tone: 'info' }])
  })
})

// ── The table ────────────────────────────────────────────────────────────────────────────────────────────────────

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
    expect(lineFilterOptions(lines, true).map((o) => o.label)).toEqual(['All · 6', 'Saved · 1', 'Skipped · 5'])
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

describe('the table rows redraw for every new set of lines (the stale-cell bug)', () => {
  it('a new set of lines gets a new key, even with the same words and ids; the same set keeps its key', () => {
    const keyOf = createTableKeys()
    // Fulfilment → FBM refused every row; then Quantity skips the same rows for another reason, with the same line ids.
    const fulfilment = [line('r|row-1|AMAZON:EU|0', 'SKU-A', 'Refused — 3 things to fix')]
    const quantity = [line('r|row-1|AMAZON:EU|0', 'SKU-A', 'Amazon-managed — the quantity is never written')]
    expect(keyOf(fulfilment)).toBe(keyOf(fulfilment))
    expect(keyOf(quantity)).not.toBe(keyOf(fulfilment))
    expect(keyOf([...fulfilment])).not.toBe(keyOf(fulfilment))
    const before = tableRows(fulfilment, keyOf(fulfilment)).map((r) => r.key)
    const after = tableRows(quantity, keyOf(quantity)).map((r) => r.key)
    // No row of the new table can be mistaken by the grid for a row of the old one.
    expect(after.some((k) => before.includes(k))).toBe(false)
  })
  it('keys are unique within a set, even when a set repeats a line id', () => {
    const rows = tableRows([line('a', 'X', null), line('a', 'Y', null), line('b', 'Z', null), line('a', 'W', null)], 't9')
    expect(rows.map((r) => r.key)).toEqual(['t9|a', 't9|a#2', 't9|b', 't9|a#3'])
    expect(rows[1]!.line.sku).toBe('Y')
  })
  it('the filter keeps each row its key', () => {
    const rows = tableRows([line('1', 'A', null), line('2', 'B', 'x')], 't1')
    expect(filterRows(rows, 'skipped').map((r) => r.key)).toEqual(['t1|2'])
    expect(filterRows(rows, 'changes').map((r) => r.key)).toEqual(['t1|1'])
    expect(filterRows(rows, 'all')).toHaveLength(2)
  })
  it('names each variant once per run: its first row in the table on screen, after the filter too', () => {
    const rows = tableRows([line('1', 'A', null), line('2', 'A', 'x'), line('3', 'A', null), line('4', 'B', null)], 't1')
    expect(filterRows(rows, 'all').map((r) => r.first)).toEqual([true, false, false, true])
    // Changes only: A's second change follows A's first, so it is not named again; B starts its own run.
    expect(filterRows(rows, 'changes').map((r) => [r.line.id, r.first])).toEqual([['1', true], ['3', false], ['4', true]])
    expect(filterRows(rows, 'skipped').map((r) => r.first)).toEqual([true])
  })
})

// ── Markets ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('markets — held ones in one line, and the Copy from source', () => {
  const opts: BulkMarketOption[] = [
    { key: 'AMAZON:IT', label: 'Amazon · IT', held: null },
    { key: 'AMAZON:DE', label: 'Amazon · DE', held: null },
    { key: 'EBAY:IT', label: 'eBay · IT', held: 'None of these rows is on it' },
    { key: 'ETSY:GLOBAL', label: 'Etsy', held: 'None of these rows is on it.' },
    { key: 'SHOPIFY:GLOBAL', label: 'Shopify', held: 'Sync held' },
  ]
  it('one line, grouped by reason, the largest group first', () => {
    expect(heldMarketsLine(opts)).toBe('None of these rows is on it: eBay · IT, Etsy. Sync held: Shopify.')
    expect(heldMarketsLine(opts.slice(0, 2))).toBeNull()
  })
  it('the market a price is copied from shows held and leaves the request', () => {
    expect(copySource('copy', { choice: 'AMAZON:DE' })).toBe('AMAZON:DE')
    expect(copySource('copy', { choice: '' })).toBeNull()
    expect(copySource('set', { choice: 'AMAZON:DE' })).toBeNull()
    const shown = marketsShown(opts, 'AMAZON:DE')
    expect(shown.find((m) => m.key === 'AMAZON:DE')?.held).toBe(COPY_SOURCE_HELD)
    // Ticked before it became the source: still ticked in the form, never sent.
    expect(requestMarkets(['AMAZON:DE', 'AMAZON:IT'], shown)).toEqual(['AMAZON:IT'])
    expect(heldMarketsLine(shown)).toContain('Prices are copied from here: Amazon · DE.')
    // Another source: the market comes back as it was ticked.
    expect(requestMarkets(['AMAZON:DE', 'AMAZON:IT'], marketsShown(opts, 'AMAZON:IT'))).toEqual(['AMAZON:DE'])
  })
  it('a held market is never sent, and the order is the order shown', () => {
    expect(requestMarkets(['EBAY:IT', 'AMAZON:DE', 'AMAZON:IT'], marketsShown(opts, null))).toEqual(['AMAZON:IT', 'AMAZON:DE'])
  })
})

// ── The field list and what the dialog opens on ──────────────────────────────────────────────────────────────────

const markets: Record<string, BulkMarketOption[]> = {
  price: [
    { key: 'AMAZON:IT', label: 'Amazon · IT', held: null },
    { key: 'AMAZON:DE', label: 'Amazon · DE', held: null },
    { key: 'EBAY:IT', label: 'eBay · IT', held: 'eBay prices follow the base price' },
  ],
  fulfilment: [{ key: 'AMAZON:IT', label: 'Amazon · IT', held: null }],
  quantity: [{ key: 'AMAZON:IT', label: 'Amazon · IT', held: null }],
}
const fields: BulkFieldSpec[] = [
  { id: 'basePrice', label: 'Base price', description: 'The main price.', group: 'Prices', perMarket: false, held: 'Only an owner can change the base price',
    modes: [{ id: 'set', label: 'Set to', input: 'money', hint: '' }] },
  { id: 'price', label: 'Market price', description: 'A price of its own.', group: 'Prices', perMarket: true, held: null, modes: [
    { id: 'set', label: 'Set to', input: 'money', hint: '' },
    { id: 'raise', label: 'Raise', input: 'adjust', units: ['percent', 'money'], hint: '' },
    { id: 'lower', label: 'Lower', input: 'adjust', units: ['percent', 'money'], hint: '' },
    { id: 'copy', label: 'Copy from', input: 'choice', hint: '' },
  ] },
  { id: 'fulfilment', label: 'Fulfilment', description: 'Who ships.', group: 'Listing', perMarket: true, held: null,
    modes: [{ id: 'method', label: 'Set to', input: 'choice', hint: '' }] },
  { id: 'quantity', label: 'Quantity', description: 'How many units.', group: 'Stock', perMarket: true, held: null, modes: [
    { id: 'follow', label: 'Follow stock', input: 'none', hint: '' },
    { id: 'pin', label: 'Fixed number', input: 'integer', hint: '' },
  ] },
  { id: 'salePrice', label: 'Sale', description: 'A lower price between two dates.', group: 'Prices', perMarket: true, held: null, modes: [
    { id: 'sale-set', label: 'Set a sale', input: 'sale', hint: '' },
  ] },
]
type Shape = Pick<BulkEditSource, 'fields' | 'marketsFor' | 'defaultMarkets' | 'defaultMode'>
const source: Shape = {
  fields,
  marketsFor: (f) => markets[f] ?? [],
  defaultMarkets: (f) => (f === 'price' ? ['AMAZON:IT', 'EBAY:IT'] : ['AMAZON:IT']),
  // Quantity opens on Fixed number when every row already follows (the runner knows; here: always).
  defaultMode: (f) => (f === 'quantity' ? 'pin' : null),
}

describe('the field list', () => {
  it('groups the fields under their headings, in the order given', () => {
    expect(fieldGroups(fields).map((g) => [g.group, g.fields.map((f) => f.id)])).toEqual([
      ['Prices', ['basePrice', 'price', 'salePrice']], ['Listing', ['fulfilment']], ['Stock', ['quantity']],
    ])
  })
  it('the phone list: the description as the note; a held field with its reason instead', () => {
    const opts = fieldListOptions(fields)
    expect(opts[1]).toEqual({ value: 'price', label: 'Market price', group: 'Prices', note: 'A price of its own.' })
    expect(opts[0]).toEqual({ value: 'basePrice', label: 'Base price', group: 'Prices', note: 'Only an owner can change the base price', heldReason: 'Only an owner can change the base price' })
  })
})

describe('the default mode', () => {
  it('the runner picks it for the field and markets; else the first mode', () => {
    expect(defaultModeFor(source, fields[3]!, ['AMAZON:IT'])?.id).toBe('pin')
    expect(defaultModeFor(source, fields[1]!, ['AMAZON:IT'])?.id).toBe('set')
  })
  it('a mode the field does not have falls back to the first; no defaultMode at all, too', () => {
    expect(defaultModeFor({ ...source, defaultMode: () => 'retry' }, fields[3]!, [])?.id).toBe('follow')
    const { defaultMode: _, ...without } = source
    expect(defaultModeFor(without, fields[3]!, [])?.id).toBe('follow')
  })
  it('the runner is asked with the markets the field opens on', () => {
    const asked: unknown[] = []
    fieldDefaults({ ...source, defaultMode: (f, keys) => { asked.push([f, [...keys]]); return null } }, 'price', TODAY)
    expect(asked).toEqual([['price', ['AMAZON:IT']]])
  })
})

describe('resolveInitial and fieldDefaults', () => {
  it('no initial: the first field that is not held, its default mode, its default markets that can be ticked', () => {
    expect(resolveInitial(source, undefined, TODAY)).toEqual({ field: 'price', mode: 'set', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
  })
  it('honours an offered initial field, mode, value and markets', () => {
    expect(resolveInitial(source, { field: 'price', mode: 'lower', input: { percent: -5 }, coordinateKeys: ['AMAZON:DE'] }, TODAY))
      .toEqual({ field: 'price', mode: 'lower', markets: ['AMAZON:DE'], raw: { ...EMPTY_RAW, text: '5', unit: 'percent' } })
  })
  it('an initial field without a mode opens on the default mode', () => {
    expect(resolveInitial(source, { field: 'quantity' }, TODAY)).toMatchObject({ field: 'quantity', mode: 'pin' })
    expect(resolveInitial(source, { field: 'quantity', input: { amount: 5 } }, TODAY).raw.text).toBe('5')
  })
  it('ticks only the initial markets that are offered and not held; none left → the defaults', () => {
    expect(resolveInitial(source, { coordinateKeys: ['EBAY:IT', 'AMAZON:DE', 'SHOPIFY:GLOBAL'] }, TODAY).markets).toEqual(['AMAZON:DE'])
    expect(resolveInitial(source, { coordinateKeys: ['SHOPIFY:GLOBAL'] }, TODAY).markets).toEqual(['AMAZON:IT'])
  })
  it('a held initial field is not opened on; its value is not carried to another field', () => {
    expect(resolveInitial(source, { field: 'basePrice', input: { amount: 3 } }, TODAY)).toEqual({ field: 'price', mode: 'set', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
  })
  it('an unknown initial mode falls back to the default, without the value meant for the other mode', () => {
    expect(resolveInitial(source, { field: 'price', mode: 'sale-set', input: { amount: 3 } }, TODAY)).toMatchObject({ mode: 'set', raw: EMPTY_RAW })
  })
  it('every field held: opens on the first, which then says why', () => {
    const allHeld = { ...source, fields: fields.map((f) => ({ ...f, held: 'No' })) }
    expect(resolveInitial(allHeld, undefined, TODAY).field).toBe('basePrice')
  })
  it('a product-level field has no markets; no source opens on nothing', () => {
    const onlyBase = { ...source, fields: [{ ...fields[0]!, held: null }] }
    expect(resolveInitial(onlyBase, undefined, TODAY).markets).toEqual([])
    expect(resolveInitial(null, undefined, TODAY)).toEqual({ field: null, mode: null, markets: [], raw: EMPTY_RAW })
  })
  it('fieldDefaults: changing the field resets mode, value and markets to that field', () => {
    expect(fieldDefaults(source, 'fulfilment', TODAY)).toEqual({ field: 'fulfilment', mode: 'method', markets: ['AMAZON:IT'], raw: EMPTY_RAW })
    expect(fieldDefaults(source, 'quantity', TODAY)).toMatchObject({ mode: 'pin' })
  })
  it('fieldDefaults: a sale opens with today and a week from today', () => {
    expect(fieldDefaults(source, 'salePrice', TODAY).raw).toMatchObject({ start: '2026-10-12', end: '2026-10-19' })
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
  it('Lower 5 % and Lower €2 become a signed percentage and a signed delta', () => {
    const lower = price.modes[2]!
    expect(buildRequest(price, lower, adjust('5', 'percent', 'lower'), ['AMAZON:IT'])?.input).toEqual({ percent: -5 })
    expect(buildRequest(price, lower, adjust('2', 'money', 'lower'), ['AMAZON:IT'])?.input).toEqual({ delta: -2 })
  })
  it('a hand-off is never previewed', () => {
    const casePack: BulkFieldSpec = { id: 'casePack', label: 'Case size', description: '', group: 'Stock', perMarket: false, held: null,
      modes: [{ id: 'open', label: 'Open', input: 'handoff', inputLabel: 'Open case sizes…', hint: '' }] }
    expect(buildRequest(casePack, casePack.modes[0]!, parseInput('handoff', EMPTY_RAW), [])).toBeNull()
  })
  it('the key ignores the order markets were ticked in and the order input keys were written in', () => {
    const a = requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['B', 'A'] })
    const b = requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['A', 'B'] })
    expect(a).toBe(b)
    const s1 = requestKey({ field: 'salePrice', mode: 'sale-set', input: { sale: { value: 1, start: '2026-01-01', end: '2026-01-02' } }, coordinateKeys: [] })
    const s2 = requestKey({ field: 'salePrice', mode: 'sale-set', input: { sale: { end: '2026-01-02', start: '2026-01-01', value: 1 } }, coordinateKeys: [] })
    expect(s1).toBe(s2)
  })
  it('the key changes with anything that changes the answer — a percentage and an amount included', () => {
    const k = (over: object) => requestKey({ field: 'price', mode: 'set', input: { amount: 12 }, coordinateKeys: ['A'], ...over })
    const base = k({})
    expect(k({ input: { amount: 13 } })).not.toBe(base)
    expect(k({ mode: 'raise', input: { percent: 12 } })).not.toBe(base)
    expect(k({ mode: 'raise', input: { percent: 2 } })).not.toBe(k({ mode: 'raise', input: { delta: 2 } }))
    expect(k({ mode: 'lower', input: { delta: -2 } })).not.toBe(k({ mode: 'lower', input: { delta: -3 } }))
    expect(k({ coordinateKeys: ['A', 'B'] })).not.toBe(base)
    expect(k({ field: 'basePrice' })).not.toBe(base)
    expect(requestKey(null)).toBeNull()
    // Sells from: the order is the sale order — a reorder is a different request.
    const src = (codes: string[]) => requestKey({ field: 'stockSource', mode: 'sources', input: { codes }, coordinateKeys: ['AMAZON:EU'] })
    expect(src(['IT-MAIN', 'MI-3PL'])).not.toBe(src(['MI-3PL', 'IT-MAIN']))
  })
})

describe('parseInput — Amazon Business: a percent below the price, and quantity discounts', () => {
  const percent = (text: string) => parseInput('percent', raw({ text }))
  const row = (key: string, minQty: string, value: string) => ({ key, minQty, value })
  const tiers = (rows: Array<ReturnType<typeof row>>, tierType: BulkRaw['tierType'] = 'percent') => parseInput('tiers', raw({ tierType, tiers: rows }))

  it('% below the price: 0 to 99, up to 2 decimals, no sign (the mode says below)', () => {
    expect(percent('5')).toMatchObject({ state: 'ok', input: { percent: 5 } })
    expect(percent('5,5 %')).toMatchObject({ state: 'ok', input: { percent: 5.5 } })
    expect(percent('0')).toMatchObject({ state: 'ok', input: { percent: 0 } })
    expect(percent('')).toMatchObject({ state: 'empty' })
    expect(percent('5,')).toMatchObject({ state: 'partial' })
    expect(percent('-5')).toMatchObject({ state: 'invalid', reason: NO_SIGN })
    expect(percent('100')).toMatchObject({ state: 'invalid', reason: 'Enter a percentage from 0 to 99.' })
    expect(percent('2.555')).toMatchObject({ state: 'invalid', reason: 'Use at most 2 decimals, like 2.5.' })
  })

  it('quantity discounts: every row read, then the shape Amazon takes — said in the shared rule\'s words', () => {
    expect(tiers([row('k1', '2', '3'), row('k2', '5', '5 %')])).toMatchObject({ state: 'ok', input: { tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } } })
    expect(tiers([row('k1', '3', '85,50')], 'fixed')).toMatchObject({ state: 'ok', input: { tiers: { type: 'fixed', levels: [{ minQty: 3, value: 85.5 }] } } })
    expect(tiers([])).toMatchObject({ state: 'empty', reason: TIERS_EMPTY })
    expect(tiers([row('k1', '2', '')])).toMatchObject({ state: 'empty', reason: TIERS_UNFILLED })
    expect(tiers([row('k1', '2', '3,')])).toMatchObject({ state: 'partial' })
    expect(tiers([row('k1', '2.5', '3')])).toMatchObject({ state: 'invalid', reason: 'Discount 1: write a whole number of units, 2 or more.' })
    expect(tiers([row('k1', '1', '3')])).toMatchObject({ state: 'invalid', reason: 'Discount 1: the quantity must be a whole number of at least 2.' })
    expect(tiers([row('k1', '5', '3'), row('k2', '2', '5')])).toMatchObject({ state: 'invalid', reason: 'Discount 2: each quantity must be higher than the one before.' })
    expect(tiers([row('k1', '2', '5'), row('k2', '5', '3')])).toMatchObject({ state: 'invalid', reason: 'Discount 2: each percent must be bigger than the one before.' })
    const six = Array.from({ length: 6 }, (_, i) => row(`k${i}`, String(i + 2), String(i + 1)))
    expect(tiers(six)).toMatchObject({ state: 'invalid', reason: 'Amazon takes 1 to 5 quantity discounts; this has 6.' })
  })

  it('marks the entries that are no number, by row and field; an empty one is not marked yet', () => {
    const marked = tierFieldProblems({ tierType: 'percent', tiers: [row('k1', 'two', '3'), row('k2', '5', 'x'), row('k3', '', '')] })
    expect([...marked.keys()]).toEqual(['k1:minQty', 'k2:value'])
  })

  it('a quantity discounts mode starts with one suggested row; an opening value comes back in its rows; the request key tells tiers apart', () => {
    const start = modeRaw({ input: 'tiers' }, TODAY)
    expect(start.tiers.map((t) => [t.minQty, t.value])).toEqual([['2', '3']])
    expect(start.tierType).toBe('percent')
    const back = rawFromInput({ input: 'tiers' }, { tiers: { type: 'fixed', levels: [{ minQty: 3, value: 85 }] } }, TODAY)
    expect([back.tierType, back.tiers.map((t) => [t.minQty, t.value])]).toEqual(['fixed', [['3', '85']]])
    expect(rawFromInput({ input: 'percent' }, { percent: 5 }, TODAY).text).toBe('5')
    const key = (levels: Array<{ minQty: number; value: number }>) => requestKey({ field: 'businessTiers', mode: 'tiers-set', input: { tiers: { type: 'percent', levels } }, coordinateKeys: ['AMAZON:IT'] })
    expect(key([{ minQty: 2, value: 3 }])).not.toBe(key([{ minQty: 2, value: 4 }]))
    expect(key([{ minQty: 2, value: 3 }])).toBe(key([{ minQty: 2, value: 3 }]))
  })

  it('the next step names what is missing in plain words', () => {
    const field = { held: null, perMarket: true }
    const mode = { id: 'tiers-set' as const, input: 'tiers' as const, inputLabel: 'Quantity discounts' }
    expect(nextStep({ field, mode, parsed: tiers([]), ticked: 1 })!.short).toBe('Add a quantity discount')
    expect(nextStep({ field, mode, parsed: tiers([row('k1', '2', '')]), ticked: 1 })!.short).toBe('Fill in every quantity discount')
    expect(nextStep({ field, mode: { id: 'b2b-percent', input: 'percent', inputLabel: 'Percent below the price' }, parsed: percent(''), ticked: 1 })!.short).toBe('Enter the percent below the price')
  })
})
