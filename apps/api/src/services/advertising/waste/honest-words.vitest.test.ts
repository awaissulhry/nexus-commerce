/**
 * Negative Targeting page — HONEST items 13, 18, 19 (2026-10-27): every sentence says exactly what the data counts.
 *   19   a person is named by their own name ("A person" when Nexus has none); "You" only for the person looking
 *   18b  "still spends in" counts places where the words SPENT (never impressions alone), since the stop when it has one
 *   18c  the all-markets criteria's "elsewhere" is the page's default bar (never the first market's strategy); the Wasting
 *        tile's money says the windows of the rows it sums
 *   18d  a removal that lands in Nexus only (Amazon never had the negative) is not "archived at Amazon"
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { ownerOfActor, rowOwner, negativeOwner, viewerNamed, UNNAMED_PERSON, type OwnerNames } from './owner.js'
import { dayIndex, totalsOf, type WasteRow } from './pure.js'
import { criteriaOfAll, servingPlaces, type WasteFacts } from './read.js'
import { removalLands } from './write.js'

const NOW = new Date('2026-10-27T10:00:00Z')
const TODAY = dayIndex(NOW)

describe('HONEST 19 — a person by their own name, "You" only for the person looking', () => {
  const names: OwnerNames = { rules: new Map(), claudeChangeSets: new Set(), people: new Map([['user:u1', 'Test person one']]) }

  it('a person on record reads their name; one Nexus has no name for reads "A person" — never "You"', () => {
    expect(ownerOfActor('user:u1', names)).toEqual({ kind: 'PERSON', name: 'Test person one', id: 'u1' })
    expect(ownerOfActor('user:u2', names)).toEqual({ kind: 'PERSON', name: UNNAMED_PERSON, id: 'u2' })
    expect(rowOwner({ hold: { by: null } }, NOW.getTime(), names)).toEqual({ kind: 'PERSON', name: UNNAMED_PERSON, id: null })
    expect(negativeOwner({ origin: 'PERSON', create: { actor: 'user:u1', executionId: null, evidence: null } }, names)).toEqual({ kind: 'PERSON', name: 'Test person one', id: 'u1' })
    expect(negativeOwner({ origin: 'PERSON' }, names).name).toBe(UNNAMED_PERSON)
    for (const o of [ownerOfActor('user:u1', names), ownerOfActor('user:u2', names), negativeOwner({ origin: 'PERSON' }, names)]) expect(o.name).not.toBe('You')
  })

  it('viewerNamed: the person looking reads "You" (owners and by refs); everyone else, rules and Claude keep their names', () => {
    const answer = {
      rows: [
        { owner: { kind: 'PERSON', name: 'Test person one', id: 'u1' }, lastChange: { by: { id: 'u1', name: 'Test person one' } }, waiting: { by: { id: 'u2', name: 'A person' } } },
        { owner: { kind: 'RULE', name: 'Stop waste', id: 'u1' }, at: '2026-10-20T00:00:00.000Z' },
      ],
    }
    const seen = viewerNamed(answer, 'u1')
    expect(seen.rows[0]).toEqual({ owner: { kind: 'PERSON', name: 'You', id: 'u1' }, lastChange: { by: { id: 'u1', name: 'You' } }, waiting: { by: { id: 'u2', name: 'A person' } } })
    // Another kind with the same id is never a person.
    expect(seen.rows[1].owner.name).toBe('Stop waste')
    expect(seen.rows[1].at).toBe('2026-10-20T00:00:00.000Z')
    // No one looking: as is (the MCP tools, a read without a session).
    expect(viewerNamed(answer, null)).toBe(answer)
    expect(answer.rows[0].owner.name).toBe('Test person one')
  })
})

describe('HONEST 18b — servingPlaces counts places where the words SPENT, since the stop when there is one', () => {
  const place = (adGroupId: string, lastSpendDay: number | null) => ({ adGroupId, campaignId: 'c1', key: 'made up boots', text: 'made up boots', lastSpendDay, vias: new Map() })
  const f = {
    now: NOW,
    campaigns: new Map([['c1', { id: 'c1', live: true }]]),
    adGroups: new Map(['g0', 'g1', 'g2', 'g3', 'g4'].map((id) => [id, { id, campaignId: 'c1', live: id !== 'g4' }])),
    negByGroup: new Map(), negByCampaign: new Map(), targetByExt: new Map(),
    placesByKey: new Map([['made up boots', [
      place('g0', TODAY - 5), // the row's own place
      place('g1', TODAY - 10), // spent 10 days ago
      place('g2', TODAY - 45), // spent only 45 days ago
      place('g3', null), // shown (impressions), never a click: no spend
      place('g4', TODAY - 5), // spent, but the ad group does not run
    ]]]),
  } as unknown as WasteFacts

  it('in the window: spend only (an impression alone is not spend), never the own place or a place that does not run', () => {
    expect(servingPlaces(f, 'made up boots', 'g0')).toEqual(['g1', 'g2'])
  })
  it('since a stop 40 days ago: only where it spent after the stop day', () => {
    expect(servingPlaces(f, 'made up boots', 'g0', TODAY - 40)).toEqual(['g1'])
    expect(servingPlaces(f, 'made up boots', 'g0', TODAY - 10)).toEqual([])
  })
})

describe('HONEST 18c — the window words', () => {
  const facts = (market: string, bar: unknown) => ({ now: NOW, markets: [market], marketNegateBar: new Map([[market, bar]]) }) as unknown as WasteFacts
  const strategy = { source: 'strategy', by: { id: 'strategy', name: 'the ads strategy: market' }, minClicks: 9, minSpendCents: 900, maxOrders: 1, windowDays: 90 }

  it('every market: a market with an ads strategy says its own bar; "elsewhere" is the page\'s default, never that market\'s', () => {
    const c = criteriaOfAll([facts('DE', strategy), facts('IT', null)], null)
    expect(c.sentence).toMatch(/^Every market \(DE, IT\)/)
    expect(c.sentence).toContain('DE: search terms follow the ads strategy: market: 9 clicks or more, spend at its minimum, at most 1 order, 90 days')
    expect(c.sentence).toMatch(/Elsewhere: Search terms: 0 orders, clicks at least max\(20/)
    // The first market's strategy is never read as the bar of the others.
    expect(c.sentence.split('Elsewhere:')[1]).not.toMatch(/9 clicks|ads strategy/)
    // Every market names its own: no "elsewhere" at all.
    const both = criteriaOfAll([facts('DE', strategy), facts('IT', { ...strategy, minClicks: 12 })], null)
    expect(both.sentence).not.toMatch(/Elsewhere/)
    expect(both.sentence).toContain('IT: search terms follow the ads strategy: market: 12 clicks or more')
  })

  it('the Wasting tile\'s money names the windows of the rows it sums', () => {
    const row = (id: string, windowDays: number, e: Partial<WasteRow> = {}): WasteRow => ({
      id, kind: 'TERM', text: id, match: 'BROAD', channel: 'AMAZON', market: 'IT', currency: 'EUR', portfolio: null,
      campaign: { id: 'c', name: 'c' }, adGroup: { id: 'g', name: 'g' }, product: null, productCount: 1, via: null, state: 'RUNNING',
      owner: { kind: 'NONE', name: '—', id: null }, verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null },
      test: { met: true, by: null, sentence: '', windowDays, clicksNeeded: 20, spendBarCents: 100, xCpaBar: 1.5 },
      d: { impressions: 0, clicks: 30, orders: 0, spendCents: 500, salesCents: 0, acosPct: null, cpcCents: 17, xCpa: 2 },
      d90: null, spark: [], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null, clash: null, ...e,
    })
    expect(totalsOf([row('a', 60), row('b', 60)], 'wasting', { negated: 0 }).wastingWindows).toEqual([60])
    expect(totalsOf([row('a', 90), row('b', 30), row('c', 60, { test: { ...row('x', 60).test, met: false } })], 'wasting', { negated: 0 }).wastingWindows).toEqual([30, 90])
  })
})

describe('HONEST 18d — a removal Amazon never had changes Nexus only', () => {
  it('lands in Nexus: not final at Amazon, lets nothing spend again; at Amazon: final, as before', () => {
    const base = { action: 'REMOVE_NEGATIVE' as const, final: true, raise: true }
    expect(removalLands(base, 'nexus')).toEqual({ final: false, raise: false })
    expect(removalLands(base, 'amazon')).toEqual({ final: true, raise: true })
    expect(removalLands({ action: 'TURN_ON', final: false, raise: true }, 'nexus')).toEqual({ final: false, raise: true })
  })
})
