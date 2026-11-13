import { describe, expect, it } from 'vitest'
import { CARRIER_REFUSAL_ISSUES, databaseCarrierRefusal } from './carrier-refusals'

describe('databaseCarrierRefusal()', () => {
  it("reads the database's carrier refusals of a shipment back as words with their issue path", () => {
    expect(databaseCarrierRefusal('carriers: shipment x has a tracking number typed by hand (1 to 100 characters on one line) only when a carrier booked outside Sendcloud carries it (CARRIER, no Sendcloud shipment)')?.path).toBe(CARRIER_REFUSAL_ISSUES.manual)
    expect(databaseCarrierRefusal('carriers: shipment x records who collected it, the plate and the signature only when the customer collects (RECIPIENT)')?.path).toBe(CARRIER_REFUSAL_ISSUES.collected)
    expect(databaseCarrierRefusal("carriers: shipment x is on a day's sheet only while a carrier carries it and it is PACKED or left (take it off the sheet first)")?.path).toBe(CARRIER_REFUSAL_ISSUES.sheet)
    expect(databaseCarrierRefusal("carriers: shipment x goes with carrier brt, not on the day's sheet of gls")?.path).toBe(CARRIER_REFUSAL_ISSUES.sheet)
    expect(databaseCarrierRefusal("carriers: the day's sheet y is closed; shipment x stays on it")?.path).toBe(CARRIER_REFUSAL_ISSUES.closed)
    expect(databaseCarrierRefusal("carriers: shipment x is on a day's sheet only while a carrier carries it and it is PACKED or left (take it off the sheet first)")?.message).toMatch(/take it off the sheet first/)
  })

  it('leaves every other message alone', () => {
    expect(databaseCarrierRefusal('carriers: who collected shipment x is 1 to 200 characters on one line')).toBeNull()
    expect(databaseCarrierRefusal('carriers: pickup request x cannot move from FAILED to CONFIRMED')).toBeNull()
    expect(databaseCarrierRefusal('shipping: shipment x cannot move from DRAFT to SHIPPED')).toBeNull()
  })
})
