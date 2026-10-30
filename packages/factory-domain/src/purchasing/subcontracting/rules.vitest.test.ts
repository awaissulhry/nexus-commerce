import { describe, expect, it } from 'vitest'
import {
  backProblems,
  cancelProblems,
  canMove,
  closeProblems,
  defaultSizes,
  earnedAmount,
  isFee,
  isLate,
  issueProblems,
  kindChangeProblems,
  kitStateOf,
  operationAmount,
  orderAmount,
  piecesProblems,
  receiveProblems,
  reopenProblems,
  sendProblems,
  sentProblems,
  statusAfterReceipt,
  statusAfterReturn,
  workshopLocationProblems,
  type OrderFacts,
} from './rules'

const cells = [
  { id: 'c1', quantity: 2 },
  { id: 'c2', quantity: 3 },
]
const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  status: 'DRAFT',
  expectedBackDate: '2026-11-30',
  orderDate: '2026-11-20',
  currency: 'EUR',
  workshopActive: true,
  locationActive: true,
  workOrderStatus: 'RELEASED',
  operations: [{ seq: 10, pieces: 5, pricePerPiece: '4.5', piecesSent: 0 }],
  kitLines: [{ status: 'PLANNED' }],
  ...over,
})
const counts = (over: Partial<{ pieces: number; piecesSent: number; piecesBackGood: number; piecesBackDefective: number; piecesScrapped: number }> = {}) => ({
  pieces: 5,
  piecesSent: 5,
  piecesBackGood: 0,
  piecesBackDefective: 0,
  piecesScrapped: 0,
  ...over,
})

describe('the order’s life (SCM-138): the trigger’s moves', () => {
  it('moves forward, back to draft from issued, and back a step when goods are taken back', () => {
    expect(canMove('DRAFT', 'ISSUED')).toBe(true)
    expect(canMove('ISSUED', 'DRAFT')).toBe(true)
    expect(canMove('ISSUED', 'AT_WORKSHOP')).toBe(true)
    expect(canMove('AT_WORKSHOP', 'ISSUED')).toBe(true)
    expect(canMove('AT_WORKSHOP', 'RECEIVED')).toBe(true)
    expect(canMove('RECEIVED', 'CLOSED')).toBe(true)
  })
  it('never leaves CLOSED or CANCELLED, and an order that is out is never cancelled', () => {
    expect(canMove('CLOSED', 'RECEIVED')).toBe(false)
    expect(canMove('CANCELLED', 'DRAFT')).toBe(false)
    expect(canMove('AT_WORKSHOP', 'CANCELLED')).toBe(false)
    expect(canMove('DRAFT', 'AT_WORKSHOP')).toBe(false)
  })
})

describe('money (cost grain): pieces × fee, rounded once', () => {
  it('rounds half up to minor units', () => {
    expect(operationAmount(7, '4.5', 'EUR')).toBe(3150)
    expect(operationAmount(3, '0.335', 'EUR')).toBe(101)
    expect(orderAmount([{ netAmount: 3150 }, { netAmount: 101 }])).toBe(3251)
    expect(earnedAmount(2, '4.5', 'EUR')).toBe(900)
  })
  it('takes a fee of 0 or more with at most six places', () => {
    expect(isFee('0')).toBe(true)
    expect(isFee('4.123456')).toBe(true)
    expect(isFee('4.1234567')).toBe(false)
    expect(isFee('-1')).toBe(false)
  })
})

describe('pieces per size', () => {
  it('defaults to every cell with all its garments', () => {
    expect(defaultSizes(cells)).toEqual([
      { workOrderSizeId: 'c1', pieces: 2 },
      { workOrderSizeId: 'c2', pieces: 3 },
    ])
  })
  it('accepts sizes adding up to the pieces, and no split at all', () => {
    expect(piecesProblems(4, [{ workOrderSizeId: 'c1', pieces: 1 }, { workOrderSizeId: 'c2', pieces: 3 }], cells)).toEqual([])
    expect(piecesProblems(5, [], cells)).toEqual([])
  })
  it('refuses a foreign cell, a cell twice, more than a cell holds, a wrong sum and more than the work order makes', () => {
    expect(piecesProblems(2, [{ workOrderSizeId: 'x', pieces: 2 }], cells)[0]?.path).toBe('sizes/0/workOrderSizeId')
    expect(piecesProblems(2, [{ workOrderSizeId: 'c1', pieces: 1 }, { workOrderSizeId: 'c1', pieces: 1 }], cells)[0]?.path).toBe('sizes/1/workOrderSizeId')
    expect(piecesProblems(3, [{ workOrderSizeId: 'c1', pieces: 3 }], cells)[0]?.path).toBe('sizes/0/pieces')
    expect(piecesProblems(4, [{ workOrderSizeId: 'c1', pieces: 2 }], cells)[0]?.message).toContain('add up to 2')
    expect(piecesProblems(6, [], cells)[0]?.message).toContain('makes 5')
    expect(piecesProblems(0, [], cells)[0]?.path).toBe('pieces')
  })
})

describe('issue, back to draft, cancel, close: in words', () => {
  it('issues a complete draft', () => {
    expect(issueProblems(facts())).toEqual([])
  })
  it('names every gap of an incomplete one', () => {
    const problems = issueProblems(facts({ operations: [{ seq: 10, pieces: 5, pricePerPiece: '0', piecesSent: 0 }], expectedBackDate: null, workshopActive: false, workOrderStatus: 'ON_HOLD' }))
    expect(problems.join(' ')).toContain('Line 10 has no fee')
    expect(problems.join(' ')).toContain('no return date')
    expect(problems.join(' ')).toContain('not active')
    expect(problems.join(' ')).toContain('ON_HOLD')
    expect(issueProblems(facts({ operations: [] }))[0]).toContain('no operation')
  })
  it('takes an issued order back, or cancels it, only while nothing is out', () => {
    expect(reopenProblems(facts({ status: 'ISSUED' }))).toEqual([])
    expect(reopenProblems(facts({ status: 'ISSUED', kitLines: [{ status: 'SENT' }] }))[0]).toContain('out already')
    expect(cancelProblems(facts({ status: 'ISSUED', operations: [{ seq: 10, pieces: 5, pricePerPiece: '4', piecesSent: 2 }] }))[0]).toContain('out already')
    expect(cancelProblems(facts({ status: 'AT_WORKSHOP' }))[0]).toContain('at the workshop')
    expect(cancelProblems(facts())).toEqual([])
  })
  it('closes once everything is back', () => {
    expect(closeProblems({ status: 'RECEIVED' })).toEqual([])
    expect(closeProblems({ status: 'PARTLY_RECEIVED' })[0]).toContain('partly back')
  })
})

describe('kit out and goods back (SCM-140, SCM-142)', () => {
  it('sends while issued and until every piece is back, for a released or running work order', () => {
    expect(sendProblems({ status: 'ISSUED', workOrderStatus: 'IN_PROGRESS', locationActive: true })).toEqual([])
    expect(sendProblems({ status: 'DRAFT', workOrderStatus: 'IN_PROGRESS', locationActive: true })[0]).toContain('a draft')
    expect(sendProblems({ status: 'ISSUED', workOrderStatus: 'ON_HOLD', locationActive: true })[0]).toContain('ON_HOLD')
  })
  it('sends at most the pieces still to send', () => {
    expect(sentProblems(counts({ piecesSent: 3 }), 2)).toEqual([])
    expect(sentProblems(counts({ piecesSent: 3 }), 3)[0]?.message).toContain('Only 2')
    expect(sentProblems(counts(), 1)[0]?.message).toContain('went out already')
  })
  it('takes back at most what is at the workshop, at least one piece', () => {
    expect(backProblems(counts({ piecesBackGood: 2 }), { good: 2, defective: 1, scrapped: 0 })).toEqual([])
    expect(backProblems(counts({ piecesBackGood: 2 }), { good: 3, defective: 1, scrapped: 0 })[0]?.message).toContain('Only 3')
    expect(backProblems(counts(), { good: 0, defective: 0, scrapped: 0 })[0]?.message).toContain('at least one')
    expect(backProblems(counts({ piecesSent: 0 }), { good: 1, defective: 0, scrapped: 0 })[0]?.message).toContain('No piece')
  })
  it('is RECEIVED once every operation has all its pieces back, PARTLY_RECEIVED before', () => {
    expect(statusAfterReceipt([counts({ piecesBackGood: 4, piecesScrapped: 1 })])).toBe('RECEIVED')
    expect(statusAfterReceipt([counts({ piecesBackGood: 4 }), counts({ piecesBackGood: 5 })])).toBe('PARTLY_RECEIVED')
    expect(statusAfterReceipt([counts({ pieces: 5, piecesSent: 3, piecesBackGood: 3 })])).toBe('PARTLY_RECEIVED')
  })
  it('receives pieces only from an order that is out, material also once it is back', () => {
    expect(receiveProblems({ status: 'AT_WORKSHOP' }, true)).toEqual([])
    expect(receiveProblems({ status: 'RECEIVED' }, true)[0]).toContain('back')
    expect(receiveProblems({ status: 'RECEIVED' }, false)).toEqual([])
    expect(receiveProblems({ status: 'ISSUED' }, false)[0]).toContain('kit went out')
  })
  it('goes back to ISSUED when the last thing out came back unsent', () => {
    const none = { operations: [{ seq: 10, pieces: 5, pricePerPiece: '4', piecesSent: 0 }], kitLines: [{ status: 'PLANNED' as const }] }
    expect(statusAfterReturn('AT_WORKSHOP', none)).toBe('ISSUED')
    expect(statusAfterReturn('AT_WORKSHOP', { ...none, kitLines: [{ status: 'SENT' }] })).toBe('AT_WORKSHOP')
    expect(statusAfterReturn('PARTLY_RECEIVED', none)).toBe('PARTLY_RECEIVED')
  })
  it('says where the kit stands and when an order is late', () => {
    expect(kitStateOf([])).toBe('NONE')
    expect(kitStateOf([{ status: 'CANCELLED' }])).toBe('NONE')
    expect(kitStateOf([{ status: 'PLANNED' }])).toBe('TO_SEND')
    expect(kitStateOf([{ status: 'PLANNED' }, { status: 'SENT' }])).toBe('PARTLY_SENT')
    expect(kitStateOf([{ status: 'SENT' }, { status: 'CANCELLED' }])).toBe('SENT')
    expect(isLate('AT_WORKSHOP', '2026-11-01', '2026-11-02')).toBe(true)
    expect(isLate('AT_WORKSHOP', '2026-11-02', '2026-11-02')).toBe(false)
    expect(isLate('RECEIVED', '2026-11-01', '2026-11-02')).toBe(false)
  })
})

describe('a workshop’s stock location (SCM-141)', () => {
  const workshop = { roles: ['SUPPLIER', 'SUBCONTRACTOR'], status: 'ACTIVE', companyId: 'A' }
  it('names its workshop exactly for a SUBCONTRACTOR location', () => {
    expect(workshopLocationProblems('SUBCONTRACTOR', 'p', workshop, 'A')).toEqual([])
    expect(workshopLocationProblems('BIN', null, null, 'A')).toEqual([])
    expect(workshopLocationProblems('SUBCONTRACTOR', null, null, 'A')[0]?.message).toContain('name it')
    expect(workshopLocationProblems('BIN', 'p', workshop, 'A')[0]?.message).toContain('Only a SUBCONTRACTOR')
  })
  it('refuses a party without the role, an archived one and another company’s', () => {
    expect(workshopLocationProblems('SUBCONTRACTOR', 'p', { ...workshop, roles: ['SUPPLIER'] }, 'A')[0]?.message).toContain('no subcontractor')
    expect(workshopLocationProblems('SUBCONTRACTOR', 'p', { ...workshop, status: 'ARCHIVED' }, 'A')[0]?.message).toContain('archived')
    expect(workshopLocationProblems('SUBCONTRACTOR', 'p', workshop, 'B')[0]?.message).toContain('another company')
    expect(workshopLocationProblems('SUBCONTRACTOR', 'p', { ...workshop, companyId: null }, 'B')).toEqual([])
  })
  it('never retypes to or from a workshop location', () => {
    expect(kindChangeProblems('BIN', 'ZONE')).toEqual([])
    expect(kindChangeProblems('BIN', 'SUBCONTRACTOR')[0]?.path).toBe('kind')
    expect(kindChangeProblems('SUBCONTRACTOR', 'BIN')[0]?.path).toBe('kind')
    expect(kindChangeProblems('SUBCONTRACTOR', 'SUBCONTRACTOR')).toEqual([])
  })
})
