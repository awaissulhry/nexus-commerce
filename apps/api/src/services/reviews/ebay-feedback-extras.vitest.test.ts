/**
 * Reviews › eBay page (PR G) — the pure halves of the two sections eBay's REST Feedback API makes real: eBay's AI topics
 * counted over the stored feedback, the revision requests (eBay's state of each feedback, what can still be asked) and
 * eBay's yearly allowance in words.
 */
import { describe, expect, it } from 'vitest'
import { countEbayTopics, revisionAllowance, revisionRows } from './ebay-feedback-extras.service.js'

const NOW = new Date('2026-10-27T10:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('eBay’s AI topics', () => {
  it('counts each topic once per feedback, with its mood, most mentioned first', () => {
    const out = countEbayTopics([
      { channelTopics: [{ topic: 'shipping', sentiment: 'POSITIVE' }, { topic: 'shipping', sentiment: 'POSITIVE' }, { topic: 'fit', sentiment: 'NEGATIVE' }] },
      { channelTopics: [{ topic: 'shipping', sentiment: 'NEGATIVE' }] },
      { channelTopics: [] },
      { channelTopics: null },
      { channelTopics: 'broken' },
    ])
    expect(out.read).toBe(3)
    expect(out.words).toBeNull()
    expect(out.topics).toEqual([
      { topic: 'shipping', label: 'Shipping', count: 2, positive: 1, negative: 1, neutral: 0 },
      { topic: 'fit', label: 'Fit & sizing', count: 1, positive: 0, negative: 1, neutral: 0 },
    ])
  })

  it('says why nothing shows: not read yet, or eBay found none', () => {
    expect(countEbayTopics([{ channelTopics: null }]).words).toMatch(/has not read this feedback yet/)
    expect(countEbayTopics([{ channelTopics: [] }]).words).toBe('eBay found no topics in this feedback.')
  })
})

describe('revision requests', () => {
  const row = (id: string, over: Partial<Parameters<typeof revisionRows>[0][number]> = {}) => ({
    id, authorName: `buyer-${id}`, marketplace: 'IT', rating: 1, postedAt: daysAgo(5), feedbackState: 'ENTERED', revisionEligible: false, feedbackStateAt: daysAgo(4), ...over,
  })

  it('lists eBay’s revision states and the neutral or negative feedback that can still be asked, can-ask first', () => {
    const out = revisionRows([
      row('waiting', { feedbackState: 'REVISION_OPEN' }),
      row('revised', { feedbackState: 'REVISED', postedAt: daysAgo(40) }),
      row('no', { feedbackState: 'REVISION_DECLINED_OR_EXPIRED' }),
      row('ask-late', { revisionEligible: true, postedAt: daysAgo(25), rating: 3 }),
      row('ask-early', { revisionEligible: true, postedAt: daysAgo(2) }),
      row('positive', { revisionEligible: true, rating: 5 }),
      row('too-old', { revisionEligible: true, postedAt: daysAgo(31) }),
      row('plain', {}),
    ], NOW)
    expect(out.rows.map((r) => [r.id, r.words])).toEqual([
      ['ask-late', 'Can be asked in Seller Hub'],
      ['ask-early', 'Can be asked in Seller Hub'],
      ['waiting', 'Waiting for the buyer'],
      ['no', 'Buyer said no, or 10 days passed'],
      ['revised', 'Revised by the buyer'],
    ])
    expect(out.rows[0]).toMatchObject({ type: 'neutral', daysLeft: 5, canAsk: true, stateSince: null })
    expect(out.rows[2]).toMatchObject({ type: 'negative', canAsk: false, daysLeft: null, stateSince: daysAgo(4).toISOString() })
    expect(out.counts).toEqual({ waiting: 1, revised: 1, declined: 1, canAsk: 2 })
  })

  it('counts eBay’s allowance: 5 a year, plus 5 per 1,000 feedback received that year', () => {
    expect(revisionAllowance(2026, 999, 1)).toMatchObject({ allowed: 5, seen: 1 })
    expect(revisionAllowance(2026, 2400, 0).allowed).toBe(15)
    expect(revisionAllowance(2026, 1200, 2).words).toBe('2026: about 10 requests allowed (Nexus counts 1,200 feedback received this year). Nexus saw 2 revision requests this year; eBay counts every request, including ones Nexus did not see.')
  })
})
