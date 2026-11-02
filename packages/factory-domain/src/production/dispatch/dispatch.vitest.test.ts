import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { HANDOVER_LIMITS, handoverProblems, newSince, shiftLabelAt } from './handover'
import { lineLoad, needsReassign, plannedWhy, presenceOf, sumMinutes } from './load'
import { materialFlagOf, worstMaterial } from './material'
import { dispatchPaper } from './paper'
import { PRODUCTION_DISPATCH_PERMISSIONS } from './permissions'
import { assignmentKindOf, DISPATCH_REFUSALS, laneFirst, laneNumbers, laneOrderIssue, movePlan, namedCardKey, placementsOf, REST_CARD, sequenceOf, wholeCardKey, type AssignmentFacts } from './rules'

const at = new Date('2026-11-17T06:00:00.000Z')
const row = (id: string, fields: Partial<AssignmentFacts> = {}): AssignmentFacts => ({ id, version: 1, lineId: 'L1', stationId: 'S1', workOrderOperationId: 'OP', bundleIds: [], workerId: null, sequence: null, createdAt: at, ...fields })
const OPEN = ['B1', 'B2', 'B3', 'B4']
const to = (fields: { stationId?: string | null; lineId?: string | null; workerId?: string | null; unplaced?: boolean; clearWorker?: boolean }) => ({ stationId: null, lineId: null, workerId: null, unplaced: false, ...fields })

describe('an assignment row', () => {
  it('has the three shapes of the database guard', () => {
    expect(assignmentKindOf({ workOrderOperationId: null, workerId: 'W' })).toBe('STATION_OPERATOR')
    expect(assignmentKindOf({ workOrderOperationId: 'OP', workerId: 'W' })).toBe('OPERATION_OPERATOR')
    expect(assignmentKindOf({ workOrderOperationId: 'OP', workerId: null })).toBe('OPERATION_AT_STATION')
  })
})

describe('placements of an operation', () => {
  it('leaves everything unplaced with no row, also before it has bundles', () => {
    expect(placementsOf([], OPEN)).toMatchObject({ placements: [], rest: OPEN, unplaced: true })
    expect(placementsOf([], [])).toMatchObject({ placements: [], rest: [], unplaced: true })
  })

  it('gives a row with no list all the rest, after the bundles named elsewhere', () => {
    const { placements, rest, unplaced } = placementsOf([row('whole'), row('named', { stationId: 'S2', bundleIds: ['B2', 'B3'] })], OPEN)
    expect(unplaced).toBe(false)
    expect(rest).toEqual([])
    expect(placements.find((placement) => placement.whole)).toMatchObject({ key: wholeCardKey('station:S1'), bundleIds: ['B1', 'B4'] })
    expect(placements.find((placement) => !placement.whole)).toMatchObject({ key: namedCardKey('station:S2', null), bundleIds: ['B2', 'B3'] })
  })

  it('drops a reported bundle from a row, and a row with nothing open is no card', () => {
    const { placements, rest } = placementsOf([row('spent', { bundleIds: ['B9'] }), row('some', { stationId: 'S2', bundleIds: ['B1', 'B9'] })], OPEN)
    expect(placements).toHaveLength(1)
    expect(placements[0]!.bundleIds).toEqual(['B1'])
    expect(rest).toEqual(['B2', 'B3', 'B4'])
  })

  it('puts a second person on the same bundles on the same card', () => {
    const { placements } = placementsOf([row('a', { bundleIds: ['B1'], workerId: 'W1' }), row('b', { bundleIds: ['B1'], workerId: 'W2' })], OPEN)
    expect(placements).toHaveLength(1)
    expect(placements[0]!.rows.map((entry) => entry.workerId)).toEqual(['W1', 'W2'])
  })

  it('keeps two rows with no list on one card, and a bundle in one place', () => {
    const { placements } = placementsOf([row('a', { workerId: 'W1' }), row('b', { workerId: 'W2' })], OPEN)
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({ whole: true, bundleIds: OPEN })
    expect(placements[0]!.rows).toHaveLength(2)
    const twice = placementsOf([row('a', { stationId: 'S1', bundleIds: ['B1'] }), row('b', { stationId: 'S2', bundleIds: ['B1', 'B2'] })], OPEN)
    expect(twice.placements.flatMap((placement) => placement.bundleIds).sort()).toEqual(['B1', 'B2'])
  })
})

describe('a move', () => {
  it('makes a row for what had no place, and goes back by removing it', () => {
    const made = movePlan({ rows: [], openBundleIds: OPEN, from: REST_CARD, bundleIds: null, to: to({ stationId: 'S1', lineId: 'L1' }) })
    expect(made.ok && made.plan).toMatchObject({ creates: [{ stationId: 'S1', workerId: null, bundleIds: [] }], updates: [], removes: [], whole: true, key: wholeCardKey('station:S1'), back: { to: { unplaced: true } } })
    const undone = movePlan({ rows: [row('r')], openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: null, to: to({ unplaced: true }) })
    expect(undone.ok && undone.plan).toMatchObject({ removes: [{ id: 'r' }], updates: [], creates: [], key: REST_CARD })
  })

  it('takes the rows along when the whole card moves', () => {
    const moved = movePlan({ rows: [row('a', { workerId: 'W1' }), row('b', { workerId: 'W2' })], openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: null, to: to({ stationId: 'S2', lineId: 'L2' }) })
    expect(moved.ok && moved.plan.updates.map((change) => [change.id, change.stationId, change.lineId])).toEqual([['a', 'S2', 'L2'], ['b', 'S2', 'L2']])
    expect(moved.ok && moved.plan.back.to).toMatchObject({ stationId: 'S1', lineId: 'L1', workerId: null })
  })

  it('splits bundles off a whole card, and they come back to it', () => {
    const rows = [row('whole')]
    const split = movePlan({ rows, openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: ['B1', 'B2'], to: to({ stationId: 'S2', lineId: 'L1' }) })
    expect(split.ok && split.plan).toMatchObject({ creates: [{ stationId: 'S2', bundleIds: ['B1', 'B2'] }], updates: [], removes: [], whole: false, key: namedCardKey('station:S2', null) })
    expect(split.ok && split.plan.back.bundleIds).toEqual(['B1', 'B2'])
    const back = movePlan({ rows: [...rows, row('split', { stationId: 'S2', bundleIds: ['B1', 'B2'] })], openBundleIds: OPEN, from: namedCardKey('station:S2', null), bundleIds: ['B1', 'B2'], to: to({ stationId: 'S1', lineId: 'L1' }) })
    expect(back.ok && back.plan).toMatchObject({ removes: [{ id: 'split' }], updates: [], creates: [], key: wholeCardKey('station:S1') })
  })

  it('moves only the bundles named, even every open one of a card that also holds garments not in a bundle yet', () => {
    const moved = movePlan({ rows: [row('whole')], openBundleIds: ['B1'], from: wholeCardKey('station:S1'), bundleIds: ['B1'], to: to({ stationId: 'S2' }) })
    expect(moved.ok && moved.plan).toMatchObject({ creates: [{ stationId: 'S2', bundleIds: ['B1'] }], updates: [], whole: false })
    const rest = movePlan({ rows: [], openBundleIds: ['B1', 'B2'], from: REST_CARD, bundleIds: ['B1', 'B2'], to: to({ stationId: 'S2' }) })
    expect(rest.ok && rest.plan.creates).toEqual([{ stationId: 'S2', lineId: null, workerId: null, bundleIds: ['B1', 'B2'] }])
  })

  it('joins the bundles to what that place holds by name', () => {
    const rows = [row('a', { stationId: 'S1', bundleIds: ['B1', 'B2'] }), row('b', { stationId: 'S2', bundleIds: ['B3'] })]
    const moved = movePlan({ rows, openBundleIds: OPEN, from: namedCardKey('station:S1', null), bundleIds: ['B2'], to: to({ stationId: 'S2' }) })
    expect(moved.ok && moved.plan.updates).toEqual([{ id: 'a', version: 1, bundleIds: ['B1'] }, { id: 'b', version: 1, bundleIds: ['B3', 'B2'] }])
  })

  it('gives work to another operator at the same station, and undoes it to nobody named', () => {
    const moved = movePlan({ rows: [row('a')], openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: null, to: to({ stationId: 'S1', lineId: 'L1', workerId: 'W2' }) })
    expect(moved.ok && moved.plan.updates).toEqual([{ id: 'a', version: 1, stationId: 'S1', lineId: 'L1', workerId: 'W2' }])
    expect(moved.ok && moved.plan.back.to).toMatchObject({ workerId: null, clearWorker: true })
    const undone = movePlan({ rows: [row('a', { workerId: 'W2' })], openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: null, to: to({ stationId: 'S1', lineId: 'L1', clearWorker: true }) })
    expect(undone.ok && undone.plan.updates[0]).toMatchObject({ workerId: null })
  })

  it('refuses a card that changed, a bundle it does not hold, nothing to do, and part of a card back to Not assigned', () => {
    const rows = [row('whole')]
    const refusalOf = (outcome: ReturnType<typeof movePlan>) => (outcome.ok ? null : outcome.refusal)
    expect(refusalOf(movePlan({ rows, openBundleIds: OPEN, from: wholeCardKey('station:S9'), bundleIds: null, to: to({ stationId: 'S2' }) }))).toBe(DISPATCH_REFUSALS.MOVED_ALREADY)
    expect(refusalOf(movePlan({ rows, openBundleIds: OPEN, from: REST_CARD, bundleIds: null, to: to({ stationId: 'S2' }) }))).toBe(DISPATCH_REFUSALS.MOVED_ALREADY)
    expect(refusalOf(movePlan({ rows, openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: ['B9'], to: to({ stationId: 'S2' }) }))).toBe(DISPATCH_REFUSALS.MOVED_ALREADY)
    expect(refusalOf(movePlan({ rows, openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: null, to: to({ stationId: 'S1', lineId: 'L1' }) }))).toBe(DISPATCH_REFUSALS.NOTHING_TO_MOVE)
    expect(refusalOf(movePlan({ rows, openBundleIds: OPEN, from: wholeCardKey('station:S1'), bundleIds: ['B1'], to: to({ unplaced: true }) }))).toBe(DISPATCH_REFUSALS.NOT_SPLIT_OFF)
  })
})

describe('a lane', () => {
  const lane = [row('a', { sequence: 1 }), row('b', { sequence: 2 }), row('c', { sequence: 3 })]

  it('numbers only what changes, keeps a card together and clamps the position', () => {
    expect(laneNumbers(lane, ['c'], 1)).toEqual([{ id: 'c', sequence: 1 }, { id: 'a', sequence: 2 }, { id: 'b', sequence: 3 }])
    expect(laneNumbers(lane, ['a'], null)).toEqual([{ id: 'b', sequence: 1 }, { id: 'c', sequence: 2 }, { id: 'a', sequence: 3 }])
    expect(laneNumbers(lane, ['c'], 99)).toEqual([])
    expect(laneNumbers([...lane, row('d')], ['d'], null)).toEqual([{ id: 'd', sequence: 4 }])
  })

  it('finds a later operation before an earlier one of the same work order only', () => {
    const entry = (workOrderId: string, seq: number) => ({ workOrderId, workOrderNumber: workOrderId, seq, name: `Op${seq}` })
    expect(laneOrderIssue([entry('A', 10), entry('A', 20), entry('B', 5)])).toBeNull()
    expect(laneOrderIssue([entry('A', 20), entry('B', 5), entry('A', 10)])?.words).toBe('Op 20 Op20 of A stands before Op 10 Op10.')
  })

  it('keeps rush first, then the board order, then leaves the plan order', () => {
    expect(laneFirst({ rush: true, order: 5 }, { rush: false, order: 1 })).toBeLessThan(0)
    expect(laneFirst({ rush: false, order: 2 }, { rush: false, order: 1 })).toBeGreaterThan(0)
    expect(laneFirst({ rush: false, order: null }, { rush: false, order: 1 })).toBeGreaterThan(0)
    expect(laneFirst({ rush: false, order: null }, { rush: false, order: null })).toBe(0)
  })
})

describe('the sequence rule on a list (MES-025)', () => {
  const facts = { operation: { seq: 30, name: 'Collar' }, previous: { seq: 20, name: 'Sewing' }, waiting: true }

  it('holds at a strict site, warns at a warn site and says nothing at a free one', () => {
    expect(sequenceOf('STRICT', facts)).toMatchObject({ state: 'HELD', words: 'Op 30 Collar starts when Op 20 Sewing has passed work on: this site keeps a strict sequence.' })
    expect(sequenceOf('WARN', facts)).toMatchObject({ state: 'WARN', words: 'Op 20 Sewing has passed nothing on yet: it may start, and the team leader is told.' })
    expect(sequenceOf('FREE', facts)).toMatchObject({ state: 'CLEAR', words: null })
  })

  it('is clear for the first operation and for work that has arrived, whatever the rule', () => {
    expect(sequenceOf('STRICT', { ...facts, previous: null })).toMatchObject({ state: 'CLEAR' })
    expect(sequenceOf('STRICT', { ...facts, waiting: false })).toMatchObject({ state: 'CLEAR' })
  })
})

describe("today's load against available minutes (MES-031)", () => {
  const facts = { workingMinutes: 480, efficiencyPct: '75', plannedPeople: 8, clockedIn: 6, why: null, operators: 0, notIn: 0, minimumGroup: 3 } as const

  it("is people × working minutes left × the line's efficiency, in the design's words", () => {
    // 6 × 480 × 75% = 2,160; 2,410 queued → 250 over.
    expect(lineLoad({ ...facts, queued: '2410' })).toMatchObject({ queuedMinutes: 2410, availableMinutes: 2160, overMinutes: 250, spareMinutes: 0, state: 'OVER', source: 'CLOCKED_IN', people: 6, words: 'Queued 2,410 min · available 2,160 min · 250 min over' })
    expect(lineLoad({ ...facts, queued: '2000.4' })).toMatchObject({ queuedMinutes: 2000, spareMinutes: 160, state: 'FITS', words: 'Queued 2,000 min · available 2,160 min · 160 min spare' })
  })

  it('falls back to the planned people, and says why', () => {
    // 8 × 480 × 75% = 2,880.
    expect(lineLoad({ ...facts, queued: '100', clockedIn: null, why: 'ATTENDANCE_OFF' })).toMatchObject({ availableMinutes: 2880, source: 'PLANNED', people: 8, sourceWords: 'Planned people: clock-in is not switched on at this site.' })
  })

  it('rounds half up and adds minutes as decimals', () => {
    expect(lineLoad({ ...facts, queued: '675.5' }).queuedMinutes).toBe(676)
    expect(sumMinutes(['0.1', '0.2'])).toBe('0.3')
    expect(sumMinutes([])).toBe('0.0')
  })

  it('never shows a count, or minutes that give it away, under the minimum group size', () => {
    const load = lineLoad({ ...facts, queued: '100', clockedIn: null, why: 'TOO_FEW' })
    expect(load).toMatchObject({ people: null, availableMinutes: 2880, source: 'PLANNED' })
    expect(plannedWhy({ attendanceOpen: true, isToday: true, shiftBegun: true, clockedIn: 2, minimumGroup: 3 })).toBe('TOO_FEW')
    expect(lineLoad({ ...facts, queued: '100', operators: 2, notIn: 1 }).absent).toBeNull()
    expect(lineLoad({ ...facts, queued: '100', operators: 3, notIn: 1 }).absent).toBe(1)
  })

  it('says why the clock does not count', () => {
    const base = { attendanceOpen: true, isToday: true, shiftBegun: true, clockedIn: 5, minimumGroup: 3 }
    expect(plannedWhy(base)).toBeNull()
    expect(plannedWhy({ ...base, attendanceOpen: false })).toBe('ATTENDANCE_OFF')
    expect(plannedWhy({ ...base, isToday: false })).toBe('NOT_TODAY')
    expect(plannedWhy({ ...base, shiftBegun: false, clockedIn: 0 })).toBe('BEFORE_THE_SHIFT')
    // The shift has begun and nobody is in: nothing is available, which is the truth.
    expect(plannedWhy({ ...base, clockedIn: 0 })).toBeNull()
  })

  it('reports nothing available when no one is in', () => {
    expect(lineLoad({ ...facts, queued: '100', clockedIn: 0 })).toMatchObject({ availableMinutes: 0, state: 'NOTHING_AVAILABLE', overMinutes: 100 })
  })
})

describe('absence-aware dispatch (MES-028)', () => {
  const now = new Date('2026-11-17T09:00:00.000Z')
  const facts = { attendanceOpen: true, isToday: true, hasRecord: true, clocked: null, planned: null, lineStartsAt: null, now } as const

  it('reads nothing with the gate off, on another day or with no person record', () => {
    expect(presenceOf({ ...facts, attendanceOpen: false })).toBe('UNKNOWN')
    expect(presenceOf({ ...facts, isToday: false })).toBe('UNKNOWN')
    expect(presenceOf({ ...facts, hasRecord: false })).toBe('UNKNOWN')
  })

  it('takes the clock first, then the planned shift', () => {
    expect(presenceOf({ ...facts, clocked: 'IN', planned: { kind: 'OFF' } })).toBe('IN')
    expect(presenceOf({ ...facts, clocked: 'ON_BREAK' })).toBe('ON_BREAK')
    expect(presenceOf({ ...facts, planned: { kind: 'OFF' } })).toBe('OFF')
    expect(presenceOf({ ...facts, planned: { kind: 'WORK', startsAt: new Date('2026-11-17T13:00:00.000Z') } })).toBe('LATER')
    expect(presenceOf({ ...facts, planned: { kind: 'WORK', startsAt: new Date('2026-11-17T05:00:00.000Z') } })).toBe('NOT_IN')
    expect(presenceOf({ ...facts, lineStartsAt: new Date('2026-11-17T13:00:00.000Z') })).toBe('LATER')
    expect(presenceOf(facts)).toBe('NOT_IN')
  })

  it('offers only those who will not come for reassignment', () => {
    expect((['IN', 'ON_BREAK', 'NOT_IN', 'LATER', 'OFF', 'UNKNOWN'] as const).filter(needsReassign)).toEqual(['NOT_IN', 'OFF'])
  })
})

describe('the material ready flag (MES-026)', () => {
  it('maps each readiness word to in stock, on the way or missing', () => {
    expect(materialFlagOf('RECEIVED', null).state).toBe('IN_STOCK')
    expect(materialFlagOf('NOT_BOOKED', null).state).toBe('IN_STOCK')
    expect(materialFlagOf('EXPECTED', '2026-11-20')).toMatchObject({ state: 'ON_THE_WAY', words: 'Some material is on the way: expected 2026-11-20.' })
    expect(materialFlagOf('REQUESTED', null).state).toBe('ON_THE_WAY')
    expect(materialFlagOf('DELAYED', null).state).toBe('ON_THE_WAY')
    expect(materialFlagOf('NOT_ENOUGH', null).state).toBe('MISSING')
    expect(materialFlagOf('NOT_PLANNED', null).state).toBe('NOT_KNOWN')
  })

  it('shows the worst of a station', () => {
    expect(worstMaterial(['IN_STOCK', 'MISSING', 'ON_THE_WAY'])).toBe('MISSING')
    expect(worstMaterial(['NOT_KNOWN', 'IN_STOCK'])).toBe('IN_STOCK')
    expect(worstMaterial(['NOT_KNOWN'])).toBe('NOT_KNOWN')
    expect(worstMaterial([])).toBeNull()
  })
})

describe('handover notes (MES-033)', () => {
  it('asks a topic or a text, each topic once, within the limits', () => {
    expect(handoverProblems({ topics: [], text: '  ' }).map((issue) => issue.path)).toEqual(['topics'])
    expect(handoverProblems({ topics: ['MACHINES', 'MACHINES'] }).map((issue) => issue.path)).toEqual(['topics'])
    expect(handoverProblems({ topics: [], text: 'x'.repeat(HANDOVER_LIMITS.text + 1) }).map((issue) => issue.path)).toEqual(['text'])
    expect(handoverProblems({ topics: ['MACHINES'], shiftLabel: ' ' }).map((issue) => issue.path)).toEqual(['shiftLabel'])
    expect(handoverProblems({ topics: [], text: 'Needle 3 is bent.' })).toEqual([])
  })

  it('belongs to the running shift, else the last that began, else the first', () => {
    const shifts = [
      { label: 'A', start: new Date('2026-11-17T05:00:00.000Z'), end: new Date('2026-11-17T13:00:00.000Z') },
      { label: null, start: new Date('2026-11-17T14:00:00.000Z'), end: new Date('2026-11-17T22:00:00.000Z') },
    ]
    expect(shiftLabelAt(shifts, new Date('2026-11-17T10:00:00.000Z'))).toBe('A')
    expect(shiftLabelAt(shifts, new Date('2026-11-17T13:30:00.000Z'))).toBe('A')
    expect(shiftLabelAt(shifts, new Date('2026-11-17T15:00:00.000Z'))).toBe('Shift 2')
    expect(shiftLabelAt(shifts, new Date('2026-11-17T03:00:00.000Z'))).toBe('A')
    expect(shiftLabelAt([], new Date('2026-11-17T03:00:00.000Z'))).toBe('Day')
  })

  it('is new since the previous session ended, else since it was last seen, else the look-back', () => {
    const now = new Date('2026-11-17T06:00:00.000Z')
    const ended = new Date('2026-11-16T14:00:00.000Z')
    const seen = new Date('2026-11-16T13:00:00.000Z')
    expect(newSince({ startedAt: seen, endedAt: ended, lastSeenAt: seen }, now)).toEqual(ended)
    expect(newSince({ startedAt: seen, endedAt: null, lastSeenAt: seen }, now)).toEqual(seen)
    expect(newSince(null, now)).toEqual(new Date('2026-11-16T06:00:00.000Z'))
  })
})

describe('the printed list (MES-032)', () => {
  const card = { order: 1, rush: true, workOrder: 'WO-1', style: 'JKT Giacca', operation: { seq: 20, name: 'Sewing' }, bundles: ['B-1', 'B-2'], pieces: 12, minutes: '60.0', dueDate: '2026-11-20', material: 'MISSING', held: false } as const
  const facts = {
    site: { code: 'A1', name: 'Plant' },
    target: { kind: 'LINE', code: 'L1', name: 'Line one' },
    day: '2026-11-17',
    shift: 'A',
    version: 3,
    printedAt: new Date('2026-11-17T06:00:00.000Z'),
    timeZone: 'Europe/Rome',
    sections: [
      { station: { code: 'SEW-01', name: 'Machine 1' }, operators: ['Made-up Person'], cards: [card] },
      { station: { code: 'SEW-02', name: 'Machine 2' }, operators: [], cards: [] },
    ],
  } as const

  it('says it in the language asked, with an empty column to tick', () => {
    const it_ = dispatchPaper(facts, 'it')
    expect(it_).toMatchObject({ title: 'Lista di lavoro', heading: 'Linea L1 · Line one', empty: null, fileName: 'Lista di lavoro L1 2026-11-17.pdf' })
    expect(it_.facts).toContainEqual({ label: 'Stampata', value: '2026-11-17 07:00' })
    expect(it_.sections).toHaveLength(1)
    expect(it_.sections[0]).toMatchObject({ title: 'SEW-01 · Machine 1', operators: 'Operatori: Made-up Person', footer: 'Totale: 12 · 60.0 min' })
    expect(it_.sections[0]!.rows[0]!.cells).toEqual(['1', 'WO-1 URGENTE', 'JKT Giacca', 'Op 20 Sewing', 'B-1, B-2', '12', '60.0', '2026-11-20', 'Manca', ''])
    expect(dispatchPaper(facts, 'en').sections[0]!.rows[0]!.cells.slice(1, 2)).toEqual(['WO-1 RUSH'])
    // Printed just after midnight at the plant: the plant's day, not London's.
    expect(dispatchPaper({ ...facts, printedAt: new Date('2026-11-17T23:30:00.000Z') }, 'en').facts).toContainEqual({ label: 'Printed', value: '2026-11-18 00:30' })
  })

  it('says so when nothing is queued', () => {
    expect(dispatchPaper({ ...facts, sections: [] }, 'en')).toMatchObject({ sections: [], empty: 'Nothing queued for this shift.' })
  })
})

describe('the catalogues', () => {
  it('declares the permissions and shares them with the floor', () => {
    for (const name of PRODUCTION_DISPATCH_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
      expect(FLOOR_SHARED_PERMISSIONS).toContain(name)
    }
  })

  it('declares the events, with no person and no word of a note', () => {
    const changed = EVENT_CATALOGUE.get('dispatch.assignment_changed', 1)
    expect(changed.live).toMatchObject({ permission: 'production.dispatch.view', floor: 'floor.work' })
    expect(Object.keys(changed.payload.shape).sort()).toEqual(['assignmentIds', 'change', 'lineIds', 'siteId', 'stationIds', 'workDate', 'workOrderId', 'workOrderOperationId'])
    expect(Object.keys(EVENT_CATALOGUE.get('dispatch.handover_written', 1).payload.shape)).not.toContain('text')
  })
})
