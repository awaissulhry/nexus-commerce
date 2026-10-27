/**
 * Reviews › eBay page — eBay's GetFeedback summary read: score, counts per period, the four detailed seller ratings,
 * eBay's refusal in words, eBay's % positive and several accounts combined. No network.
 */
import { describe, expect, it } from 'vitest'
import { combineSummaries, ebayFeedbackSummaryRequest, parseEbayFeedbackSummary, positivePercent, yearPeriod } from './ebay-feedback-summary.js'

const period = (days: number, count: number) => `<FeedbackPeriod><Count>${count}</Count><PeriodInDays>${days}</PeriodInDays></FeedbackPeriod>`
const rating = (key: string, value: string, count: number) => `<AverageRatingDetails><RatingDetail>${key}</RatingDetail><Rating>${value}</Rating><RatingCount>${count}</RatingCount></AverageRatingDetails>`

const ANSWER = `<?xml version="1.0" encoding="UTF-8"?>
<GetFeedbackResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <FeedbackDetailArray><FeedbackDetail><CommentText>Great</CommentText></FeedbackDetail></FeedbackDetailArray>
  <FeedbackScore>2431</FeedbackScore>
  <FeedbackSummary>
    <NegativeFeedbackPeriodArray>${period(30, 0)}${period(180, 2)}${period(365, 3)}</NegativeFeedbackPeriodArray>
    <NeutralFeedbackPeriodArray>${period(30, 1)}${period(180, 4)}${period(365, 7)}</NeutralFeedbackPeriodArray>
    <PositiveFeedbackPeriodArray>${period(30, 18)}${period(180, 90)}${period(365, 171)}</PositiveFeedbackPeriodArray>
    <SellerRatingSummaryArray>
      <AverageRatingSummary><FeedbackSummaryPeriod>ThirtyDays</FeedbackSummaryPeriod>${rating('ItemAsDescribed', '4.5', 10)}</AverageRatingSummary>
      <AverageRatingSummary><FeedbackSummaryPeriod>FiftyTwoWeeks</FeedbackSummaryPeriod>
        ${rating('ItemAsDescribed', '4.92', 176)}${rating('Communication', '5.0', 174)}${rating('ShippingTime', '4.8', 178)}${rating('ShippingAndHandlingCharges', '4.9', 175)}
      </AverageRatingSummary>
    </SellerRatingSummaryArray>
  </FeedbackSummary>
</GetFeedbackResponse>`

describe('the request', () => {
  it('asks for the feedback received as a seller, one entry per page (the summary is the point)', () => {
    const xml = ebayFeedbackSummaryRequest()
    expect(xml).toContain('<FeedbackType>FeedbackReceivedAsSeller</FeedbackType>')
    expect(xml).toContain('<DetailLevel>ReturnAll</DetailLevel>')
    expect(xml).toContain('<EntriesPerPage>1</EntriesPerPage>')
    expect(xml).not.toMatch(/Token|eBayAuthToken/)
  })
})

describe('the answer', () => {
  it('reads the score, the counts per period (shortest first) and the 52-week detailed ratings', () => {
    const parsed = parseEbayFeedbackSummary(ANSWER)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.summary.score).toBe(2431)
    expect(parsed.summary.periods).toEqual([
      { days: 30, positive: 18, neutral: 1, negative: 0 },
      { days: 180, positive: 90, neutral: 4, negative: 2 },
      { days: 365, positive: 171, neutral: 7, negative: 3 },
    ])
    expect(parsed.summary.dsrPeriod).toBe('FiftyTwoWeeks')
    expect(parsed.summary.dsr).toEqual([
      { key: 'ItemAsDescribed', label: 'Item as described', rating: 4.9, count: 176 },
      { key: 'Communication', label: 'Communication', rating: 5, count: 174 },
      { key: 'ShippingTime', label: 'Shipping time', rating: 4.8, count: 178 },
      { key: 'ShippingAndHandlingCharges', label: 'Shipping charges', rating: 4.9, count: 175 },
    ])
  })

  it('a missing rating is null, never 0; no summary at all is an empty summary', () => {
    const parsed = parseEbayFeedbackSummary('<GetFeedbackResponse><Ack>Success</Ack></GetFeedbackResponse>')
    expect(parsed).toEqual({
      ok: true,
      summary: {
        score: null,
        periods: [],
        dsrPeriod: null,
        dsr: [
          { key: 'ItemAsDescribed', label: 'Item as described', rating: null, count: 0 },
          { key: 'Communication', label: 'Communication', rating: null, count: 0 },
          { key: 'ShippingTime', label: 'Shipping time', rating: null, count: 0 },
          { key: 'ShippingAndHandlingCharges', label: 'Shipping charges', rating: null, count: 0 },
        ],
      },
    })
  })

  it("eBay's refusal comes back in words; an answer that is not eBay's says so", () => {
    expect(parseEbayFeedbackSummary('<GetFeedbackResponse><Ack>Failure</Ack><Errors><ShortMessage>Auth token is hard expired.</ShortMessage></Errors></GetFeedbackResponse>'))
      .toEqual({ ok: false, error: 'eBay refused the read: Auth token is hard expired.' })
    expect(parseEbayFeedbackSummary('<html>Bad gateway</html>')).toEqual({ ok: false, error: 'eBay sent an answer Nexus could not read.' })
  })
})

describe("eBay's numbers", () => {
  it('% positive is positive ÷ (positive + negative) over 12 months, one decimal; nothing counted → null', () => {
    const parsed = parseEbayFeedbackSummary(ANSWER)
    if (!parsed.ok) throw new Error('parse')
    expect(yearPeriod(parsed.summary)).toEqual({ days: 365, positive: 171, neutral: 7, negative: 3 })
    expect(positivePercent(yearPeriod(parsed.summary))).toBe(98.3)
    expect(positivePercent({ positive: 0, negative: 0 })).toBeNull()
    expect(positivePercent(null)).toBeNull()
    // No 365-day period: the longest one eBay sent.
    expect(yearPeriod({ periods: [{ days: 30, positive: 1, neutral: 0, negative: 0 }, { days: 180, positive: 5, neutral: 0, negative: 1 }] })?.days).toBe(180)
  })

  it('several accounts add up; each detailed rating is weighted by its number of ratings', () => {
    const a = { score: 1786, periods: [{ days: 365, positive: 115, neutral: 5, negative: 1 }], dsrPeriod: 'FiftyTwoWeeks' as const, dsr: [{ key: 'ItemAsDescribed', label: 'Item as described', rating: 5, count: 100 }] }
    const b = { score: 645, periods: [{ days: 365, positive: 56, neutral: 2, negative: 2 }], dsrPeriod: 'FiftyTwoWeeks' as const, dsr: [{ key: 'ItemAsDescribed', label: 'Item as described', rating: 4, count: 100 }] }
    const both = combineSummaries([a, b])!
    expect(both.score).toBe(2431)
    expect(both.periods).toEqual([{ days: 365, positive: 171, neutral: 7, negative: 3 }])
    expect(both.dsr[0]).toEqual({ key: 'ItemAsDescribed', label: 'Item as described', rating: 4.5, count: 200 })
    expect(both.dsr[1]).toMatchObject({ key: 'Communication', rating: null, count: 0 })
    expect(combineSummaries([a])).toBe(a)
    expect(combineSummaries([])).toBeNull()
  })
})
