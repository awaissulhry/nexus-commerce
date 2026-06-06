import { describe, it, expect } from 'vitest'
import { detectSelfCompetition, type CampaignTargeting } from './rank-self-competition.js'

const c = (campaignId: string, o: Partial<CampaignTargeting> = {}): CampaignTargeting => ({ campaignId, keywords: [], isAuto: false, acos: null, spendCents: 0, ...o })

describe('RD.6 detectSelfCompetition', () => {
  it('no overlap → nothing demoted', () => {
    const r = detectSelfCompetition([c('a', { keywords: ['misano|EXACT'] }), c('b', { keywords: ['rev3|EXACT'] })])
    expect(r.demoted.size).toBe(0)
    expect(r.conflicts).toHaveLength(0)
  })

  it('shared keyword → higher-ACOS campaign demoted', () => {
    const r = detectSelfCompetition([
      c('good', { keywords: ['misano jacket|EXACT'], acos: 0.2 }),
      c('bad', { keywords: ['misano jacket|EXACT'], acos: 0.6 }),
    ])
    expect(r.demoted.has('bad')).toBe(true)
    expect(r.demoted.has('good')).toBe(false)
  })

  it('two AUTO campaigns → worse one demoted', () => {
    const r = detectSelfCompetition([
      c('autoA', { isAuto: true, acos: 0.3 }),
      c('autoB', { isAuto: true, acos: 0.5 }),
    ])
    expect(r.demoted.has('autoB')).toBe(true)
    expect([...r.conflicts].some((x) => x.on === 'AUTO')).toBe(true)
  })

  it('a campaign that wins one contest is NOT demoted for losing another', () => {
    // A wins kw1 (vs B), B wins kw2 (vs C). B loses kw1 but wins kw2 → kept. C pure loser → demoted.
    const r = detectSelfCompetition([
      c('A', { keywords: ['kw1|EXACT'], acos: 0.1 }),
      c('B', { keywords: ['kw1|EXACT', 'kw2|EXACT'], acos: 0.2 }),
      c('C', { keywords: ['kw2|EXACT'], acos: 0.9 }),
    ])
    expect(r.demoted.has('B')).toBe(false)
    expect(r.demoted.has('C')).toBe(true)
    expect(r.demoted.has('A')).toBe(false)
  })

  it('unknown ACOS tie-break by higher spend (more proven keeps the slot)', () => {
    const r = detectSelfCompetition([
      c('proven', { keywords: ['k|PHRASE'], acos: null, spendCents: 5000 }),
      c('unproven', { keywords: ['k|PHRASE'], acos: null, spendCents: 100 }),
    ])
    expect(r.demoted.has('unproven')).toBe(true)
    expect(r.demoted.has('proven')).toBe(false)
  })
})
