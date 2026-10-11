import { describe, expect, it } from 'vitest'
import type { HarvestSourceRow } from '../_shared/types'
import {
  EVERY_RULE, SCOPE_REFUSAL, assignChanges, assignOptions, detachChanges, detachOptions, detachPlan, harvestingWord, isSourcesShow, pauseChanges, pauseHeld,
  roleWord, rowMatchesSearch, ruleReachOf, sourcesViewTotals, visibleSources, type RuleReach,
} from './sourcesModel'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })

function src(over: Partial<HarvestSourceRow> = {}): HarvestSourceRow {
  return {
    id: 'g1', adGroup: ref('g1', 'Auto group'), campaign: ref('c1', 'Jacket Auto'), portfolio: ref('p1', 'IT jackets'), product: ref('pr1', 'Jacket'),
    role: 'AUTO', rules: [], paused: null, terms: 10, sellingTerms: 2, harvested: 1,
    ...over,
  }
}
const mapRule = { id: 'm1', name: 'Mapping rule' }
const scopeRule = { id: 's1', name: 'Scope rule' }
const reach = new Map<string, RuleReach | null>([['m1', 'mapping'], ['m2', 'mapping'], ['s1', 'scope']])

describe('sources: tiles and the rows they show', () => {
  const rows = [
    src({ id: 'a', rules: [mapRule] }),
    src({ id: 'b', sellingTerms: 0 }),
    src({ id: 'c', paused: { by: 'user:u1', at: '2026-10-01T00:00:00Z' }, rules: [scopeRule] }),
  ]
  it('each tile counts exactly the rows its filter shows', () => {
    const t = sourcesViewTotals(rows)
    expect(t).toMatchObject({ sources: 3, withRule: 2, noRule: 1, converting: 2, paused: 1 })
    for (const tile of t.tiles) expect(visibleSources(rows, tile.id, '')).toHaveLength(tile.value)
    expect(t.tiles.map((x) => x.label)).toEqual(['With a rule', 'No rule', 'Selling groups · 60 d', 'Harvest off'])
    expect(sourcesViewTotals(rows, 30).tiles[2].label).toBe('Selling groups · 30 d')
  })
  it('search: ad group, campaign, portfolio, product, rules, kind', () => {
    expect(rowMatchesSearch(rows[0], 'mapping auto')).toBe(true)
    expect(rowMatchesSearch(rows[0], 'phrase')).toBe(false)
    expect(isSourcesShow('paused')).toBe(true)
    expect(isSourcesShow('on')).toBe(false)
  })
  it('words', () => {
    expect(roleWord('PRODUCT')).toBe('Product')
    expect(roleWord(null)).toBe('—')
    expect(harvestingWord(rows[2])).toBe('Off')
    expect(harvestingWord(rows[0])).toBe('On')
  })
})

describe('sources: the one window (HCORE S9)', () => {
  it('a selling source has a selling term in the window; the window is the read\'s', async () => {
    const { rowMatchesShow, windowWord } = await import('./sourcesModel')
    expect(rowMatchesShow(src({ sellingTerms: 0 }), 'converting')).toBe(false)
    expect(rowMatchesShow(src(), 'converting')).toBe(true)
    expect(windowWord(60)).toBe('60 d')
    expect(windowWord(null)).toBe('60 d')
  })
})

describe('sources: which rule can be assigned or detached here', () => {
  it('a builder rule reads its mapping; an engine rule its scope; anything else is no harvest rule', () => {
    expect(ruleReachOf([{ type: 'keyword-harvesting' }])).toBe('mapping')
    expect(ruleReachOf([{ type: 'harvest_and_negate' }])).toBe('scope')
    expect(ruleReachOf([{ type: 'promote_to_exact' }])).toBe('scope')
    expect(ruleReachOf([{ type: 'bid' }])).toBeNull()
    expect(ruleReachOf(null)).toBeNull()
  })
  it('Assign offers this market’s rules; a scope rule is held with why', () => {
    const out = assignOptions([{ id: 'm1', name: 'A', reach: 'mapping', offered: true }, { id: 's1', name: 'B', reach: 'scope', offered: true }, { id: 'x', name: 'C', reach: 'mapping', offered: false }])
    expect(out).toEqual([{ value: 'm1', label: 'A' }, { value: 's1', label: 'B', heldReason: SCOPE_REFUSAL, note: 'By its scope' }])
  })
  it('Detach offers the rules on the ticked rows (and "Every rule" when two can go)', () => {
    const rows = [src({ id: 'a', rules: [mapRule, scopeRule] }), src({ id: 'b', rules: [{ id: 'm2', name: 'Another' }] })]
    expect(detachOptions(rows, reach)).toEqual([
      { value: EVERY_RULE, label: 'Every rule here' },
      { value: 'm2', label: 'Another' },
      { value: 'm1', label: 'Mapping rule' },
      { value: 's1', label: 'Scope rule', heldReason: SCOPE_REFUSAL, note: 'By its scope' },
    ])
    expect(detachOptions([rows[0]], reach).map((o) => o.value)).toEqual(['m1', 's1'])
  })
})

describe('sources: the reviews', () => {
  const rows = [src({ id: 'a', rules: [mapRule] }), src({ id: 'b' }), src({ id: 'c', rules: [mapRule, scopeRule], paused: { by: 'user:u1', at: 'x' } })]
  it('assign: only the rows without the rule', () => {
    expect(assignChanges(rows, mapRule)).toEqual([{ id: 'b', where: 'Auto group · Jacket Auto', what: 'Rules', now: '—', next: 'Mapping rule' }])
    expect(assignChanges(rows, { id: 'm2', name: 'Another' }).map((c) => [c.id, c.next])).toEqual([['a', 'Mapping rule, Another'], ['b', 'Another'], ['c', 'Mapping rule, Scope rule, Another']])
  })
  it('detach: a scope rule stays (it cannot be detached here); the plan groups ad groups by rule', () => {
    expect(detachChanges(rows, 'm1', reach).map((c) => [c.id, c.now, c.next])).toEqual([['a', 'Mapping rule', '—'], ['c', 'Mapping rule, Scope rule', 'Scope rule']])
    expect(detachChanges(rows, 's1', reach)).toEqual([])
    expect([...detachPlan(rows, EVERY_RULE, reach)]).toEqual([['m1', ['a', 'c']]])
  })
  it('pause / resume: only rows whose harvesting changes; held with why', () => {
    expect(pauseChanges(rows, true).map((c) => [c.id, c.what, c.now, c.next, c.note ?? null])).toEqual([['a', 'Harvest from here', 'On', 'Off', null], ['b', 'Harvest from here', 'On', 'Off', null]])
    expect(pauseChanges(rows, false).map((c) => c.id)).toEqual(['c'])
    expect(pauseHeld([], true)).toBe('Tick at least one ad group')
    expect(pauseHeld([rows[2]], true)).toBe('Already off')
    expect(pauseHeld([rows[0]], false)).toBe('None of these is off')
    expect(pauseHeld(rows, true)).toBeNull()
  })
})
