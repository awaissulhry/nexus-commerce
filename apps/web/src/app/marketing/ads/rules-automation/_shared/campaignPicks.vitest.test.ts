/**
 * 4i (review 4.8, 4.10, 4.7) — the rule builder's campaign picker follows the rule's market and ad type, and a draft
 * holding picks the rule can never act on says so and drops them in one click (the save then passes 4c's check).
 */
import { describe, expect, it } from 'vitest'
import { campaignInScope, pickScopeTags, picksOutsideNotice, picksOutsideScope, ruleMarketOptions, type PickFacts } from './campaignPicks'

const c = (id: string, marketplace: string | null, adProduct = 'SP'): PickFacts => ({ id, marketplace, adProduct })
const ALL = [c('de-sp', 'DE'), c('it-sp', 'IT'), c('fr-sb', 'FR', 'SB'), c('de-sd', 'DE', 'SD'), c('es-sp', 'ES')]
const ids = (xs: PickFacts[]) => xs.map((x) => x.id)

describe('ruleMarketOptions — one list of markets (review 4.10)', () => {
  it('offers All markets plus the four live Amazon Ads markets, and no NL/BE/SE/PL', () => {
    const values = ruleMarketOptions().map((o) => o.value)
    expect(values).toEqual(['all', 'IT', 'DE', 'ES', 'FR'])
    expect(ruleMarketOptions().find((o) => o.value === 'DE')?.label).toBe('Germany (DE)')
  })

  it('keeps a stored market outside the list on screen, named as not connected', () => {
    const opts = ruleMarketOptions('NL')
    expect(opts.at(-1)).toEqual({ value: 'NL', label: 'Netherlands (NL) — not connected' })
    expect(ruleMarketOptions('DE')).toHaveLength(5)
    expect(ruleMarketOptions('all')).toHaveLength(5)
  })
})

describe('campaignInScope — what the picker offers', () => {
  it('a DE rule is offered DE campaigns only', () => {
    expect(ids(ALL.filter((x) => campaignInScope(x, { marketplace: 'DE' })))).toEqual(['de-sp', 'de-sd'])
  })

  it('All markets (or no market) offers every campaign', () => {
    expect(ALL.filter((x) => campaignInScope(x, { marketplace: 'all' }))).toHaveLength(5)
    expect(ALL.filter((x) => campaignInScope(x, { marketplace: null }))).toHaveLength(5)
  })

  it('a Placement rule is offered Sponsored Products only, in its market', () => {
    expect(ids(ALL.filter((x) => campaignInScope(x, { adProducts: ['SP'] })))).toEqual(['de-sp', 'it-sp', 'es-sp'])
    expect(ids(ALL.filter((x) => campaignInScope(x, { marketplace: 'DE', adProducts: ['SP'] })))).toEqual(['de-sp'])
  })

  it('the list says what it is narrowed to', () => {
    expect(pickScopeTags({ marketplace: 'DE', adProducts: ['SP'] })).toEqual(['DE only', 'Sponsored Products only'])
    expect(pickScopeTags({ marketplace: 'all' })).toEqual([])
  })
})

describe('picksOutsideScope + picksOutsideNotice — "Remove N picks outside DE"', () => {
  it('🔴 "Reclaim idle budget — DE": picks in IT/FR/ES are named, counted and removable', () => {
    const selected = [c('de-1', 'DE'), c('it-1', 'IT'), c('it-2', 'IT'), c('fr-1', 'FR'), c('es-1', 'ES')]
    const o = picksOutsideScope(selected, new Map(), { marketplace: 'DE' })
    expect(o.ids).toEqual(['it-1', 'it-2', 'fr-1', 'es-1'])
    const n = picksOutsideNotice(o, { marketplace: 'DE' })
    expect(n).toEqual({
      title: 'This rule can never change 4 of its 5 picked campaigns',
      sentence: 'It runs in DE only, and 4 picks are elsewhere (2 in IT, 1 in ES, 1 in FR). Nexus will not save the rule until they are removed.',
      button: 'Remove 4 picks outside DE',
    })
    // what the button leaves behind is a draft 4c accepts
    const kept = selected.filter((x) => !o.ids.includes(x.id))
    expect(picksOutsideNotice(picksOutsideScope(kept, new Map(), { marketplace: 'DE' }), { marketplace: 'DE' })).toBeNull()
  })

  it('a pick is judged on the LIVE campaign when the picker has it, as the server judges it', () => {
    const stored = [c('x', 'DE')] // stored copy says DE…
    const live = new Map([['x', c('x', 'IT')]]) // …the campaign row says IT
    expect(picksOutsideScope(stored, live, { marketplace: 'DE' }).ids).toEqual(['x'])
    expect(picksOutsideScope([c('y', 'IT')], new Map([['y', c('y', 'DE')]]), { marketplace: 'DE' }).ids).toEqual([])
  })

  it('a Placement rule names its non-SP picks', () => {
    const o = picksOutsideScope([c('a', 'IT'), c('b', 'IT', 'SB'), c('d', 'IT', 'SD')], new Map(), { adProducts: ['SP'] })
    expect(o.ids).toEqual(['b', 'd'])
    expect(picksOutsideNotice(o, { adProducts: ['SP'] })).toMatchObject({
      sentence: 'It can change Sponsored Products campaigns only, and 2 picks are not (1 Sponsored Brands, 1 Sponsored Display). Nexus will not save the rule until they are removed.',
      button: 'Remove 2 picks that are not Sponsored Products',
    })
  })

  it('both at once: one count, one button, both reasons', () => {
    const scope = { marketplace: 'DE', adProducts: ['SP'] }
    const o = picksOutsideScope([c('ok', 'DE'), c('it', 'IT'), c('sb', 'DE', 'SB'), c('both', 'FR', 'SB')], new Map(), scope)
    expect(o.ids).toEqual(['it', 'sb', 'both'])
    const n = picksOutsideNotice(o, scope)!
    expect(n.title).toBe('This rule can never change 3 of its 4 picked campaigns')
    expect(n.button).toBe('Remove 3 picks it can never change')
    expect(n.sentence).toContain('2 picks are elsewhere (1 in FR, 1 in IT)')
    expect(n.sentence).toContain('2 picks are not (2 Sponsored Brands)')
  })

  it('one pick reads in the singular; All markets never warns about markets', () => {
    const one = picksOutsideNotice(picksOutsideScope([c('i', 'IT')], new Map(), { marketplace: 'DE' }), { marketplace: 'DE' })!
    expect(one.button).toBe('Remove 1 pick outside DE')
    expect(one.sentence).toContain('1 pick is elsewhere (1 in IT)')
    expect(picksOutsideNotice(picksOutsideScope(ALL, new Map(), { marketplace: 'all' }), { marketplace: 'all' })).toBeNull()
  })
})
