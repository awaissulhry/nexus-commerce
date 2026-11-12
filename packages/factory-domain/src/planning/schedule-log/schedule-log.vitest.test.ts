import { describe, expect, it } from 'vitest'
import { changeWords, inverseOf, placeWords, resultHolds, standingLatest, undoHoldOf, undoHoldWords, undoPermissionOf, type ChangeFacts, type ChangePlace } from './changes'
import { compareVersion, compareWords, type CompareSlot } from './compare'
import { daySheetPaper, type SheetFacts } from './day-sheet'
import { floorStatusOf, floorStatusWords, type FloorScanRow } from './floor-status'

/** B-W2b-329: the board's record (PLN-133 floor colours, PLN-149 the change log and its undo, PLN-154 day sheets and versions). Made-up data. */

const TZ = 'Europe/Rome'
const at = (iso: string) => new Date(iso)
let n = 0
const scan = (bundleId: string, kind: string, time: string, extra: Partial<FloorScanRow> = {}): FloorScanRow => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  bundleId,
  kind,
  correctsId: null,
  goodQuantity: 0,
  scrapQuantity: 0,
  reworkQuantity: 0,
  pauseReasonCode: null,
  workerId: 'w1',
  stationId: null,
  deviceId: 'd1',
  deviceTime: null,
  serverTime: at(time),
  ...extra,
})

describe('floor status of a bar (PLN-133)', () => {
  it('is not started with no scan, running while a bundle runs, paused when every open one is paused, done when nothing is left', () => {
    expect(floorStatusOf([{ garments: 7, remaining: 7, rows: [] }])).toMatchObject({ state: 'NOT_STARTED', done: 0, of: 7, pct: 0, since: null })
    const running = floorStatusOf([{ garments: 7, remaining: 5, rows: [scan('b1', 'REPORT', '2026-11-10T08:00:00Z', { goodQuantity: 2 }), scan('b2', 'START', '2026-11-10T09:30:00Z')] }])
    expect(running).toMatchObject({ state: 'RUNNING', done: 2, of: 7, pct: 28, runningBundles: 1, pausedBundles: 0, since: at('2026-11-10T09:30:00Z') })
    expect(floorStatusWords(running, TZ)).toBe('Running: 2 of 7 garments done, 1 bundle being worked since 10:30.')
    const paused = floorStatusOf([{ garments: 7, remaining: 5, rows: [scan('b2', 'START', '2026-11-10T09:30:00Z'), scan('b2', 'PAUSE', '2026-11-10T10:00:00Z', { pauseReasonCode: 'BREAK' })] }])
    expect(paused).toMatchObject({ state: 'PAUSED', pausedBundles: 1, since: at('2026-11-10T10:00:00Z'), pauseReasonCode: 'BREAK' })
    expect(floorStatusWords(paused, TZ)).toBe('Paused since 11:00 (BREAK): 2 of 7 garments done, 1 bundle paused.')
    // A running bundle wins over a paused one.
    expect(floorStatusOf([{ garments: 7, remaining: 5, rows: [scan('b2', 'START', '2026-11-10T09:30:00Z'), scan('b2', 'PAUSE', '2026-11-10T10:00:00Z'), scan('b3', 'START', '2026-11-10T10:05:00Z')] }]).state).toBe('RUNNING')
    expect(floorStatusOf([{ garments: 7, remaining: 0, rows: [] }])).toMatchObject({ state: 'DONE', done: 7, pct: 100 })
  })

  it('a one-tap site (reports, no start) is under way between bundles; a reported bundle closes its stretch', () => {
    const between = floorStatusOf([{ garments: 7, remaining: 4, rows: [scan('b1', 'START', '2026-11-10T08:00:00Z'), scan('b1', 'REPORT', '2026-11-10T08:40:00Z', { goodQuantity: 3 })] }])
    expect(between).toMatchObject({ state: 'RUNNING', runningBundles: 0, since: null, lastScanAt: at('2026-11-10T08:40:00Z') })
    expect(floorStatusWords(between, TZ)).toBe('Under way: 3 of 7 garments done; no bundle is being worked now.')
  })

  it('a part books several operations: done counts the garments through every one; its own garments cap it', () => {
    const part = floorStatusOf([{ garments: 7, remaining: 2, rows: [] }, { garments: 7, remaining: 6, rows: [] }], 4)
    expect(part).toMatchObject({ done: 1, of: 4, state: 'RUNNING' })
    expect(floorStatusOf([{ garments: 7, remaining: 0, rows: [] }, { garments: 7, remaining: 0, rows: [] }], 4)).toMatchObject({ state: 'DONE', done: 4, of: 4 })
  })
})

const L1 = { kind: 'LINE' as const, id: 'line-1' }
const L2 = { kind: 'LINE' as const, id: 'line-2' }
const place = (lane: typeof L1, start: string, end: string): ChangePlace => ({ lane, startAt: Date.parse(start), endAt: Date.parse(end) })
const A = place(L1, '2026-11-17T07:00:00Z', '2026-11-17T11:00:00Z')
const B = place(L2, '2026-11-18T08:00:00Z', '2026-11-18T12:00:00Z')
const change = (kind: ChangeFacts['kind'], from: ChangePlace | null, to: ChangePlace | null, operationId: string | null = 'op-1'): ChangeFacts => ({ id: 'c1', kind, slotId: 's1', operationId, from, to })
const slotAt = (p: ChangePlace, pinned = false) => ({ lane: p.lane, startAt: p.startAt, endAt: p.endAt, pinned })

describe('the change log and its undo (PLN-149)', () => {
  it('undoes only the latest change of a bar while the bar is where it left it, once, with its permission', () => {
    const move = change('MOVE', A, B)
    expect(undoHoldOf(move, { undone: false, latestOfSlot: 'c1', slot: slotAt(B), may: true })).toBeNull()
    expect(undoHoldOf(move, { undone: true, latestOfSlot: 'c1', slot: slotAt(B), may: true })).toBe('ALREADY_UNDONE')
    expect(undoHoldOf(move, { undone: false, latestOfSlot: 'c2', slot: slotAt(B), may: true })).toBe('CHANGED_SINCE')
    // Moved again by a write the log never saw: not where it left it.
    expect(undoHoldOf(move, { undone: false, latestOfSlot: 'c1', slot: slotAt(A), may: true })).toBe('CHANGED_SINCE')
    expect(undoHoldOf(move, { undone: false, latestOfSlot: 'c1', slot: slotAt(B), may: false })).toBe('NO_PERMISSION')
    expect(undoHoldOf(change('PUBLISH', null, null, null), { undone: false, latestOfSlot: null, slot: null, may: true })).toBe('NOT_UNDOABLE')
    expect(undoHoldOf(change('UNDO', null, A), { undone: false, latestOfSlot: 'c1', slot: slotAt(A), may: true })).toBe('NOT_UNDOABLE')
    // A part's removal goes back on the allocation board (its garments are not in the log).
    expect(undoHoldOf(change('REMOVE', A, null, null), { undone: false, latestOfSlot: 'c1', slot: null, may: true })).toBe('NOT_UNDOABLE')
    expect(undoHoldOf(change('REMOVE', A, null), { undone: false, latestOfSlot: 'c1', slot: null, may: true })).toBeNull()
  })

  it('goes back one change at a time: an undone change and its undo do not stand', () => {
    const row = (id: string, kind: string, undoesChangeId: string | null = null) => ({ id, kind, undoesChangeId })
    expect(standingLatest([row('m2', 'MOVE'), row('m1', 'MOVE')])).toBe('m2')
    expect(standingLatest([row('u2', 'UNDO', 'm2'), row('m2', 'MOVE'), row('m1', 'MOVE')])).toBe('m1')
    expect(standingLatest([row('u1', 'UNDO', 'm1'), row('u2', 'UNDO', 'm2'), row('m2', 'MOVE'), row('m1', 'MOVE')])).toBeNull()
    expect(standingLatest([])).toBeNull()
  })

  it('knows where each kind leaves the slot and what its undo does', () => {
    expect(resultHolds(change('PLACE', null, A), slotAt(A))).toBe(true)
    expect(resultHolds(change('PLACE', null, A), null)).toBe(false)
    expect(resultHolds(change('REMOVE', A, null), null)).toBe(true)
    expect(resultHolds(change('PIN', null, null), slotAt(A, true))).toBe(true)
    expect(resultHolds(change('UNPIN', null, null), slotAt(A, true))).toBe(false)
    expect(inverseOf({ ...change('PLACE', null, A), kind: 'PLACE' })).toEqual({ action: 'TAKE_OFF', from: A, to: null })
    expect(inverseOf({ ...change('MOVE', A, B), kind: 'MOVE' })).toEqual({ action: 'MOVE_BACK', from: B, to: A })
    expect(inverseOf({ ...change('REMOVE', A, null), kind: 'REMOVE' })).toEqual({ action: 'PUT_BACK', from: null, to: A })
    expect(inverseOf({ ...change('PIN', null, null), kind: 'PIN' }).action).toBe('UNPIN')
    expect(undoPermissionOf('PIN')).toBe('planning.schedule.pin')
    expect(undoPermissionOf('MOVE')).toBe('planning.schedule.manage')
  })

  it('says each entry in words, from → to in the site time', () => {
    expect(placeWords(A, 'L1', TZ)).toBe('L1 · 17 Nov 08:00–12:00')
    expect(placeWords(place(L1, '2026-11-17T21:00:00Z', '2026-11-18T01:00:00Z'), 'L1', TZ)).toBe('L1 · 17 Nov 22:00–18 Nov 02:00')
    const what = 'Op 20 Sew of SEED-WO-0001'
    const sides = { from: { place: A, laneName: 'L1' }, to: { place: B, laneName: 'L2' } }
    expect(changeWords({ kind: 'MOVE', what, ...sides, published: null, undoes: null, fromWhatIf: false, timeZone: TZ })).toBe('Moved Op 20 Sew of SEED-WO-0001 from L1 · 17 Nov 08:00–12:00 to L2 · 18 Nov 09:00–13:00.')
    expect(changeWords({ kind: 'PLACE', what, from: null, to: sides.from, published: null, undoes: null, fromWhatIf: true, timeZone: TZ })).toBe('Placed Op 20 Sew of SEED-WO-0001 on L1 · 17 Nov 08:00–12:00 (applied from a what-if).')
    expect(changeWords({ kind: 'PUBLISH', what: '', from: null, to: null, published: 13, undoes: null, fromWhatIf: false, timeZone: TZ })).toBe('Published v13 to the floor.')
    expect(changeWords({ kind: 'UNDO', what, from: sides.to, to: sides.from, published: null, undoes: 'MOVE', fromWhatIf: false, timeZone: TZ })).toBe('Undid the move of Op 20 Sew of SEED-WO-0001: back on L1 · 17 Nov 08:00–12:00.')
    expect(undoHoldWords('CHANGED_SINCE', { kind: 'MOVE', operationId: 'op-1', what, undoneBy: null, later: 'moved by Pia at 17 Nov 09:00', permission: 'planning.schedule.manage' })).toBe(
      'Op 20 Sew of SEED-WO-0001 changed since: moved by Pia at 17 Nov 09:00. Only the latest change of a bar is undone.',
    )
  })
})

describe('a published version beside the working plan (PLN-154)', () => {
  const slot = (id: string, workOrderId: string, operationId: string | null, lane: typeof L1, start: string, end: string, pieces: number | null = null): CompareSlot => ({ id, workOrderId, operationId, lane, startAt: Date.parse(start), endAt: Date.parse(end), pieces })
  it('names each version bar SAME, MOVED or REMOVED and the working bars it lacks as added', () => {
    const version = [slot('v1', 'wo1', 'op1', L1, '2026-11-17T07:00:00Z', '2026-11-17T11:00:00Z'), slot('v2', 'wo1', 'op2', L1, '2026-11-18T07:00:00Z', '2026-11-18T09:00:00Z'), slot('v3', 'wo2', 'op3', L2, '2026-11-17T07:00:00Z', '2026-11-17T08:00:00Z')]
    const working = [slot('w1', 'wo1', 'op1', L1, '2026-11-17T07:00:00Z', '2026-11-17T11:00:00Z'), slot('w2', 'wo1', 'op2', L2, '2026-11-18T07:00:00Z', '2026-11-18T09:00:00Z'), slot('w4', 'wo3', null, L2, '2026-11-17T07:00:00Z', '2026-11-19T16:00:00Z', 3)]
    const compare = compareVersion(version, working)
    expect(compare.slots.get('v1')).toMatchObject({ state: 'SAME', working: { id: 'w1' } })
    expect(compare.slots.get('v2')).toMatchObject({ state: 'MOVED', working: { id: 'w2' } })
    expect(compare.slots.get('v3')).toMatchObject({ state: 'REMOVED', working: null })
    expect(compare.added.map((entry) => entry.id)).toEqual(['w4'])
    expect(compareWords(12, { moved: compare.moved, added: compare.added.length, removed: compare.removed })).toBe('Since v12 the working plan has 1 moved, 1 added, 1 removed on its days.')
    expect(compareWords(12, { moved: 0, added: 0, removed: 0 })).toBe("The working plan has v12's days as they were published.")
  })
})

describe('day sheets per line (PLN-154)', () => {
  const facts: SheetFacts = {
    site: { code: 'A1', name: 'Plant A1' },
    day: '2026-11-17',
    plan: { kind: 'PUBLISHED', number: 3, publishedAt: at('2026-11-16T16:00:00Z') },
    printedAt: at('2026-11-17T05:30:00Z'),
    timeZone: TZ,
    lanes: [
      {
        kind: 'LINE',
        code: 'L1',
        name: 'Line one',
        load: { availableMinutes: '2880.0', bookedMinutes: '2340.0', loadPct: '81', overMinutes: '0.0' },
        rows: [
          { startAt: at('2026-11-17T12:00:00Z'), endAt: at('2026-11-17T14:00:00Z'), rush: false, workOrder: 'WO-2', style: 'J-1 Jacket', operation: { seq: 30, name: 'QC' }, pieces: 4, minutes: '40.0', dueDate: '2026-12-01', floor: { state: 'NOT_STARTED', done: 0, of: 4 }, pinned: false, note: null },
          { startAt: at('2026-11-16T21:00:00Z'), endAt: at('2026-11-17T09:00:00Z'), rush: true, workOrder: 'WO-1', style: 'J-1 Jacket', operation: { seq: 20, name: 'Sew' }, pieces: 5, minutes: '120.5', dueDate: null, floor: { state: 'RUNNING', done: 2, of: 7 }, pinned: true, note: 'Use the red thread' },
        ],
      },
      { kind: 'LINE', code: 'L2', name: 'Line two', load: null, rows: [] },
    ],
  }
  it('one sheet per line in start order, the plan named, the load and totals at the foot, in Italian by default', () => {
    const paper = daySheetPaper(facts)
    expect(paper.title).toBe('Foglio di giornata')
    expect(paper.fileName).toBe('Foglio di giornata 2026-11-17.pdf')
    const [one, two] = paper.sheets
    expect(one!.heading).toBe('Linea L1 · Line one')
    expect(one!.facts.find((fact) => fact.label === 'Piano')!.value).toBe('v3, pubblicato il 2026-11-16 17:00')
    expect(one!.banner).toBeNull()
    expect(one!.rows.map((row) => row.cells.slice(0, 3))).toEqual([
      ['2026-11-16 22:00', '10:00', 'WO-1 URGENTE'],
      ['13:00', '15:00', 'WO-2'],
    ])
    expect(one!.rows[0]!.cells[4]).toBe('Op 20 Sew (fissato) Nota: Use the red thread')
    expect(one!.rows[0]!.cells[8]).toBe('In corso 2/7')
    expect(one!.footer).toBe('Totale: 9 pezzi · 160.5 min · carico 81% (2340.0 / 2880.0 min)')
    expect(two!.empty).toBe('Niente in programma su questa linea in questo giorno.')
  })
  it('the working plan is marked as not published, with the version the floor works to', () => {
    const paper = daySheetPaper({ ...facts, plan: { kind: 'WORKING', floorNumber: 3 }, lanes: [facts.lanes[1]!] }, 'en')
    expect(paper.sheets[0]!.banner).toBe('Working plan not yet published to the floor: the floor works to v3.')
    expect(paper.sheets[0]!.facts.find((fact) => fact.label === 'Plan')!.value).toBe('Working plan, not published')
    expect(paper.fileName).toBe('Day sheet L2 2026-11-17.pdf')
  })
})
