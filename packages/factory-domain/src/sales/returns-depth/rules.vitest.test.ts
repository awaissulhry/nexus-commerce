import { describe, expect, it } from 'vitest'
import { rmaPapers } from './papers'
import {
  arrivalOf,
  channelOfParty,
  creditWithoutReturnProblems,
  deadlineOf,
  feeOf,
  feeRuleProblems,
  feeWithAmount,
  pickFeeRule,
  policyDraftProblems,
  SCAN_CODE,
  scanCodeCandidates,
  scanCodeOf,
  windowCheckOf,
  withdrawalOf,
  type FeeRuleLike,
  type PolicyDraft,
} from './rules'

/** Returns in depth (B-W2b-341; SAL-336, SAL-337, SAL-338, SAL-342, SAL-343, SAL-346): the pure rules. */

const policy: PolicyDraft = { channel: 'B2B', name: 'Brands and dealers', windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', conditions: null, withdrawalWords: null, effectiveFrom: '2026-11-01' }
const rule = (over: Partial<FeeRuleLike>): FeeRuleLike => ({ id: 'r', name: 'Change of mind', channel: null, reasonCodes: [], kind: 'PERCENT', percent: '10', amount: null, currency: null, sequence: 100, active: true, createdAt: '2026-01-01T00:00:00.000Z', ...over })

describe('the return policy (SAL-338)', () => {
  it('takes a business policy; a consumer at a distance has at least 14 days and only it has withdrawal words', () => {
    expect(policyDraftProblems(policy)).toEqual([])
    expect(policyDraftProblems({ ...policy, channel: 'CONSUMER_DISTANCE', windowDays: 10 }).map((problem) => problem.path)).toEqual(['windowDays'])
    expect(policyDraftProblems({ ...policy, channel: 'CONSUMER_DISTANCE', windowDays: 14, withdrawalWords: 'Words for the lawyer.' })).toEqual([])
    expect(policyDraftProblems({ ...policy, withdrawalWords: 'Words.' }).map((problem) => problem.path)).toEqual(['withdrawalWords'])
    expect(policyDraftProblems({ ...policy, name: 'two\nlines', goodsDueDays: 0, windowDays: 400 }).map((problem) => problem.path)).toEqual(['name', 'windowDays', 'goodsDueDays'])
  })

  it('reads the channel from the customer: a private person buys as a consumer', () => {
    expect(channelOfParty('PERSON')).toBe('CONSUMER_DISTANCE')
    expect(channelOfParty('ORGANISATION')).toBe('B2B')
  })

  it('checks a line against the window in words, never silently', () => {
    expect(windowCheckOf('2026-11-01', '2026-11-20', 30)).toMatchObject({ inWindow: true, lastDay: '2026-12-01', words: null })
    expect(windowCheckOf('2026-10-01', '2026-11-12', 30, 10)).toEqual({ deliveredOn: '2026-10-01', lastDay: '2026-10-31', inWindow: false, daysOver: 12, words: "Line 10 was delivered on 2026-10-01: the policy's 30 days ended on 2026-10-31 (12 days ago)." })
    expect(windowCheckOf(null, '2026-11-12', 30, 20).words).toBe('Line 20: the delivery day is not known, so the 30 days of the policy cannot be counted.')
  })

  it('gives the consumer the right of withdrawal only for standard goods sold at a distance, within 14 days (art. 52, art. 59)', () => {
    const line = { seq: 10, deliveredOn: '2026-11-05', madeToMeasure: false, personalised: false, orderSaysNone: false }
    expect(withdrawalOf({ channel: 'CONSUMER_DISTANCE', today: '2026-11-12', lines: [line] })).toEqual({ applies: true, why: [], notes: [] })
    expect(withdrawalOf({ channel: 'B2B', today: '2026-11-12', lines: [line] }).applies).toBe(false)
    const refused = withdrawalOf({ channel: 'CONSUMER_DISTANCE', today: '2026-11-25', lines: [line, { ...line, seq: 20, madeToMeasure: true }, { ...line, seq: 30, personalised: true }, { ...line, seq: 40, orderSaysNone: true }] })
    expect(refused.applies).toBe(false)
    expect(refused.why).toEqual([
      'Line 10 was delivered on 2026-11-05: the 14 days of withdrawal ended on 2026-11-19.',
      "Line 20 is made to measure: goods made to the consumer's specifications have no right of withdrawal (art. 59 c.1 c).",
      'Line 20 was delivered on 2026-11-05: the 14 days of withdrawal ended on 2026-11-19.',
      "Line 30 is personalised (the customer's artwork or own words): no right of withdrawal (art. 59 c.1 c).",
      'Line 30 was delivered on 2026-11-05: the 14 days of withdrawal ended on 2026-11-19.',
      'Line 40: its order states that it has no right of withdrawal (made to measure for the consumer).',
      'Line 40 was delivered on 2026-11-05: the 14 days of withdrawal ended on 2026-11-19.',
    ])
    expect(withdrawalOf({ channel: 'CONSUMER_DISTANCE', today: '2026-11-12', lines: [{ ...line, deliveredOn: null }] })).toMatchObject({ applies: true, notes: ['Line 10: the delivery day is not known; the 14 days count from delivery.'] })
  })
})

describe('the deadline on the RMA (SAL-337)', () => {
  it('counts from the authorisation and flags a late arrival by its day', () => {
    expect(deadlineOf('2026-11-01', 15)).toBe('2026-11-16')
    expect(deadlineOf('2026-11-01', null)).toBeNull()
    expect(arrivalOf('2026-11-16', null, '2026-11-10')).toEqual({ state: 'WAITING', daysLate: 0, words: 'Waiting for the goods by 2026-11-16.' })
    expect(arrivalOf('2026-11-16', null, '2026-11-18')).toMatchObject({ state: 'OVERDUE', daysLate: 2 })
    expect(arrivalOf('2026-11-16', '2026-11-16', '2026-11-20')).toMatchObject({ state: 'ON_TIME', daysLate: 0 })
    expect(arrivalOf('2026-11-16', '2026-11-19', '2026-11-20')).toEqual({ state: 'LATE', daysLate: 3, words: 'Arrived after the deadline: on 2026-11-19, 3 days after 2026-11-16.' })
    expect(arrivalOf(null, '2026-11-19', '2026-11-20').state).toBe('NO_DEADLINE')
  })
})

describe('restocking and handling fees (SAL-343)', () => {
  it('checks a rule: a percent of the credit or a fixed amount with its currency', () => {
    expect(feeRuleProblems({ channel: null, name: 'Change of mind', reasonCodes: ['OTHER'], kind: 'PERCENT', percent: '10', amount: null, currency: null, sequence: 10 })).toEqual([])
    expect(feeRuleProblems({ channel: 'B2B', name: 'Wrong size', reasonCodes: ['WRONG_SIZE'], kind: 'AMOUNT', percent: null, amount: 1500, currency: 'EUR', sequence: 20 })).toEqual([])
    expect(feeRuleProblems({ channel: null, name: 'Bad', reasonCodes: ['OTHER', 'OTHER', 'x'], kind: 'PERCENT', percent: '120', amount: 5, currency: null, sequence: 0 }).map((problem) => problem.path)).toEqual(['reasonCodes', 'percent', 'amount', 'sequence'])
    expect(feeRuleProblems({ channel: null, name: 'Bad', reasonCodes: ['ok'], kind: 'AMOUNT', percent: null, amount: 0, currency: 'eur', sequence: 1 }).map((problem) => problem.path)).toEqual(['reasonCodes/0', 'amount', 'currency'])
  })

  it('picks the first active rule of the channel and the reason, in its order', () => {
    const rules = [rule({ id: 'b', sequence: 20, reasonCodes: ['WRONG_SIZE'], channel: 'B2B' }), rule({ id: 'a', sequence: 10, reasonCodes: ['OTHER'] }), rule({ id: 'off', sequence: 1, active: false }), rule({ id: 'all', sequence: 99 })]
    expect(pickFeeRule(rules, { channel: 'B2B', reasonCode: 'WRONG_SIZE' })?.id).toBe('b')
    expect(pickFeeRule(rules, { channel: 'CONSUMER_DISTANCE', reasonCode: 'WRONG_SIZE' })?.id).toBe('all')
    expect(pickFeeRule(rules, { channel: 'B2B', reasonCode: 'OTHER' })?.id).toBe('a')
    expect(pickFeeRule([rule({ channel: 'B2B', reasonCodes: ['X1'] })], { channel: 'B2B', reasonCode: 'OTHER' })).toBeNull()
  })

  it('withholds the fee from the credit, never more than it, and drops it when the cause is ours', () => {
    expect(feeOf(rule({}), { credit: 12_345, currency: 'EUR', cause: 'NO_FAULT' })).toEqual({ amount: 1235, dropped: null, creditAfter: 11_110, words: 'Change of mind: 10 % of the credit' })
    expect(feeOf(rule({ kind: 'AMOUNT', percent: null, amount: 1500, currency: 'EUR' }), { credit: 1000, currency: 'EUR', cause: null })).toMatchObject({ amount: 1000, creditAfter: 0 })
    expect(feeOf(rule({}), { credit: 10_000, currency: 'EUR', cause: 'OUR_DEFECT' })).toEqual({ amount: 0, dropped: 'OUR_CAUSE', creditAfter: 10_000, words: 'Change of mind: 10 % of the credit, dropped: the cause is ours (our defect).' })
    expect(feeOf(rule({}), { credit: 10_000, currency: 'EUR', cause: 'TRANSIT' }).dropped).toBe('OUR_CAUSE')
    expect(feeOf(rule({}), { credit: 0, currency: 'EUR', cause: null }).dropped).toBe('NO_CREDIT')
    expect(feeOf(rule({ kind: 'AMOUNT', percent: null, amount: 1500, currency: 'USD' }), { credit: 9000, currency: 'EUR', cause: null }).dropped).toBe('OTHER_CURRENCY')
    expect(feeWithAmount(feeOf(rule({}), { credit: 12_000, currency: 'EUR', cause: null }), 'EUR')).toBe('Change of mind: 10 % of the credit = 12.00 EUR')
  })
})

describe('credit without a return (SAL-342)', () => {
  const facts = { status: 'AUTHORISED' as const, seq: 10, quantity: 2, received: 0, decided: false, value: 50_000, waiting: false }
  it('credits a line none of whose pieces came, at most what they are worth', () => {
    expect(creditWithoutReturnProblems(facts, undefined)).toEqual([])
    expect(creditWithoutReturnProblems(facts, 15_000)).toEqual([])
    expect(creditWithoutReturnProblems(facts, 60_000)).toEqual([{ path: 'creditAmount', message: 'Never more than what its pieces are worth.' }])
    expect(creditWithoutReturnProblems({ ...facts, received: 1 }, undefined)[0]!.message).toMatch(/^Pieces of line 10 arrived/)
    expect(creditWithoutReturnProblems({ ...facts, decided: true }, undefined)[0]!.message).toBe('Line 10 is decided already.')
    expect(creditWithoutReturnProblems({ ...facts, waiting: true }, undefined)[0]!.message).toBe('A credit of line 10 without the goods waits for a yes already.')
    expect(creditWithoutReturnProblems({ ...facts, status: 'CLOSED' }, undefined)[0]!.message).toBe('The return is closed: nothing more is credited on it.')
    expect(creditWithoutReturnProblems({ ...facts, value: null }, undefined)[0]!.path).toBe('creditAmount')
  })
})

describe('the scan code on the papers (SAL-346)', () => {
  it('makes codes of the shape from the number, the company first when another RMA holds it', () => {
    const codes = scanCodeCandidates('RMA-2026-0001', 'A')
    expect(codes.slice(0, 3)).toEqual(['RMA-2026-0001', 'A-RMA-2026-0001', 'A-RMA-2026-0001-2'])
    expect(codes.every((code) => SCAN_CODE.test(code))).toBe(true)
    expect(scanCodeCandidates('r/12', 'Società').slice(0, 2)).toEqual(['RMA-R-12', 'SOCIETA-R-12'])
    expect(scanCodeCandidates('r/12', 'Società').every((code) => SCAN_CODE.test(code))).toBe(true)
    expect(scanCodeCandidates('X'.repeat(80), 'B').every((code) => code.length <= 40 && SCAN_CODE.test(code))).toBe(true)
    expect(scanCodeOf(' rma-2026-0001 ')).toBe('RMA-2026-0001')
    expect(scanCodeOf('RMA 1')).toBeNull()
  })

  it('prints the code, the lines with serial and lot, the deadline and the box label; no price', () => {
    const papers = rmaPapers({
      language: 'en',
      date: '2026-11-12',
      company: { name: 'Made-up Leather Srl', lines: ['Made-up street 1'], legal: 'Made-up legal line' },
      number: 'RMA-2026-0001',
      scanCode: 'RMA-2026-0001',
      customer: { name: 'Made-up Brand', reference: 'REF-1' },
      sendTo: { name: 'Plant A1', address: null },
      authorisedOn: '2026-11-10',
      goodsDueBy: '2026-11-25',
      freightPaidBy: 'BY_CAUSE',
      lines: [{ seq: 10, description: 'Jacket RED 52', size: '52', quantity: 1, serial: 'SN-1', lot: 'BT-1' }],
      policyName: 'Brands and dealers',
      conditions: 'Unused, with labels.',
      withdrawal: null,
    })
    expect(papers.scanCode).toBe('RMA-2026-0001')
    expect(papers.sections[0]!.table!.rows).toEqual([['10', 'Jacket RED 52', '52', '1', 'SN-1', 'BT-1']])
    expect(papers.facts.map((fact) => fact.label)).toContain('Send it by')
    expect(papers.label.lines[0]).toBe('Return RMA-2026-0001')
    expect(papers.fileName).toBe('return-RMA-2026-0001.pdf')
    expect(JSON.stringify(papers)).not.toMatch(/price|credit/i)
  })
})
