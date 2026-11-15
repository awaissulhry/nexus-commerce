import { describe, expect, it } from 'vitest'
import type { EntryDraft } from '../ledger/entries'
import { AFTER_CLOSE_EVENT_WORDS, afterCloseLineWords, afterCloseSources, afterCloseWords, mainDraftOf } from './after-close'
import { ENTRY_EVENTS } from '../ledger/contracts'

/**
 * B-W2b-F46 — costs that arrived after a work order's close, pure: the count in words, one line per source in words without a
 * figure of money, the plan's entries grouped by their source event (an overhead with the entry it was applied on). Every id
 * and figure is made up.
 */

const uid = (n: number) => `0190f0e2-4646-7000-8000-${String(n).padStart(12, '0')}`
const draft = (n: number, fields: Partial<EntryDraft>): EntryDraft => ({
  id: uid(n),
  kind: 'MATERIAL',
  occurredAt: new Date('2026-11-15T10:00:00.000Z'),
  itemId: null,
  quantity: null,
  minutes: null,
  unitCost: null,
  standardUnitCost: null,
  standardCostId: null,
  amount: 0,
  stockMoveId: null,
  operationScanId: null,
  subcontractOrderId: null,
  supplierInvoiceLineId: null,
  sourceType: null,
  sourceId: null,
  reversalOfId: null,
  reason: null,
  idempotencyKey: `k-${n}`,
  ...fields,
})

describe('the count in words', () => {
  it('says how many costs wait for a reopen, one or many, and nothing when none', () => {
    expect(afterCloseWords(0)).toBe('Nothing arrived after the close.')
    expect(afterCloseWords(1)).toBe('1 cost arrived after the close — reopen the work order to post it.')
    expect(afterCloseWords(3)).toBe('3 costs arrived after the close — reopen the work order to post them.')
  })

  it('has words for every event of the ledger', () => {
    expect(Object.keys(AFTER_CLOSE_EVENT_WORDS).sort()).toEqual([...ENTRY_EVENTS].sort())
  })
})

describe('one line per source, in words without money', () => {
  it('names what it records, its document, how much of what, and its day; a return reads without its sign', () => {
    expect(afterCloseLineWords({ event: 'RETURN', label: 'RETURN · WO-00009 · LOT-7', item: { code: 'DEMO-LIN-01', baseUom: 'M' }, quantity: '-0.5', minutes: null, day: '2026-11-15' })).toBe(
      'Returned to stock (RETURN · WO-00009 · LOT-7): 0.5 M of DEMO-LIN-01, on 2026-11-15.',
    )
    expect(afterCloseLineWords({ event: 'LABOUR', label: 'B-0001 · 20 SEW', item: null, quantity: '2', minutes: '193', day: '2026-11-15' })).toBe('Labour reported (B-0001 · 20 SEW): 193 standard minutes, on 2026-11-15.')
    expect(afterCloseLineWords({ event: 'SUBCONTRACT', label: 'SC-0004', item: null, quantity: null, minutes: null, day: '2026-11-16' })).toBe("A workshop's fee (SC-0004), on 2026-11-16.")
    expect(afterCloseLineWords({ event: 'SUBCONTRACT', label: null, item: null, quantity: null, minutes: null, day: '2026-11-16' })).toBe("A workshop's fee, on 2026-11-16.")
  })
})

describe("the plan's entries per source event", () => {
  it('groups by stock move, scan, rework and subcontract order; an overhead and its reversal ride with their entry', () => {
    const move = draft(1, { kind: 'MATERIAL', stockMoveId: uid(101), amount: -155 })
    const moveOverhead = draft(2, { kind: 'OVERHEAD', sourceType: 'WorkOrderCostEntry', sourceId: uid(1), amount: -15 })
    const labour = draft(3, { kind: 'LABOUR', operationScanId: uid(201), amount: 9650 })
    const scanScrap = draft(4, { kind: 'SCRAP', operationScanId: uid(201), amount: 0 })
    const rework = draft(5, { kind: 'SCRAP', operationScanId: uid(201), sourceType: 'ReworkOrder', sourceId: uid(301) })
    const fee = draft(6, { kind: 'SUBCONTRACT', subcontractOrderId: uid(401), sourceType: 'SubcontractOperation', sourceId: uid(402), amount: 1700 })
    // An undo voids a posted labour entry (uid 900): its reversal names the undo scan; its overhead's reversal names the entry.
    const undo = draft(7, { kind: 'LABOUR', operationScanId: uid(202), reversalOfId: uid(900), amount: -500 })
    const undoOverhead = draft(8, { kind: 'OVERHEAD', reversalOfId: uid(901), sourceType: 'WorkOrderCostEntry', sourceId: uid(900), amount: -50 })
    const lone = draft(9, { kind: 'ADJUSTMENT', amount: 12 })
    const sources = afterCloseSources([move, moveOverhead, labour, scanScrap, rework, fee, undo, undoOverhead, lone])
    expect(sources.map((source) => [source.sourceType, source.sourceId, source.drafts.map((row) => row.id)])).toEqual([
      ['StockMove', uid(101), [uid(1), uid(2)]],
      ['OperationScan', uid(201), [uid(3), uid(4)]],
      ['ReworkOrder', uid(301), [uid(5)]],
      ['SubcontractOrder', uid(401), [uid(6)]],
      ['OperationScan', uid(202), [uid(7), uid(8)]],
      ['WorkOrderCostEntry', uid(9), [uid(9)]],
    ])
    expect(mainDraftOf(sources[0]!).id).toBe(uid(1))
    expect(afterCloseSources([])).toEqual([])
  })

  it('a line is named after its own entry, not the overhead applied with it', () => {
    const overhead = draft(2, { kind: 'OVERHEAD', sourceType: 'WorkOrderCostEntry', sourceId: uid(1) })
    const own = draft(1, { kind: 'MATERIAL', stockMoveId: uid(101) })
    const [source] = afterCloseSources([own, overhead])
    expect(mainDraftOf({ ...source!, drafts: [overhead, own] }).id).toBe(uid(1))
  })
})
