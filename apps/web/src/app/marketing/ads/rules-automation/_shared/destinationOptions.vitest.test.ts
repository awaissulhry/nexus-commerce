/**
 * destinationOptions (Keyword Harvest page F2, 2026-10-10) — the picker's places, from the `/destinations` tree.
 * Made-up names; no business figures.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEW_KEY, NO_PORTFOLIO_GROUP, PLANNED_GROUP, SUGGESTED_GROUP,
  destinationLabel, destinationOptions, fromValue, negateAtSourceFor, suggestedTo, toValue,
  type DestinationAdGroup, type DestinationCampaign, type HarvestDestinations,
} from './destinationOptions'

const group = (id: string, name: string, role: DestinationAdGroup['role'], extra: Partial<DestinationAdGroup> = {}): DestinationAdGroup =>
  ({ id, name, role, keywords: 3, productTargets: 0, serving: true, held: null, suggested: false, ...extra })
const campaign = (id: string, name: string, role: DestinationCampaign['role'], adGroups: DestinationAdGroup[]): DestinationCampaign =>
  ({ id, name, status: 'ENABLED', serving: true, role, biddingStrategy: null, adGroups, href: `/marketing/ads/campaigns/${id}` })

const tree = (over: Partial<HarvestDestinations> = {}): HarvestDestinations => ({
  market: 'IT',
  product: { id: 'p1', name: 'Jacket' },
  match: 'EXACT',
  suggested: { kind: 'existing', adGroupId: 'g-exact' },
  portfolios: [{
    id: 'pf1', name: 'Jacket IT', campaigns: [
      campaign('c-exact', 'Jacket IT Exact', 'EXACT', [group('g-exact', 'Exact group', 'EXACT')]),
      campaign('c-phrase', 'Jacket IT Phrase', 'PHRASE', [group('g-phrase', 'Phrase group', 'PHRASE')]),
      campaign('c-broad', 'Jacket IT Broad', 'BROAD', [group('g-broad', 'Broad group', 'BROAD', { held: { label: 'Found here', reason: 'The term comes from this ad group.' } })]),
      campaign('c-auto', 'Jacket IT Auto', 'AUTO', [group('g-auto', 'Auto group', 'AUTO', { held: { label: 'Takes no keywords', reason: 'An auto campaign takes no keywords.' } })]),
    ],
  }],
  unplaced: [campaign('c-shared', 'Shared Exact', 'EXACT', [group('g-shared', 'Exact group', 'EXACT')])],
  newCampaign: { name: 'Jacket | IT | Exact 2', adGroupName: 'Ad group', portfolio: { id: 'pf1', name: 'Jacket IT' }, held: null },
  stored: [],
  ...over,
})

describe('destinationOptions', () => {
  it('Suggested first (taken out of its portfolio), then each portfolio, then "No portfolio"; one option per Campaign › Ad group', () => {
    const opts = destinationOptions(tree())
    expect(opts.map((o) => [o.group, o.label])).toEqual([
      [SUGGESTED_GROUP, 'Jacket IT Exact › Exact group'],
      ['Jacket IT', 'Jacket IT Phrase › Phrase group'],
      ['Jacket IT', 'Jacket IT Broad › Broad group'],
      ['Jacket IT', 'Jacket IT Auto › Auto group'],
      [NO_PORTFOLIO_GROUP, 'Shared Exact › Exact group'],
    ])
    expect(opts[0].suggested).toBe(true)
  })

  it('every option carries its match word and is found by portfolio, campaign, ad group or match', () => {
    const [exact] = destinationOptions(tree())
    expect(exact.match).toBe('Exact')
    expect(exact.searchText).toContain('Jacket IT')
    expect(exact.searchText).toContain('Exact group')
  })

  it('held places stay listed with their reason and a short word — never hidden', () => {
    const broad = destinationOptions(tree()).find((o) => o.value === 'ag:g-broad')!
    expect(broad.heldReason).toBe('The term comes from this ad group.')
    expect(broad.heldLabel).toBe('Found here')
    expect(destinationOptions(tree()).find((o) => o.value === 'ag:g-phrase')!.heldReason).toBeUndefined()
  })

  it('a per-ad-group "suggested" counts too, and a held suggestion is still listed first, with its reason', () => {
    const t = tree({ suggested: null })
    t.portfolios[0].campaigns[1].adGroups[0].suggested = true
    expect(destinationOptions(t)[0].value).toBe('ag:g-phrase')
    const held = tree()
    held.portfolios[0].campaigns[0].adGroups[0].held = { label: 'Has this term', reason: 'This ad group already has the keyword.' }
    expect(destinationOptions(held)[0]).toMatchObject({ group: SUGGESTED_GROUP, heldLabel: 'Has this term' })
  })

  it('when the server suggests a NEW campaign, it is the first option (its key), held when the server holds it', () => {
    const t = tree({ suggested: { kind: 'new' } })
    const [first] = destinationOptions(t)
    expect(first).toMatchObject({ value: `new:${DEFAULT_NEW_KEY}`, label: 'New campaign · Jacket | IT | Exact 2', group: SUGGESTED_GROUP, match: 'Exact' })
    expect(destinationOptions(t, { newCampaignKey: 'k1' })[0].value).toBe('new:k1')
    t.newCampaign.held = { label: 'Two products', reason: 'Pick terms of one product first.' }
    expect(destinationOptions(t)[0].heldReason).toBe('Pick terms of one product first.')
  })

  it('planned new campaigns are places of their own, after the tree, never twice', () => {
    const opts = destinationOptions(tree(), { planned: [{ key: 'k1', name: 'Jacket | IT | Exact 3' }] })
    expect(opts.at(-1)).toMatchObject({ value: 'new:k1', group: PLANNED_GROUP, label: 'New campaign · Jacket | IT | Exact 3' })
    const dup = destinationOptions(tree({ suggested: { kind: 'new' } }), { planned: [{ key: DEFAULT_NEW_KEY, name: 'x' }] })
    expect(dup.filter((o) => o.value === `new:${DEFAULT_NEW_KEY}`)).toHaveLength(1)
  })

  it('no tree yet = no options', () => {
    expect(destinationOptions(null)).toEqual([])
  })
})

describe('values, the starting place, the source switch and the label', () => {
  it('the value round-trips the preview body\'s `to`', () => {
    expect(fromValue(toValue({ adGroupId: 'g|1' }))).toEqual({ adGroupId: 'g|1' })
    expect(fromValue(toValue({ newCampaign: 'k1' }))).toEqual({ newCampaign: 'k1' })
    expect(fromValue('ag:')).toBeNull()
    expect(fromValue('other')).toBeNull()
  })

  it('starts on the suggestion only when it can take the term', () => {
    expect(suggestedTo(tree())).toEqual({ adGroupId: 'g-exact' })
    const held = tree()
    held.portfolios[0].campaigns[0].adGroups[0].held = { label: 'Paused', reason: 'The campaign is paused.' }
    expect(suggestedTo(held)).toBeNull()
    expect(suggestedTo(tree({ suggested: { kind: 'new' } }), 'k9')).toEqual({ newCampaign: 'k9' })
    expect(suggestedTo(tree({ suggested: null }))).toBeNull()
  })

  it('"In source" is on by default; a stored destination set off wins, with the reason', () => {
    expect(negateAtSourceFor(tree(), { adGroupId: 'g-exact' })).toEqual({ on: true, why: null })
    const t = tree({ stored: [{ grain: 'product', scopeId: 'p1', match: 'EXACT', adGroup: { id: 'g-exact', name: 'Exact group' }, negateAtSource: false }] })
    expect(negateAtSourceFor(t, { adGroupId: 'g-exact' }, 'EXACT')).toEqual({ on: false, why: 'Off for this destination: your setting' })
    expect(negateAtSourceFor(t, { adGroupId: 'g-exact' }, 'PHRASE').on).toBe(true)
    expect(negateAtSourceFor(t, { newCampaign: 'k1' }).on).toBe(true)
  })

  it('names a chosen place', () => {
    expect(destinationLabel(tree(), { adGroupId: 'g-shared' })).toBe('Shared Exact › Exact group')
    expect(destinationLabel(tree(), { newCampaign: DEFAULT_NEW_KEY })).toBe('New campaign · Jacket | IT | Exact 2')
    expect(destinationLabel(tree(), { newCampaign: 'k1' }, [{ key: 'k1', name: 'Mine' }])).toBe('New campaign · Mine')
    expect(destinationLabel(tree(), { adGroupId: 'gone' })).toBeNull()
  })
})
