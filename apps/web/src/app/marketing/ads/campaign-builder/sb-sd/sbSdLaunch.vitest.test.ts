/**
 * W2-D — the SB/SD builder's launch logic (CC-11, CC-12).
 *
 * The creative limits mirror the API's `sbCreativeProblems` (Amazon's Sponsored Brands 4.0 document): the API is the
 * authority and is asked before anything is created; these keep the screen from offering a launch Amazon would refuse.
 */
import { describe, expect, it } from 'vitest'
import {
  SB_CREATIVE_CHOICES, SD_VIEWS_LOOKBACK_DAYS, partlyMadeSummary, sbCreativeAsins, sbCreativeScreenProblems, sbCreativeSpec,
} from './sbSdLaunch'

describe('CC-11 — the creative types the builder offers', () => {
  it('manual collection (current) first, then product collection (deprecated, still accepted) — no store spotlight or video', () => {
    expect(SB_CREATIVE_CHOICES.map((c) => c.key)).toEqual(['manualCollection', 'productCollection'])
    expect(sbCreativeSpec('productCollection').detail).toMatch(/deprecated it on 6 July 2026 but still accepts it/)
  })

  it('Amazon\'s limits per type: manual 3–10 products, title ≤ 32; product 1–3, headline ≤ 50', () => {
    expect(sbCreativeSpec('manualCollection')).toMatchObject({ asinsMin: 3, asinsMax: 10, headlineLabel: 'Title', headlineMax: 32 })
    expect(sbCreativeSpec('productCollection')).toMatchObject({ asinsMin: 1, asinsMax: 3, headlineLabel: 'Headline', headlineMax: 50 })
  })

  it('carries the first products picked up to the type\'s limit', () => {
    const picked = Array.from({ length: 12 }, (_, i) => `B0TEST${String(i).padStart(4, '0')}`)
    expect(sbCreativeAsins(picked, 'manualCollection')).toHaveLength(10)
    expect(sbCreativeAsins(picked, 'productCollection')).toHaveLength(3)
    expect(sbCreativeAsins(picked.slice(0, 2), 'manualCollection')).toEqual(picked.slice(0, 2))
  })

  it('says what stops the creative before it is previewed', () => {
    expect(sbCreativeScreenProblems('manualCollection', 'Ride', 2)).toEqual(['A manual collection needs at least 3 products; 2 picked.'])
    expect(sbCreativeScreenProblems('manualCollection', 'x'.repeat(33), 3)).toEqual(['Amazon allows 32 characters in a manual collection title.'])
    expect(sbCreativeScreenProblems('productCollection', '  ', 1)).toEqual(['Write a headline.'])
    expect(sbCreativeScreenProblems('productCollection', 'Ride in style', 5)).toEqual([])
    expect(sbCreativeScreenProblems('manualCollection', 'Ride in style', 4)).toEqual([])
  })
})

describe('CC-12 — the "viewed" audience window', () => {
  it('only the windows Amazon lists for views', () => {
    expect([...SD_VIEWS_LOOKBACK_DAYS]).toEqual([7, 14, 30, 60, 90])
  })
})

describe('CC-11 — a launch that stops part-way lists what is live, and deletes nothing', () => {
  it('names each thing on Amazon with its id, and says nothing was deleted', () => {
    const s = partlyMadeSummary([
      { what: 'Campaign "Brand IT", paused', amazonId: 'C-TEST-1' },
      { what: 'Ad group', amazonId: 'AG-TEST-1' },
    ], 'Amazon did not take the creative (logo rejected). The keywords were not added.')
    expect(s.title).toBe('Partly made: Amazon did not take the creative (logo rejected). The keywords were not added.')
    expect(s.items).toEqual(['Campaign "Brand IT", paused (Amazon C-TEST-1)', 'Ad group (Amazon AG-TEST-1)'])
    expect(s.note).toMatch(/Nothing was deleted: keep and finish them, or archive them/)
  })

  it('with nothing on Amazon, it says so instead of "partly made"', () => {
    const s = partlyMadeSummary([], 'the ad group was not created, so the campaign cannot serve.')
    expect(s.title).toMatch(/^Not made: /)
    expect(s.items).toEqual([])
    expect(s.note).toBe('Nothing was created on Amazon.')
  })

  it('counts without ids stay plain', () => {
    expect(partlyMadeSummary([{ what: '3 keywords' }], 'x').items).toEqual(['3 keywords'])
  })
})
