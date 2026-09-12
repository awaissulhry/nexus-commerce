/**
 * PES.7 — the cross-channel planner. The case that matters is the one the old 5-iteration loop
 * hid: five Amazon market targets are one destination.
 */
import { describe, expect, it } from 'vitest'

import {
  buildTargets, collisionGroups, collisionSentence, destinationOf, isEmpty, mechanismFor,
  mechanismNote, planHeadline, summarisePlan, type PublishTarget, type TargetRow,
} from './crossChannel'

const EU = ['IT', 'DE', 'FR', 'ES', 'UK']
const channels = [
  { id: 'AMAZON', markets: EU },
  { id: 'EBAY', markets: ['IT'] },
]

const row = (over: Partial<TargetRow> = {}): TargetRow =>
  ({ platform: 'AMAZON', marketplace: null, amazonSlot: 'MAIN', url: 'a.jpg', ...over })

describe('mechanismFor', () => {
  it('maps the three channels with a publish path', () => {
    expect(mechanismFor('AMAZON')).toBe('sp-api-global')
    expect(mechanismFor('EBAY')).toBe('ebay-inventory')
    expect(mechanismFor('SHOPIFY')).toBe('shopify-media')
  })

  it('names an unknown channel unsupported rather than guessing one', () => {
    expect(mechanismFor('ETSY')).toBe('unsupported')
  })
})

describe('buildTargets', () => {
  const listing: TargetRow[] = [
    ...Array.from({ length: 45 }, () => row({ marketplace: null })),
    row({ marketplace: 'IT' }), row({ marketplace: 'IT' }),
    ...Array.from({ length: 14 }, () => row({ marketplace: 'ES' })),
    row({ platform: 'EBAY', marketplace: null }),
  ]

  it('makes one target per channel-market the marketplace table declares', () => {
    const t = buildTargets({ channels, listing })
    expect(t.map((x) => x.key)).toEqual([
      'AMAZON:IT', 'AMAZON:DE', 'AMAZON:FR', 'AMAZON:ES', 'AMAZON:UK', 'EBAY:IT',
    ])
  })

  it('separates rows pinned to a market from those inherited from all-markets', () => {
    const t = buildTargets({ channels, listing })
    // Matches the measured split on GALE-JACKET: 45 on the all-markets layer, 2 pinned to IT.
    expect(t.find((x) => x.key === 'AMAZON:IT')).toMatchObject({ pinned: 2, inherited: 45 })
    expect(t.find((x) => x.key === 'AMAZON:ES')).toMatchObject({ pinned: 14, inherited: 45 })
    expect(t.find((x) => x.key === 'AMAZON:DE')).toMatchObject({ pinned: 0, inherited: 45 })
  })

  it('never counts another channel’s rows', () => {
    expect(buildTargets({ channels, listing }).find((x) => x.key === 'EBAY:IT'))
      .toMatchObject({ inherited: 1 })
  })

  it('gives a channel with no declared markets a single target', () => {
    const t = buildTargets({ channels: [{ id: 'SHOPIFY', markets: [] }], listing: [row({ platform: 'SHOPIFY' })] })
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ marketplace: null, pinned: 1 })
  })
})

describe('the five-markets-one-destination truth', () => {
  const targets = buildTargets({
    channels,
    listing: [row({ marketplace: null }), row({ platform: 'EBAY', marketplace: null })],
  })

  it('routes every Amazon market to the ASIN, not to the market', () => {
    const amazon = targets.filter((t) => t.channel === 'AMAZON')
    expect(new Set(amazon.map(destinationOf)).size).toBe(1)
    expect(destinationOf(amazon[0])).toBe('AMAZON:ASIN')
  })

  it('groups all five as one collision', () => {
    const groups = collisionGroups(targets)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(5)
  })

  it('says plainly that they overwrite each other', () => {
    const s = collisionSentence(collisionGroups(targets)[0])
    expect(s).toMatch(/IT, DE, FR, ES, UK all write the same set of pictures on AMAZON/)
    expect(s).toMatch(/whichever finishes last is what Amazon keeps/)
  })

  it('does not collide eBay with anything', () => {
    expect(collisionGroups(targets).flat().some((t) => t.channel === 'EBAY')).toBe(false)
  })

  it('ignores empty targets — nothing that sends nothing can overwrite anything', () => {
    // No rows at all: every target is empty, so there is no collision to warn about.
    const bare = buildTargets({ channels, listing: [] })
    expect(collisionGroups(bare)).toEqual([])
  })
})

describe('mechanismNote', () => {
  it('says the Amazon set is stored against the ASIN and shown everywhere', () => {
    const n = mechanismNote('sp-api-global')
    expect(n).toMatch(/stores images against the ASIN/)
    expect(n).toMatch(/does not give that market its own pictures/)
  })

  it('names the two mechanisms that would give per-country images, and that neither is automated', () => {
    const n = mechanismNote('sp-api-global')
    expect(n).toMatch(/Country-Specific Upload/)
    expect(n).toMatch(/A\+ Content/)
    expect(n).toMatch(/neither is automated from this screen/)
  })

  it('does not claim a publish path for a channel that has none', () => {
    expect(mechanismNote('unsupported')).toMatch(/no image publish path/)
  })
})

describe('summarisePlan / planHeadline', () => {
  const t = (over: Partial<PublishTarget>): PublishTarget => ({
    key: 'AMAZON:IT', channel: 'AMAZON', marketplace: 'IT', mechanism: 'sp-api-global',
    pinned: 1, inherited: 0, ...over,
  })

  it('counts destinations, not targets', () => {
    const s = summarisePlan([t({ key: 'AMAZON:IT' }), t({ key: 'AMAZON:DE', marketplace: 'DE' })])
    expect(s.selected).toBe(2)
    expect(s.destinations).toBe(1)
  })

  it('leads with the overwrite when targets outnumber destinations', () => {
    const headline = planHeadline({ selected: 5, destinations: 1, empty: 0, unsupported: 0 })
    expect(headline).toMatch(/5 targets, but only 1 destination — some of them overwrite each other/)
  })

  it('says so when each target is genuinely separate', () => {
    expect(planHeadline({ selected: 2, destinations: 2, empty: 0, unsupported: 0 }))
      .toMatch(/each writing somewhere different/)
  })

  it('handles an empty selection and a selection that sends nothing', () => {
    expect(planHeadline({ selected: 0, destinations: 0, empty: 0, unsupported: 0 })).toBe('Nothing selected.')
    expect(planHeadline({ selected: 3, destinations: 0, empty: 3, unsupported: 0 }))
      .toMatch(/would send any pictures/)
  })

  it('counts empty and unsupported targets separately', () => {
    const s = summarisePlan([
      t({ pinned: 0, inherited: 0 }),
      t({ key: 'ETSY:IT', channel: 'ETSY', mechanism: 'unsupported' }),
    ])
    expect(s.empty).toBe(1)
    expect(s.unsupported).toBe(1)
    expect(s.destinations).toBe(0)
  })

  it('isEmpty is true only when neither pinned nor inherited rows exist', () => {
    expect(isEmpty(t({ pinned: 0, inherited: 0 }))).toBe(true)
    expect(isEmpty(t({ pinned: 0, inherited: 3 }))).toBe(false)
  })
})
