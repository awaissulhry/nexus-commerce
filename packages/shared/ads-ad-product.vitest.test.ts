/**
 * 6a — which ad product a campaign is, and the one refusal sentence. The mutation layer, the write gate, the
 * placement path, the marketing adapter and Claude's change tools all read these, so a Sponsored Brands or Display
 * campaign is refused in the same words everywhere and a Sponsored Products one never is.
 */
import { describe, it, expect } from 'vitest'
import { adProductOf, adProductLabel, adProductRefusal, adWriteRefusal, budgetPeriodOf, isLifetimeBudget, AD_PRODUCT_UNSUPPORTED, SPONSORED_PRODUCTS, type AdWrite } from './ads-ad-product.js'

describe('adProductOf — v1 column first, legacy type second', () => {
  it('reads the v1 adProduct column', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_PRODUCTS', type: 'SP' })).toBe('SPONSORED_PRODUCTS')
    expect(adProductOf({ adProduct: 'SPONSORED_BRANDS', type: 'SB' })).toBe('SPONSORED_BRANDS')
    expect(adProductOf({ adProduct: 'SPONSORED_DISPLAY', type: 'SD' })).toBe('SPONSORED_DISPLAY')
  })

  it('falls back to the required legacy type when the v1 column is empty (old rows)', () => {
    expect(adProductOf({ adProduct: null, type: 'SP' })).toBe('SPONSORED_PRODUCTS')
    expect(adProductOf({ adProduct: '', type: 'SB' })).toBe('SPONSORED_BRANDS')
    expect(adProductOf({ type: 'SD' })).toBe('SPONSORED_DISPLAY')
    expect(adProductOf({ type: 'DSP' })).toBe('DSP')
  })

  it('the v1 column wins over a type that disagrees, as the sync writes it', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_BRANDS', type: 'SP' })).toBe('SPONSORED_BRANDS')
  })

  it('an unrecognised value stays itself — never read as Sponsored Products', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_TELEVISION', type: 'SP' })).toBe('SPONSORED_TELEVISION')
    expect(adProductOf({ adProduct: 'something new' })).toBe('SOMETHING NEW')
  })

  it('null when neither column says', () => {
    expect(adProductOf({})).toBeNull()
    expect(adProductOf({ adProduct: null, type: null })).toBeNull()
    expect(adProductOf(null)).toBeNull()
    expect(adProductOf(undefined)).toBeNull()
  })
})

describe('adProductRefusal — one sentence, null for Sponsored Products', () => {
  it('never refuses a Sponsored Products campaign, from either column', () => {
    expect(adProductRefusal({ adProduct: SPONSORED_PRODUCTS, name: 'Italy exact' })).toBeNull()
    expect(adProductRefusal({ type: 'SP', name: 'Italy exact' })).toBeNull()
  })

  it('refuses Sponsored Brands and Display by name, saying what it is and where to make the change', () => {
    const sb = adProductRefusal({ adProduct: 'SPONSORED_BRANDS', type: 'SB', name: 'Italy brands' })
    // W4-11 — "this change": Nexus now sends some SB/SD changes; the sentence is true of the change it refuses.
    expect(sb).toBe("Italy brands is not a Sponsored Products campaign (it is Sponsored Brands). Nexus makes this change for Sponsored Products campaigns only, so nothing was sent to Amazon; make it in Amazon's advertising console.")
    expect(adProductRefusal({ type: 'SD', name: 'GALE Display IT' })).toMatch(/^GALE Display IT is not a Sponsored Products campaign \(it is Sponsored Display\)\./)
    expect(adProductRefusal({ type: 'DSP' })).toMatch(/^This campaign is not a Sponsored Products campaign \(it is Amazon DSP\)\./)
  })

  it('an unknown ad product is refused by default (fail closed) and allowed only when the caller says so', () => {
    expect(adProductRefusal({ name: 'Mystery' })).toMatch(/^Mystery is not a Sponsored Products campaign\. Nexus makes this change/)
    expect(adProductRefusal({ name: 'Mystery' }, { unknown: 'allow' })).toBeNull()
    // 'allow' is about the unknown only: a known Sponsored Brands campaign is still refused.
    expect(adProductRefusal({ type: 'SB' }, { unknown: 'allow' })).toMatch(/it is Sponsored Brands/)
  })

  it('labels and the deniedAt code', () => {
    expect(adProductLabel('SPONSORED_BRANDS')).toBe('Sponsored Brands')
    expect(adProductLabel(null)).toBeNull()
    expect(AD_PRODUCT_UNSUPPORTED).toBe('ad_product_unsupported')
  })
})

/** W4-11 — the SB and SD changes Nexus sends through their own endpoints; everything else keeps the refusal. */
describe('adWriteRefusal (W4-11)', () => {
  const SB = { adProduct: 'SPONSORED_BRANDS', type: 'SB', name: 'Brand test', costType: 'cpc', budgetJson: { budgetType: 'DAILY' } }
  const SD = { adProduct: 'SPONSORED_DISPLAY', type: 'SD', name: 'Display test', costType: 'CPC' }
  const ok = (c: object, w: AdWrite) => expect(adWriteRefusal(c, w)).toBeNull()
  const no = (c: object, w: AdWrite | null, re: RegExp) => expect(adWriteRefusal(c, w)).toMatch(re)

  it('never refuses Sponsored Products, whatever the write', () => {
    for (const w of [null, { entity: 'PLACEMENT' }, { entity: 'AD_GROUP', fields: ['defaultBid'] }] as Array<AdWrite | null>) {
      expect(adWriteRefusal({ adProduct: SPONSORED_PRODUCTS }, w)).toBeNull()
    }
  })

  it('a write that does not say what it is keeps the Sponsored-Products-only sentence', () => {
    expect(adWriteRefusal(SB, null)).toBe(adProductRefusal(SB))
    expect(adWriteRefusal({ adProduct: 'SPONSORED_TELEVISION', name: 'TV' }, { entity: 'CAMPAIGN', fields: ['dailyBudget'] })).toBe(adProductRefusal({ adProduct: 'SPONSORED_TELEVISION', name: 'TV' }))
  })

  it('a campaign: daily budget and on/off are sent; archive, placements, strategy and the rest are refused by name', () => {
    for (const c of [SB, SD]) {
      ok(c, { entity: 'CAMPAIGN', fields: ['dailyBudget'] })
      ok(c, { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'paused' })
      ok(c, { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'ENABLED' })
      no(c, { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'ARCHIVED' }, /— not archiving the campaign —/)
      no(c, { entity: 'CAMPAIGN', fields: ['biddingStrategy'] }, /— not the campaign's biddingStrategy —/)
      no(c, { entity: 'PLACEMENT' }, /— not a change to the placement adjustments —/)
      no(c, { entity: 'AD_GROUP', fields: ['defaultBid'] }, /— not a change to an ad group —/)
      no(c, { entity: 'PRODUCT_AD', fields: ['status'], toStatus: 'PAUSED' }, /— not a change to an ad —/)
    }
    no(SB, { entity: 'CAMPAIGN', fields: ['endDate'] }, /^Brand test is a Sponsored Brands campaign\. Nexus changes its daily budget and on\/off state, the bids and on\/off state of its keywords and product targets, and its negative keywords in an ad group \(add and retire\) — not the campaign's endDate — so nothing was sent to Amazon; make this change in Amazon's advertising console\.$/)
  })

  it('a target: bid and on/off of SB keywords and product targets, and of SD targets', () => {
    ok(SB, { entity: 'AD_TARGET', kind: 'KEYWORD', fields: ['bid'] })
    ok(SB, { entity: 'AD_TARGET', kind: 'PRODUCT', fields: ['bid', 'status'], toStatus: 'PAUSED' })
    no(SB, { entity: 'AD_TARGET', kind: 'AUDIENCE', fields: ['bid'] }, /not that kind of target/)
    ok(SD, { entity: 'AD_TARGET', kind: 'AUDIENCE', fields: ['bid'] })
    ok(SD, { entity: 'AD_TARGET', kind: 'PRODUCT', fields: ['status'], toStatus: 'ENABLED' })
    no(SD, { entity: 'AD_TARGET', kind: 'KEYWORD', fields: ['bid'] }, /not that kind of target/)
    no(SD, { entity: 'AD_TARGET', kind: 'PRODUCT', fields: ['status'], toStatus: 'ARCHIVED' }, /not archiving a target/)
  })

  it('negatives: SB keyword and SD product target in an ad group, added and retired; nothing else', () => {
    ok(SB, { entity: 'NEGATIVE_CREATE', kind: 'KEYWORD', negativeLevel: 'AD_GROUP' })
    no(SB, { entity: 'NEGATIVE_CREATE', kind: 'KEYWORD', negativeLevel: 'CAMPAIGN' }, /not a negative other than a keyword in an ad group/)
    no(SB, { entity: 'NEGATIVE_CREATE', kind: 'PRODUCT' }, /not a negative other than a keyword in an ad group/)
    ok(SD, { entity: 'NEGATIVE_CREATE', kind: 'PRODUCT', negativeLevel: null })
    no(SD, { entity: 'NEGATIVE_CREATE', kind: 'KEYWORD' }, /not a negative other than a product target \(an ASIN\) in an ad group/)
    ok(SB, { entity: 'AD_TARGET', kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP', fields: ['status'], toStatus: 'ARCHIVED' })
    ok(SD, { entity: 'AD_TARGET', kind: 'PRODUCT', isNegative: true, fields: ['status'], toStatus: 'archived' })
    no(SB, { entity: 'AD_TARGET', kind: 'KEYWORD', isNegative: true, fields: ['status'], toStatus: 'PAUSED' }, /not a change to a negative other than retiring it/)
  })

  it('an SB campaign with a lifetime budget: its budget is refused, its on/off is not', () => {
    const life = { ...SB, budgetJson: { budgetType: 'LIFETIME' } }
    no(life, { entity: 'CAMPAIGN', fields: ['dailyBudget'] }, /^Brand test is a Sponsored Brands campaign with a lifetime budget at Amazon\. Nexus sets a daily budget only/)
    ok(life, { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'PAUSED' })
    ok({ ...SB, budgetJson: { recurrenceTimePeriod: 'DAILY' } }, { entity: 'CAMPAIGN', fields: ['dailyBudget'] })
  })

  it('fails closed: an SB budget whose period Nexus has not read, and an SB/SD bid whose cost type it has not read, are refused', () => {
    no({ ...SB, budgetJson: null }, { entity: 'CAMPAIGN', fields: ['dailyBudget'] }, /^Brand test is a Sponsored Brands campaign, and Nexus has not read from Amazon whether its budget is daily or for the campaign's lifetime\./)
    no({ ...SB, budgetJson: { budgetType: 'MONETARY' } }, { entity: 'CAMPAIGN', fields: ['dailyBudget'] }, /has not read from Amazon whether its budget is daily/)
    ok({ ...SB, budgetJson: null }, { entity: 'CAMPAIGN', fields: ['status'], toStatus: 'PAUSED' })
    // SD has a daily budget only (SD 3.0 `budgetType: daily`): no period to read.
    ok({ ...SD, budgetJson: null }, { entity: 'CAMPAIGN', fields: ['dailyBudget'] })
    for (const c of [SB, SD]) no({ ...c, costType: null }, { entity: 'AD_TARGET', kind: c === SB ? 'KEYWORD' : 'PRODUCT', fields: ['bid'] }, /has not read from Amazon whether it pays per click \(CPC\) or per thousand viewable impressions \(vCPM\)/)
    ok({ ...SB, costType: null }, { entity: 'AD_TARGET', kind: 'KEYWORD', fields: ['status'], toStatus: 'PAUSED' })
  })

  it('an SB or SD bid in a vCPM campaign is refused: the bid limits are per click', () => {
    no({ ...SD, costType: 'vcpm' }, { entity: 'AD_TARGET', kind: 'AUDIENCE', fields: ['bid'] }, /^Display test is a Sponsored Display campaign that pays per thousand viewable impressions \(vCPM\)\. The ads strategy's bid limits and Nexus's bid floors are per click, so Nexus does not change its bids/)
    no({ ...SB, costType: 'VCPM' }, { entity: 'AD_TARGET', kind: 'KEYWORD', fields: ['bid'] }, /pays per thousand viewable impressions/)
    ok({ ...SD, costType: 'vcpm' }, { entity: 'AD_TARGET', kind: 'AUDIENCE', fields: ['status'], toStatus: 'PAUSED' })
  })

  it('budgetPeriodOf reads Amazon\'s budget object: daily, lifetime, or not read', () => {
    expect([budgetPeriodOf({ budgetType: 'DAILY' }), budgetPeriodOf({ recurrenceTimePeriod: 'lifetime' }), budgetPeriodOf({ budgetType: 'MONETARY' }), budgetPeriodOf(null)]).toEqual(['DAILY', 'LIFETIME', null, null])
  })

  it('isLifetimeBudget reads Amazon\'s budget object in either spelling', () => {
    expect(isLifetimeBudget({ budgetType: 'LIFETIME' })).toBe(true)
    expect(isLifetimeBudget({ recurrenceTimePeriod: 'lifetime' })).toBe(true)
    expect(isLifetimeBudget({ budgetType: 'DAILY' })).toBe(false)
    expect(isLifetimeBudget(null)).toBe(false)
  })
})
