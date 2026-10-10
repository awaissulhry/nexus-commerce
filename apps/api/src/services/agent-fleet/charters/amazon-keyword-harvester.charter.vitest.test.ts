/**
 * Harvest fix B15 — the keyword harvester's charter names no business: the fleet runs in every business and the repository
 * is public, so its prompt says "this business". The rest of the charter is as it was.
 */
import { describe, expect, it } from 'vitest'
import { amazonKeywordHarvesterCharter } from './amazon-keyword-harvester.charter.js'

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
