import { describe, expect, it } from 'vitest'
import {
  addReason,
  afterReport,
  askPayload,
  correctionHeld,
  countsOfTarget,
  finishHeld,
  goodOf,
  NO_COUNTS,
  openingOf,
  removeReason,
  reportPayload,
  setGood,
  touched,
  undoClosesIn,
  undoOpen,
  type BundleCard,
  type CardOperation,
  type CorrectionTarget,
  type LastAction,
} from './model'

const op = (id: string, seq: number, kind: string, state: CardOperation['state'], expected: number | null, own: boolean | null = null): CardOperation => ({
  id,
  seq,
  code: `OP${seq}`,
  name: `Operation ${seq}`,
  scanRequired: true,
  workCentreKind: kind,
  final: false,
  sewn: false,
  state,
  expected,
  report: own === null ? null : { scanId: `s-${seq}`, kind: 'REPORT', goodQuantity: 19, scrapQuantity: 1, reworkQuantity: 0, serverTime: '2026-10-29T08:00:00.000Z', station: null, own },
})

const card = (extra: Partial<BundleCard> = {}): BundleCard => ({
  scanned: 'BN-1',
  refusal: null,
  bundle: { id: 'b', code: 'BN-1', status: 'ACTIVE', quantity: 20, part: null, workOrderSizeId: 'c', colourwayCode: 'BLK', colourwayName: 'Black', size: '52' },
  workOrder: { id: 'w', number: 'WO-1', batchNumber: null, status: 'IN_PROGRESS', siteId: 's', style: { code: 'S', name: 'Style' } },
  station: { id: 'st', code: 'SEW-1', name: 'Sewing 1', kind: 'SEWING' },
  operations: [op('o10', 10, 'CUTTING', 'DONE', 20, false), op('o20', 20, 'SEWING', 'OPEN', 20), op('o30', 30, 'SEWING', 'NOT_REACHED', null)],
  next: 'o20',
  choose: [],
  hint: null,
  reasons: [],
  ...extra,
})

describe('what a scanned bundle opens', () => {
  it('the next operation of this station opens its counts (one tap to finish)', () => {
    expect(openingOf(card())).toMatchObject({ kind: 'counts', operation: { id: 'o20' } })
  })

  it('an old ticket, a voided bundle or a closed work order is refused before anything else', () => {
    expect(openingOf(card({ refusal: { code: 'REPLACED', message: 'x' } }))).toMatchObject({ kind: 'refused', code: 'REPLACED' })
  })

  it('two operations of this station: the picker, first in sequence first', () => {
    const opening = openingOf(card({ next: null, choose: ['o30', 'o20'] }))
    expect(opening.kind).toBe('pick')
    expect(opening.kind === 'pick' && opening.options.map((operation) => operation.id)).toEqual(['o20', 'o30'])
  })

  it('already reported at this station: own or another person\'s, from the station\'s done operation', () => {
    const done = card({ next: null, hint: { code: 'ALREADY_REPORTED', message: 'x', fix: 'y' }, operations: [op('o10', 10, 'CUTTING', 'DONE', 20, false), op('o20', 20, 'SEWING', 'DONE', 20, true)] })
    expect(openingOf(done)).toMatchObject({ kind: 'already', operation: { id: 'o20' }, report: { own: true } })
  })

  it('another hint (nothing to do here, the operation before missing) is a refusal with its words', () => {
    expect(openingOf(card({ next: null, hint: { code: 'PREVIOUS_NOT_REPORTED', message: 'm', fix: 'f' } }))).toEqual({ kind: 'refused', code: 'PREVIOUS_NOT_REPORTED', message: 'm', fix: 'f' })
  })
})

describe('reason-first counting', () => {
  it('Good opens at the expected number and balances itself', () => {
    expect(goodOf(NO_COUNTS, 20)).toBe(20)
    const one = addReason(NO_COUNTS, 'SCRAP', 'STAIN', 20)
    expect(one.ok && goodOf(one.counts, 20)).toBe(19)
    const two = one.ok ? addReason(one.counts, 'REWORK', 'RESTITCH', 20) : one
    expect(two.ok && goodOf(two.counts, 20)).toBe(18)
    expect(two.ok && removeReason(two.counts, 'SCRAP', 'STAIN').scrap).toEqual({})
  })

  it('never counts more pieces than the operation may take', () => {
    let counts = NO_COUNTS
    for (let i = 0; i < 2; i++) {
      const move = addReason(counts, 'SCRAP', 'STAIN', 2)
      if (move.ok) counts = move.counts
    }
    expect(addReason(counts, 'SCRAP', 'STAIN', 2)).toEqual({ ok: false, problem: 'atMost' })
    expect(setGood(NO_COUNTS, 21, 20)).toEqual({ ok: false, problem: 'atMost' })
  })

  it('a typed Good gives way to a reason tap, and Finish holds an empty or unknown count', () => {
    const typed = setGood(NO_COUNTS, 20, 20)
    const move = typed.ok ? addReason(typed.counts, 'SCRAP', 'STAIN', 20) : typed
    expect(move.ok && goodOf(move.counts, 20)).toBe(19)
    expect(finishHeld(NO_COUNTS, 20)).toBeNull()
    expect(finishHeld(NO_COUNTS, null)).toBe('unknown')
    const zero = setGood(NO_COUNTS, 0, 20)
    expect(zero.ok && finishHeld(zero.counts, 20)).toBe('nothing')
    expect(touched(NO_COUNTS)).toBe(false)
    expect(zero.ok && touched(zero.counts)).toBe(true)
  })

  it('the report body names the ticket, the operation, good and one line per reason (empty lines left out)', () => {
    const move = addReason(NO_COUNTS, 'SCRAP', 'STAIN', 20)
    expect(move.ok && reportPayload(card(), 'o20', move.counts, 20)).toEqual({ code: 'BN-1', workOrderOperationId: 'o20', good: 19, scrap: [{ reason: 'STAIN', quantity: 1 }] })
    expect(reportPayload(card(), 'o20', NO_COUNTS, 20)).toEqual({ code: 'BN-1', workOrderOperationId: 'o20', good: 20 })
  })

  it('after its own report the tablet knows the operation is done (an offline scan says so) and the next may take it', () => {
    const after = afterReport(card(), 'o20', NO_COUNTS, 20, new Date('2026-10-29T08:00:00Z'))
    expect(openingOf(after)).toMatchObject({ kind: 'already', operation: { id: 'o20' }, report: { own: true, goodQuantity: 20 } })
    expect(after.operations.find((operation) => operation.id === 'o30')).toMatchObject({ state: 'OPEN', expected: 20 })
  })
})

describe('undo, then a correction', () => {
  const last: LastAction = { clientEventId: 'e1', bundleCode: 'BN-1', operation: { id: 'o20', seq: 20, code: 'OP20', name: 'x' }, good: 20, scrap: {}, rework: {}, at: '2026-10-29T08:00:00.000Z', scannedAfter: false, undoEventId: null, askEventId: null }

  it('Undo stays until the next scan or two minutes', () => {
    expect(undoOpen(last, new Date('2026-10-29T08:01:59Z'))).toBe(true)
    expect(undoOpen(last, new Date('2026-10-29T08:02:01Z'))).toBe(false)
    expect(undoOpen({ ...last, scannedAfter: true }, new Date('2026-10-29T08:00:10Z'))).toBe(false)
    expect(undoOpen({ ...last, undoEventId: 'u1' }, new Date('2026-10-29T08:00:10Z'))).toBe(false)
    expect(undoClosesIn(last, new Date('2026-10-29T08:01:00Z'))).toBe(60_000)
  })

  const target: CorrectionTarget = { key: 's', scanId: 's-1', clientScanId: 'c-1', bundleCode: 'BN-1', operation: { seq: 20, code: 'OP20', name: 'x' }, good: 19, scrap: { STAIN: 1 }, rework: {}, at: last.at, pending: false }

  it('a correction opens with the report\'s counts, needs a change and a reason, and names the report', () => {
    const start = countsOfTarget(target)
    expect(correctionHeld(target, start, 'count')).toBe('same')
    const moved = removeReason(start, 'SCRAP', 'STAIN')
    expect(correctionHeld(target, moved, null)).toBe('reason')
    expect(correctionHeld(target, moved, 'found')).toBeNull()
    expect(askPayload(target, moved, 'Pieces found later')).toEqual({ scanId: 's-1', good: 19, scrap: [], rework: [], reason: 'Pieces found later' })
    expect(askPayload({ ...target, scanId: null }, moved, 'x').targetClientScanId).toBe('c-1')
  })
})
