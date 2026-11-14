import { describe, expect, it } from 'vitest'
import { CARRIER_RULE_CODES, carrierRuleOf, carrierRuleProblems, checkShipment, isPhone, POSTAL_CODE_FORMATS, type CheckFacts } from './rules'

const sender = { name: 'Made-up Factory', line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT', phone: '+39 000 0000000' }
const recipient = { name: 'Made-up Racing', line1: 'Via Esempio 12', postalCode: '20121', city: 'Milano', country: 'IT' }
const parcel = (seq: number, grossWeightKg: string | null, sizes: [string | null, string | null, string | null] = [null, null, null]) => ({ seq, grossWeightKg, lengthCm: sizes[0], widthCm: sizes[1], heightCm: sizes[2] })
const facts = (over: Partial<CheckFacts> = {}): CheckFacts => ({ carrierCode: 'dpd', sender, recipient, serviceCode: 'made-up-service', parcels: [parcel(1, '2.5')], ...over })
const codes = (input: CheckFacts) => checkShipment(input).problems.map((problem) => problem.code)

describe('the check before printing (LOG-045)', () => {
  it('passes a parcel its carrier takes', () => {
    const outcome = checkShipment(facts())
    expect(outcome.problems).toEqual([])
    expect(outcome.carrier).toMatchObject({ code: 'dpd', name: 'DPD', ruleKept: true, verified: false, rule: { maxWeightKg: '31.5' } })
  })

  it('refuses a postal code of the wrong form for its country, in words (sender and recipient)', () => {
    const outcome = checkShipment(facts({ recipient: { ...recipient, postalCode: '2012' }, sender: { ...sender, country: 'NL', postalCode: '10115' } }))
    expect(outcome.problems.map((problem) => [problem.code, problem.path])).toEqual([
      ['POSTAL_CODE', 'settings/senderAddress/postalCode'],
      ['POSTAL_CODE', 'shipment/shipTo/postalCode'],
    ])
    expect(outcome.problems[1]!.words).toBe('The delivery postal code "2012" is not a postal code of IT (like 20121).')
    expect(codes(facts({ recipient: { ...recipient, country: 'GB', postalCode: 'sw1a 1aa', phone: '+44 20 0000 0000' } }))).toEqual([])
    expect(codes(facts({ recipient: { ...recipient, country: 'ZZ', postalCode: 'anything' } }))).toEqual(['PHONE_NEEDED'])
    for (const [country, format] of Object.entries(POSTAL_CODE_FORMATS)) expect(format.pattern.test(format.example.toUpperCase()), country).toBe(true)
  })

  it('needs the phone where the carrier always asks and for a parcel leaving the EU; a phone must look like one', () => {
    expect(codes(facts({ carrierCode: 'ups' }))).toEqual(['PHONE_NEEDED'])
    expect(checkShipment(facts({ carrierCode: 'ups' })).problems[0]!.words).toBe("UPS needs the recipient's phone: add it to the delivery address.")
    const swiss = checkShipment(facts({ recipient: { ...recipient, country: 'CH', postalCode: '8001' } }))
    expect(swiss.problems.map((problem) => problem.code)).toEqual(['PHONE_NEEDED'])
    expect(swiss.problems[0]!.words).toMatch(/leaving the European Union/)
    expect(codes(facts({ recipient: { ...recipient, phone: 'call me' } }))).toEqual(['PHONE_FORMAT'])
    expect(codes(facts({ carrierCode: 'ups', recipient: { ...recipient, phone: '+39 02 0000 0000' } }))).toEqual([])
    expect(isPhone('+39 (02) 000-0000')).toBe(true)
    expect(isPhone('12345')).toBe(false)
    expect(isPhone('+1234567890123456')).toBe(false)
  })

  it("refuses a parcel heavier than its carrier takes, and checks no weight for a carrier it keeps no rule for", () => {
    const heavy = checkShipment(facts({ parcels: [parcel(1, '2.5'), parcel(2, '34.0000')] }))
    expect(heavy.problems).toEqual([
      { code: 'TOO_HEAVY', parcelSeq: 2, path: 'parcels/2/grossWeightKg', params: { seq: 2, weightKg: '34', carrier: 'DPD', maxKg: '31.5' }, words: 'Parcel 2 weighs 34 kg; DPD takes at most 31.5 kg a parcel: repack it into lighter parcels.' },
    ])
    expect(codes(facts({ carrierCode: 'dpd', parcels: [parcel(1, '31.5')] }))).toEqual([])
    expect(codes(facts({ carrierCode: 'seed-express', parcels: [parcel(1, '31.5')] }))).toEqual([])
    expect(carrierRuleOf('seed-express')).toMatchObject({ kept: false, rule: { maxWeightKg: null } })
    expect(codes(facts({ parcels: [parcel(1, null)] }))).toEqual(['NO_WEIGHT'])
  })

  it('checks the sizes: all or none, the longest side, length plus girth, the largest box', () => {
    expect(codes(facts({ parcels: [parcel(1, '2', ['40', null, '10'])] }))).toEqual(['SIZES_PARTIAL'])
    expect(codes(facts({ parcels: [parcel(1, '2', ['180', '20', '20'])] }))).toEqual(['TOO_LONG'])
    expect(codes(facts({ parcels: [parcel(1, '2', ['100', '60', '50'])] }))).toEqual(['TOO_BIG'])
    const box = checkShipment(facts({ carrierCode: 'dhl', parcels: [parcel(1, '2', ['50', '130', '40'])] }))
    expect(box.problems.map((problem) => [problem.code, problem.words])).toEqual([['DOES_NOT_FIT', "Parcel 1 (130 x 50 x 40 cm) does not fit DHL's largest parcel (120 x 60 x 60 cm)."]])
    expect(codes(facts({ carrierCode: 'dhl', parcels: [parcel(1, '2', ['60', '120', '40'])] }))).toEqual([])
  })

  it('says what the addresses and the service lack', () => {
    const outcome = checkShipment(facts({ sender: null, recipient: { ...recipient, line1: ' ', city: '' }, serviceCode: null }))
    expect(outcome.problems.map((problem) => [problem.code, problem.words])).toEqual([
      ['SENDER_INCOMPLETE', "The sender's address (the site's shipping settings) lacks who it is, the street, the postal code, the city, the country."],
      ['RECIPIENT_INCOMPLETE', 'The delivery address lacks the street, the city.'],
      ['NO_SERVICE', 'Choose the carrier service for the shipment (or a default one in the site settings).'],
    ])
  })

  it("refuses a buy on the carrier's rules only (the field checks are W1's)", () => {
    const outcome = checkShipment(facts({ serviceCode: null, recipient: { ...recipient, postalCode: '1' }, parcels: [parcel(1, null), parcel(2, '40')] }))
    expect(carrierRuleProblems(outcome).map((problem) => problem.code)).toEqual(['POSTAL_CODE', 'TOO_HEAVY'])
    expect(CARRIER_RULE_CODES).not.toContain('NO_WEIGHT')
  })
})
