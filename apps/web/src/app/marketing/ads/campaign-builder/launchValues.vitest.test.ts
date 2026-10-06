/**
 * W2-C — the launch values and the launch answer, as the builders read them.
 *   CC-29  a blank or zero bid/budget is refused with the campaigns named, never replaced by €0.75 / €10.
 *   CC-15  the campaigns a launch created come from `created[].campaignId` (the SP Super Wizard's AI Control read
 *          `campaignIds` / `campaigns[].id`, which the answer never had, so its plans held no campaigns).
 */
import { describe, expect, it } from 'vitest'
import { createdCampaignIds, missingBidOrBudget, positiveAmount } from './launchValues'

describe('CC-29 — no silent bid/budget substitution', () => {
  it('reads a positive amount, comma or dot; blank, zero, negative and text are not amounts', () => {
    expect(positiveAmount('0.75')).toBe(0.75)
    expect(positiveAmount('1,5')).toBe(1.5)
    expect(positiveAmount(2)).toBe(2)
    for (const bad of ['', '   ', '0', '0.00', '-1', 'abc', null, undefined]) expect(positiveAmount(bad as never)).toBeNull()
  })

  it('names every campaign with a missing bid or budget, and passes when all have both', () => {
    expect(missingBidOrBudget([{ name: 'A', bid: '0.5', budget: '10' }, { name: 'B', bid: '0.4', budget: '5' }])).toBeNull()
    const msg = missingBidOrBudget([{ name: 'A', bid: '', budget: '10' }, { name: 'B', bid: '0.4', budget: '0' }, { name: 'C', bid: '0.4', budget: '5' }])
    expect(msg).toContain('A, B')
    expect(msg).not.toContain('C')
  })

  it('shortens a long list', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, bid: '', budget: '' }))
    expect(missingBidOrBudget(rows)).toContain('A, B, C and 2 more')
  })
})

describe('CC-15 — the campaigns a launch created', () => {
  it('reads created[].campaignId, the field the launch answers with', () => {
    expect(createdCampaignIds({ ok: true, created: [{ name: 'x', campaignId: 'c1' }, { name: 'y', campaignId: 'c2' }] })).toEqual(['c1', 'c2'])
  })

  it('🔴 the old fields are not the answer: campaignIds / campaigns[].id alone give nothing', () => {
    expect(createdCampaignIds({ campaignIds: ['c1'], campaigns: [{ id: 'c2' }] })).toEqual([])
  })

  it('an answer with no created list, or rows without an id, gives no campaigns', () => {
    expect(createdCampaignIds(null)).toEqual([])
    expect(createdCampaignIds({ created: [{ name: 'x' }, { campaignId: '' }, null] })).toEqual([])
  })
})
