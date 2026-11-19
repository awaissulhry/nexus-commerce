import { describe, expect, it } from 'vitest'
import { CARRIER_REFUSAL_ISSUES, databaseCarrierRefusal } from './carrier-refusals'
// B-OP-034: the typed tracking link's rule.
import { OWN_TRANSPORT_LIMITS, TRACKING_URL_PATTERN, trackingUrlProblems } from './own-transport/rules'

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

// B-OP-034 (order page plan N5, set C): the tracking link typed beside a carrier booked by hand — the database's rule, in words.
describe('trackingUrlProblems() (B-OP-034)', () => {
  it('an https address of 1 to 500 characters on one line, no name or password, only with its tracking number', () => {
    expect(trackingUrlProblems('https://track.example.com/T-0001?lang=it#top', true)).toEqual([])
    expect(trackingUrlProblems('https://track.example.com:8443/T-0001', true)).toEqual([])
    expect(trackingUrlProblems(null, false)).toEqual([])
    expect(trackingUrlProblems('   ', false)).toEqual([])
    expect(trackingUrlProblems('https://track.example.com/T-0001', false)).toEqual([{ path: 'body/trackingUrl', message: 'A tracking link is typed only with its tracking number.' }])
    for (const wrong of ['http://track.example.com/T-0001', 'https://user:secret@track.example.com/T-1', 'https://track.example.com/T 0001', 'https://track.example.com/T-1\nx', 'ftp://track.example.com', `https://track.example.com/${'x'.repeat(500)}`]) {
      expect(trackingUrlProblems(wrong, true), wrong).toEqual([{ path: 'body/trackingUrl', message: 'A tracking link is an https address of 1 to 500 characters on one line, with no name or password in it.' }])
    }
    expect(TRACKING_URL_PATTERN.test('https://track.example.com')).toBe(true)
    expect(OWN_TRANSPORT_LIMITS.trackingUrl).toBe(500)
  })
})
