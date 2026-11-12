import { describe, expect, it } from 'vitest'
import { canFor, RMA_AUTHORISED, RMA_INSPECTED, RMA_RECEIVED } from '../demo/fixtures'
import { decisionDraftProblems, decisionLinesOf, PICKABLE_DISPOSITIONS, sourcesOf, TILES } from '../model'
import { DEPTH_AUTHORISED, DEPTH_CREDIT_WAITING, DEPTH_INSPECTED, DEPTH_RECEIVED, DEPTH_RECEIVED_LATE, depthModel, OUTCOMES_INSPECTED, OUTCOMES_PART_RECEIVED, POLICY_CHECK, RMA_PART_RECEIVED } from './demo/fixtures'
import { arrivalWords, creditBody, creditDraftProblems, creditHeldKey, creditStateOf, feeWords, finishOptionsOf, finishProblems, lateRowsOf, policyHeld, policyProblems, policyWords, printHeld, splitHeldKey, windowWords } from './model'

const owner = canFor('owner')

describe('the W2b parts of a return (B-W2b-352)', () => {
  it('the policy and the goods against their deadline, in words', () => {
    expect(policyWords(DEPTH_AUTHORISED)).toEqual({ key: 'depth:policy.salesSettings' })
    expect(policyWords(DEPTH_RECEIVED_LATE)).toEqual({ key: 'depth:policy.named', params: { name: 'Demo returns policy 2026', days: 30 } })
    expect(arrivalWords(DEPTH_RECEIVED_LATE)).toEqual({ key: 'depth:arrival.LATE', params: { date: '2026-10-27', count: 3 } })
    expect(arrivalWords(DEPTH_AUTHORISED)).toEqual({ key: 'depth:arrival.WAITING', params: { date: '2026-11-14' } })
    expect(windowWords({ deliveredOn: '2026-09-01', lastDay: '2026-10-01', inWindow: false, daysOver: 3 })).toEqual({ key: 'depth:window.over', params: { date: '2026-10-01', count: 3 } })
    expect(windowWords({ deliveredOn: '2026-09-01', lastDay: '2026-10-01', inWindow: true, daysOver: 0 })).toBeNull()
  })

  it('a credit without the goods: allowed, waiting, credited, or held by the role first', () => {
    const [first, second] = DEPTH_CREDIT_WAITING.lines
    expect(creditStateOf(first!)).toBe('waiting')
    expect(creditStateOf(second!)).toBe('credited')
    const line = { ...DEPTH_AUTHORISED.lines[0]!, decided: false }
    expect(creditHeldKey('AUTHORISED', line, owner, false)).toBeNull()
    expect(creditHeldKey('AUTHORISED', line, canFor('warehouse'), false)).toEqual({ key: 'held.right.decide' })
    expect(creditHeldKey('AUTHORISED', line, owner, true)).toEqual({ key: 'held.offline' })
    expect(creditHeldKey('AUTHORISED', { ...line, creditWithoutReturn: { credited: false, waiting: null, allowed: false }, receivedQuantity: 1 }, owner, false)).toEqual({ key: 'depth:held.credit.arrived', params: { seq: 10 } })
    expect(creditHeldKey('CLOSED', { ...line, creditWithoutReturn: { credited: false, waiting: null, allowed: false } }, owner, false)).toEqual({ key: 'held.final.CLOSED' })
  })

  it('the credit asked: empty is the value, a typed amount in minor units, never above the value', () => {
    expect(creditBody({ lineId: 'l', amount: '', note: ' ' })).toEqual({ note: null })
    expect(creditBody({ lineId: 'l', amount: '12,50', note: 'kept' })).toEqual({ creditAmount: 1250, note: 'kept' })
    const preview = { ok: true, problems: [], lineId: 'l', seq: 10, pieces: 1, currency: 'EUR', value: 25000, creditAmount: 25000, approval: { needed: false, approverRoleId: null, approverUserId: null, nobodyElse: false }, waiting: null }
    expect(creditDraftProblems({ lineId: 'l', amount: '300', note: '' }, preview)).toEqual([{ key: 'depth:credit.problem.over' }])
    expect(creditDraftProblems({ lineId: 'l', amount: 'x', note: '' }, preview)).toEqual([{ key: 'depth:credit.problem.amount' }])
    expect(creditDraftProblems({ lineId: 'l', amount: '', note: '' }, { ...preview, approval: { ...preview.approval, needed: true, nobodyElse: true } })).toEqual([{ key: 'depth:credit.problem.nobodyElse' }])
  })

  it('the fee in words: no policy, set at the decision, withheld, dropped when the cause is ours', () => {
    expect(feeWords(null, { feesApply: false, decided: false })).toEqual({ key: 'depth:fee.noPolicy' })
    expect(feeWords(null, { feesApply: true, decided: false })).toEqual({ key: 'depth:fee.atDecision' })
    expect(feeWords(DEPTH_INSPECTED.lines[0]!.fee, { feesApply: true, decided: true })).toEqual({ key: 'depth:fee.dropped.OUR_CAUSE', params: { rule: 'Restocking 10%' } })
    expect(feeWords(DEPTH_INSPECTED.lines[1]!.fee, { feesApply: true, decided: true })).toEqual({ key: 'depth:fee.withheld', params: { rule: 'Restocking 10%' } })
  })

  it('split the rest: only after the goods, only what did not arrive', () => {
    expect(splitHeldKey('RECEIVED', OUTCOMES_PART_RECEIVED.lines[1]!)).toBeNull()
    expect(splitHeldKey('AUTHORISED', { ...OUTCOMES_PART_RECEIVED.lines[1]!, split: { allowed: false, rest: 0 } })).toEqual({ key: 'depth:held.split.beforeGoods', params: { seq: 20 } })
    expect(splitHeldKey('RECEIVED', { ...OUTCOMES_PART_RECEIVED.lines[0]!, split: { allowed: false, rest: 0 } })).toEqual({ key: 'depth:held.split.all', params: { seq: 10 } })
    expect(RMA_PART_RECEIVED.lines[1]!.receivedQuantity).toBe(1)
  })

  it('binding the policy: the check first, a reason outside the window', () => {
    expect(policyProblems(null, { withdrawal: false, reason: '' })).toEqual([{ key: 'depth:policy.problem.checking' }])
    expect(policyProblems(POLICY_CHECK, { withdrawal: false, reason: '' })).toEqual([])
    expect(policyProblems({ ...POLICY_CHECK, outsideWindow: true }, { withdrawal: false, reason: ' ' })).toEqual([{ key: 'depth:policy.problem.reason' }])
    expect(policyProblems({ ...POLICY_CHECK, policy: null }, { withdrawal: true, reason: '' }).map((words) => words.key)).toEqual(['depth:policy.problem.none', 'depth:check.noWithdrawal'])
    expect(policyHeld(depthModel(), owner, false)).toBeNull()
    expect(policyHeld(depthModel({ depth: { value: DEPTH_RECEIVED, problem: null } }), owner, false)).toEqual({ key: 'depth:held.policy.bound', params: { name: 'Demo returns policy 2026' } })
    expect(policyHeld(depthModel(), canFor('warehouse'), false)).toEqual({ key: 'held.right.manage' })
  })

  it('the papers: printed once the code is set; the code set by a person who manages returns', () => {
    expect(printHeld(depthModel(), owner, false)).toBeNull()
    expect(printHeld(depthModel(), canFor('warehouse'), false)).toEqual({ key: 'depth:held.papers.code' })
    expect(printHeld(depthModel({ depth: { value: DEPTH_RECEIVED, problem: null } }), canFor('warehouse'), false)).toBeNull()
    expect(printHeld(depthModel({ depth: { value: null, problem: 'quality:problem.unavailable' } }), owner, false)).toEqual({ key: 'depth:read.failed' })
  })

  it('the finish reasons: the suggested first, the ones that do not fit held, Other needs words', () => {
    const options = finishOptionsOf(OUTCOMES_INSPECTED, RMA_INSPECTED)
    expect(options[0]).toEqual({ reason: 'COMPLETED', held: null })
    expect(options.find((option) => option.reason === 'GOODS_NOT_RECEIVED')?.held).toEqual({ key: 'depth:finish.held.GOODS_NOT_RECEIVED' })
    expect(finishProblems('', '', options)).toEqual({ key: 'close.pickReason' })
    expect(finishProblems('OTHER', ' ', options)).toEqual({ key: 'close.otherNote' })
    expect(finishProblems('COMPLETED', '', options)).toBeNull()
    expect(finishProblems('CUSTOMER_WITHDREW', '', options)).toEqual({ key: 'depth:finish.held.CUSTOMER_WITHDREW' })
    // A received line not decided: the outcomes allow no reason, and each says which lines to decide first.
    const undecided = { ...OUTCOMES_INSPECTED, finish: { ...OUTCOMES_INSPECTED.finish, reasons: OUTCOMES_INSPECTED.finish.reasons.map((entry) => ({ ...entry, allowed: false })), suggested: null } }
    expect(finishOptionsOf(undecided, RMA_RECEIVED).map((option) => option.held)).toEqual(Array(6).fill({ key: 'depth:finish.held.undecided', params: { lines: '10, 20', count: 2 } }))
  })

  it('Arrived after the deadline: its own tile and view; the view keeps the open returns the API names', () => {
    expect(TILES).toContain('arrivedLate')
    expect(sourcesOf('arrivedLate')).toEqual({ returns: 'open', repairs: null })
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(lateRowsOf(rows, { rows: [{ id: 'b' }, { id: 'z' }], truncated: false })).toEqual({ rows: [{ id: 'b' }], missing: 1, truncated: true })
    expect(lateRowsOf(rows, { rows: [{ id: 'c' }], truncated: false })).toEqual({ rows: [{ id: 'c' }], missing: 0, truncated: false })
  })

  it('a size exchange is picked like any disposition, with the size the customer gets instead', () => {
    expect(PICKABLE_DISPOSITIONS).toContain('SIZE_EXCHANGE')
    const line = { ...RMA_RECEIVED.lines[1]!, grade: 'LIKE_NEW' as const }
    const drafts = { [line.id]: { disposition: 'SIZE_EXCHANGE' as const, outcome: 'RESTOCK' as const, credit: '', exchangeSize: '52' } }
    expect(decisionLinesOf(drafts, [line], true)).toEqual([{ lineId: line.id, disposition: 'SIZE_EXCHANGE', goodsOutcome: 'RESTOCK', exchangeSize: '52' }])
    expect(decisionDraftProblems({ [line.id]: { ...drafts[line.id]!, exchangeSize: '' } }, [line], true)).toEqual([{ key: 'depth:exchange.pickSize', params: { seq: 20 } }])
    expect(decisionLinesOf({ [line.id]: { disposition: 'CREDIT_ONLY', outcome: 'RESTOCK', credit: '', exchangeSize: '52' } }, [line], true)[0]).not.toHaveProperty('exchangeSize')
    expect(RMA_AUTHORISED.status).toBe('AUTHORISED')
  })
})
