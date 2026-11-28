import { describe, expect, it } from 'vitest'
import { cardPrintNo, cardShipped, pagePrintNo, printAgainProblems, printStartState, smallChangeNote, type PrintAgainFacts, type PrintRow } from './prints'

// Made-up ids and codes.
const facts: PrintAgainFacts = {
  lineIds: new Set(['l1', 'l2']),
  baskets: new Map([
    ['b1', { workOrderStatus: 'IN_PROGRESS', status: 'ACTIVE', code: 'BN-T-0001-1', shipped: false }],
    ['b2', { workOrderStatus: 'IN_PROGRESS', status: 'ACTIVE', code: 'BN-T-0002-2', shipped: true }],
    ['b3', { workOrderStatus: 'CLOSED', status: 'ACTIVE', code: 'BN-T-0003-3', shipped: false }],
    ['b4', { workOrderStatus: 'RELEASED', status: 'VOID', code: 'BN-T-0004-4', shipped: false }],
  ]),
}

describe('Print again: the same codes, a reason, the pages and cards ticked (settle L7)', () => {
  it('a small change says what changed (at most 140 characters); something is ticked', () => {
    expect(printAgainProblems({ reason: 'SMALL_CHANGE', note: ' ', pages: [{ salesOrderLineId: 'l1', page: 1 }], cards: [] }, facts).map((problem) => problem.path)).toEqual(['body/note'])
    expect(printAgainProblems({ reason: 'SMALL_CHANGE', note: 'x'.repeat(141), pages: [{ salesOrderLineId: 'l1', page: 1 }], cards: [] }, facts).map((problem) => problem.path)).toEqual(['body/note'])
    expect(printAgainProblems({ reason: 'LOST', pages: [], cards: [] }, facts).map((problem) => problem.path)).toEqual(['body/pages'])
    expect(printAgainProblems({ reason: 'ONE_MORE_COPY', pages: [{ salesOrderLineId: 'l2', page: 2 }], cards: [{ bundleId: 'b1' }] }, facts)).toEqual([])
  })

  it('a card of a basket whose garments left, of a closed work order, a void one or another order’s never prints again', () => {
    const paths = (bundleId: string) => printAgainProblems({ reason: 'DAMAGED', pages: [], cards: [{ bundleId }] }, facts).map((problem) => problem.message)
    expect(paths('b2')[0]).toMatch(/left with its goods/)
    expect(paths('b3')[0]).toMatch(/is CLOSED/)
    expect(paths('b4')[0]).toMatch(/is void/)
    expect(paths('other')[0]).toBe('Not a basket of this order.')
    expect(printAgainProblems({ reason: 'DAMAGED', pages: [{ salesOrderLineId: 'l9', page: 1 }, { salesOrderLineId: 'l1', page: 0 }], cards: [{ bundleId: 'b1' }, { bundleId: 'b1' }] }, facts).map((problem) => problem.path)).toEqual(['body/pages/0/salesOrderLineId', 'body/pages/1/page', 'body/cards/1/bundleId'])
    expect([cardShipped('IN_PROGRESS', false), cardShipped('IN_PROGRESS', true), cardShipped('CANCELLED', false)]).toEqual([false, true, true])
  })

  it('the print numbers: 1 at the first print, +1 for each print again naming the page or card', () => {
    const rows: PrintRow[] = [
      { kind: 'FIRST', pages: [{ salesOrderLineId: 'l1', page: 1 }], cards: [] },
      { kind: 'AGAIN', pages: [{ salesOrderLineId: 'l1', page: 1 }], cards: [{ bundleId: 'b1' }] },
      { kind: 'AGAIN', pages: [], cards: [{ bundleId: 'b1' }] },
    ]
    expect(pagePrintNo(rows, { salesOrderLineId: 'l1', page: 1 })).toBe(2)
    expect(pagePrintNo(rows, { salesOrderLineId: 'l2', page: 1 })).toBe(1)
    expect(cardPrintNo(rows, 'b1')).toBe(3)
    expect(cardPrintNo(rows.slice(0, 2), 'b1')).toBe(2)
    expect(smallChangeNote(' logo moved left ')).toBe('The design changed: logo moved left')
  })

  it('the preview’s state', () => {
    expect(printStartState({ status: 'CONFIRMED' }, null)).toBe('READY')
    expect(printStartState({ status: 'IN_PRODUCTION' }, null)).toBe('READY')
    expect(printStartState({ status: 'PENDING_APPROVAL' }, null)).toBe('NOT_CONFIRMED')
    expect(printStartState({ status: 'CONFIRMED' }, new Date('2026-11-20T08:00:00Z'))).toBe('PRINTED')
  })
})
