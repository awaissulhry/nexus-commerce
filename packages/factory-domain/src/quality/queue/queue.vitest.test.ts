import { describe, expect, it } from 'vitest'
import { FLOOR_SYNC_KINDS, QUEUED_ACTIONS } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import { blockOf, compareRows, garmentsToInspect, isMine, oldestWaitingSince, queueOrder, scanTargets, takenOf, waitingOf, withinDays, type Ordered } from './rules'

/** B-W2b-106: the inspector queue's order, whose a row is, how long it waited, where a scan leads, and the offline kinds. */

const ME = { workerId: 'w-me', userId: null }
const OTHER = { workerId: 'w-other', userId: null }
const NOBODY = { workerId: null, userId: null }

describe('whose a row is (no person named)', () => {
  it('the assignee first, else the inspector; a record nobody took is nobody’s yet', () => {
    expect(takenOf(ME, ME)).toBe('MINE')
    expect(takenOf(OTHER, ME)).toBe('OTHER')
    expect(takenOf(NOBODY, ME)).toBe('NOBODY')
    expect(takenOf(OTHER, ME, ME)).toBe('MINE')
    expect(takenOf(ME, ME, OTHER)).toBe('OTHER')
    expect(takenOf({ workerId: null, userId: 'u-1' }, { workerId: null, userId: 'u-1' })).toBe('MINE')
    expect([isMine('MINE'), isMine('NOBODY'), isMine('OTHER')]).toEqual([true, true, false])
  })
})

describe('what a row holds up', () => {
  const today = '2026-11-03'
  it('an open first piece holds the run: the most urgent', () => {
    const block = blockOf({ kind: 'FIRST_PIECE', workOrder: 'WO-1', operation: '30 Sewing', open: true }, today)
    expect(block).toMatchObject({ what: 'RUN', rank: 0 })
    expect(block.words.en).toBe('Holds the run of WO-1 at 30 Sewing: the other bundles wait for this first piece.')
  })
  it('a lot in quarantine: work orders that need it before stock nobody needs; a released lot holds nothing', () => {
    expect(blockOf({ kind: 'INCOMING', lot: 'LA-1', lotStatus: 'QUARANTINE', units: '12 hides', neededBy: { workOrders: 2, earliest: '2026-11-10' } }, today)).toMatchObject({ what: 'WORK_ORDERS', rank: 1, needBy: '2026-11-10', count: 2 })
    expect(blockOf({ kind: 'INCOMING', lot: 'LA-1', lotStatus: 'QUARANTINE', units: '12 hides', neededBy: { workOrders: 0, earliest: null } }, today)).toMatchObject({ what: 'STOCK', rank: 2, words: { en: 'Lot LA-1 (12 hides) waits in quarantine.' } })
    expect(blockOf({ kind: 'INCOMING', lot: 'LA-1', lotStatus: 'RELEASED', units: null, neededBy: { workOrders: 3, earliest: null } }, today)).toMatchObject({ what: 'NONE', rank: 3 })
  })
  it('garments due to ship within a week are as urgent as a lot work waits for; later ones after', () => {
    expect(blockOf({ kind: 'FINAL', workOrder: 'WO-1', garments: 20, dueDate: '2026-11-08' }, today)).toMatchObject({ what: 'SHIPPING', rank: 1, count: 20 })
    expect(blockOf({ kind: 'FINAL_DUE', workOrder: 'WO-1', garments: 1, dueDate: '2026-12-04' }, today)).toMatchObject({ what: 'SHIPPING', rank: 2, words: { en: '1 garment of WO-1 cannot be released or shipped · due 2026-12-04.' } })
    expect(blockOf({ kind: 'FINAL', workOrder: 'WO-1', garments: 2, dueDate: '2026-10-30' }, today).rank).toBe(1)
    expect(blockOf({ kind: 'ROVING' }, today)).toMatchObject({ what: 'NONE', rank: 3 })
    expect([withinDays('2026-11-10', today, 7), withinDays('2026-11-11', today, 7), withinDays(null, today, 7)]).toEqual([true, false, false])
  })
})

describe('how long it waited', () => {
  const now = new Date('2026-11-03T12:00:00.000Z')
  it('in minutes, hours, days; Italian and English', () => {
    expect(waitingOf(new Date('2026-11-03T11:59:40.000Z'), now).words.en).toBe('Waiting since just now')
    expect(waitingOf(new Date('2026-11-03T11:48:00.000Z'), now)).toEqual({ minutes: 12, words: { it: 'In attesa da 12 min', en: 'Waiting 12 min' } })
    expect(waitingOf(new Date('2026-11-03T09:50:00.000Z'), now).words.en).toBe('Waiting 2 h 10 min')
    expect(waitingOf(new Date('2026-10-31T08:00:00.000Z'), now).words).toEqual({ it: 'In attesa da 3 g 4 h', en: 'Waiting 3 d 4 h' })
    expect(waitingOf(new Date('2026-11-04T00:00:00.000Z'), now).minutes).toBe(0)
  })
  it('garments wait since the oldest one no inspection covers was finished (first in, first out)', () => {
    const reports = [
      { at: '2026-11-01T08:00:00.000Z', good: 3 },
      { at: '2026-11-02T08:00:00.000Z', good: 2 },
      { at: '2026-11-03T08:00:00.000Z', good: 2 },
    ]
    expect(oldestWaitingSince(reports, 0)).toBe('2026-11-01T08:00:00.000Z')
    expect(oldestWaitingSince(reports, 3)).toBe('2026-11-02T08:00:00.000Z')
    expect(oldestWaitingSince(reports, 5)).toBe('2026-11-03T08:00:00.000Z')
    expect(oldestWaitingSince(reports, 9)).toBe('2026-11-03T08:00:00.000Z')
    expect(oldestWaitingSince([], 0)).toBeNull()
  })
})

describe('the order: blocking first, then the day it is needed, then the longest wait', () => {
  const row = (key: string, rank: number, needBy: string | null, dueAt: string | null, waitingSince: string | null): Ordered => ({ key, block: { rank, needBy }, dueAt, waitingSince })
  it('sorts', () => {
    const rows = [
      row('roving', 3, null, null, '2026-11-01T08:00:00.000Z'),
      row('stock-old', 2, null, null, '2026-10-20T08:00:00.000Z'),
      row('ship-late', 2, '2026-12-04', null, '2026-11-02T08:00:00.000Z'),
      row('lot-needed', 1, '2026-11-12', null, '2026-11-03T08:00:00.000Z'),
      row('ship-soon', 1, '2026-11-05', null, '2026-11-03T09:00:00.000Z'),
      row('first-piece', 0, null, null, '2026-11-03T11:00:00.000Z'),
      row('overdue', 2, null, '2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z'),
      row('stock-new', 2, null, null, '2026-11-02T08:00:00.000Z'),
    ]
    expect(queueOrder(rows).map((entry) => entry.key)).toEqual(['first-piece', 'ship-soon', 'lot-needed', 'overdue', 'ship-late', 'stock-old', 'stock-new', 'roving'])
  })
  it('is stable on equal rows (the key decides)', () => {
    expect(compareRows(row('a', 3, null, null, null), row('b', 3, null, null, null))).toBeLessThan(0)
    expect(compareRows(row('a', 3, null, null, null), row('a', 3, null, null, null))).toBe(0)
  })
})

describe('where a scan leads', () => {
  it('the bench picks the inspection; a code of another bench is refused in words', () => {
    expect(scanTargets('LOT', 'INCOMING')).toEqual({ ok: true, targets: ['INCOMING'] })
    expect(scanTargets('HIDE', null)).toEqual({ ok: true, targets: ['INCOMING'] })
    expect(scanTargets('BUNDLE', null)).toEqual({ ok: true, targets: ['IN_LINE', 'FINAL'] })
    expect(scanTargets('BUNDLE', 'FINAL')).toEqual({ ok: true, targets: ['FINAL'] })
    expect(scanTargets('CARTON', 'FINAL')).toEqual({ ok: true, targets: ['FINAL'] })
    expect(scanTargets('WORK_ORDER', 'IN_LINE')).toEqual({ ok: true, targets: ['IN_LINE'] })
    const refused = scanTargets('LOT', 'FINAL')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.words.en).toBe('This is a lot: it is not inspected at this bench. Scan the work order, a bundle, a garment serial or a carton here.')
    expect(scanTargets('SERIAL', 'INCOMING').ok).toBe(false)
  })
  it('a new final inspection takes the garments finished, not released and not in an open inspection', () => {
    expect(garmentsToInspect({ finished: 20, released: 5, inOpenInspections: 10 })).toBe(5)
    expect(garmentsToInspect({ finished: 20, released: 15, inOpenInspections: 10 })).toBe(0)
    expect(garmentsToInspect({ finished: null, released: 0, inOpenInspections: 0 })).toBe(0)
  })
})

describe('the offline kinds (floor-sync)', () => {
  it('each queues under the record permission of its module; none prints a label', () => {
    expect(QUEUED_ACTIONS['quality.final.record']).toMatchObject({ permission: 'quality.inspections.record', numbers: null })
    expect(QUEUED_ACTIONS['quality.incoming.record']).toMatchObject({ permission: 'quality.incoming.record', numbers: null })
    expect(QUEUED_ACTIONS['quality.inprocess.results']).toMatchObject({ permission: 'quality.inprocess.record', numbers: null })
    expect(FLOOR_SYNC_KINDS).toEqual(expect.arrayContaining(['quality.final.record', 'quality.incoming.record', 'quality.inprocess.results']))
  })
  it('the lists show what and on which record, never who and never a value typed', () => {
    expect(summaryOf('quality.final.record', { inspectionId: 'i-1', what: 'COUNT', add: 1, note: 'a made-up note' })).toEqual({ code: 'COUNT', target: 'i-1', quantity: 1 })
    expect(summaryOf('quality.final.record', { inspectionId: 'i-1', what: 'RESULTS', results: [{ checkCode: 'CE', outcome: 'PASS' }, { checkCode: 'X', outcome: 'FAIL' }] })).toEqual({ code: 'RESULTS', target: 'i-1', quantity: 2 })
    expect(summaryOf('quality.incoming.record', { inspectionId: 'n-1', what: 'HIDE', hideId: 'h-1', measuredArea: '50' })).toEqual({ code: 'HIDE', target: 'n-1' })
    expect(summaryOf('quality.inprocess.results', { checkId: 'c-1', results: [{ code: 'SEAM' }] })).toEqual({ code: 'RESULTS', target: 'c-1', quantity: 1 })
  })
})
