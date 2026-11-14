import { describe, expect, it } from 'vitest'
import type { CarrierLabelRequest } from '../../ports/carrier'
import { backToTestRefusal, goLiveRefusal, isTestLabel, TEST_LABEL_PREFIX, testLabelOf, testLabelText, testTrackingNumberOf } from './rules'

const address = { name: 'Made-up Racing', companyName: null, line1: 'Via Esempio 12', line2: null, postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT', phone: null, email: null }
const request: CarrierLabelRequest = {
  shipmentNumber: 'SH-00001',
  seq: 2,
  parcels: 3,
  externalReference: '3f2a9c1b-0000-4000-8000-000000000001.v4',
  from: { ...address, name: 'Made-up Factory' },
  to: address,
  carrierCode: 'brt',
  serviceCode: 'made-up-service',
  weightKg: '2.5000',
  lengthCm: null,
  widthCm: null,
  heightCm: null,
}

describe('TEST labels (LOG-035)', () => {
  it('are marked by their provider id, never a Sendcloud one', () => {
    expect(isTestLabel(`${TEST_LABEL_PREFIX}abc.v1`)).toBe(true)
    expect(isTestLabel('fk-1a2b3c4d:7')).toBe(false)
    expect(isTestLabel('123456:987')).toBe(false)
    expect(isTestLabel(null)).toBe(false)
    expect(isTestLabel(undefined)).toBe(false)
  })

  it('take a TEST tracking number from the parcel and its version: the same parcel the same number until a void', () => {
    expect(testTrackingNumberOf('3f2a9c1b-0000-4000-8000-000000000001.v4')).toBe('TEST-3F2A9C1B00-4')
    expect(testTrackingNumberOf('3f2a9c1b-0000-4000-8000-000000000001.v5')).toBe('TEST-3F2A9C1B00-5')
    expect(testTrackingNumberOf('weird')).toBe('TEST-ED-1')
  })

  it('name no carrier, no tracking page and no expected delivery', () => {
    expect(testLabelOf(request)).toEqual({ providerId: `test:${request.externalReference}`, trackingNumber: 'TEST-3F2A9C1B00-4', trackingUrl: null, expectedDeliveryAt: null, carrierCode: 'brt', carrierName: null })
  })

  it('print TEST, that nothing was sent, the parcel and both addresses', () => {
    const text = testLabelText(request, { trackingNumber: 'TEST-3F2A9C1B00-4' })
    expect(text.banner).toBe('TEST')
    expect(text.title).toBe('TEST LABEL - NOT FOR SHIPPING')
    expect(text.notice).toMatch(/nothing was sent to a carrier and nothing was charged/)
    expect(text.lines).toEqual([
      'Shipment SH-00001 - parcel 2 of 3',
      'Tracking TEST-3F2A9C1B00-4',
      'Weight 2.5000 kg',
      'From:',
      'Made-up Factory',
      'Via Esempio 12',
      '20121 Milano MI',
      'IT',
      'To:',
      'Made-up Racing',
      'Via Esempio 12',
      '20121 Milano MI',
      'IT',
    ])
  })
})

describe('switching a site (LOG-035)', () => {
  it('goes live from test mode with a usable connection only', () => {
    expect(goLiveRefusal(null, [])?.code).toBe('NO_SETTINGS')
    expect(goLiveRefusal({ testMode: false }, [])?.code).toBe('ALREADY_LIVE')
    const noAccount = goLiveRefusal({ testMode: true }, [{ path: 'account', message: 'This company has no Sendcloud connection.' }])
    expect(noAccount).toEqual({ code: 'NO_CARRIER_ACCOUNT', message: "Live labels need the company's own Sendcloud connection: This company has no Sendcloud connection." })
    expect(goLiveRefusal({ testMode: true }, [])).toBeNull()
  })

  it('goes back to test mode from live only', () => {
    expect(backToTestRefusal(null)?.code).toBe('NO_SETTINGS')
    expect(backToTestRefusal({ testMode: true })?.code).toBe('ALREADY_TEST')
    expect(backToTestRefusal({ testMode: false })).toBeNull()
  })
})
