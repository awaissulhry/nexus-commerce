import { describe, expect, it } from 'vitest'
import { apportion, expectedRows, leftOf, shareReceived } from '../customer-materials/rules'
import { freezeVerdict, frozenProblems, furthestStage, looseningProblem, type FreezeRuleFacts } from './freeze'
import { changeYesStateOf, customerDecisionOf, extraDepositOf, pricedInputProblems, pricedPartsOf, salesOrderChangeFacts } from './priced'

const rule = (over: Partial<FreezeRuleFacts>): FreezeRuleFacts => ({ id: over.id ?? 'r', field: 'SIZE_QUANTITY', frozenFrom: 'CUT', action: 'CHANGE_REQUEST', active: true, note: null, ...over })
const line = (over: Partial<Parameters<typeof pricedPartsOf>[0][number]>) => ({ change: 'CHANGED' as const, lineId: 'l1', seq: 10, styleId: 's', colourwayId: 'c', piecesBefore: 6, piecesAfter: 7, sizes: [], unitPrice: null, netBefore: 60000, netAfter: 70000, textChanged: false, ...over })

describe('what freezes at each stage (SAL-218)', () => {
  const rules = [rule({ id: 'a', frozenFrom: 'CUT', action: 'CHANGE_REQUEST' }), rule({ id: 'b', frozenFrom: 'FINISHED', action: 'BLOCKED' }), rule({ id: 'off', frozenFrom: 'RELEASED', action: 'BLOCKED', active: false })]

  it('leaves a field open before its stage, asks a priced change from it, blocks from a later rule; a switched-off rule holds nothing', () => {
    expect(freezeVerdict(rules, 'SIZE_QUANTITY', null).state).toBe('OPEN')
    expect(freezeVerdict(rules, 'SIZE_QUANTITY', 'RELEASED').state).toBe('OPEN')
    const cut = freezeVerdict(rules, 'SIZE_QUANTITY', 'SEWING')
    expect(cut).toMatchObject({ state: 'CHANGE_REQUEST', ruleId: 'a', frozenFrom: 'CUT' })
    expect(cut.words.en).toBe('Cutting started — size frozen: a change is a priced change request the customer accepts')
    expect(freezeVerdict(rules, 'SIZE_QUANTITY', 'SHIPPED')).toMatchObject({ state: 'BLOCKED', ruleId: 'b' })
    expect(freezeVerdict(rules, 'PRICE', 'SHIPPED').state).toBe('OPEN')
    expect(freezeVerdict([rule({ note: 'Cut on the table: ask the planner' })], 'SIZE_QUANTITY', 'CUT').words).toEqual({ en: 'Cut on the table: ask the planner', it: 'Cut on the table: ask the planner' })
  })

  it('refuses a block of a change, and a change request unless priced', () => {
    const changes = [
      { field: 'SIZE_QUANTITY' as const, lineId: 'l1', seq: 10, size: '52', verdict: freezeVerdict(rules, 'SIZE_QUANTITY', 'CUT') },
      { field: 'DELIVERY_DATE' as const, lineId: null, seq: null, size: null, verdict: freezeVerdict(rules, 'DELIVERY_DATE', 'CUT') },
    ]
    expect(frozenProblems(changes, false).map((issue) => issue.path)).toEqual(['body/lines/10/SIZE_QUANTITY'])
    expect(frozenProblems(changes, true)).toEqual([])
    const blocked = [{ ...changes[0]!, verdict: freezeVerdict(rules, 'SIZE_QUANTITY', 'FINISHED') }]
    expect(frozenProblems(blocked, true)[0]!.message).toMatch(/^Line 10, size 52: Pieces finished — size frozen: it cannot change any more\.$/)
  })

  it('never lets a later stage loosen an earlier block (the database rule, in words)', () => {
    expect(looseningProblem([rule({ frozenFrom: 'CUT', action: 'BLOCKED' }), rule({ frozenFrom: 'SEWING', action: 'CHANGE_REQUEST' })], 'SIZE_QUANTITY')).toMatch(/cannot open them again/)
    expect(looseningProblem([rule({ frozenFrom: 'CUT', action: 'CHANGE_REQUEST' }), rule({ frozenFrom: 'SEWING', action: 'BLOCKED' })], 'SIZE_QUANTITY')).toBeNull()
    expect(furthestStage([null, 'CUT', 'RELEASED'])).toBe('CUT')
  })
})

describe('a priced change and its extra deposit (SAL-219, SAL-221)', () => {
  it('prices one part per line whose net moved, in the office words when given', () => {
    const parts = pricedPartsOf([line({}), line({ lineId: 'l2', seq: 20, change: 'ADDED', piecesBefore: 0, piecesAfter: 5, netBefore: 0, netAfter: 50000 }), line({ lineId: 'l3', seq: 30, netBefore: 100, netAfter: 100 })], new Map([['l1', 'One more jacket in 52, cut on its own']]))
    expect(parts).toEqual([
      { label: 'One more jacket in 52, cut on its own', orderLineId: 'l1', amount: 10000 },
      { label: 'Line 20 added: 5 pieces', orderLineId: 'l2', amount: 50000 },
    ])
    expect(pricedInputProblems({ fee: '0', deposit: { pct: '10', amount: '5.00' } }, 'EUR').map((issue) => issue.path)).toEqual(['body/fee', 'body/deposit'])
  })

  it('asks an extra deposit only when the order grew: the order percent, the office percent or amount, never above the growth', () => {
    expect(extraDepositOf({ growth: 0, currency: 'EUR', orderPct: '30', asked: undefined })).toBeNull()
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: '30', asked: undefined })).toEqual({ amount: 3660, pct: '30.0000', basis: 'ORDER_PERCENT' })
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: null, asked: undefined })).toBeNull()
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: '30', asked: null })).toBeNull()
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: null, asked: { pct: '50' } })).toEqual({ amount: 6100, pct: '50.0000', basis: 'PERCENT' })
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: null, asked: { amount: '61.00' } })).toMatchObject({ amount: 6100, basis: 'AMOUNT' })
    expect(extraDepositOf({ growth: 12200, currency: 'EUR', orderPct: null, asked: { amount: '200.00' } })).toMatchObject({ path: 'body/deposit/amount' })
  })

  it('gives the new yes its facts, and reads the yes and the customer decision in words', () => {
    const facts = salesOrderChangeFacts({ currency: 'EUR', netBefore: 60000, netAfter: 72000, feeAmount: 2500, lines: [{ piecesBefore: 6, piecesAfter: 7 }], priced: true, stage: 'CUT', customerCode: 'P1', wasApproved: false })
    expect(facts).toEqual({ orderValue: '720', changeValue: '120', changePct: '20.00', feeValue: '25', currency: 'EUR', linesChanged: 1, piecesChange: 1, priced: true, stage: 'CUT', customerCode: 'P1', wasApproved: false })
    expect(customerDecisionOf(false, null)).toBe('NOT_NEEDED')
    expect(customerDecisionOf(true, null)).toBe('NOT_ASKED')
    expect(customerDecisionOf(true, 'REFUSED')).toBe('REFUSED')
    expect(changeYesStateOf('REJECTED')).toBe('TURNED_DOWN')
    expect(changeYesStateOf(null)).toBe('NOT_ASKED')
  })
})

describe("the customer's own materials (SAL-306)", () => {
  it('expects per size from the explosion, rounded once per size, the whole their sum', () => {
    const need = { bomRevisionId: 'r', bomLineId: 'b', itemId: 'i', itemColourId: null, uom: 'PCS', perPiece: '1.00005' }
    const rows = expectedRows([{ orderLineId: 'l1', sizes: [{ size: '50', pieces: 2 }, { size: '52', pieces: 0 }, { size: '54', pieces: 3 }], needsBySize: new Map([['50', [need]], ['52', [need]], ['54', [need]]]) }])
    expect(rows).toEqual([{ orderLineId: 'l1', bomRevisionId: 'r', bomLineId: 'b', itemId: 'i', itemColourId: null, uom: 'PCS', expectedQuantity: '5.0003', expectedBySize: { '50': '2.0001', '54': '3.0002' } }])
  })

  it('shares what the customer sent: first what each row used and returned, then oldest first up to what it expects, the rest on the newest', () => {
    const rows = [
      { id: 'old', itemId: 'i', itemColourId: null, expected: '10.0000', used: '0.0000', returned: '0.0000' },
      { id: 'new', itemId: 'i', itemColourId: null, expected: '10.0000', used: '4.0000', returned: '0.0000' },
    ]
    expect(shareReceived(rows, new Map([['i|-', '12']])).received).toEqual(new Map([['old', '8.0000'], ['new', '4.0000']]))
    expect(shareReceived(rows, new Map([['i|-', '30']])).received).toEqual(new Map([['old', '10.0000'], ['new', '20.0000']]))
    expect(shareReceived(rows, new Map([['i|-', '2']])).short).toEqual(['i|-'])
    expect([...apportion('10', [{ id: 'a', weight: '1' }, { id: 'b', weight: '2' }]).values()]).toEqual(['3.3333', '6.6667'])
    expect(leftOf({ received: '10', used: '4', returned: '1' })).toBe('5.0000')
  })
})
