/**
 * HONEST 8, 9 (2026-10-27) — the page's side of the server's guard: a bulk plan reads the full rows (a held row is left
 * out with why), the Where tab's "Add negative exact" is held with the server's reason, and a search term whose every
 * buying keyword is paused says so (never "Running · Wasting", never a Stopped negative's "Paused"). Made-up values.
 */
import { describe, expect, it } from 'vitest'
import { isPausedTerm, KEYWORD_PAUSED, placeNegateHeld, stateChip, stateSentence, wasteBulkPlan, wasteVerb } from './wasteModel'
import type { StoppedRow, WasteRow } from './wasteTypes'

const ref = (id: string) => ({ id, name: id, href: `/x/${id}` })
const term = (over: Partial<WasteRow> = {}): WasteRow => ({
  id: 'term:IT|EXT1|made up boots', kind: 'TERM', text: 'made up boots', match: 'BROAD', channel: 'AMAZON', market: 'IT', currency: 'EUR',
  portfolio: null, campaign: ref('c1'), adGroup: ref('g1'), product: ref('p1'), productCount: 1, via: ref('k1'),
  state: 'RUNNING', owner: { kind: 'NONE', name: '—', id: null }, verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null },
  test: { met: true, by: null, sentence: 'Wastes', windowDays: 60, clicksNeeded: 20, spendBarCents: 1500, xCpaBar: 1.5 },
  d: { impressions: 800, clicks: 40, orders: 0, spendCents: 4000, salesCents: 0, acosPct: null, cpcCents: 100, xCpa: 4 },
  d90: { clicks: 40, orders: 0, spendCents: 4000 }, spark: [], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null, clash: null,
  ...over,
})

describe('HONEST 9 — a term whose every buying keyword is paused', () => {
  const paused = term({ state: 'PAUSED' })
  it('its chip and its words say why; never "Wasting"', () => {
    expect(isPausedTerm(paused)).toBe(true)
    expect(stateChip(paused)).toMatchObject({ word: 'Keyword paused', title: KEYWORD_PAUSED })
    expect(stateSentence(paused)).toBe(KEYWORD_PAUSED)
    expect(wasteVerb(paused)).toBeNull()
  })
  it('a bulk verb leaves it out with that reason', () => {
    expect(wasteBulkPlan([paused], 'negExact')).toEqual({ items: [], left: [{ id: paused.id, text: 'made up boots', why: KEYWORD_PAUSED }] })
  })
  it('a Stopped negative switched off (PAUSED too) and our paused keyword keep their own words', () => {
    const off = { id: 'neg:n1', kind: 'TERM', state: 'PAUSED', match: 'EXACT', level: 'AD_GROUP' } as unknown as StoppedRow
    expect(isPausedTerm(off)).toBe(false)
    expect(stateChip(off).word).toBe('Paused')
    expect(stateChip(term({ id: 'kw:k1', kind: 'KEYWORD', state: 'PAUSED' })).word).toBe('Paused')
  })
})

describe('HONEST 8 — the client plans from what holds each row', () => {
  it('a held row is left out with the server\'s reason', () => {
    const held = term({ verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: { label: 'New place', reason: 'The ad group is 5 days old: nothing is stopped in a place younger than 14 days.' } } })
    expect(wasteBulkPlan([held, term({ id: 'term:IT|EXT1|made up hats', text: 'made up hats' })], 'negExact')).toEqual({
      items: [{ rowId: 'term:IT|EXT1|made up hats', action: 'NEGATE_EXACT', where: 'adGroup' }],
      left: [{ id: held.id, text: 'made up boots', why: 'The ad group is 5 days old: nothing is stopped in a place younger than 14 days.' }],
    })
  })
  it('the Where tab\'s "Add negative exact": held by the write permission first, then by the term\'s own hold there', () => {
    expect(placeNegateHeld({}, null)).toBeNull()
    expect(placeNegateHeld({ held: { label: 'Harvested lately', reason: 'Harvest made "made up boots" a keyword 4 days ago.' } }, null)).toBe('Harvest made "made up boots" a keyword 4 days ago.')
    expect(placeNegateHeld({ held: { label: 'Our keyword', reason: '' } }, null)).toBe('Our keyword')
    expect(placeNegateHeld({ held: { label: 'Our keyword', reason: 'x' } }, 'You may not change ads here')).toBe('You may not change ads here')
  })
})
