/**
 * Negative Targeting page, step 4 — the words of the reach check in the review and of "Did it work?" on the
 * Stopped view: one line per negative, the sent ones together (money per currency, never added across them), the window
 * said once, the terms that sold (sent ones first, once per place), the Saved cell and the record's line — money only
 * when the server sent it. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { effectLine, previewSummary, reachLine, reachTotalLine, reachWindowWords, savedView, showsTogether, soldItems, soldNotes, sortOf, STOPPED_CSV_HEADERS, stoppedCsvRow, viewSort } from './wasteModel'
import type { PreviewStep, Reach, StoppedRow } from './wasteTypes'

const ref = (id: string, name = id) => ({ id, name })
const reach = (over: Partial<Reach> = {}): Reach => ({ windowDays: 60, currency: 'EUR', terms: 14, spendCents: 3200, clicks: 40, orders: 0, salesCents: 0, sold: [], ...over })
const step = (over: Partial<PreviewStep> = {}): PreviewStep => ({
  rowId: 'term:IT|X1|made up gloves', action: 'NEGATE_PHRASE', text: 'made up gloves', place: { portfolio: null, campaign: ref('c1', 'Gloves exact'), adGroup: ref('g1', 'Main') },
  from: 'RUNNING', to: 'NEGATED', lands: 'amazon', runsAt: null, refusal: null, raise: false, needsCode: false, tool: 'add-negative-targets', summary: null, level: 'AD_GROUP', final: false,
  reach: reach(), ...over,
})

describe('the review: what each negative would block', () => {
  it('one short line per negative; no money without ad spend; nothing seen says so', () => {
    expect(reachLine(reach())).toBe('Blocks 14 terms · €32.00 · 0 orders')
    expect(reachLine(reach({ terms: 1, orders: 1, spendCents: undefined }))).toBe('Blocks 1 term · 1 order')
    expect(reachLine(reach({ terms: 0, spendCents: 0 }))).toBe('Blocks no term seen here')
  })

  it('together, once; money per currency, never added across them; the window once', () => {
    expect(reachTotalLine({ windowDays: 60, currency: 'EUR', terms: 22, spendCents: 5400, clicks: 70, orders: 0, salesCents: 0, currencies: [{ currency: 'EUR', spendCents: 5400, salesCents: 0 }] }))
      .toBe('Together: blocks 22 terms · €54.00 · 0 orders')
    expect(reachTotalLine({ windowDays: null, currency: null, terms: 3, spendCents: null, clicks: 9, orders: 1, salesCents: null, currencies: [{ currency: 'EUR', spendCents: 500, salesCents: 0 }, { currency: 'GBP', spendCents: 300, salesCents: 0 }] }))
      .toBe('Together: blocks 3 terms · €5.00 + £3.00 · 1 order')
    // Without ad spend: counts only.
    expect(reachTotalLine({ windowDays: 60, currency: 'EUR', terms: 2, clicks: 3, orders: 0, currencies: [{ currency: 'EUR' }] })).toBe('Together: blocks 2 terms · 0 orders')
    expect(reachWindowWords(60)).toBe('Shows the last 60 days')
    expect(reachWindowWords(null)).toBe('Shows each market\'s own window')
  })

  it('the terms that sold: once per place, the sent ones first; the title says whether they are sent or left out', () => {
    const steps = [
      step({ reach: reach({ orders: 3, sold: [{ text: 'made up gloves', orders: 2 }, { text: 'warm made up gloves', orders: 1 }] }) }),
      // The same term in the same place through an exact: once.
      step({ action: 'NEGATE_EXACT', reach: reach({ terms: 1, orders: 2, sold: [{ text: 'made up gloves', orders: 2 }] }) }),
      // Left out (the tool's own hold: it converts there) in a whole campaign.
      step({ level: 'CAMPAIGN', place: { portfolio: null, campaign: ref('c2', 'Gloves broad'), adGroup: null }, refusal: { code: 'refused', label: 'converts' }, reach: reach({ sold: [{ text: 'made up mittens', orders: 5 }] }) }),
      step({ action: 'PAUSE', reach: undefined }),
    ]
    const items = soldItems(steps)
    expect(items.map((i) => [i.text, i.orders, i.where, i.leftOut])).toEqual([
      ['made up gloves', 2, 'Gloves exact › Main', false],
      ['warm made up gloves', 1, 'Gloves exact › Main', false],
      ['made up mittens', 5, 'Gloves broad · whole campaign', true],
    ])
    // Red only for what a sent step blocks; a calm note for the left-out ones (nothing that sold is blocked there).
    const notes = soldNotes(items)
    expect(notes.danger).toMatchObject({ title: 'Blocks 2 terms that sold' })
    expect(notes.danger!.items.map((i) => i.text)).toEqual(['made up gloves', 'warm made up gloves'])
    expect(notes.calm).toMatchObject({ title: 'Not blocked: 1 term that sold — left out' })
    expect(soldNotes(items.filter((i) => i.leftOut))).toMatchObject({ danger: null, calm: { title: 'Not blocked: 1 term that sold — left out' } })
    expect(soldNotes([])).toEqual({ danger: null, calm: null })
    expect(soldItems([step()])).toEqual([])
  })

  it('"Together" only for two negatives or more sent: one step\'s own line says it already', () => {
    expect(showsTogether([step()])).toBe(false)
    expect(showsTogether([step(), step({ refusal: { code: 'x', label: 'no' } })])).toBe(false)
    expect(showsTogether([step(), step({ action: 'NEGATE_EXACT' })])).toBe(true)
  })

  it('left out counts the steps the server leaves out and the ticked rows a bulk verb left out', () => {
    expect(previewSummary([step(), step({ refusal: { code: 'x', label: 'no' } })], 'it', 146)).toBe('Amazon IT · 1 to Amazon · 147 left out')
    expect(previewSummary([step()], 'it', 0)).toBe('Amazon IT · 1 to Amazon')
  })
})

describe('the Stopped view is ordered by the server', () => {
  it('a sort reaches the server only for the view that takes it; its column shows it', () => {
    expect(viewSort('stopped', '-saved')).toBe('-saved')
    expect(viewSort('stopped', 'spendBefore')).toBe('spendBefore')
    expect(viewSort('stopped', '-spend')).toBeNull()
    expect(viewSort('wasting', '-saved')).toBeNull()
    expect(viewSort('wasting', '-spend')).toBe('-spend')
    expect(sortOf('-saved')).toEqual({ colId: 'saved', dir: 'desc' })
    expect(sortOf('since')).toEqual({ colId: 'since', dir: 'asc' })
  })
})

function stopped(over: Partial<StoppedRow> = {}): StoppedRow {
  return {
    id: 'neg:n1', kind: 'TERM', text: 'made up socks', match: 'EXACT', level: 'AD_GROUP', market: 'IT', currency: 'EUR', portfolio: null, campaign: ref('c1'), adGroup: ref('g1'),
    product: null, owner: { kind: 'PERSON', name: 'You', id: 'u1' }, since: '2026-09-15T10:00:00.000Z', sinceSource: 'record', keptPaused: null, spendBeforeCents: 9000,
    state: 'NEGATED', stillServesIn: 0, places: 1,
    actions: { turnOn: { allowed: false, why: 'x' }, removeNegative: { allowed: true, why: 'x' }, release: { allowed: false, why: 'x' } },
    effect: { since: '2026-09-15T10:00:00.000Z', days: 40, verdict: 'SAVED', beforePerDayCents: 300, afterCents: 500, savedCents: 10600, words: 'Spends less here in the 37 days since the stop' },
    ...over,
  }
}

describe('the Stopped view: "Did it work?"', () => {
  it('Saved: the money, green; amber while it still spends elsewhere; below 0 with a real minus sign', () => {
    expect(savedView(stopped())).toEqual({ text: '€106.00', tone: 'ok', hint: 'Spends less here in the 37 days since the stop', cents: 10600 })
    expect(savedView(stopped({ effect: { ...stopped().effect!, verdict: 'STILL_SPENDS', words: 'Stopped here, but its words still spend in 1 other ad group' } }))).toMatchObject({ text: '€106.00', tone: 'warn' })
    expect(savedView(stopped({ effect: { ...stopped().effect!, savedCents: -300, words: 'Spends as much here as before, in the 17 days since the stop' } }))).toMatchObject({ text: '−€3.00', tone: 'muted' })
  })

  it('Too early for the first 14 days (no money claim); a dash when not known or without ad spend, why on hover', () => {
    expect(savedView(stopped({ effect: { since: 'x', days: 9, verdict: 'TOO_EARLY', beforePerDayCents: null, afterCents: null, savedCents: null, words: 'Stopped 9 days ago, checked from 14 days' } })))
      .toEqual({ text: 'Too early', tone: 'muted', hint: 'Stopped 9 days ago, checked from 14 days', cents: null })
    expect(savedView(stopped({ effect: null }))).toMatchObject({ text: '—', hint: 'Not known: the days before it stopped are older than Nexus keeps' })
    expect(savedView(stopped({ effect: null, since: null }))).toMatchObject({ text: '—', hint: 'Not known: when it stopped is not on record' })
    const hidden = { since: 'x', days: 40, verdict: 'SAVED' as const, words: 'Spends less here in the 37 days since the stop' }
    expect(savedView(stopped({ effect: hidden }))).toEqual({ text: '—', tone: 'muted', hint: hidden.words, cents: null })
  })

  it('the record\'s line: the saving, before and after; the words below', () => {
    expect(effectLine(stopped())).toEqual({ value: 'Saved €106.00 · before €3.00 a day · after €5.00', hint: 'Spends less here in the 37 days since the stop' })
    expect(effectLine(stopped({ effect: { since: 'x', days: 9, verdict: 'TOO_EARLY', words: 'Stopped 9 days ago, checked from 14 days' } }))).toEqual({ value: 'Too early', hint: 'Stopped 9 days ago, checked from 14 days' })
  })

  it('Export carries Saved beside Spend before', () => {
    const i = STOPPED_CSV_HEADERS.indexOf('Saved')
    expect(STOPPED_CSV_HEADERS[i - 1]).toBe('Spend before')
    expect(stoppedCsvRow(stopped())[i]).toBe('€106.00')
    expect(stoppedCsvRow(stopped({ effect: { since: 'x', days: 3, verdict: 'TOO_EARLY', words: 'w' } }))[i]).toBe('Too early')
  })
})
