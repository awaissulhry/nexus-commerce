import { describe, expect, it } from 'vitest'
import { bookingCheck, bookingExtrasOf, servicesChangeRefusal, servicesProblems, type BookingFacts } from './booking'
import { carrierOfferOf, chosenServicesOf, destinationOf, providerContractsOf, serviceStateOf, withChosenServices } from './catalogue'
import { goodsValues, insuranceRuleOf, insuredAfterRule, insureAboveProblem, parcelValueProblems, piecesValue } from './insurance'

const rule = (insure: boolean | null) => ({ insure, words: insure ? 'Declared above 500.00 EUR: insured.' : 'Not insured.' })

/** A made-up PACKED shipment to Milano with one parcel, in test mode, no contract, no customer account. */
function facts(over: Omit<Partial<BookingFacts>, 'shipment'> & { shipment?: Partial<BookingFacts['shipment']> } = {}): BookingFacts {
  return {
    destination: 'DOMESTIC',
    testMode: true,
    account: null,
    contract: null,
    customer: null,
    currency: 'EUR',
    parcels: [{ id: 'p1', seq: 1, labelled: false, declaredValue: null, insuredValue: null, rule: rule(null) }],
    ...over,
    shipment: { number: 'SH-1', status: 'PACKED', transportBy: 'CARRIER', carrierCode: 'brt', serviceCode: 'made-up-brt', express: false, dutyPayer: null, paperless: false, ...over.shipment },
  }
}
const codes = (check: ReturnType<typeof bookingCheck>) => check.problems.map((problem) => problem.code)
const LIVE = { mode: 'LIVE' as const, settings: {} }

describe('the catalogue (Q20: a service not chosen stays on the fake)', () => {
  it('knows what the listed carriers offer; an unknown carrier refuses nothing', () => {
    expect(carrierOfferOf('brt')).toEqual({ known: true, offer: { express: true, dutiesPaid: false, paperless: false, insurance: true, customerAccount: false } })
    expect(carrierOfferOf('DHL_EXPRESS').offer.paperless).toBe(true)
    expect(carrierOfferOf('seed-express')).toMatchObject({ known: false, offer: { express: true, dutiesPaid: true, customerAccount: true } })
  })

  it('reads and writes the Owner’s choice in the connection settings, keeping every other key', () => {
    const settings = withChosenServices({ contractId: 12, services: ['NOPE'] }, ['INSURANCE', 'EXPRESS'], new Map([['ups', 7], ['brt', 3]]))
    expect(settings).toEqual({ contractId: 12, services: ['EXPRESS', 'INSURANCE'], contracts: { brt: 3, ups: 7 } })
    expect(chosenServicesOf(settings)).toEqual(['EXPRESS', 'INSURANCE'])
    expect([...providerContractsOf({ contracts: { brt: 3, gls: 'x', dpd: -1 } })]).toEqual([['brt', 3]])
    expect(chosenServicesOf(null)).toEqual([])
  })

  it('says each service’s state: test mode, the FAKE connection, live chosen or not', () => {
    expect(serviceStateOf('INSURANCE', { testMode: true, account: LIVE })).toBe('TEST')
    expect(serviceStateOf('INSURANCE', { testMode: false, account: { mode: 'FAKE', settings: {} } })).toBe('FAKE')
    expect(serviceStateOf('INSURANCE', { testMode: false, account: { mode: 'LIVE', settings: { services: ['INSURANCE'] } } })).toBe('CHOSEN')
    expect(serviceStateOf('INSURANCE', { testMode: false, account: LIVE })).toBe('NOT_CHOSEN')
    expect(serviceStateOf('INSURANCE', { testMode: false, account: null })).toBe('NOT_CHOSEN')
  })

  it('classes the destination: the same country, the European Union, an export', () => {
    expect(destinationOf('IT', 'it')).toBe('DOMESTIC')
    expect(destinationOf('IT', 'DE')).toBe('EU')
    expect(destinationOf('IT', 'CH')).toBe('EXPORT')
    expect(destinationOf('IT', 'GB')).toBe('EXPORT')
    expect(destinationOf('IT', null)).toBeNull()
  })
})

describe('insurance and declared value (LOG-042)', () => {
  it('values each parcel’s goods at the order’s net prices: carton contents first, else the line’s parcel', () => {
    const lines = [
      { id: 'l1', parcelId: 'p1', quantity: 2, orderLineQuantity: 4, orderLineNet: 100000 },
      { id: 'l2', parcelId: null, quantity: 3, orderLineQuantity: 3, orderLineNet: 33333 },
    ]
    const contents = [
      { shipmentLineId: 'l2', parcelId: 'p1', quantity: 1 },
      { shipmentLineId: 'l2', parcelId: 'p2', quantity: 2 },
    ]
    expect(Object.fromEntries(goodsValues(['p1', 'p2', 'p3'], lines, contents))).toEqual({ p1: 50000 + 11111, p2: 22222, p3: 0 })
    expect(piecesValue(1, { orderLineQuantity: 0, orderLineNet: 100 })).toBe(0)
  })

  it('insures by the site’s rule above its value, words without amounts for a reader without the grain', () => {
    const base = { insureAbove: 50000, companyCurrency: 'EUR', orderCurrency: 'EUR' }
    expect(insuranceRuleOf({ ...base, declared: 52000, declaredInCompany: 52000 })).toEqual({ insure: true, words: "Declared above 500.00 EUR: insured for its declared value by the site's rule." })
    expect(insuranceRuleOf({ ...base, declared: 50000, declaredInCompany: 50000 }).insure).toBe(false)
    expect(insuranceRuleOf({ ...base, declared: 52000, declaredInCompany: 52000 }, false).words).not.toMatch(/500/)
    expect(insuranceRuleOf({ ...base, orderCurrency: 'CHF', declared: 52000, declaredInCompany: null })).toMatchObject({ insure: null, words: expect.stringMatching(/^No exchange rate of CHF today/) })
    expect(insuranceRuleOf({ ...base, insureAbove: null, declared: 52000, declaredInCompany: 52000 }).insure).toBeNull()
  })

  it('applies the rule: insured for the declared value, not insured, or the typed insurance kept when it cannot say', () => {
    expect(insuredAfterRule(52000, null, rule(true))).toBe(52000)
    expect(insuredAfterRule(30000, 30000, rule(false))).toBeNull()
    expect(insuredAfterRule(30000, 20000, rule(null))).toBe(20000)
    expect(insuredAfterRule(10000, 20000, rule(null))).toBeNull()
  })

  it('refuses values out of shape: negative, not whole, insured above declared', () => {
    expect(parcelValueProblems(52000, 52000)).toEqual([])
    expect(parcelValueProblems(null, 1000)).toEqual([])
    expect(parcelValueProblems(-1, null).map((problem) => problem.path)).toEqual(['body/declaredValue'])
    expect(parcelValueProblems(100, 0).map((problem) => problem.path)).toEqual(['body/insuredValue'])
    expect(parcelValueProblems(100, 200)[0]!.message).toBe('A parcel is insured for at most its declared value.')
    expect(parcelValueProblems(1.5, null)).toHaveLength(1)
    expect(insureAboveProblem(null)).toBeNull()
    expect(insureAboveProblem(-5)).toMatch(/0 or more/)
  })
})

describe('the booking (LOG-033, LOG-038, LOG-041)', () => {
  it('a plain domestic booking in test mode: Sendcloud’s rates, nothing refused', () => {
    const check = bookingCheck(facts())
    expect(check).toMatchObject({ billedTo: 'AGGREGATOR', contract: null, extras: [], problems: [], warnings: [] })
  })

  it('an export says who pays the duties; DDP and paperless only where the carrier offers them', () => {
    expect(codes(bookingCheck(facts({ destination: 'EXPORT' })))).toEqual(['DUTY_PAYER_NEEDED'])
    expect(codes(bookingCheck(facts({ destination: 'EXPORT', shipment: { dutyPayer: 'SENDER', paperless: true } })))).toEqual(['DUTIES_PAID_NOT_OFFERED', 'PAPERLESS_NOT_OFFERED'])
    const ups = bookingCheck(facts({ destination: 'EXPORT', shipment: { carrierCode: 'ups', dutyPayer: 'SENDER', paperless: true, express: true } }))
    expect(ups.problems).toEqual([])
    expect(ups.extras.map((extra) => [extra.service, extra.state])).toEqual([
      ['EXPRESS', 'TEST'],
      ['DUTIES_PAID', 'TEST'],
      ['PAPERLESS', 'TEST'],
    ])
    expect(codes(bookingCheck(facts({ shipment: { dutyPayer: 'RECEIVER' } })))).toEqual(['NOT_EXPORT'])
    expect(codes(bookingCheck(facts({ shipment: { carrierCode: 'inpost', express: true } })))).toEqual(['EXPRESS_NOT_OFFERED'])
  })

  it('live, a service not chosen stays on the fake: refused with its cost in words; chosen, it goes', () => {
    const insured = [{ id: 'p1', seq: 1, labelled: false, declaredValue: 52000, insuredValue: 52000, rule: rule(true) }]
    const notChosen = bookingCheck(facts({ testMode: false, account: LIVE, parcels: insured }))
    expect(codes(notChosen)).toEqual(['SERVICE_NOT_CHOSEN'])
    expect(notChosen.problems[0]!.message).toMatch(/stays on the fake until the Owner chooses it\. Insurance is charged per parcel/)
    expect(codes(bookingCheck(facts({ testMode: false, account: { mode: 'LIVE', settings: { services: ['INSURANCE'] } }, parcels: insured })))).toEqual([])
    // A parcel already labelled is not booked again: its insurance is not checked.
    expect(codes(bookingCheck(facts({ testMode: false, account: LIVE, parcels: insured }), []))).toEqual([])
  })

  it('our own contract: used in test mode and on the FAKE; live only when chosen and known to Sendcloud; "use only our rates" refuses the aggregator', () => {
    const contract = { id: 'c1', siteId: null, ownRatesOnly: false }
    expect(bookingCheck(facts({ contract }))).toMatchObject({ billedTo: 'OWN_CONTRACT', contract: { id: 'c1', providerContractId: null } })
    const live = bookingCheck(facts({ contract, testMode: false, account: LIVE }))
    expect(live).toMatchObject({ billedTo: 'AGGREGATOR', contract: null, problems: [], warnings: [{ code: 'CONTRACT_NOT_USED' }] })
    expect(codes(bookingCheck(facts({ contract: { ...contract, ownRatesOnly: true }, testMode: false, account: LIVE })))).toEqual(['OWN_CONTRACT_NOT_READY'])
    const chosenUnknown = bookingCheck(facts({ contract: { ...contract, ownRatesOnly: true }, testMode: false, account: { mode: 'LIVE', settings: { services: ['OWN_CONTRACT'] } } }))
    expect(chosenUnknown.problems[0]).toMatchObject({ code: 'OWN_CONTRACT_NOT_READY', message: expect.stringMatching(/does not know that contract yet/) })
    const ready = bookingCheck(facts({ contract: { ...contract, ownRatesOnly: true }, testMode: false, account: { mode: 'LIVE', settings: { services: ['OWN_CONTRACT'], contracts: { brt: 42 } } } }))
    expect(ready).toMatchObject({ billedTo: 'OWN_CONTRACT', contract: { id: 'c1', providerContractId: 42 }, problems: [] })
  })

  it("the customer's account: billed to it when the shipment goes with the customer's carrier; a warning when it does not", () => {
    const customer = { name: 'Made-up Brand', carrierCode: 'ups', freightBilling: 'COLLECT' as const, accountOnFile: true, defaultService: 'made-up-ups-saver' }
    const collect = bookingCheck(facts({ customer, shipment: { carrierCode: 'ups' } }))
    expect(collect).toMatchObject({ billedTo: 'CUSTOMER_ACCOUNT', problems: [], extras: [{ service: 'CUSTOMER_ACCOUNT', state: 'TEST' }] })
    expect(collect.billedToWords).toMatch(/Made-up Brand's own account/)
    expect(bookingExtrasOf(facts({ customer, shipment: { carrierCode: 'ups' } }), collect, 'p1')).toMatchObject({ billing: 'COLLECT', contract: null })
    expect(codes(bookingCheck(facts({ customer: { ...customer, carrierCode: 'brt' } })))).toEqual(['CUSTOMER_ACCOUNT_NOT_OFFERED'])
    const other = bookingCheck(facts({ customer }))
    expect(other).toMatchObject({ billedTo: 'AGGREGATOR', warnings: [{ code: 'CUSTOMER_PAYS_OTHER_CARRIER' }] })
  })

  it("each parcel's extras: the values as decimals of the order's currency, duties only for an export", () => {
    const booked = facts({ destination: 'EXPORT', shipment: { carrierCode: 'ups', dutyPayer: 'RECEIVER', express: true }, parcels: [{ id: 'p1', seq: 1, labelled: false, declaredValue: 52000, insuredValue: 51000, rule: rule(true) }] })
    expect(bookingExtrasOf(booked, bookingCheck(booked), 'p1')).toEqual({ express: true, dutyPayer: 'RECEIVER', paperless: false, declaredValue: '520.00', insuredValue: '510.00', currency: 'EUR', contract: null, billing: null })
    expect(bookingCheck(booked).warnings).toEqual([])
    const ruleSays = facts({ parcels: [{ id: 'p1', seq: 1, labelled: false, declaredValue: 52000, insuredValue: null, rule: rule(true) }] })
    expect(bookingCheck(ruleSays).warnings.map((warning) => warning.code)).toEqual(['NOT_INSURED_BY_RULE'])
  })

  it('services change only before any label and while the goods have not left; what the carrier offers is checked', () => {
    expect(servicesChangeRefusal('PACKED', 0)).toBeNull()
    expect(servicesChangeRefusal('PACKED', 2)).toMatchObject({ code: 'LABELLED' })
    expect(servicesChangeRefusal('SHIPPED', 0)).toMatchObject({ code: 'LEFT' })
    expect(servicesChangeRefusal('CANCELLED', 0)).toMatchObject({ code: 'CANCELLED' })
    const base = { carrierCode: 'brt', transportBy: 'CARRIER' as const, destination: 'DOMESTIC' as const, express: false, dutyPayer: null, paperless: false }
    expect(servicesProblems(base)).toEqual([])
    expect(servicesProblems({ ...base, transportBy: 'SENDER', express: true }).map((problem) => problem.code)).toEqual(['NOT_CARRIER'])
    expect(servicesProblems({ ...base, dutyPayer: 'SENDER' }).map((problem) => problem.code)).toEqual(['NOT_EXPORT'])
    expect(servicesProblems({ ...base, destination: 'EXPORT', dutyPayer: 'SENDER', paperless: true }).map((problem) => problem.code)).toEqual(['DUTIES_PAID_NOT_OFFERED', 'PAPERLESS_NOT_OFFERED'])
    expect(servicesProblems({ ...base, carrierCode: 'colissimo', express: true }).map((problem) => problem.code)).toEqual(['EXPRESS_NOT_OFFERED'])
  })
})
