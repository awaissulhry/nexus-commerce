import { describe, expect, it } from 'vitest'
import type { OrderLinePrice } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { vatFor } from './draft'

// B-W2b-GF2 (G463): goods we send to a special fiscal territory outside the EU's VAT area (Livigno, Campione d'Italia, the
// Canary Islands …) are an export for VAT (N3.1, art. 8 c.1 a DPR 633/1972), whatever the customer's own tax mode.

const line: OrderLinePrice = { salesOrderLineId: 'l1', orderId: 'o1', orderNumber: 'SO-1', description: 'Giacca moto in pelle', itemCode: 'JKT-1', unitPrice: '305.00', sizePrices: {}, vatRatePct: '22.00' }

describe('the VAT of shipped goods by where they went', () => {
  it('an Italian or EU customer is taxed as always inside the VAT area, as an export outside it', () => {
    expect(vatFor({ taxMode: 'IT_B2B' })(line)).toMatchObject({ kind: 'TAXABLE', rate: 22 })
    expect(vatFor({ taxMode: 'IT_B2B' }, true)(line)).toMatchObject({ kind: 'NON_TAXABLE', natura: 'N3.1' })
    // A Canarian business with a Spanish VAT number that VIES does not know: Italian VAT inside the area, an export to the islands.
    expect(vatFor({ taxMode: 'EU_B2B', viesValid: false })(line)).toMatchObject({ kind: 'TAXABLE' })
    expect(vatFor({ taxMode: 'EU_B2B', viesValid: false }, true)(line)).toMatchObject({ kind: 'NON_TAXABLE', natura: 'N3.1' })
    expect(vatFor({ taxMode: 'EXTRA_EU' }, true)(line)).toMatchObject({ natura: 'N3.1' })
    expect(vatFor(null, true)(line)).toMatchObject({ path: 'party/taxIdentity' })
  })
})
