import { describe, expect, it } from 'vitest'
import { InvalidStateError } from '../../core/errors'
import { assertTransition } from '../../state/machine'
import { Dec } from '../../tax/decimal'
import { LEGAL_WORDING, nonTaxable, taxable } from '../../tax/vat-treatment'
import {
  addDays,
  approvalDetails,
  brokenReasons,
  discountOf,
  isIssueList,
  isPriced,
  lineCostOf,
  priceBasisOf,
  priceVersion,
  quoteIssues,
  quoteVersionMachine,
  resolvePrice,
  sendBlockers,
  sizeGrid,
  submitBlockers,
  validityProblem,
  versionTaxModeOf,
  type IssueFacts,
  type MoneyLine,
  type SizeRow,
} from './quotes'
import { QUOTE_RULE_DEFAULTS, quoteRuleProblems } from './rules'

/**
 * Quotes' pure rules (B-W1-21), every figure made up and worked out by hand. The costs per garment are the costing seed's
 * jacket with no overhead (B-W1-16's hand-computed sheet): size 50 = 281.031, 52 = 290.439, 54 = 302.199.
 */

const IT = taxable(22)
const N32 = nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY)
const rules = { marginFloorPct: '20', discountLimitPct: '15' }
const cost = { '50': new Dec('281.031'), '52': new Dec('290.439'), '54': new Dec('302.199') } as const
const BLK: SizeRow[] = [
  { size: '50', quantity: 2, unitPrice: null },
  { size: '52', quantity: 4, unitPrice: null },
  { size: '54', quantity: 2, unitPrice: null },
]
const RED: SizeRow[] = [
  { size: '50', quantity: 1, unitPrice: null },
  { size: '52', quantity: 3, unitPrice: null },
  { size: '54', quantity: 2, unitPrice: null },
]
const costed = (sizes: SizeRow[]) => sizes.map((row) => ({ quantity: row.quantity, complete: true, knownTotal: cost[row.size as keyof typeof cost] }))
const BLK_COST = lineCostOf(costed(BLK), 'EUR')
const RED_COST = lineCostOf(costed(RED), 'EUR')
const line = (seq: number, unitPrice: string, sizes: SizeRow[], costAmount: number | null, listUnitPrice: string | null = null): MoneyLine => ({ seq, unitPrice, listUnitPrice, sizes, costAmount })
const net = (lines: MoneyLine[], depositPct: string | null = '30', treatment = IT) => priceVersion({ basis: 'NET', currency: 'EUR', treatment, lines, depositPct, rules })

describe('price basis and tax mode (GAP-001; Codice del Consumo art. 49; DL 331/1993 art. 41)', () => {
  it('prices consumers VAT included, businesses net', () => {
    expect(['IT_B2B', 'IT_B2C', 'EU_B2B', 'EU_B2C', 'EXTRA_EU'].map((mode) => priceBasisOf(mode as never))).toEqual(['NET', 'GROSS', 'NET', 'GROSS', 'NET'])
  })
  it('taxes an EU business without a VIES proof as an Italian sale', () => {
    expect(versionTaxModeOf('EU_B2B', true)).toBe('EU_B2B')
    expect(versionTaxModeOf('EU_B2B', false)).toBe('IT_B2B')
    expect(versionTaxModeOf('IT_B2C', false)).toBe('IT_B2C')
  })
})

describe("a line's price and size grid (SAL-268)", () => {
  it('takes a unit price, or a list price and a discount; the discount is list vs unit', () => {
    expect(resolvePrice({ unitPrice: '450.00' }, null, 'body')).toEqual({ unitPrice: '450', listUnitPrice: null })
    expect(resolvePrice({ listUnitPrice: '450', discountPct: '20' }, null, 'body')).toEqual({ unitPrice: '360', listUnitPrice: '450' })
    // 99.99 × 0.875 = 87.49125 → 87.49125 (6 places, nothing to round); 0.0000005 rounds half up.
    expect(resolvePrice({ listUnitPrice: '99.99', discountPct: '12.5' }, null, 'body')).toEqual({ unitPrice: '87.49125', listUnitPrice: '99.99' })
    expect(resolvePrice({ discountPct: '10' }, { unitPrice: '450', listUnitPrice: '500' }, 'body')).toEqual({ unitPrice: '450', listUnitPrice: '500' })
    expect(resolvePrice({}, { unitPrice: '450', listUnitPrice: null }, 'body')).toEqual({ unitPrice: '450', listUnitPrice: null })
    expect(resolvePrice({}, null, 'body')).toEqual({ unitPrice: '0', listUnitPrice: null })
  })
  it('refuses a discount with a unit price, without a list price, out of range, and negative prices', () => {
    expect(resolvePrice({ unitPrice: '400', listUnitPrice: '450', discountPct: '5' }, null, 'b')).toEqual([{ path: 'b/discountPct', message: 'Send a unit price or a discount off the list price, not both.' }])
    expect(resolvePrice({ discountPct: '5' }, null, 'b')).toEqual([{ path: 'b/listUnitPrice', message: 'A discount is taken off the list price: send the list price too.' }])
    expect(resolvePrice({ listUnitPrice: '450', discountPct: '100' }, null, 'b')).toEqual([{ path: 'b/discountPct', message: 'A discount from 0 to below 100 percent.' }])
    expect(resolvePrice({ unitPrice: '-1' }, null, 'b')).toEqual([{ path: 'b/unitPrice', message: 'A unit price of 0 or more with at most 6 decimals.' }])
    expect(resolvePrice({ unitPrice: '1.0000001' }, null, 'b')).toHaveLength(1)
  })
  it('keeps the offered sizes of the range, in its order, and drops the empty ones', () => {
    const facts = { range: ['50', '52', '54'], offered: new Set(['50', '52']) }
    expect(sizeGrid([{ size: '52', quantity: 4 }, { size: '50', quantity: 2, unitPrice: '455.50' }], facts, 'b')).toEqual([
      { size: '50', quantity: 2, unitPrice: '455.5' },
      { size: '52', quantity: 4, unitPrice: null },
    ])
    expect(sizeGrid([{ size: '50', quantity: 0 }, { size: '52', quantity: 3, unitPrice: null }], facts, 'b')).toEqual([{ size: '52', quantity: 3, unitPrice: null }])
    expect(sizeGrid([{ size: '54', quantity: 1 }], facts, 'b')).toEqual([{ path: 'b/0/size', message: 'Size 54 is not offered in this colourway (no active SKU).' }])
    expect(sizeGrid([{ size: '56', quantity: 1 }], facts, 'b')).toEqual([{ path: 'b/0/size', message: "Not a size of this style's range (50, 52, 54)." }])
    expect(sizeGrid([{ size: '50', quantity: 1 }, { size: '50', quantity: 2 }], facts, 'b')).toEqual([{ path: 'b/1/size', message: 'Size 50 is in the grid twice.' }])
    expect(sizeGrid([{ size: '50', quantity: 1.5 }], facts, 'b')).toEqual([{ path: 'b/0/quantity', message: 'Whole pieces from 0 to 99999.' }])
    expect(sizeGrid([{ size: '50', quantity: 0 }], facts, 'b')).toEqual([{ path: 'b', message: 'A size grid line has at least one piece.' }])
    expect(isIssueList(sizeGrid([{ size: '50', quantity: 0 }], facts, 'b'))).toBe(true)
  })
  it('reads the discount off the cheapest price the line sells at; a line is priced when every piece sells above 0', () => {
    expect(discountOf({ unitPrice: '360', listUnitPrice: '450', sizes: BLK })).toBe('20')
    expect(discountOf({ unitPrice: '450', listUnitPrice: '450', sizes: [{ size: '50', quantity: 1, unitPrice: '405' }] })).toBe('10')
    expect(discountOf({ unitPrice: '460', listUnitPrice: '450', sizes: BLK })).toBeNull()
    expect(discountOf({ unitPrice: '360', listUnitPrice: null, sizes: BLK })).toBeNull()
    expect(isPriced({ unitPrice: '450', sizes: BLK })).toBe(true)
    expect(isPriced({ unitPrice: '0', sizes: BLK })).toBe(false)
    expect(isPriced({ unitPrice: '450', sizes: [{ size: '50', quantity: 1, unitPrice: '0' }] })).toBe(false)
  })
})

describe("a line's cost from the style's cost sheet (SAL-172; B-W1-16)", () => {
  it('sums cost per garment × pieces exactly and rounds once', () => {
    // BLK 2 × 281.031 + 4 × 290.439 + 2 × 302.199 = 2328.216 → 2328.22; ÷ 8 = 291.027.
    expect(BLK_COST).toEqual({ complete: true, unitCost: '291.027', amount: 232822 })
    // RED 281.031 + 3 × 290.439 + 2 × 302.199 = 1756.746 → 1756.75 (half up); ÷ 6 = 292.791.
    expect(RED_COST).toEqual({ complete: true, unitCost: '292.791', amount: 175675 })
  })
  it('is incomplete, never 0, when a size misses an input', () => {
    expect(lineCostOf([{ quantity: 2, complete: true, knownTotal: new Dec('281.031') }, { quantity: 1, complete: false, knownTotal: new Dec('59.9') }], 'EUR')).toEqual({ complete: false, unitCost: null, amount: null })
    expect(lineCostOf([], 'EUR')).toEqual({ complete: false, unitCost: null, amount: null })
  })
})

describe("a version's money: net, VAT, gross, deposit, cost and margin (GAP-001, SAL-172)", () => {
  it('an Italian business quote, 2 colours × 3 sizes, above the floor', () => {
    const priced = net([line(10, '450', BLK, BLK_COST.amount), line(20, '440', RED, RED_COST.amount)])
    // Net 8 × 450 + 6 × 440 = 3600 + 2640 = 6240.00; VAT 22 % = 1372.80; gross 7612.80; deposit 30 % = 2283.84.
    expect(priced).toMatchObject({ basis: 'NET', netAmount: 624000, vatAmount: 137280, grossAmount: 761280, depositAmount: 228384 })
    expect(priced.vat).toEqual([{ rate: '22.00', nature: null, taxable: 624000, vat: 137280, rounding: 0 }])
    // Cost 2328.22 + 1756.75 = 4084.97; margin 2155.03 = 34.5357 % of 6240.00 (floor 20 %).
    expect(priced).toMatchObject({ costComplete: true, costAmount: 408497, marginAmount: 215503, marginPct: '34.5357', marginFloorPct: '20', marginFloorBreached: false, approvalNeeded: false })
    expect(priced.lines).toEqual([
      { seq: 10, quantity: 8, netAmount: 360000, vatAmount: 79200, discountPct: null, costAmount: 232822, marginAmount: 127178, marginPct: '35.3272', belowFloor: false },
      { seq: 20, quantity: 6, netAmount: 264000, vatAmount: 58080, discountPct: null, costAmount: 175675, marginAmount: 88325, marginPct: '33.4564', belowFloor: false },
    ])
    expect(priced.rules.map((rule) => [rule.reason, rule.known, rule.broken])).toEqual([
      ['MARGIN_FLOOR', true, false],
      ['DISCOUNT_LIMIT', true, false],
    ])
  })

  it('under the floor: the margin rule breaks and names the lines', () => {
    // Net 14 × 340 = 4760.00; margin 4760.00 − 4084.97 = 675.03 = 14.1813 %; BLK 391.78 = 14.4037 %, RED 283.25 = 13.8848 %.
    const priced = net([line(10, '340', BLK, BLK_COST.amount), line(20, '340', RED, RED_COST.amount)])
    expect(priced).toMatchObject({ netAmount: 476000, marginAmount: 67503, marginPct: '14.1813', marginFloorBreached: true, approvalNeeded: true })
    expect(priced.lines.map((entry) => [entry.seq, entry.marginPct, entry.belowFloor])).toEqual([
      [10, '14.4037', true],
      [20, '13.8848', true],
    ])
    expect(priced.rules[0]).toEqual({ reason: 'MARGIN_FLOOR', known: true, broken: true, lines: [10, 20], message: "The quote's margin is under the floor: an approver decides." })
    expect(brokenReasons(priced.rules)).toEqual(['MARGIN_FLOOR'])
  })

  it('one line under the floor breaks the rule even when the quote as a whole is above it (FIN-023)', () => {
    // RED at 300: 1800.00 − 1756.75 = 43.25 = 2.4028 %; the quote 5400.00 − 4084.97 = 1315.03 = 24.3524 %.
    const priced = net([line(10, '450', BLK, BLK_COST.amount), line(20, '300', RED, RED_COST.amount)])
    expect(priced).toMatchObject({ marginPct: '24.3524', marginFloorBreached: true, approvalNeeded: true })
    expect(priced.rules[0]).toMatchObject({ broken: true, lines: [20], message: 'Line 20 is under the margin floor: an approver decides.' })
  })

  it('exactly at the floor passes; a hair under it breaks', () => {
    // A line costing 80.00 sold at 100.00 a piece: margin exactly 20 %.
    const sizes = [{ size: '50', quantity: 1, unitPrice: null }]
    expect(net([line(10, '100', sizes, 8000)]).marginFloorBreached).toBe(false)
    expect(net([line(10, '99.99', sizes, 8000)]).marginFloorBreached).toBe(true)
  })

  it('a discount over the limit breaks the discount rule, with the numbers in words', () => {
    // BLK 400 off a 500 list = 20 %, its margin 3200.00 − 2328.22 = 27.24 % (above the floor); RED 440 off 450 = 2.2222 %.
    const priced = net([line(10, '400', BLK, BLK_COST.amount, '500'), line(20, '440', RED, RED_COST.amount, '450')])
    expect(priced.lines.map((entry) => entry.discountPct)).toEqual(['20', '2.2222'])
    expect(priced.marginFloorBreached).toBe(false)
    expect(priced.rules[1]).toEqual({ reason: 'DISCOUNT_LIMIT', known: true, broken: true, lines: [10], message: 'Line 10 has a discount off the list price over the 15 % limit: an approver decides.' })
    expect(brokenReasons(priced.rules)).toEqual(['DISCOUNT_LIMIT'])
  })

  it('a size with its own price is rounded with its own group, inside the line', () => {
    // 50: 2 × 455.555 = 911.11; 52 and 54: 6 × 450 = 2700.00; line 3611.11; VAT 794.44.
    const priced = net([line(10, '450', [{ size: '50', quantity: 2, unitPrice: '455.555' }, ...BLK.slice(1)], BLK_COST.amount)], null)
    expect(priced).toMatchObject({ netAmount: 361111, vatAmount: 79444, grossAmount: 440555, depositAmount: null })
  })

  it('an EU business with a VIES proof: N3.2, no VAT, gross = net', () => {
    const priced = net([line(10, '450', BLK, BLK_COST.amount)], '30', N32)
    expect(priced).toMatchObject({ netAmount: 360000, vatAmount: 0, grossAmount: 360000, depositAmount: 108000 })
    expect(priced.vat).toEqual([{ rate: null, nature: 'N3.2', taxable: 360000, vat: 0, rounding: 0 }])
    expect(priced.lines[0]!.vatAmount).toBe(0)
  })

  it('a consumer quote is priced VAT included: the gross is what the consumer sees', () => {
    // 549.00 VAT included: 450.00 + 99.00.
    const priced = priceVersion({ basis: 'GROSS', currency: 'EUR', treatment: IT, lines: [line(10, '549', [{ size: '52', quantity: 1, unitPrice: null }], 29044)], depositPct: '30', rules })
    expect(priced).toMatchObject({ netAmount: 45000, vatAmount: 9900, grossAmount: 54900, depositAmount: 16470, marginAmount: 15956, marginPct: '35.4578' })
    expect(priced.lines[0]).toMatchObject({ netAmount: 45000, vatAmount: 9900 })
  })

  it('an incomplete cost: no margin, the floor rule unknown, never 0', () => {
    const priced = net([line(10, '450', BLK, BLK_COST.amount), line(20, '440', RED, null)])
    expect(priced).toMatchObject({ costComplete: false, costAmount: null, marginAmount: null, marginPct: null, marginFloorBreached: false })
    expect(priced.rules[0]).toEqual({ reason: 'MARGIN_FLOOR', known: false, broken: false, lines: [], message: 'The margin is not known until every line has its cost.' })
    expect(priced.lines[1]).toMatchObject({ costAmount: null, marginAmount: null, marginPct: null, belowFloor: false })
  })

  it('no lines: zeros, no deposit amount above 0, the margin not known', () => {
    expect(net([])).toMatchObject({ netAmount: 0, vatAmount: 0, grossAmount: 0, depositAmount: 0, costComplete: false, approvalNeeded: false, vat: [] })
  })
})

describe('the approval request (SAL-184)', () => {
  it('records the numbers behind each broken rule and exactly what was asked, never a cost or margin amount', () => {
    const priced = net([line(10, '340', BLK, BLK_COST.amount, '450'), line(20, '440', RED, RED_COST.amount)])
    const details = approvalDetails(priced, [{ seq: 10, description: 'Jacket black', quantity: 8, unitPrice: '340', listUnitPrice: '450' }, { seq: 20, description: 'Jacket red', quantity: 6, unitPrice: '440', listUnitPrice: null }], 'f'.repeat(64))
    expect(details.rules).toEqual([
      { reason: 'MARGIN_FLOOR', marginPct: priced.marginPct, marginFloorPct: '20', lines: [{ seq: 10, marginPct: '14.4037' }] },
      { reason: 'DISCOUNT_LIMIT', discountLimitPct: '15', lines: [{ seq: 10, discountPct: '24.4444' }] },
    ])
    expect(details.asked).toMatchObject({ netAmount: 536000, grossAmount: 653920, marginFloorPct: '20' })
    expect(JSON.stringify(details)).not.toMatch(/costAmount|marginAmount|unitCost/)
  })
})

const facts = (over: Partial<IssueFacts> = {}): IssueFacts => ({
  today: '2026-10-29',
  party: { status: 'ACTIVE', legalName: 'Cliente Fittizio', taxMode: 'IT_B2B', viesValid: false, viesMessage: null },
  version: { validUntil: '2026-11-28', billToAddressId: 'b', shipToAddressId: 's', promiseDate: null, contactEmail: 'buyer@example.com' },
  lines: [{ id: 'l1', seq: 10, label: 'SEED-JKT-01 Black', priced: true, costMissing: [], costRevision: 'RELEASED', certificates: [{ size: '50', reasons: [] }] }],
  rules: [],
  ...over,
})

describe('what stops a quote, in words', () => {
  it('nothing stops a complete quote', () => {
    expect(quoteIssues(facts())).toEqual([])
  })
  it('an incomplete cost, an unpriced line, a blocked party and no lines stop the approval request', () => {
    const issues = quoteIssues(
      facts({
        party: { status: 'BLOCKED', legalName: 'Cliente Fittizio', taxMode: 'IT_B2B', viesValid: false, viesMessage: null },
        lines: [{ id: 'l1', seq: 10, label: 'SEED-JKT-01 Black', priced: false, costMissing: ['No standard price for SEED-LEA-100.'], costRevision: 'DRAFT', certificates: [] }],
      }),
    )
    expect(submitBlockers(issues).map((issue) => [issue.code, issue.message])).toEqual([
      ['PARTY_NOT_QUOTABLE', 'Cliente Fittizio is blocked: no quote goes to it until it is active again.'],
      ['NOT_PRICED', 'Line 10 (SEED-JKT-01 Black) has no price: every piece sells above 0.'],
      ['COST_INCOMPLETE', 'Line 10 (SEED-JKT-01 Black): the cost is incomplete — No standard price for SEED-LEA-100.'],
    ])
    expect(quoteIssues(facts({ lines: [] })).map((issue) => issue.code)).toEqual(['NO_LINES'])
    expect(quoteIssues(facts({ lines: [{ id: 'l1', seq: 10, label: 'X', priced: true, costMissing: [], costRevision: null, certificates: [] }] })).map((issue) => issue.code)).toEqual(['NO_COST_REVISION'])
  })
  it('certificate gaps, an unproven EU VAT number and an estimate are said, not blocking', () => {
    const issues = quoteIssues(
      facts({
        party: { status: 'ACTIVE', legalName: 'Kunde', taxMode: 'EU_B2B', viesValid: false, viesMessage: 'Not checked with VIES yet.' },
        lines: [{ id: 'l1', seq: 10, label: 'SEED-JKT-01 Black', priced: true, costMissing: [], costRevision: 'DRAFT', certificates: [{ size: '54', reasons: ['No valid certificate covers size 54.'] }] }],
      }),
    )
    expect(issues.map((issue) => [issue.code, issue.severity, issue.size])).toEqual([
      ['COST_ESTIMATE', 'INFO', null],
      ['CERTIFICATE', 'WARNING', '54'],
      ['VIES_NOT_PROVEN', 'WARNING', null],
    ])
    expect(issues[2]!.message).toBe('VAT is charged at 22 % until VIES confirms the VAT number. Not checked with VIES yet.')
    expect(submitBlockers(issues)).toEqual([])
  })
  it('the send also needs validity, addresses, a contact email, a consumer promise date and the approval', () => {
    const issues = quoteIssues(facts({ party: { status: 'ACTIVE', legalName: 'Privato', taxMode: 'IT_B2C', viesValid: false, viesMessage: null }, version: { validUntil: '2026-10-28', billToAddressId: null, shipToAddressId: null, promiseDate: null, contactEmail: null } }))
    expect(issues.map((issue) => issue.code)).toEqual(['VALIDITY_PAST', 'NO_BILL_TO', 'NO_SHIP_TO', 'NO_CONTACT_EMAIL', 'NO_PROMISE_DATE'])
    expect(submitBlockers(issues)).toEqual([])
    expect(sendBlockers([], 'DRAFT', true).map((issue) => issue.message)).toEqual(['A rule is broken: ask for an approval first.'])
    expect(sendBlockers([], 'PENDING_APPROVAL', true).map((issue) => issue.message)).toEqual(['The approval request is waiting for a decision.'])
    expect(sendBlockers([], 'APPROVED', true)).toEqual([])
    expect(sendBlockers([], 'DRAFT', false)).toEqual([])
    expect(sendBlockers([], 'CANCELLED', false).map((issue) => issue.message)).toEqual(['The quote is cancelled.'])
  })
})

describe('states, validity and rules', () => {
  it('moves as the database allows; a cancelled or accepted version is final', () => {
    expect(() => assertTransition(quoteVersionMachine, 'DRAFT', 'PENDING_APPROVAL')).not.toThrow()
    expect(() => assertTransition(quoteVersionMachine, 'PENDING_APPROVAL', 'DRAFT')).not.toThrow()
    expect(() => assertTransition(quoteVersionMachine, 'APPROVED', 'DRAFT')).not.toThrow()
    expect(() => assertTransition(quoteVersionMachine, 'DRAFT', 'APPROVED')).toThrow(InvalidStateError)
    expect(() => assertTransition(quoteVersionMachine, 'CANCELLED', 'DRAFT')).toThrow(InvalidStateError)
    expect(quoteVersionMachine.finals).toEqual(['ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'])
  })
  it('an offer stands at least until tomorrow; the default is today + the rule', () => {
    expect(addDays('2026-10-29', QUOTE_RULE_DEFAULTS.defaultValidityDays)).toBe('2026-11-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(validityProblem('2026-10-29', '2026-10-29')).toBe('The offer stands at least until tomorrow.')
    expect(validityProblem('2026-10-30', '2026-10-29')).toBeNull()
    expect(validityProblem('30/10/2026', '2026-10-29')).toBe('Expected a calendar day written YYYY-MM-DD.')
  })
  it('the defaults are valid rules; a broken setting is refused with its path', () => {
    expect(quoteRuleProblems(QUOTE_RULE_DEFAULTS)).toEqual([])
    expect(quoteRuleProblems({ marginFloorPct: '100', discountLimitPct: '100', defaultValidityDays: 365, defaultDepositPct: '100' })).toEqual([])
    expect(quoteRuleProblems({ marginFloorPct: '-1', discountLimitPct: '100.0001', defaultValidityDays: 0, defaultDepositPct: '0' }).map((issue) => issue.path)).toEqual([
      'body/marginFloorPct',
      'body/discountLimitPct',
      'body/defaultDepositPct',
      'body/defaultValidityDays',
    ])
  })
})
