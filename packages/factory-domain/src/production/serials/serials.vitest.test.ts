import { describe, expect, it } from 'vitest'
import { parseScanId, tenantTag } from '../../numbering/scan-id'
import type { FloorReadiness } from '../../privacy/readiness'
import type { ScanFact, ScanOperation } from '../scans/rules'
import { wipOf } from '../scans/wip'
import {
  assignBundles,
  batchReprintRefusal,
  finishedBundles,
  gateRefusal,
  labelState,
  labelsReadyRefusal,
  MAX_BATCH_LABELS,
  MAX_SERIALS_AT_ONCE,
  planLabels,
  printedPerCell,
  serialReprintRefusal,
  serialText,
  voidRefusal,
  workOrderRefusal,
  type LabelCell,
  type LabelWorkOrder,
} from './rules'

/**
 * Batch or serial at the final operation (B-W1-44): the rules with figures by hand. A work order WO-7 of black jackets:
 * cell 50 (12 pieces, 10 finished), cell 52 (6 pieces, 4 finished), cell 54 (2 pieces, none finished).
 */

const WO: LabelWorkOrder = { number: 'WO-7', status: 'IN_PROGRESS', batchNumber: 'BA-00007', labelTemplateId: 'tpl', finalOperation: 'Op 40 PACK' }
const cell = (cellId: string, size: string, quantity: number, finished: number | null, labelled: number): LabelCell => ({ cellId, colourwayCode: 'BLK', size, quantity, finished, labelled })
const CELLS = [cell('c50', '50', 12, 10, 3), cell('c52', '52', 6, 4, 0), cell('c54', '54', 2, 0, 0)]

describe('what is still to label', () => {
  it('is finished less labelled, never below 0; labels above what is finished now are counted apart', () => {
    expect(labelState({ finished: 10, labelled: 3 })).toEqual({ toLabel: 7, overLabelled: 0 })
    expect(labelState({ finished: 4, labelled: 6 })).toEqual({ toLabel: 0, overLabelled: 2 })
    expect(labelState({ finished: null, labelled: 0 })).toEqual({ toLabel: 0, overLabelled: 0 })
  })
})

describe('planLabels: no more labels than finished garments', () => {
  it('"Print all" takes every cell with finished garments without a label, at what each still needs', () => {
    expect(planLabels({ workOrder: WO, tracking: 'BATCH', cells: CELLS, asks: null })).toEqual({ ok: true, lines: [{ cellId: 'c50', count: 7 }, { cellId: 'c52', count: 4 }] })
  })

  it('one size at its default (all it still needs) or a count up to it', () => {
    expect(planLabels({ workOrder: WO, tracking: 'BATCH', cells: CELLS, asks: [{ cellId: 'c52' }] })).toEqual({ ok: true, lines: [{ cellId: 'c52', count: 4 }] })
    expect(planLabels({ workOrder: WO, tracking: 'SERIAL', cells: CELLS, asks: [{ cellId: 'c50', count: 7 }] })).toEqual({ ok: true, lines: [{ cellId: 'c50', count: 7 }] })
  })

  it('refuses more than the cell still needs, in words, whole', () => {
    const plan = planLabels({ workOrder: WO, tracking: 'BATCH', cells: CELLS, asks: [{ cellId: 'c52', count: 2 }, { cellId: 'c50', count: 8 }] })
    expect(plan).toEqual({
      ok: false,
      refusal: { code: 'MORE_THAN_FINISHED', cellId: 'c50', message: 'BLK 50 has 10 garments finished and 3 of them labelled: 7 still need a label, not 8.', fix: 'Print 7, or report more garments at Op 40 PACK first.' },
    })
  })

  it('refuses a size with nothing finished, a size labelled in full, an unknown or repeated size', () => {
    const code = (asks: { cellId: string; count?: number }[], cells = CELLS) => {
      const plan = planLabels({ workOrder: WO, tracking: 'BATCH', cells, asks })
      return plan.ok ? 'ok' : plan.refusal.code
    }
    expect(code([{ cellId: 'c54' }])).toBe('NOTHING_FINISHED')
    expect(code([{ cellId: 'c52' }], [cell('c52', '52', 6, 4, 4)])).toBe('NOTHING_TO_LABEL')
    expect(code([{ cellId: 'nope' }])).toBe('UNKNOWN_CELL')
    expect(code([{ cellId: 'c52' }, { cellId: 'c52', count: 1 }])).toBe('CELL_TWICE')
    expect(code([{ cellId: 'c52', count: 0 }])).toBe('TOO_MANY_AT_ONCE')
    const none = planLabels({ workOrder: WO, tracking: 'BATCH', cells: [cell('c54', '54', 2, 0, 0)], asks: null })
    expect(none.ok ? null : none.refusal.message).toBe('No garment of work order WO-7 is finished yet: labels print after the report at Op 40 PACK.')
    const done = planLabels({ workOrder: WO, tracking: 'BATCH', cells: [cell('c52', '52', 6, 4, 4)], asks: null })
    expect(done.ok ? null : done.refusal.code).toBe('NOTHING_TO_LABEL')
  })

  it('caps one print: a BATCH cell at one job, serials at a hundred a time', () => {
    const big = [cell('c50', '50', 900, 600, 0)]
    const batch = planLabels({ workOrder: WO, tracking: 'BATCH', cells: big, asks: null })
    expect(batch.ok ? null : batch.refusal.code).toBe('TOO_MANY_AT_ONCE')
    expect(planLabels({ workOrder: WO, tracking: 'BATCH', cells: big, asks: [{ cellId: 'c50', count: MAX_BATCH_LABELS }] }).ok).toBe(true)
    const serial = planLabels({ workOrder: WO, tracking: 'SERIAL', cells: [cell('a', '50', 90, 90, 0), cell('b', '52', 20, 20, 0)], asks: null })
    expect(serial.ok ? null : serial.refusal).toMatchObject({ code: 'TOO_MANY_AT_ONCE', message: `110 garments need a serial: at most ${MAX_SERIALS_AT_ONCE} are given at a time.` })
  })

  it('refuses a work order that is not open, has no label, no batch number or no final operation', () => {
    expect(workOrderRefusal(WO)).toBeNull()
    expect(workOrderRefusal({ ...WO, status: 'COMPLETED' })).toBeNull()
    expect(workOrderRefusal({ ...WO, status: 'CLOSED' })?.message).toBe('Work order WO-7 is closed: garment labels are printed while it is released, in progress or completed.')
    expect(workOrderRefusal({ ...WO, status: 'CANCELLED' })?.code).toBe('WORK_ORDER_NOT_OPEN')
    expect(workOrderRefusal({ ...WO, labelTemplateId: null })?.code).toBe('NO_LABEL_TEMPLATE')
    expect(workOrderRefusal({ ...WO, batchNumber: null })?.code).toBe('NO_BATCH_NUMBER')
    expect(workOrderRefusal({ ...WO, finalOperation: null })?.code).toBe('NO_FINAL_OPERATION')
    const plan = planLabels({ workOrder: { ...WO, status: 'DRAFT' }, tracking: 'BATCH', cells: CELLS, asks: null })
    expect(plan.ok ? null : plan.refusal.code).toBe('WORK_ORDER_NOT_OPEN')
  })
})

describe('gateRefusal: the certificate gate in its own words, per size', () => {
  const c60 = { cellId: 'c60', colourwayCode: 'BLK', size: '60' }
  it('passes a printable label', () => {
    expect(gateRefusal(c60, { printable: true, problems: [] })).toBeNull()
  })
  it("names the gate's refusal first, with the label's words", () => {
    const words = 'No valid certificate covers BLK 60 of style JK on 2026-11-02: its garment label is not printed (Reg. (EU) 2016/425 art. 17). Certificate C-1 (EN 17092-3:2020, notified body 9999) expired: its last valid day was 2026-10-31.'
    expect(gateRefusal(c60, { printable: false, problems: [{ path: 'languages', message: 'x' }, { path: 'certificate', message: words }] })).toEqual({
      code: 'CERTIFICATE',
      cellId: 'c60',
      message: words,
      fix: 'Tell quality: the labels of this size print only once a valid certificate covers it.',
    })
  })
  it('says a retired label layout, and any other problem, in words', () => {
    expect(gateRefusal(c60, { printable: false, problems: [{ path: 'status', message: 'Label L r1 is RETIRED: garment labels print only from an ACTIVE label.' }] })).toMatchObject({ code: 'TEMPLATE_NOT_ACTIVE', fix: 'Tell the office.' })
    expect(gateRefusal(c60, { printable: false, problems: [{ path: 'languages', message: 'The buyer needs de.' }] })).toMatchObject({ code: 'LABEL_NOT_PRINTABLE', message: 'The garment label of BLK 60 cannot print: The buyer needs de.' })
  })
})

describe('reprint and void', () => {
  it('a BATCH reprint replaces at most the labels printed for the cell; a SERIAL style reprints per serial', () => {
    const c50 = cell('c50', '50', 12, 10, 3)
    expect(batchReprintRefusal({ workOrder: WO, tracking: 'BATCH', cell: c50, cellId: 'c50', count: 3 })).toBeNull()
    expect(batchReprintRefusal({ workOrder: WO, tracking: 'BATCH', cell: c50, cellId: 'c50', count: 4 })?.message).toBe('3 labels of BLK 50 were printed: a reprint replaces at most 3, not 4.')
    expect(batchReprintRefusal({ workOrder: WO, tracking: 'BATCH', cell: cell('c52', '52', 6, 4, 0), cellId: 'c52', count: 1 })?.code).toBe('MORE_THAN_PRINTED')
    expect(batchReprintRefusal({ workOrder: WO, tracking: 'SERIAL', cell: c50, cellId: 'c50', count: 1 })?.code).toBe('SERIAL_TRACKED')
    expect(batchReprintRefusal({ workOrder: WO, tracking: 'BATCH', cell: undefined, cellId: 'x', count: 1 })?.code).toBe('UNKNOWN_CELL')
    expect(batchReprintRefusal({ workOrder: { ...WO, status: 'CLOSED' }, tracking: 'BATCH', cell: c50, cellId: 'c50', count: 1 })).toBeNull()
    expect(batchReprintRefusal({ workOrder: { ...WO, status: 'CANCELLED' }, tracking: 'BATCH', cell: c50, cellId: 'c50', count: 1 })?.code).toBe('WORK_ORDER_NOT_OPEN')
  })

  it("a serial's label is printed again while MADE or RELEASED, never VOID or SHIPPED", () => {
    const serial = (status: 'MADE' | 'RELEASED' | 'SHIPPED' | 'VOID') => ({ serial: 'SN-7K-000001-X', status, workOrderSizeId: 'c50' })
    expect(serialReprintRefusal({ workOrder: WO, serial: serial('MADE') })).toBeNull()
    expect(serialReprintRefusal({ workOrder: WO, serial: serial('RELEASED') })).toBeNull()
    expect(serialReprintRefusal({ workOrder: WO, serial: serial('VOID') })?.code).toBe('SERIAL_VOID')
    expect(serialReprintRefusal({ workOrder: WO, serial: serial('SHIPPED') })?.code).toBe('SERIAL_SHIPPED')
  })

  it('voids only a MADE serial; a released one goes back through its release reversal', () => {
    const serial = (status: 'MADE' | 'RELEASED' | 'SHIPPED' | 'VOID') => ({ serial: 'SN-7K-000001-X', status, workOrderSizeId: 'c50' })
    expect(voidRefusal(serial('MADE'))).toBeNull()
    expect(voidRefusal(serial('RELEASED'))).toMatchObject({ code: 'SERIAL_RELEASED', fix: 'Ask quality to reverse the release first.' })
    expect(voidRefusal(serial('SHIPPED'))?.code).toBe('SERIAL_SHIPPED')
    expect(voidRefusal(serial('VOID'))?.code).toBe('SERIAL_VOID')
  })

  it('holds labels until the floor is ready, in the gate words', () => {
    expect(labelsReadyRefusal({ readyForFloor: true } as FloorReadiness)).toBeNull()
    const refusal = labelsReadyRefusal({ readyForFloor: false, notes: ['x'], privacy: { ready: true, notes: [] }, rules: { readyForFloor: false, notes: ['No legal basis is on record.'] } } as unknown as FloorReadiness)
    expect(refusal).toMatchObject({ code: 'FLOOR_NOT_READY', message: 'Garment labels are held at this site until its floor is ready: No legal basis is on record.' })
  })
})

describe('serials and their bundles (MES-076)', () => {
  const ops: ScanOperation[] = [
    { id: 'op10', seq: 10, code: 'CUT', name: 'Cut', scanRequired: true, workCentreKind: 'CUTTING' },
    { id: 'op20', seq: 20, code: 'SEW', name: 'Sew', scanRequired: true, workCentreKind: 'SEWING' },
    { id: 'op40', seq: 40, code: 'PACK', name: 'Pack', scanRequired: true, workCentreKind: 'PACKING' },
    { id: 'op50', seq: 50, code: 'TAG', name: 'Hang tag', scanRequired: false, workCentreKind: 'PACKING' },
  ]
  let n = 0
  const scan = (bundleId: string, operationId: string, good: number, extra: Partial<ScanFact> = {}): ScanFact => ({
    id: `s${++n}`,
    kind: 'REPORT',
    bundleId,
    workOrderOperationId: operationId,
    correctsId: null,
    goodQuantity: good,
    scrapQuantity: 0,
    reworkQuantity: 0,
    workerId: null,
    stationId: null,
    deviceId: 'd',
    clientScanId: `c${n}`,
    deviceTime: null,
    serverTime: new Date(Date.UTC(2026, 10, 2, 8, 0, n)),
    ...extra,
  })
  const bundles = [
    { id: 'b1', workOrderSizeId: 'c50', part: null, status: 'ACTIVE', quantity: 5 },
    { id: 'b2', workOrderSizeId: 'c50', part: null, status: 'ACTIVE', quantity: 5 },
    { id: 'b3', workOrderSizeId: 'c50', part: 'Sleeves', status: 'ACTIVE', quantity: 5 },
    { id: 'b4', workOrderSizeId: 'c50', part: null, status: 'VOID', quantity: 2 },
  ]
  const undone = scan('b2', 'op40', 5)
  const scans = [scan('b1', 'op40', 4), undone, scan('b2', 'op40', 0, { kind: 'UNDO', correctsId: undone.id }), scan('b2', 'op40', 3), scan('b3', 'op40', 5), scan('b1', 'op20', 5)]

  it('counts each whole ACTIVE bundle at the final operation (the last scanned one), as the WIP does per cell', () => {
    const finished = finishedBundles({ operations: ops, bundles, scans })
    expect(finished).toEqual([
      { bundleId: 'b1', cellId: 'c50', finished: 4 },
      { bundleId: 'b2', cellId: 'c50', finished: 3 },
    ])
    const wip = wipOf({ operations: ops, cells: [{ id: 'c50', quantity: 12 }], bundles: bundles.filter((bundle) => bundle.status === 'ACTIVE'), scans, lineOf: () => null })
    expect(wip.cells[0]!.finished).toBe(finished.reduce((sum, bundle) => sum + bundle.finished, 0))
    expect(finishedBundles({ operations: ops.map((op) => ({ ...op, scanRequired: false })), bundles, scans })).toEqual([])
  })

  it('gives each new serial the next bundle with room: finished less the live serials it holds', () => {
    const finished = finishedBundles({ operations: ops, bundles, scans })
    expect(assignBundles(finished, new Map(), 5)).toEqual(['b1', 'b1', 'b1', 'b1', 'b2'])
    expect(assignBundles(finished, new Map([['b1', 3]]), 3)).toEqual(['b1', 'b2', 'b2'])
    expect(assignBundles(finished, new Map([['b1', 4], ['b2', 3]]), 1)).toEqual([null])
  })

  it("prints a serial as the tenant's SERIAL scannable id", () => {
    const tag = tenantTag('7c1d4f1e-1111-4222-8333-444455556666')
    const text = serialText(tag, 42)
    expect(text.startsWith(`SN-${tag}-00001A-`)).toBe(true)
    expect(parseScanId(text, { tenantTag: tag, types: ['SERIAL'] })).toMatchObject({ ok: true, type: 'SERIAL', ref: 42 })
  })

  it('sums the label log per cell: prints, and reprints apart', () => {
    expect(
      printedPerCell([
        { kind: 'PRINT', cellId: 'c50', quantity: 3 },
        { kind: 'REPRINT', cellId: 'c50', quantity: 2 },
        { kind: 'PRINT', cellId: 'c50', quantity: 4 },
        { kind: 'PRINT', cellId: 'c52', quantity: 1 },
      ]),
    ).toEqual(
      new Map([
        ['c50', { printed: 7, reprinted: 2 }],
        ['c52', { printed: 1, reprinted: 0 }],
      ]),
    )
  })
})
