import { describe, expect, it } from 'vitest'
import type { CarrierBookingExtras, CarrierLabelRequest } from '@nexus/factory-domain/ports/carrier'
import { ProviderError } from '../../platform/gateway/gateway'
import { announceBody } from './sendcloud'
import { SENDCLOUD_SERVICE_MAPPING, withServices } from './services'

const address = { name: 'Made-up Racing', companyName: null, line1: 'Via Esempio 12', line2: null, postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT', phone: null, email: null }
const request: CarrierLabelRequest = {
  shipmentNumber: 'SH-00001',
  seq: 1,
  parcels: 1,
  externalReference: 'made-up-parcel.v1',
  from: address,
  to: { ...address, country: 'CH', postalCode: '8001', city: 'Zürich' },
  carrierCode: 'ups',
  serviceCode: 'ups:standard',
  weightKg: '2.5000',
  lengthCm: null,
  widthCm: null,
  heightCm: null,
}
const extras = (over: Partial<CarrierBookingExtras> = {}): CarrierBookingExtras => ({ express: false, dutyPayer: null, paperless: false, declaredValue: null, insuredValue: null, currency: null, contract: null, billing: null, ...over })

describe("the booking's services on Sendcloud's v3 announce (B-W2b-400)", () => {
  it('leaves a request without extras as W1 sent it', () => {
    const body = announceBody(request, { contractId: 9 })
    expect(body).toMatchObject({ ship_with: { properties: { shipping_option_code: 'ups:standard', contract_id: 9 } } })
    expect(body).not.toHaveProperty('customs_information')
  })

  it('books on our own contract by Sendcloud’s id of it, the duties and paperless trade, the insured value', () => {
    const body = announceBody({ ...request, extras: extras({ contract: { id: 'made-up-contract', providerContractId: 42 }, dutyPayer: 'SENDER', paperless: true, declaredValue: '520.00', insuredValue: '520.00', currency: 'EUR' }) }, { contractId: 9 }) as Record<string, any>
    expect(body.ship_with.properties).toEqual({ shipping_option_code: 'ups:standard', contract_id: 42 })
    expect(body.customs_information).toEqual({ incoterm: 'DDP', paperless_trade: true })
    expect(body.parcels[0]).toMatchObject({ weight: { value: '2.5000', unit: 'kg' }, additional_insured_price: { value: '520.00', currency: 'EUR' } })
    expect(JSON.stringify(body)).not.toContain('made-up-contract')
    expect((announceBody({ ...request, extras: extras({ dutyPayer: 'RECEIVER' }) }, {}) as Record<string, any>).customs_information).toEqual({ incoterm: 'DAP' })
  })

  it("refuses the customer's account before any call: Sendcloud's API takes none (not mapped)", () => {
    expect(() => withServices({}, { extras: extras({ billing: 'COLLECT' }) })).toThrow(ProviderError)
    expect(SENDCLOUD_SERVICE_MAPPING.CUSTOMER_ACCOUNT.mapped).toBe(false)
    expect(Object.values(SENDCLOUD_SERVICE_MAPPING).every((entry) => entry.verified === false)).toBe(true)
  })
})
