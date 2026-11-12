import { describe, expect, it } from 'vitest'
import {
  answerHeld,
  coverWords,
  customerNext,
  draftHeld,
  editHeld,
  estimateActions,
  estimateTotals,
  lineAmounts,
  lineProblems,
  newestOf,
  photosHeld,
  photosNeeded,
  problemOf,
  requestProblems,
  sendHeld,
  withdrawHeld,
  workHeldByEstimate,
  type EstimateFacts,
} from './rules'

const FACTS: EstimateFacts = { repairNumber: 'REP-2026-0007', stage: 'RECEIVED', revision: 2, status: 'DRAFT', lines: 2, validUntil: null, today: '2026-11-12' }

describe('the repair request from outside (SAL-384, RR1:02)', () => {
  it('needs the garment (an item or the serial), a repair its problem, an alteration the work wanted', () => {
    expect(requestProblems({ kind: 'REPAIR' }).map((issue) => issue.path)).toEqual(['body/salesOrderLineId', 'body/problem'])
    expect(requestProblems({ kind: 'ALTERATION', serial: 'SN-1', problem: 'Too long' }).map((issue) => issue.path)).toEqual(['body/workWanted'])
    expect(requestProblems({ kind: 'ALTERATION', serial: 'SN-1', workWanted: 'Add 2 cm to the sleeves' })).toEqual([])
    expect(requestProblems({ kind: 'REPAIR', serial: 'SN-1\nSN-2', problem: 'Torn seam' })).toEqual([{ path: 'body/serial', message: 'The serial is one line.' }])
    expect(requestProblems({ kind: 'REPAIR', serial: 'x'.repeat(61), problem: 'Torn seam' })[0]!.path).toBe('body/serial')
  })

  it('keeps a problem for the database: the repair words, else the work wanted', () => {
    expect(problemOf({ problem: '  Torn seam ', workWanted: 'Re-sew it' })).toBe('Torn seam')
    expect(problemOf({ problem: ' ', workWanted: ' Add 2 cm ' })).toBe('Add 2 cm')
  })

  it('takes photos before the work starts; two damage photos for a repair, none needed for an alteration', () => {
    expect(photosHeld('REP-1', 'AWAITING_GOODS')).toBeNull()
    expect(photosHeld('REP-1', 'ESTIMATED')).toBeNull()
    expect(photosHeld('REP-1', 'IN_REPAIR')).toBe('Repair REP-1 is in repair: photos are added before the work starts.')
    expect([photosNeeded('REPAIR'), photosNeeded('ALTERATION')]).toEqual([2, 0])
  })
})

describe('the estimate from parts and labour (SAL-387)', () => {
  it('checks a line: description, quantity, labour minutes, a part without minutes, prices and costs not below 0', () => {
    expect(lineProblems({ kind: 'LABOUR', description: 'Re-sew the shoulder seam', quantity: '1', minutes: 40, unitPrice: '35.00' })).toEqual([])
    expect(lineProblems({ kind: 'LABOUR', description: 'Re-sew', quantity: '1', unitPrice: '35' }).map((issue) => issue.path)).toEqual(['body/minutes'])
    expect(lineProblems({ kind: 'PART', description: 'YKK zip', quantity: '0', minutes: 5, unitPrice: '-1', unitCost: 'x' }).map((issue) => issue.path)).toEqual(['body/quantity', 'body/minutes', 'body/unitPrice', 'body/unitCost'])
    expect(lineProblems({ kind: 'LABOUR', itemId: '0190f0e2-1970-7000-8000-000000000001', description: 'Work', quantity: '1', minutes: 10, unitPrice: '1' }).map((issue) => issue.path)).toEqual(['body/itemId'])
    expect(lineProblems({ kind: 'PART', description: 'two\nlines', quantity: '1', unitPrice: '1' }).map((issue) => issue.path)).toEqual(['body/description'])
  })

  it('rounds each line once, half up, and sums the parts, the labour, our cost and the minutes', () => {
    expect(lineAmounts({ quantity: '3', unitPrice: '12.505', unitCost: '4.333333' }, 'EUR')).toEqual({ amount: 3752, costAmount: 1300 })
    expect(lineAmounts({ quantity: '1', unitPrice: '10', unitCost: null }, 'EUR')).toEqual({ amount: 1000, costAmount: null })
    const totals = estimateTotals([
      { kind: 'PART', amount: 1850, costAmount: 900, minutes: null, quantity: '1' },
      { kind: 'LABOUR', amount: 3500, costAmount: 1200, minutes: 40, quantity: '1.5' },
    ])
    expect(totals).toEqual({ amount: 5350, parts: 1850, labour: 3500, costAmount: 2100, labourMinutes: 60, lines: 2 })
    expect(estimateTotals([{ kind: 'PART', amount: 100, costAmount: null, minutes: null, quantity: '1' }]).costAmount).toBeNull()
    expect(estimateTotals([]).costAmount).toBeNull()
  })

  it('holds a new draft while one is live, before work only; a sent one is replaced on purpose', () => {
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'RECEIVED', live: null })).toBeNull()
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'RECEIVED', live: { revision: 1, status: 'DRAFT' } })).toBe('Estimate 1 is a draft: change that one (one estimate at a time).')
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'ESTIMATED', live: { revision: 1, status: 'SENT' } })).toContain('waits for the customer')
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'ESTIMATED', live: { revision: 1, status: 'SENT' }, replaces: true })).toBeNull()
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'IN_REPAIR', live: null })).toBe('Repair REP-1 is in repair: the estimate is made before the work starts.')
    expect(draftHeld({ repairNumber: 'REP-1', stage: 'CANCELLED', live: null })).toBe('Repair REP-1 is cancelled: it takes no estimate.')
  })

  it('edits only a draft, sends it with lines once the garment is here and by its last day, answers a sent one while estimated', () => {
    expect(editHeld(FACTS)).toBeNull()
    expect(editHeld({ ...FACTS, status: 'SENT' })).toBe('Estimate 2 of repair REP-2026-0007 is sent: it changes no more (make a new revision to change it).')
    expect(sendHeld(FACTS)).toBeNull()
    expect(sendHeld({ ...FACTS, lines: 0 })).toBe('Estimate 2 of repair REP-2026-0007 has no lines: add the parts and the work first.')
    expect(sendHeld({ ...FACTS, stage: 'AWAITING_GOODS' })).toBe('The garment of repair REP-2026-0007 has not arrived: send the estimate once it is here.')
    expect(sendHeld({ ...FACTS, validUntil: '2026-11-11' })).toContain('valid until 2026-11-11')
    expect(answerHeld({ ...FACTS, status: 'SENT', stage: 'ESTIMATED' })).toBeNull()
    expect(answerHeld({ ...FACTS, status: 'SENT', stage: 'ESTIMATED', validUntil: '2026-11-10' })).toContain('send a new revision')
    expect(answerHeld({ ...FACTS, status: 'ACCEPTED', stage: 'APPROVED' })).toBe('Estimate 2 of repair REP-2026-0007 is accepted already.')
    expect(answerHeld({ ...FACTS, status: 'SENT', stage: 'SHIPPED' })).toBe('Repair REP-2026-0007 is shipped back: its estimate is no longer answered.')
    expect(withdrawHeld({ ...FACTS, status: 'DECLINED' })).toContain('only a draft or a sent estimate is withdrawn')
  })

  it('names every action with the same words', () => {
    const actions = estimateActions({ ...FACTS, status: 'SENT', stage: 'ESTIMATED', newest: true })
    expect(actions.map((entry) => [entry.action, entry.allowed])).toEqual([['edit', false], ['send', false], ['answer', true], ['withdraw', true], ['revise', true]])
    expect(estimateActions({ ...FACTS, newest: false }).find((entry) => entry.action === 'revise')?.held).toBe('Estimate 2 of repair REP-2026-0007 is an older revision.')
  })

  it('approved before work starts: a sent estimate waits for the answer, a declined one refuses, a draft binds nothing yet', () => {
    expect(workHeldByEstimate('REP-1', 'APPROVED', null)).toBeNull()
    expect(workHeldByEstimate('REP-1', 'APPROVED', { revision: 2, status: 'DRAFT' })).toBeNull()
    expect(workHeldByEstimate('REP-1', 'IN_REPAIR', { revision: 2, status: 'ACCEPTED' })).toBeNull()
    expect(workHeldByEstimate('REP-1', 'APPROVED', { revision: 2, status: 'SENT' })).toBe("Estimate 2 of repair REP-1 waits for the customer's answer: record it (Estimate › Record the answer) before the repair is approved.")
    expect(workHeldByEstimate('REP-1', 'IN_REPAIR', { revision: 1, status: 'DECLINED' })).toBe('The customer declined estimate 1 of repair REP-1: make a new estimate, or send the garment back unrepaired.')
    expect(newestOf([{ revision: 1, status: 'DECLINED' as const }, { revision: 3, status: 'WITHDRAWN' as const }, { revision: 2, status: 'DRAFT' as const }])).toEqual({ revision: 2, status: 'DRAFT' })
    expect(newestOf([{ revision: 1, status: 'WITHDRAWN' as const }])).toBeNull()
  })
})

describe('the customer view and the safety rule (RR1:01, SAL-393)', () => {
  it('says the next step by code: theirs to send the garment and to answer the estimate', () => {
    expect(customerNext('AWAITING_GOODS', null)).toEqual({ code: 'SEND_GARMENT', forYou: true })
    expect(customerNext('ESTIMATED', { status: 'SENT' })).toEqual({ code: 'ANSWER_ESTIMATE', forYou: true })
    expect(customerNext('ESTIMATED', { status: 'DECLINED' })).toEqual({ code: 'WE_DECIDE', forYou: false })
    expect(customerNext('REPAIRED', null)).toEqual({ code: 'WE_CHECK', forYou: false })
    expect(customerNext('SHIPPED', null).code).toBe('DONE')
  })

  it('keeps the safety check of an altered protective garment, naming its certificate', () => {
    expect(coverWords({ kind: 'ALTERATION', required: true, styleKnown: true, certificateNumber: 'CE-0001' })).toBe('An alteration of a protective garment keeps its safety check: it goes back only after a passed check that it still protects and that certificate CE-0001 still covers it.')
    expect(coverWords({ kind: 'REPAIR', required: true, styleKnown: true, certificateNumber: null })).toContain('none covers its style, colour and size today')
    expect(coverWords({ kind: 'ALTERATION', required: false, styleKnown: true, certificateNumber: null })).toBe('Not a protective garment: it goes back without a safety check.')
    expect(coverWords({ kind: 'REPAIR', required: true, styleKnown: false, certificateNumber: null })).toContain('treated as a protective garment')
  })
})
