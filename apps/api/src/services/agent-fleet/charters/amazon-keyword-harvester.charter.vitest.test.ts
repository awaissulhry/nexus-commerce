/**
 * Harvest fix B15 — the ads analysts' charters name no business: the fleet runs in every business and the repository is
 * public, so their prompts say "this business". The rest of each charter is as it was.
 */
import { describe, expect, it } from 'vitest'
import { amazonKeywordHarvesterCharter } from './amazon-keyword-harvester.charter.js'
import { amazonAdsDirectorCharter } from './amazon-ads-director.charter.js'
import { amazonBidTunerCharter } from './amazon-bid-tuner.charter.js'
import { amazonNegativeMinerCharter } from './amazon-negative-miner.charter.js'

describe('harvest fix B15 — the keyword harvester\'s charter', () => {
  it('says "this business" and describes no business, trade or home market', () => {
    const prompt = amazonKeywordHarvesterCharter.systemPrompt
    expect(prompt).toContain('for this business')
    expect(prompt).not.toMatch(/\bseller\b|-primary\b/i)
  })

  it('keeps its one lever, its findings and its caps', () => {
    expect(amazonKeywordHarvesterCharter).toMatchObject({ key: 'amazon-keyword-harvester', version: 1, autonomyCap: 'OBSERVE', observationKeys: ['harvest-candidates'], toolNames: [] })
    expect(amazonKeywordHarvesterCharter.systemPrompt).toContain("kind 'harvest_candidate'")
    expect(amazonKeywordHarvesterCharter.systemPrompt).toContain('<kind>:<entityId>')
  })
})

describe('harvest fix B15 — the other ads charters say "this business" too', () => {
  for (const c of [amazonAdsDirectorCharter, amazonBidTunerCharter, amazonNegativeMinerCharter]) {
    it(`${c.key}: "this business", no seller described, no home market`, () => {
      expect(c.systemPrompt).toContain('this business')
      expect(c.systemPrompt).not.toMatch(/\bseller\b|-primary\b/i)
    })
  }
})
