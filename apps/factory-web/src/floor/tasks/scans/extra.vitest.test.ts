import { describe, expect, it } from 'vitest'
import { EXTRA_NOTE, extraBody, extraHeld, NEW_EXTRA, routingStep, unplannedHere, type ExtraChoices } from './extra'
import { doneHere, finishHeld, nextOpen, NO_COUNTS, openingOf, reportPayload, type BundleCard, type CardOperation } from './model'

const op = (id: string, seq: number, kind: string, state: CardOperation['state'], extra: Partial<CardOperation> = {}): CardOperation => ({ id, seq, code: id.toUpperCase(), name: id, scanRequired: true, workCentreKind: kind, final: false, sewn: false, state, expected: 20, report: null, ...extra })
const report = { scanId: 's1', kind: 'REPORT' as const, goodQuantity: 20, scrapQuantity: 0, reworkQuantity: 0, serverTime: '2026-10-29T08:00:00.000Z', station: null, own: true }
const unplanned = op('fix', 50, 'SEWING', 'OPEN', { scanRequired: false, unplanned: true })
const card = (over: Partial<BundleCard> = {}): BundleCard => ({
  scanned: 'B-1',
  refusal: null,
  bundle: { id: 'b', code: 'B-1', status: 'ACTIVE', quantity: 20, part: null, workOrderSizeId: 'c', colourwayCode: 'NERO', colourwayName: 'Nero', size: '52' },
  workOrder: { id: 'wo', number: 'WO-1', batchNumber: null, status: 'IN_PROGRESS', siteId: 's', style: { code: 'S', name: 'Style' } },
  station: { id: 'st', code: 'SEW-1', name: 'SEW-1', kind: 'SEWING' },
  operations: [op('cut', 10, 'CUTTING', 'DONE', { report }), op('sew', 20, 'SEWING', 'OPEN'), op('pack', 40, 'FINISHING', 'NOT_REACHED'), unplanned],
  next: 'sew',
  choose: [],
  hint: null,
  reasons: [],
  ...over,
})

const choices: ExtraChoices = {
  operations: [{ id: 'lib', code: 'FIX', name: 'Fix', workCentreKind: 'SEWING', standardMinutes: '1.500', pays: 'PIECE_RATE' }],
  reasons: [
    { code: 'QUALITY_FIX', label: { it: 'Difetto', en: 'Defect' }, needsNote: false },
    { code: 'OTHER', label: { it: 'Altro', en: 'Other' }, needsNote: true },
  ],
}

describe('an unplanned operation on the operation screen (B-W2b-82)', () => {
  it('a scan opens the routing\'s next step: one tap stays one tap', () => {
    expect(openingOf(card())).toMatchObject({ kind: 'counts', operation: { id: 'sew' } })
    expect(openingOf(card(), 'fix')).toMatchObject({ kind: 'counts', operation: { id: 'fix' } })
    expect(nextOpen(card())?.id).toBe('sew')
  })

  it('is offered at a station of its kind (any tablet without a station), until the bundle is reported at it', () => {
    expect(unplannedHere(card()).map((operation) => operation.id)).toEqual(['fix'])
    expect(unplannedHere(card(), 'fix')).toEqual([])
    expect(unplannedHere(card({ station: { id: 'st', code: 'FIN-1', name: 'FIN-1', kind: 'FINISHING' } }))).toEqual([])
    expect(unplannedHere(card({ station: null })).map((operation) => operation.id)).toEqual(['fix'])
    const done = card({ operations: [...card().operations.slice(0, 3), { ...unplanned, state: 'DONE', report }] })
    expect(unplannedHere(done)).toEqual([])
  })

  it('an older card kept on the tablet has none', () => {
    const old = card({ operations: card().operations.slice(0, 3) })
    expect(unplannedHere(old)).toEqual([])
  })

  it('never stands for "already reported at this station"', () => {
    const done = card({
      next: null,
      hint: { code: 'ALREADY_REPORTED', message: '', fix: '' },
      operations: [op('sew', 20, 'SEWING', 'DONE', { report }), { ...unplanned, state: 'DONE', report: { ...report, scanId: 's2' } }],
    })
    expect(doneHere(done)?.id).toBe('sew')
  })

  it('goes back to the step the card opened on', () => {
    expect(routingStep(card())?.id).toBe('sew')
    expect(routingStep(card({ next: null }))).toBeNull()
  })

  it('reports good pieces, up to the bundle\'s own', () => {
    expect(finishHeld(NO_COUNTS, 20, 20)).toBeNull()
    expect(reportPayload(card(), 'fix', NO_COUNTS, 20)).toEqual({ code: 'B-1', workOrderOperationId: 'fix', good: 20 })
  })
})

describe('adding one (a team leader, online)', () => {
  it('waits for the operation, then the reason, then the words of Other', () => {
    expect(extraHeld(NEW_EXTRA, choices)).toBe('operation')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'gone' }, choices)).toBe('operation')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib' }, null)).toBe('operation')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib' }, choices)).toBe('reason')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib', reason: 'QUALITY_FIX' }, choices)).toBeNull()
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib', reason: 'OTHER' }, choices)).toBe('words')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib', reason: 'OTHER', words: 'ab' }, choices)).toBe('words')
    expect(extraHeld({ ...NEW_EXTRA, operationId: 'lib', reason: 'OTHER', words: 'x'.repeat(EXTRA_NOTE.min) }, choices)).toBeNull()
  })

  it('sends the operation, the reason, and words only when there are some', () => {
    expect(extraBody({ operationId: 'lib', reason: 'QUALITY_FIX', words: ' ' })).toEqual({ operationId: 'lib', reasonCode: 'QUALITY_FIX' })
    expect(extraBody({ operationId: 'lib', reason: 'OTHER', words: '  Extra tack  ' })).toEqual({ operationId: 'lib', reasonCode: 'OTHER', note: 'Extra tack' })
  })
})
