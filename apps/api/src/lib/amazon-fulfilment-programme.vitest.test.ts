/**
 * Amazon sheet gaps (D3) — Remote Fulfilment and the other Seller Central codes: what each means, in one place, and
 * the fail-closed FBA guard reading every code in BOTH places.
 */
import { describe, expect, it } from 'vitest'
import {
  amazonFulfilmentCodes, amazonFulfilmentOptionLabel, describeAmazonFulfilmentCode, hasFbaFulfilmentCode, keptAmazonFulfilmentCodes,
  normaliseAmazonFulfilmentCode,
} from './amazon-fulfilment-programme.js'
import { isFbaCoordinate } from './amazon-fulfillment.js'

describe('describeAmazonFulfilmentCode — the Owner\'s nine codes, two more routes, an unknown code and the Italian label', () => {
  it.each([
    ['AMAZON_EU', { kind: 'FBA', method: 'FBA', label: 'FBA', readOnlyReason: null }],
    ['DEFAULT', { kind: 'FBM', method: 'FBM', label: 'FBM', readOnlyReason: null }],
    ['AMAZON_EU_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'EU', to: 'UK', label: 'Remote Fulfilment · EU stock → UK' }],
    ['AMAZON_EU2AE_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'EU', to: 'AE', label: 'Remote Fulfilment · EU stock → UAE' }],
    ['AMAZON_EU2SA_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'EU', to: 'SA', label: 'Remote Fulfilment · EU stock → Saudi Arabia' }],
    ['AMAZON_UK_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'UK', to: 'EU', label: 'Remote Fulfilment · UK stock → EU' }],
    ['AMAZON_UK2NL_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'UK', to: 'NL', label: 'Remote Fulfilment · UK stock → Netherlands' }],
    ['AMAZON_UK2SE_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'UK', to: 'SE', label: 'Remote Fulfilment · UK stock → Sweden' }],
    ['AMAZON_EU_VCS', { kind: 'FBA', method: 'FBA', vcs: true, label: 'FBA (VCS)' }],
    ['AMAZON_UK2IE_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'UK', to: 'IE', label: 'Remote Fulfilment · UK stock → Ireland' }],
    ['AMAZON_EU2TR_RAFN', { kind: 'REMOTE', method: 'FBA', from: 'EU', to: 'TR', label: 'Remote Fulfilment · EU stock → Türkiye' }],
    ['WAREHOUSE_X', { kind: 'UNKNOWN', method: null, label: 'WAREHOUSE_X' }],
    ['Gestito dal venditore (default)', { code: 'DEFAULT', kind: 'FBM', method: 'FBM' }],
    ['GESTITO DAL VENDITORE (DEFAULT)', { code: 'DEFAULT', kind: 'FBM', method: 'FBM' }],
  ])('%s', (code, expected) => {
    expect(describeAmazonFulfilmentCode(code)).toMatchObject(expected)
  })

  it('Remote Fulfilment says where it is switched on, and that Nexus keeps the code', () => {
    expect(describeAmazonFulfilmentCode('AMAZON_EU_RAFN').readOnlyReason).toBe(
      'Remote Fulfilment (EU stock → UK) is switched on in Seller Central → Inventory → Remote Fulfilment with FBA → Marketplace Enrolment. Nexus keeps the code Amazon reports.')
    expect(describeAmazonFulfilmentCode('AMAZON_EU_VCS').readOnlyReason).toMatch(/treats it as FBA and keeps the code/)
    expect(describeAmazonFulfilmentCode('WAREHOUSE_X').readOnlyReason).toMatch(/unknown fulfilment code/)
  })

  it('normalises case, blanks and labels; option words for the two choices', () => {
    expect(normaliseAmazonFulfilmentCode(' amazon_eu ')).toBe('AMAZON_EU')
    expect(normaliseAmazonFulfilmentCode(null)).toBe('')
    expect(normaliseAmazonFulfilmentCode('FBA (AMAZON_EU)')).toBe('AMAZON_EU')
    expect(amazonFulfilmentOptionLabel('AMAZON_EU')).toBe('FBA — Amazon stores and ships')
    expect(amazonFulfilmentOptionLabel('DEFAULT')).toBe('FBM — you ship')
    expect(amazonFulfilmentOptionLabel('AMAZON_EU_RAFN')).toBe('Remote Fulfilment · EU stock → UK')
  })
})

describe('codes from both places, every entry', () => {
  it('reads fulfillment_availability[*] and attributes.fulfillment_availability[*], without repeats', () => {
    const pa = {
      fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }],
      attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'default' }, { fulfillment_channel_code: 'AMAZON_EU2AE_RAFN' }] },
    }
    expect(amazonFulfilmentCodes(pa)).toEqual(['DEFAULT', 'AMAZON_EU_RAFN', 'AMAZON_EU2AE_RAFN'])
    expect(keptAmazonFulfilmentCodes(pa)).toEqual(['AMAZON_EU_RAFN', 'AMAZON_EU2AE_RAFN'])
    expect(keptAmazonFulfilmentCodes({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] })).toEqual([])
    expect(amazonFulfilmentCodes(null)).toEqual([])
    expect(amazonFulfilmentCodes({ fulfillment_availability: 'bad', attributes: 'bad' })).toEqual([])
  })
})

describe('the FBA guard (isFbaCoordinate) — fail-closed on any AMAZON code in either place', () => {
  it('[{DEFAULT, qty}, {AMAZON_EU_RAFN}] → FBA', () => {
    const pa = { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] }
    expect(hasFbaFulfilmentCode(pa)).toBe(true)
    expect(isFbaCoordinate({ fulfillmentMethod: 'FBM', platformAttributes: pa }, { fulfillmentMethod: 'FBM' }, { fbaStockQty: 0, hasActiveFbaOffer: false })).toBe(true)
  })

  it('D9 = A: plain AMAZON_EU only in the copy Amazon\'s pull left does not block on its own; Nexus\'s own entry and Remote Fulfilment do', () => {
    const pulled = { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }
    expect(isFbaCoordinate({ fulfillmentMethod: null, platformAttributes: pulled }, { fulfillmentMethod: 'FBM' })).toBe(false)
    expect(hasFbaFulfilmentCode(pulled)).toBe(false)
    // Any other FBA sign still closes the guard.
    expect(isFbaCoordinate({ fulfillmentMethod: null, platformAttributes: pulled }, { fulfillmentMethod: 'FBM' }, { fbaStockQty: 3 })).toBe(true)
    expect(isFbaCoordinate({ fulfillmentMethod: 'FBA', platformAttributes: pulled }, null)).toBe(true)
    // Nexus's own entry (the fulfilment door writes it) and a code only Amazon sets count from either place.
    expect(isFbaCoordinate({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }, null)).toBe(true)
    expect(isFbaCoordinate({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } }, null)).toBe(true)
  })

  it('VCS → FBA; merchant codes, the Italian label and nothing → not FBA by code', () => {
    expect(isFbaCoordinate({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_VCS' }] } } }, null)).toBe(true)
    expect(isFbaCoordinate({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'GESTITO DAL VENDITORE (DEFAULT)' }] } } }, null)).toBe(false)
    expect(isFbaCoordinate({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }, null)).toBe(false)
    expect(isFbaCoordinate({ platformAttributes: {} }, null)).toBe(false)
  })

  it('the other FBA evidence still wins over an FBM code (never weakened)', () => {
    const fbm = { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] }
    expect(isFbaCoordinate({ fulfillmentMethod: 'FBA', platformAttributes: fbm }, null)).toBe(true)
    expect(isFbaCoordinate({ platformAttributes: fbm }, { fulfillmentMethod: 'FBA' })).toBe(true)
    expect(isFbaCoordinate({ platformAttributes: fbm }, null, { fbaStockQty: 1 })).toBe(true)
    expect(isFbaCoordinate({ platformAttributes: fbm }, null, { hasActiveFbaOffer: true })).toBe(true)
  })
})
