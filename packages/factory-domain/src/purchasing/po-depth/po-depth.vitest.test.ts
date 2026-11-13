import { describe, expect, it } from 'vitest'
import { lineDifference, orderStatusAfter } from '../../inventory/receipts/rules'
import { SEND_CHECK_CODES } from '../orders'
import { DEPTH_SEND_CHECK_CODES } from './codes'
import { companyValueOf, currencyChecks, rateProblem, rateWords } from './currency'
import { dateChangeProblems, daysLater, firstDateProblem, lineDateOf, moveDateProblem } from './dates'
import { planSchedule, scheduleChecks, scheduledEditProblem, scheduleProblems } from './schedule'
import { defaultAddressOf, shipToChecks, shipToPartyProblem, shipToProblems, type ShipToAddress } from './ship-to'
import { beyondToleranceRefusal, receiptToleranceOf, toleranceFor, toleranceProblems, type ToleranceRule } from './tolerances'

// Hand-computed cases (B-W2b-296). Ids are made up.
const today = '2026-11-12'

describe('delivery schedule (SCM-052)', () => {
  const line = { seq: 10, quantity: '100.0000', baseQuantity: '9.2903' }

  it('splits a line by day, numbers the deliveries and shares the base quantity, the last taking the rest', () => {
    const deliveries = [
      { quantity: '30', needDate: '2026-12-20' },
      { quantity: '40', needDate: '2026-12-01', note: '  first part ' },
      { quantity: '30', needDate: '2027-01-10' },
    ]
    expect(scheduleProblems(line, deliveries, today)).toEqual([])
    // 40 × 9.2903 / 100 = 3.71612 → 3.7161; 30 × … = 2.78709 → 2.7870; rest 9.2903 − 6.5031 = 2.7872.
    expect(planSchedule(line, deliveries)).toEqual([
      { seq: 1, quantity: '40.0000', baseQuantity: '3.7161', needDate: '2026-12-01', note: 'first part' },
      { seq: 2, quantity: '30.0000', baseQuantity: '2.7870', needDate: '2026-12-20', note: null },
      { seq: 3, quantity: '30.0000', baseQuantity: '2.7872', needDate: '2027-01-10', note: null },
    ])
  })

  it('refuses one delivery, a past day, two on one day, a wrong sum and a bad quantity, in words', () => {
    expect(scheduleProblems(line, [{ quantity: '100', needDate: '2026-12-01' }], today)[0]!.message).toMatch(/two deliveries or more/)
    expect(scheduleProblems(line, [{ quantity: '50', needDate: '2026-11-11' }, { quantity: '50', needDate: '2026-12-01' }], today).map((issue) => issue.path)).toEqual(['body/deliveries/0/needDate'])
    expect(scheduleProblems(line, [{ quantity: '50', needDate: '2026-12-01' }, { quantity: '50', needDate: '2026-12-01' }], today)[0]!.message).toMatch(/Two deliveries on 2026-12-01/)
    expect(scheduleProblems(line, [{ quantity: '50', needDate: '2026-12-01' }, { quantity: '40', needDate: '2026-12-02' }], today)[0]!.message).toBe("The deliveries add up to 90; line 10 is 100. Together they are the line's quantity.")
    expect(scheduleProblems(line, [{ quantity: '0', needDate: '2026-12-01' }, { quantity: '100', needDate: '2026-12-02' }], today)[0]!.path).toBe('body/deliveries/0/quantity')
    expect(scheduleProblems(line, [{ quantity: '1.23456', needDate: '2026-12-01' }, { quantity: '98.76544', needDate: '2026-12-02' }], today)[0]!.path).toBe('body/deliveries/0/quantity')
  })

  it('stops the send when a schedule is no longer its line or a delivery is past', () => {
    const scheduled = { seq: 10, itemCode: 'LTH-1', quantity: '100.0000', baseQuantity: '9.2903', needDate: '2026-12-01', deliveries: [{ seq: 1, quantity: '40.0000', baseQuantity: '3.7161', needDate: '2026-12-01' }, { seq: 2, quantity: '60.0000', baseQuantity: '5.5742', needDate: '2026-12-20' }] }
    expect(scheduleChecks([scheduled], today)).toEqual([])
    expect(scheduleChecks([{ ...scheduled, quantity: '120.0000' }], today).map((check) => check.code)).toEqual(['SCHEDULE_NOT_THE_LINE'])
    expect(scheduleChecks([scheduled], '2026-12-02').map((check) => [check.code, check.path])).toEqual([['DELIVERY_DATE_PAST', 'lines/10/deliveries/1']])
    expect(scheduleChecks([{ ...scheduled, deliveries: [] }], '2030-01-01')).toEqual([])
  })

  it('refuses a scheduled line its own quantity, unit or need date', () => {
    expect(scheduledEditProblem({ seq: 10, deliveries: 0 }, { quantity: true, uom: false, needDate: false })).toBeNull()
    expect(scheduledEditProblem({ seq: 10, deliveries: 2 }, { quantity: false, uom: false, needDate: false })).toBeNull()
    expect(scheduledEditProblem({ seq: 10, deliveries: 2 }, { quantity: true, uom: false, needDate: true })).toBe('Line 10 is split into 2 deliveries: its quantity, unit and need date are theirs. Change the delivery schedule, or clear it first.')
  })

  it('names its codes among the send checks', () => {
    for (const code of DEPTH_SEND_CHECK_CODES) expect(SEND_CHECK_CODES).toContain(code)
  })
})

describe('confirmed dates and their history (SCM-088)', () => {
  const now = new Date('2026-11-12T10:00:00Z')

  it('moves a confirmed day only while the order is open, and a first day only while it is answered', () => {
    expect(moveDateProblem('CONFIRMED')).toBeNull()
    expect(moveDateProblem('PARTLY_RECEIVED')).toBeNull()
    expect(moveDateProblem('DRAFT')).toMatch(/confirmed nothing yet/)
    expect(moveDateProblem('RECEIVED')).toMatch(/move no more/)
    expect(firstDateProblem('SENT')).toBeNull()
    expect(firstDateProblem('PARTLY_RECEIVED')).toMatch(/while the supplier answers it/)
  })

  it('asks a new day, a reason, the person only for the supplier, and a time not in the future', () => {
    expect(dateChangeProblems('2026-12-01', { toDate: '2026-12-08', source: 'SUPPLIER', reason: 'Tannery holiday', supplierContactName: 'M. Rossi', changedAt: now }, now)).toEqual([])
    const wrong = dateChangeProblems('2026-12-01', { toDate: '2026-12-01', source: 'BUYER', reason: ' ', supplierContactName: 'Someone', changedAt: new Date('2026-11-13T00:00:00Z') }, now)
    expect(wrong.map((issue) => issue.path)).toEqual(['body/date', 'body/reason', 'body/supplierContactName', 'body/changedAt'])
  })

  it('says how much later than needed, and a scheduled line follows its earliest delivery', () => {
    expect(daysLater('2026-12-01', '2026-12-08')).toBe(7)
    expect(daysLater('2026-12-01', '2026-11-28')).toBe(0)
    expect(daysLater('2026-12-01', null)).toBe(0)
    expect(lineDateOf([{ confirmedDate: '2026-12-20' }, { confirmedDate: null }, { confirmedDate: '2026-12-08' }])).toBe('2026-12-08')
    expect(lineDateOf([{ confirmedDate: null }])).toBeNull()
  })
})

describe('foreign currency (SCM-065)', () => {
  it('values the order in the company currency at the rate at order, one rounding', () => {
    // 7200.00 USD / 1.0850 = 6635.944… EUR → 6635.94 EUR.
    expect(companyValueOf(720_000, 'USD', '1.0850', 'EUR')).toBe(663_594)
    // 1,000,000 JPY (no minor unit) / 162.5 = 6153.846… → 6153.85 EUR.
    expect(companyValueOf(1_000_000, 'JPY', '162.5', 'EUR')).toBe(615_385)
    expect(rateWords('1.08500000', 'USD', 'EUR')).toBe('1 EUR = 1.085 USD')
  })

  it('takes a rate above 0 with at most eight decimals, and asks one before a foreign order is sent', () => {
    expect(rateProblem('1.0850')).toBeNull()
    expect(rateProblem('0')).toMatch(/above 0/)
    expect(rateProblem('1.123456789')).toMatch(/eight decimals/)
    expect(rateProblem('1,08')).toMatch(/plain decimal/)
    expect(currencyChecks({ currency: 'USD', rateAtOrder: null }, 'EUR').map((check) => check.code)).toEqual(['NO_RATE_AT_ORDER'])
    expect(currencyChecks({ currency: 'USD', rateAtOrder: '1.085' }, 'EUR')).toEqual([])
    expect(currencyChecks({ currency: 'EUR', rateAtOrder: null }, 'EUR')).toEqual([])
  })
})

describe('ship to a third party or a workshop (SCM-066, SCM-147)', () => {
  const workshop = { id: 'p-2', name: 'Workshop Seed', roles: ['SUBCONTRACTOR' as const], status: 'ACTIVE' as const }
  const address = (fields: Partial<ShipToAddress>): ShipToAddress => ({ id: 'a-1', partyId: 'p-2', kinds: ['SHIP_TO'], status: 'ACTIVE', approvalStatus: null, isDefaultShipTo: false, ...fields })

  it('ships to an active workshop, customer or brand, never to the supplier', () => {
    expect(shipToPartyProblem(workshop, 'p-1')).toBeNull()
    expect(shipToPartyProblem(workshop, 'p-2')).toMatch(/The supplier is who delivers/)
    expect(shipToPartyProblem({ ...workshop, roles: ['CARRIER'] }, 'p-1')).toMatch(/not a workshop/)
    expect(shipToPartyProblem({ ...workshop, status: 'BLOCKED' }, 'p-1')).toMatch(/blocked/)
  })

  it('takes the default delivery address, else the only one, and refuses one that cannot take goods', () => {
    expect(defaultAddressOf([address({ id: 'a-1' }), address({ id: 'a-2', isDefaultShipTo: true })])?.id).toBe('a-2')
    expect(defaultAddressOf([address({ id: 'a-1' }), address({ id: 'a-2', kinds: ['BILL_TO'] })])?.id).toBe('a-1')
    expect(defaultAddressOf([address({ id: 'a-1' }), address({ id: 'a-2' })])).toBeNull()
    const waiting = shipToProblems({ party: workshop, address: address({ approvalStatus: 'WAITING' }), addressNamed: true, place: null, placeNamed: false, siteId: 's-1' })
    expect(waiting.map((issue) => issue.path)).toEqual(['body/addressId'])
    const elsewhere = shipToProblems({ party: workshop, address: address({}), addressNamed: true, place: { id: 'l-1', partyId: 'p-2', siteId: 's-2', kind: 'SUBCONTRACTOR', status: 'ACTIVE' }, placeNamed: true, siteId: 's-1' })
    expect(elsewhere.map((issue) => issue.path)).toEqual(['body/locationId'])
  })

  it('warns when a workshop has no place on the site, and blocks an address gone', () => {
    expect(shipToChecks({ party: workshop, address: address({}), hasPlace: true }, 'p-1')).toEqual([])
    expect(shipToChecks({ party: workshop, address: address({}), hasPlace: false }, 'p-1').map((check) => [check.code, check.severity])).toEqual([['SHIP_TO_NO_WORKSHOP_PLACE', 'WARNING']])
    expect(shipToChecks({ party: workshop, address: address({ status: 'ARCHIVED' }), hasPlace: true }, 'p-1').map((check) => check.code)).toEqual(['SHIP_TO_NOT_USABLE'])
    expect(shipToChecks(null, 'p-1')).toEqual([])
  })
})

describe('delivery tolerances (SCM-061)', () => {
  const rule = (id: string, fields: Partial<ToleranceRule>): ToleranceRule => ({ id, companyId: null, supplierId: null, itemId: null, itemKind: null, overPct: '10', underPct: '5', whenBeyond: 'APPROVAL', status: 'ACTIVE', ...fields })
  const rules = [
    rule('r-tenant', {}),
    rule('r-kind', { companyId: 'c-A', supplierId: 's-2', itemKind: 'LEATHER', overPct: '5', underPct: '5', whenBeyond: 'BLOCK' }),
    rule('r-item', { companyId: 'c-A', supplierId: 's-2', itemId: 'i-prot', overPct: '0', underPct: '0', whenBeyond: 'BLOCK' }),
    rule('r-supplier', { supplierId: 's-3', overPct: '2', underPct: '2' }),
    rule('r-old', { itemId: 'i-prot', status: 'ARCHIVED' }),
  ]

  it('picks the most specific active rule: material, then supplier, then company', () => {
    expect(toleranceFor(rules, { companyId: 'c-A', supplierId: 's-2', itemId: 'i-prot', itemKind: 'PROTECTOR' })?.id).toBe('r-item')
    expect(toleranceFor(rules, { companyId: 'c-A', supplierId: 's-2', itemId: 'i-hide', itemKind: 'LEATHER' })?.id).toBe('r-kind')
    expect(toleranceFor(rules, { companyId: 'c-B', supplierId: 's-2', itemId: 'i-hide', itemKind: 'LEATHER' })?.id).toBe('r-tenant')
    expect(toleranceFor(rules, { companyId: 'c-B', supplierId: 's-3', itemId: 'i-hide', itemKind: 'LEATHER' })?.id).toBe('r-supplier')
    expect(toleranceFor([rules[4]!], { companyId: 'c-B', supplierId: 's-3', itemId: 'i-prot', itemKind: 'PROTECTOR' })).toBeNull()
  })

  it('keeps a line its own tolerance (W1), else the rule, else none', () => {
    expect(receiptToleranceOf({ areaTolerancePct: '7.5000' }, rules[1]!)).toEqual({ overPct: '7.5', underPct: '7.5', whenBeyond: 'REASON', source: 'LINE', toleranceId: null })
    expect(receiptToleranceOf({ areaTolerancePct: null }, rules[0]!)).toEqual({ overPct: '10', underPct: '5', whenBeyond: 'APPROVAL', source: 'RULE', toleranceId: 'r-tenant' })
    expect(receiptToleranceOf({ areaTolerancePct: null }, null)).toEqual({ overPct: '0', underPct: '0', whenBeyond: 'REASON', source: 'NONE', toleranceId: null })
  })

  it('counts a line received within the tolerance under, and refuses beyond the one over in words', () => {
    // 96 of 100 with −5 %: received; 94: still open. +10 % over: up to 110.
    expect(lineDifference({ expected: '100', receivedBefore: '0', receiving: '96', tolerancePct: '10', underPct: '5' })).toMatchObject({ kind: 'WITHIN_TOLERANCE', complete: true, underPct: '5' })
    expect(lineDifference({ expected: '100', receivedBefore: '0', receiving: '94', tolerancePct: '10', underPct: '5' })).toMatchObject({ kind: 'SHORT', complete: false, open: '6.0000' })
    expect(lineDifference({ expected: '100', receivedBefore: '0', receiving: '111', tolerancePct: '10', underPct: '5' })).toMatchObject({ kind: 'OVER', upTo: '110.0000' })
    expect(orderStatusAfter({ status: 'CONFIRMED', confirmed: true }, [{ expected: '100', received: '96', tolerancePct: '10', underPct: '5' }])).toBe('RECEIVED')
    expect(orderStatusAfter({ status: 'CONFIRMED', confirmed: true }, [{ expected: '100', received: '96', tolerancePct: '0' }])).toBe('PARTLY_RECEIVED')
    const tolerance = receiptToleranceOf({ areaTolerancePct: null }, rules[2]!)
    expect(beyondToleranceRefusal('Line 10: 12 received of 10.', tolerance, '10 pcs')).toBe('Line 10: 12 received of 10. Beyond the delivery tolerance (+0 %) the extra is refused: receive at most 10 pcs in all; the rest goes back to the supplier.')
    expect(beyondToleranceRefusal('W.', receiptToleranceOf({ areaTolerancePct: null }, rules[0]!), '110 m')).toMatch(/needs a person's yes: the office records this receipt to ask it, or receive at most 110 m in all here/)
    expect(beyondToleranceRefusal('W.', receiptToleranceOf({ areaTolerancePct: '5' }, rules[0]!), '105 m')).toBeNull()
  })

  it('takes percentages from 0 to 100, one material or one kind, never finished garments', () => {
    expect(toleranceProblems({ itemId: null, itemKind: 'LEATHER', overPct: '5', underPct: '5', note: null })).toEqual([])
    expect(toleranceProblems({ itemId: 'i-1', itemKind: 'LEATHER', overPct: '101', underPct: '-1', note: '' }).map((issue) => issue.path)).toEqual(['body/itemKind', 'body/overPct', 'body/underPct', 'body/note'])
    expect(toleranceProblems({ itemId: null, itemKind: 'FINISHED', overPct: '5', underPct: '5', note: null }).map((issue) => issue.path)).toEqual(['body/itemKind'])
  })
})
