import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { CUSTOMER_SIDE_TYPES, EITHER_SIDE_TYPES, INCOMING_OWN_TYPES, onSide, partyOnSide, SUPPLIER_SIDE_TYPES, THREAD_VIEW_GATES, typesOfSide, viewGateOf } from './view-gates'

/** B-TH-047: one view gate per thread record type, and the side a conversation waits on (pure). */

describe('the view gates and the sides (B-TH-047)', () => {
  it('every gate is a permission of the catalogue; every listed type has one; an unknown type has none (listed to nobody)', () => {
    for (const [type, gate] of Object.entries(THREAD_VIEW_GATES)) expect(FACTORY_PERMISSIONS.get(gate), `${type}: ${gate}`).toBeDefined()
    for (const type of [...CUSTOMER_SIDE_TYPES, ...SUPPLIER_SIDE_TYPES, ...EITHER_SIDE_TYPES]) expect(viewGateOf(type), type).not.toBeNull()
    expect(viewGateOf('Quote')).toBe('quotes.view')
    expect(viewGateOf('PurchaseOrder')).toBe('purchasing.view')
    expect(viewGateOf('MadeUpRecord')).toBeNull()
  })
  it('Incoming’s own kinds never wait in Customer replies; the sides do not overlap but for the either-side records', () => {
    for (const type of INCOMING_OWN_TYPES) {
      expect(typesOfSide('CUSTOMER')).not.toContain(type)
      expect(typesOfSide('SUPPLIER')).not.toContain(type)
    }
    expect(CUSTOMER_SIDE_TYPES.filter((type) => (SUPPLIER_SIDE_TYPES as readonly string[]).includes(type))).toEqual([])
    expect(onSide('Quote', 'CUSTOMER', [])).toBe(true)
    expect(onSide('Quote', 'SUPPLIER', ['SUPPLIER'])).toBe(false)
    expect(onSide('PurchaseOrder', 'SUPPLIER', [])).toBe(true)
  })
  it('a party’s own thread is on the side of its roles (a customer and supplier: both)', () => {
    expect(onSide('Party', 'CUSTOMER', ['CUSTOMER'])).toBe(true)
    expect(onSide('Party', 'SUPPLIER', ['CUSTOMER'])).toBe(false)
    expect(onSide('Party', 'CUSTOMER', ['BRAND'])).toBe(true)
    expect(onSide('ChangeRequest', 'SUPPLIER', ['SUBCONTRACTOR'])).toBe(true)
    expect(partyOnSide(['CUSTOMER', 'SUPPLIER'], 'CUSTOMER') && partyOnSide(['CUSTOMER', 'SUPPLIER'], 'SUPPLIER')).toBe(true)
    expect(partyOnSide(['CARRIER'], 'CUSTOMER') || partyOnSide(['CARRIER'], 'SUPPLIER')).toBe(false)
  })
})
