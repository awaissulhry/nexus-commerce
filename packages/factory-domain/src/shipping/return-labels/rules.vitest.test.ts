import { describe, expect, it } from 'vitest'
import { carrierCodeOf, makeHeldOf, returnLabelMail, returnLabelRequestOf, type ReturnLabelHeldFacts } from './rules'

/** Return labels (B-W2b-398; LOG-112): the shipment's addresses swapped, never in test mode, only while the goods may come back. */

const ready: ReturnLabelHeldFacts = { returnStatus: 'AUTHORISED', testMode: false, hasShipment: true, hasAccount: true, hasAddress: true, hasService: true }

describe('what stops a return label', () => {
  it('asks a return that takes goods, a shipment to swap, a live site, a carrier account, both addresses and a service', () => {
    expect(makeHeldOf(ready)).toBeNull()
    expect(makeHeldOf({ ...ready, returnStatus: 'RECEIVED' })).toBeNull()
    expect(makeHeldOf({ ...ready, returnStatus: 'INSPECTED' })).toBe('RETURN_CLOSED')
    expect(makeHeldOf({ ...ready, hasShipment: false })).toBe('NO_SHIPMENT')
    expect(makeHeldOf({ ...ready, testMode: true })).toBe('TEST_MODE')
    expect(makeHeldOf({ ...ready, hasAccount: false })).toBe('NO_CARRIER_ACCOUNT')
    expect(makeHeldOf({ ...ready, hasAddress: false })).toBe('NO_ADDRESS')
    expect(makeHeldOf({ ...ready, hasService: false })).toBe('NO_SERVICE')
  })
})

describe('the booking', () => {
  it('swaps the addresses: from the customer to our return address, one parcel, the label own reference', () => {
    const request = returnLabelRequestOf({
      returnNumber: 'RMA-0007',
      labelId: 'label-1',
      customerAddress: { name: 'Demo Shop', line1: 'Via Demo 2', postalCode: '40121', city: 'Bologna', country: 'IT' },
      siteAddress: { name: 'Demo Factory', line1: 'Via dei Campioni 1', postalCode: '61100', city: 'Pesaro', country: 'IT' },
      carrierCode: 'brt',
      serviceCode: 'brt:standard',
      weightKg: '2.5000',
    })
    expect(request).toMatchObject({ shipmentNumber: 'RMA-0007', seq: 1, parcels: 1, externalReference: 'return-label:label-1', carrierCode: 'brt', serviceCode: 'brt:standard', weightKg: '2.500' })
    expect(request.from.city).toBe('Bologna')
    expect(request.to.city).toBe('Pesaro')
    expect(returnLabelRequestOf({ returnNumber: 'R', labelId: 'l', customerAddress: {}, siteAddress: {}, carrierCode: null, serviceCode: null, weightKg: null }).weightKg).toBe('1')
    expect(carrierCodeOf(' brt ')).toBe('brt')
    expect(carrierCodeOf('two words')).toBeNull()
  })

  it('mails the link in the customer language, with the day it stops opening', () => {
    const mail = returnLabelMail({ locale: 'it', companyName: 'Demo', returnNumber: 'RMA-0007', customerRef: 'RESO-1', openUntil: '2026-12-14' }, 'https://factory.example/l#token=made-up')
    expect(mail.subject).toBe('Il Suo reso RESO-1: l’etichetta del vettore - Demo')
    expect(mail.body).toContain('https://factory.example/l#token=made-up')
    expect(mail.body).toContain('fino al 14/12/2026')
    expect(returnLabelMail({ locale: 'en', companyName: 'Demo', returnNumber: 'RMA-0007', customerRef: null, openUntil: '2026-12-14' }, null).body).toContain('The link is in the mail we sent you.')
  })
})
