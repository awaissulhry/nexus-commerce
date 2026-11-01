import { describe, expect, it } from 'vitest'
import { choiceProblems } from '../../auth/floor/literacy'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import type { DailyScan } from '../reports/daily'
import { boardNoteOf, lineQuality, STATION_BOARD_LOOKS, STATION_BOARD_STATES, stationBoardState } from './board'
import { heatMap, isPile, levelOf, type WaitingBundle } from './heatmap'
import { dayTotals, goodByLineHour, hourRows, paceOf, shiftAt, workingMinutesByHour } from './hourly'
import { PRODUCTION_BOARDS_FLOOR_PERMISSIONS, PRODUCTION_BOARDS_PERMISSIONS } from './permissions'
import { BOARD_REFUSALS, hourLabel, isPastDay, shortReasonRefusal, targetDraftProblems, targetPlan, type StoredTarget } from './targets'

/**
 * Line targets and boards (B-W2b-50; MES-084, MES-161, MES-162, MES-166, ANA-007), the pure rules. Every name and number
 * is made up. Rome is UTC+1 in November: 10:00 Rome is 09:00Z.
 */

const DAY = '2026-11-20'
const ZONE = 'Europe/Rome'
const at = (iso: string) => new Date(iso)

describe('the permissions, the templates and the events', () => {
  it('declares view, targets and reason; the floor shares view and reason; nobody per person', () => {
    for (const name of PRODUCTION_BOARDS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(PRODUCTION_BOARDS_FLOOR_PERMISSIONS).toEqual(['production.boards.view', 'production.boards.reason'])
    for (const name of PRODUCTION_BOARDS_FLOOR_PERMISSIONS) expect(FLOOR_SHARED_PERMISSIONS).toContain(name)
    expect(FLOOR_SHARED_PERMISSIONS).not.toContain('production.boards.targets')
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining(['production.boards.view', 'production.boards.targets', 'production.boards.reason']))
    expect(templateOf('floor_supervisor')?.permissions).toEqual(expect.arrayContaining(['production.boards.view', 'production.boards.targets', 'production.boards.reason']))
    expect(templateOf('planner')?.permissions).toEqual(expect.arrayContaining(['production.boards.view', 'production.boards.targets']))
    expect(templateOf('planner')?.permissions).not.toContain('production.boards.reason')
    expect(templateOf('quality_inspector')?.permissions).toContain('production.boards.view')
    expect(templateOf('team_leader')?.permissions).toEqual(expect.arrayContaining(['production.boards.view', 'production.boards.reason']))
    expect(templateOf('operator')?.permissions).not.toContain('production.boards.view')
    expect(templateOf('read_only')?.permissions).toContain('production.boards.view')
    expect(templateOf('read_only')?.permissions).not.toContain('production.boards.targets')
  })

  it('declares the two events with ids, hours and codes only (no person, no typed words)', () => {
    const changed = EVENT_CATALOGUE.get('line_targets.changed', 1)
    const reason = EVENT_CATALOGUE.get('line_target.reason_given', 1)
    expect(changed.live).toMatchObject({ permission: 'production.boards.view', floor: 'production.boards.view' })
    expect(Object.keys(changed.payload.shape)).toEqual(['lineId', 'workDate', 'set', 'removed'])
    expect(Object.keys(reason.payload.shape)).toEqual(['targetId', 'lineId', 'workDate', 'hour', 'reasonCode', 'by'])
    expect(() => EVENT_CATALOGUE.parse('line_target.reason_given', 1, { targetId: crypto.randomUUID(), lineId: crypto.randomUUID(), workDate: DAY, hour: 10, reasonCode: 'BREAKDOWN', by: 'FLOOR', shortNote: 'words' })).toThrow()
  })
})

describe('the targets of a day (MES-084)', () => {
  const stored: StoredTarget[] = [
    { id: 't8', hour: 8, targetPieces: 30, version: 1, reasonGiven: false },
    { id: 't9', hour: 9, targetPieces: 30, version: 2, reasonGiven: true },
    { id: 't10', hour: 10, targetPieces: 30, version: 1, reasonGiven: false },
  ]

  it('checks the hours asked: 0-23, once each, whole pieces or empty', () => {
    expect(targetDraftProblems([{ hour: 8, targetPieces: 30 }, { hour: 9, targetPieces: null }])).toEqual([])
    expect(targetDraftProblems([]).map((issue) => issue.path)).toEqual(['hours'])
    expect(targetDraftProblems([{ hour: 24, targetPieces: 1 }, { hour: 7, targetPieces: -1 }, { hour: 7, targetPieces: 1.5 }]).map((issue) => issue.path)).toEqual(['hours/0/hour', 'hours/1/targetPieces', 'hours/2/hour', 'hours/2/targetPieces'])
    expect(targetDraftProblems([{ hour: 8, targetPieces: 100_001 }])[0]!.path).toBe('hours/0/targetPieces')
  })

  it('plans creates, changes, removes and leaves the same ones alone', () => {
    const plan = targetPlan(stored, [
      { hour: 11, targetPieces: 25 },
      { hour: 8, targetPieces: 30 },
      { hour: 10, targetPieces: null },
      { hour: 9, targetPieces: 28, version: 2 },
      { hour: 12, targetPieces: null },
    ])
    expect(plan.create).toEqual([{ hour: 11, targetPieces: 25 }])
    expect(plan.change.map((entry) => [entry.target.id, entry.targetPieces])).toEqual([['t9', 28]])
    expect(plan.remove.map((target) => target.id)).toEqual(['t10'])
    expect(plan.unchanged).toEqual([8, 12])
    expect(plan.refusal).toBeNull()
    expect(plan.stale).toBeNull()
  })

  it('REFUSED: removing an hour whose reason was given; a stale version names the hour', () => {
    expect(targetPlan(stored, [{ hour: 9, targetPieces: null }]).refusal).toEqual({ refusal: BOARD_REFUSALS.REASON_GIVEN, hour: 9 })
    expect(targetPlan(stored, [{ hour: 8, targetPieces: 31, version: 3 }]).stale).toEqual({ hour: 8, stored: 1, sent: 3 })
  })

  it('a past day is history; labels name the hour', () => {
    expect(isPastDay('2026-11-19', DAY)).toBe(true)
    expect(isPastDay(DAY, DAY)).toBe(false)
    expect(hourLabel(10)).toBe('10:00–11:00')
    expect(hourLabel(23)).toBe('23:00–00:00')
  })
})

describe('the reason of a short hour (MES-161 "Why was 10:00–11:00 short?")', () => {
  const code = { active: true, needsDetail: false }
  it('needs an hour that is over and short, an active code, and words for an "Other" code', () => {
    expect(shortReasonRefusal({ over: true, done: 20, targetPieces: 30, code, note: null })).toBeNull()
    expect(shortReasonRefusal({ over: false, done: 20, targetPieces: 30, code, note: null })).toBe(BOARD_REFUSALS.HOUR_NOT_OVER)
    expect(shortReasonRefusal({ over: true, done: 30, targetPieces: 30, code, note: null })).toBe(BOARD_REFUSALS.NOT_SHORT)
    expect(shortReasonRefusal({ over: true, done: 2, targetPieces: 30, code: null, note: null })).toBe(BOARD_REFUSALS.CODE_NOT_LISTED)
    expect(shortReasonRefusal({ over: true, done: 2, targetPieces: 30, code: { active: false, needsDetail: false }, note: null })).toBe(BOARD_REFUSALS.CODE_NOT_LISTED)
    expect(shortReasonRefusal({ over: true, done: 2, targetPieces: 30, code: { active: true, needsDetail: true }, note: '  ' })).toBe(BOARD_REFUSALS.NOTE_NEEDED)
    expect(shortReasonRefusal({ over: true, done: 2, targetPieces: 30, code: { active: true, needsDetail: true }, note: 'Thread ran out.' })).toBeNull()
    for (const refusal of Object.values(BOARD_REFUSALS)) expect(refusal.fix.length).toBeGreaterThan(0)
  })
})

describe('hour by hour (MES-161, ANA-007)', () => {
  const ops = new Map([
    ['op-cut', { workOrderId: 'wo', seq: 10, scanRequired: true, workCentreId: 'CUT', standardMinutes: '2' }],
    ['op-sew', { workOrderId: 'wo', seq: 20, scanRequired: true, workCentreId: 'SEW', standardMinutes: '12' }],
    ['op-qc', { workOrderId: 'wo', seq: 30, scanRequired: true, workCentreId: 'QC', standardMinutes: '1' }],
  ])
  const scan = (id: string, over: Partial<DailyScan>): DailyScan => ({ id, kind: 'REPORT', correctsId: null, bundleId: 'b1', workOrderId: 'wo', operationId: 'op-sew', good: 0, scrap: 0, rework: 0, stationId: 'sew1', at: at('2026-11-20T08:10:00Z'), ...over })
  const facts = (scans: DailyScan[]) => ({
    day: DAY,
    timeZone: ZONE,
    scans,
    bundles: new Map([
      ['b1', { part: null, status: 'ACTIVE' }],
      ['b2', { part: null, status: 'ACTIVE' }],
      ['sleeves', { part: 'sleeve', status: 'ACTIVE' }],
    ]),
    operations: ops,
    stationLanes: new Map<string, { kind: 'LINE' | 'WORK_CENTRE'; id: string }>([
      ['sew1', { kind: 'LINE', id: 'L1' }],
      ['sew2', { kind: 'LINE', id: 'L1' }],
      ['qc1', { kind: 'WORK_CENTRE', id: 'QC' }],
    ]),
    laneCentres: new Map([['LINE:L1', new Set(['SEW'])], ['WORK_CENTRE:QC', new Set(['QC'])]]),
  })

  it('counts garments out of the line’s last operation per local hour; a correction on its report’s hour; never part bundles or a lane alone', () => {
    const scans = [
      scan('s1', { good: 4, at: at('2026-11-20T08:10:00Z') }), // 09:10 Rome
      scan('s2', { good: 3, bundleId: 'b2', stationId: 'sew2', at: at('2026-11-20T09:05:00Z') }), // 10:05 Rome …
      scan('s3', { kind: 'CORRECTION', correctsId: 's2', good: 2, bundleId: 'b2', stationId: 'sew2', at: at('2026-11-20T11:00:00Z') }), // … corrected at noon: 2 at 10:00
      scan('s4', { good: 5, bundleId: 'sleeves', at: at('2026-11-20T09:20:00Z') }), // a part bundle
      scan('s5', { good: 4, operationId: 'op-qc', stationId: 'qc1', at: at('2026-11-20T09:30:00Z') }), // the bench alone
      scan('s6', { good: 1, at: at('2026-11-19T15:00:00Z') }), // yesterday
      scan('s7', { good: 2, at: at('2026-11-20T09:40:00Z') }), // undone below
      scan('s8', { kind: 'UNDO', correctsId: 's7', at: at('2026-11-20T09:41:00Z') }),
    ]
    const out = goodByLineHour(facts(scans))
    expect([...out.keys()]).toEqual(['L1'])
    expect([...out.get('L1')!.entries()].sort()).toEqual([[10, 2], [9, 4]].sort())
  })

  it('takes the working minutes per hour from the shifts’ working stretches', () => {
    const minutes = workingMinutesByHour(DAY, ZONE, [
      { start: at('2026-11-20T05:00:00Z'), end: at('2026-11-20T09:00:00Z') }, // 06:00-10:00
      { start: at('2026-11-20T09:15:00Z'), end: at('2026-11-20T13:00:00Z') }, // 10:15-14:00 (a break 10:00-10:15)
    ])
    expect([...minutes.entries()]).toEqual([[6, 60], [7, 60], [8, 60], [9, 60], [10, 45], [11, 60], [12, 60], [13, 60]])
  })

  it('lists the hours with a target, an output or working time; short = over and below its target; totals so far and the pace', () => {
    const now = at('2026-11-20T09:30:00Z') // 10:30 Rome
    const rows = hourRows({
      day: DAY,
      timeZone: ZONE,
      now,
      targets: [
        { id: 't8', hour: 8, targetPieces: 6, version: 1 },
        { id: 't9', hour: 9, targetPieces: 6, version: 1 },
        { id: 't10', hour: 10, targetPieces: 6, version: 1 },
        { id: 't11', hour: 11, targetPieces: 6, version: 1 },
      ],
      done: new Map([[8, 6], [9, 2], [10, 1], [15, 1]]),
      workingMinutes: new Map([[8, 60], [9, 60], [10, 60], [11, 60], [12, 60]]),
      calls: new Map([[9, 2]]),
    })
    expect(rows.map((row) => [row.hour, row.state, row.done, row.target?.targetPieces ?? null, row.short, row.calls])).toEqual([
      [8, 'OVER', 6, 6, false, 0],
      [9, 'OVER', 2, 6, true, 2],
      [10, 'RUNNING', 1, 6, false, 0],
      [11, 'LATER', 0, 6, false, 0],
      [12, 'LATER', 0, null, false, 0],
      [15, 'LATER', 1, null, false, 0],
    ])
    expect(rows[0]!.start.toISOString()).toBe('2026-11-20T07:00:00.000Z')
    const totals = dayTotals(rows, now)
    // 6 + 6 over, half of 10:00's 6 gone: 15 so far; 10 done < 90 % of 15.
    expect(totals).toEqual({ done: 10, target: 24, targetSoFar: 15, pace: 'BEHIND', shortHours: 1 })
    expect(dayTotals(hourRows({ day: DAY, timeZone: ZONE, now, targets: [], done: new Map([[9, 3]]), workingMinutes: new Map() }), now)).toEqual({ done: 3, target: null, targetSoFar: null, pace: 'NO_TARGET', shortHours: 0 })
    expect(paceOf(14, 15)).toBe('ON_PACE')
    expect(paceOf(13, 15)).toBe('BEHIND')
    expect(paceOf(0, 0)).toBe('NO_TARGET')
  })

  it('finds the shift running now', () => {
    const shifts = [
      { label: 'A', start: at('2026-11-20T05:00:00Z'), end: at('2026-11-20T13:00:00Z') },
      { label: 'B', start: at('2026-11-20T13:00:00Z'), end: at('2026-11-20T21:00:00Z') },
    ]
    expect(shiftAt(shifts, at('2026-11-20T09:00:00Z'))?.label).toBe('A')
    expect(shiftAt(shifts, at('2026-11-20T13:00:00Z'))?.label).toBe('B')
    expect(shiftAt(shifts, at('2026-11-20T22:00:00Z'))).toBeNull()
  })
})

describe('the WIP heat map (MES-162)', () => {
  const op = (code: string, seq: number) => ({ code, name: `Op ${code}`, seq })
  const waiting = (lineId: string | null, code: string, seq: number, count: number, stuck = 0): WaitingBundle[] =>
    Array.from({ length: count }, (_, index) => ({ lineId, operation: op(code, seq), pieces: 10, stuck: index < stuck }))

  it('levels against the biggest cell and marks a pile above the line’s usual cell with a word', () => {
    expect(levelOf(0, 9)).toBe('NONE')
    expect(levelOf(3, 9)).toBe('LOW')
    expect(levelOf(6, 9)).toBe('MEDIUM')
    expect(levelOf(7, 9)).toBe('HIGH')
    expect(isPile(2, [])).toBe(false)
    expect(isPile(5, [])).toBe(false)
    expect(isPile(6, [])).toBe(true)
    expect(isPile(4, [1, 2, 0])).toBe(true)
    expect(isPile(4, [3, 2])).toBe(false)
  })

  it('makes one column per operation code in routing order, one row per line and a row of no line', () => {
    const map = heatMap([...waiting('L2', 'SEW-COLLAR', 30, 1), ...waiting('L1', 'SEW-SLEEVE', 20, 2, 1), ...waiting('L1', 'SEW-COLLAR', 30, 9), ...waiting(null, 'SEW-SLEEVE', 25, 1), ...waiting('L1', 'CUT', 10, 1)], ['L1', 'L2'])
    expect(map.columns.map((column) => column.code)).toEqual(['CUT', 'SEW-SLEEVE', 'SEW-COLLAR'])
    expect(map.max).toBe(9)
    expect(map.rows.map((row) => row.lineId)).toEqual(['L1', 'L2', null])
    const [l1, l2, none] = map.rows
    expect(l1).toMatchObject({ bundles: 12, pieces: 120, stuck: 1 })
    expect(l1!.cells.map((cell) => [cell.code, cell.bundles, cell.level, cell.pile])).toEqual([
      ['CUT', 1, 'LOW', false],
      ['SEW-SLEEVE', 2, 'LOW', false],
      ['SEW-COLLAR', 9, 'HIGH', true],
    ])
    expect(l2!.cells.map((cell) => cell.bundles)).toEqual([0, 0, 1])
    expect(none!.cells.map((cell) => cell.bundles)).toEqual([0, 1, 0])
    expect(heatMap([], ['L1'])).toEqual({ columns: [], rows: [{ lineId: 'L1', bundles: 0, pieces: 0, stuck: 0, cells: [] }], max: 0 })
  })
})

describe('the line TV (ANA-007, MES-166)', () => {
  it('says a station by colour, shape and word: a machine down first, then a call, then someone coming', () => {
    expect(stationBoardState({ call: 'CALLING', machineDown: true })).toBe('MACHINE_DOWN')
    expect(stationBoardState({ call: 'CALLING', machineDown: false })).toBe('CALLING')
    expect(stationBoardState({ call: 'COMING', machineDown: false })).toBe('COMING')
    expect(stationBoardState({ call: 'CLEAR', machineDown: false })).toBe('CLEAR')
    // Told apart without reading (MES-188): every state has its own icon and tone, and its own shape.
    expect(choiceProblems(STATION_BOARD_STATES.map((state) => ({ code: state, look: STATION_BOARD_LOOKS[state] })))).toEqual([])
    expect(new Set(STATION_BOARD_STATES.map((state) => STATION_BOARD_LOOKS[state].shape)).size).toBe(STATION_BOARD_STATES.length)
  })

  it('counts DHU from the day’s scrap and rework over the garments made', () => {
    expect(lineQuality({ good: 18, scrap: 2, rework: 3 })).toEqual({ defects: 5, units: 20, dhu: '25.0' })
    expect(lineQuality({ good: 2, scrap: 1, rework: 1 })).toEqual({ defects: 2, units: 3, dhu: '66.7' })
    expect(lineQuality({ good: 0, scrap: 0, rework: 4 })).toEqual({ defects: 4, units: 0, dhu: null })
  })

  it('shows the latest of the day’s notes that says something, else none', () => {
    const note = (shiftLabel: string, iso: string, text: string | null, topics: string[] = []) => ({ shiftLabel, topics, text, updatedAt: at(iso) })
    expect(boardNoteOf([note('A', '2026-11-20T07:00:00Z', 'Morning words'), note('B', '2026-11-20T13:30:00Z', 'Afternoon words'), note('C', '2026-11-20T15:00:00Z', ' ')])?.shiftLabel).toBe('B')
    expect(boardNoteOf([note('A', '2026-11-20T07:00:00Z', null, ['MACHINES'])])?.shiftLabel).toBe('A')
    expect(boardNoteOf([])).toBeNull()
  })
})
