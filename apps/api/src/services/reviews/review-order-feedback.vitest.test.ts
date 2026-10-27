/**
 * The order page's "Manage Feedback" card (live audit A10): never "has not left you feedback" where Nexus does not read
 * the channel's feedback; Amazon gives Nexus only its 1–3 star feedback.
 */
import { describe, expect, it } from 'vitest'
import { orderFeedbackWords } from './review-order-feedback.js'

describe('orderFeedbackWords', () => {
  it('Amazon: not read says so; read and none says only 1–3 stars come to Nexus', () => {
    expect(orderFeedbackWords('AMAZON', false, false).words).toMatch(/^Not read: Nexus does not read Amazon seller feedback in this setup/)
    expect(orderFeedbackWords('AMAZON', true, false).words).toMatch(/^No 1–3 star feedback for this order in Nexus\. Amazon gives Nexus only/)
    expect(orderFeedbackWords('amazon', true, true).channel).toBe('AMAZON')
  })

  it('eBay: read every 30 minutes, or not read in this setup', () => {
    expect(orderFeedbackWords('EBAY', true, false).words).toBe('No feedback from this buyer in Nexus yet. Nexus reads eBay feedback every 30 minutes.')
    expect(orderFeedbackWords('EBAY', false, false).words).toMatch(/^Not read:/)
  })

  it('a channel with no seller feedback shows no card; no words name a setting', () => {
    expect(orderFeedbackWords('SHOPIFY', false, false)).toEqual({ channel: 'none', words: '' })
    for (const [c, r, f] of [['AMAZON', false, false], ['AMAZON', true, false], ['EBAY', false, false], ['EBAY', true, true]] as const) {
      expect(orderFeedbackWords(c, r, f).words).not.toMatch(/NEXUS_|has not left you feedback/)
    }
  })
})
