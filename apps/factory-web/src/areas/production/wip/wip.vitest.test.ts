import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { HeatmapAnswer, Hour, TrackedBundle } from './api'
import { boardRefusal, boardsLiveTouches, boardTouched, bundleHref, bundlesHref, floorBoardsCan, heatGrid, hourRow, lastPlace, lineTvHref, reasonHeld, shortHours, stuckCsv, targetChanges, targetDraft, targetsHeld, targetsTotal, tvLine, type TargetDraftRow } from './model'

const hour = (over: Partial<Hour>): Hour => ({ hour: 10, label: '10:00–11:00', start: '', end: '', state: 'OVER', workingMinutes: 60, done: 18, target: { id: 't', targetPieces: 24, version: 2 }, short: true, calls: 0, reason: null, ...over })

describe('who reads and does what on Floor now (B-W2b-66)', () => {
  it('reads each section only with its own permission', () => {
    expect(floorBoardsCan(['production.boards.view'])).toEqual({ boards: true, targets: false, bundles: false, calls: false })
    expect(floorBoardsCan(['production.boards.targets', 'production.bundles.view', 'production.calls.view'])).toEqual({ boards: false, targets: true, bundles: true, calls: true })
  })

  it('re-reads by what changed: scans together, calls and reasons at once', () => {
    expect(boardsLiveTouches({ type: 'production.scan_recorded' })).toBe('scan')
    expect(boardsLiveTouches({ type: 'production.bundle_stuck' })).toBe('scan')
    expect(boardsLiveTouches({ type: 'help_call.sent' })).toBe('calls')
    expect(boardsLiveTouches({ type: 'line_target.reason_given' })).toBe('hours')
    expect(boardsLiveTouches({ type: 'line_targets.changed' })).toBe('hours')
    expect(boardsLiveTouches({ type: 'workorder.released' })).toBeNull()
    expect(boardTouched({ type: 'help_call.sent' })).toBe(true)
  })
})

describe('hour by hour (MES-161)', () => {
  it('colours an hour’s bar by met, short or running, draws no bar for an hour to come, and the target only where set', () => {
    expect(hourRow(hour({}))).toEqual({ hour: '10:00', met: 0, short: 18, target: 24 })
    expect(hourRow(hour({ short: false, done: 26 }))).toEqual({ hour: '10:00', met: 26, short: 0, target: 24 })
    expect(hourRow(hour({ state: 'LATER', short: false, done: 0 }))).toEqual({ hour: '10:00', target: 24 })
    expect(hourRow(hour({ state: 'RUNNING', short: false, done: 7 }))).toEqual({ hour: '10:00', running: 7, target: 24 })
    expect(hourRow(hour({ target: null, short: false }))).toEqual({ hour: '10:00', met: 18, short: 0 })
  })

  it('lists the hours short or with a reason; a reason needs its code, "Other" its words', () => {
    const reason = { code: 'X', labelIt: '', labelEn: '', labelI18n: {}, icon: null, colour: null, note: null, at: '' }
    const line = { hours: [hour({ hour: 8 }), hour({ hour: 9, short: false }), hour({ hour: 10, short: false, reason })] } as never
    expect(shortHours(line).map((row) => row.hour)).toEqual([8, 10])
    const reasons = [{ code: 'BREAKDOWN', needsDetail: false }, { code: 'OTHER', needsDetail: true }] as never
    expect(reasonHeld(reasons, { code: '', note: '' })).toBe('reason.held.code')
    expect(reasonHeld(reasons, { code: 'OTHER', note: '  ' })).toBe('reason.held.note')
    expect(reasonHeld(reasons, { code: 'OTHER', note: 'A power cut' })).toBeNull()
    expect(reasonHeld(reasons, { code: 'BREAKDOWN', note: '' })).toBeNull()
  })

  it('says a refusal in the page’s words, with its fix', () => {
    expect(boardRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/HOUR_NOT_OVER' }, { path: 'fix' }]))).toEqual({ key: 'refusal.HOUR_NOT_OVER', fix: 'fix.HOUR_NOT_OVER' })
    expect(boardRefusal(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ key: 'refusal.STALE', fix: 'fix.STALE' })
    expect(boardRefusal(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('error.forbidden')
    expect(boardRefusal(new Error('no answer')).key).toBe('error.read')
  })
})

describe('a line’s targets (Set targets)', () => {
  const rows = targetDraft({
    line: { id: 'l', code: 'L1', name: 'L' },
    site: { id: 's', code: 'A1', name: 'A', timeZone: 'Europe/Rome' },
    day: '2026-10-29',
    today: '2026-10-29',
    past: false,
    total: 48,
    canSet: true,
    hours: [
      { hour: 8, label: '08:00–09:00', workingMinutes: 60, target: { id: 'a', targetPieces: 24, version: 3 }, reasonGiven: true },
      { hour: 9, label: '09:00–10:00', workingMinutes: 60, target: { id: 'b', targetPieces: 24, version: 1 }, reasonGiven: false },
      { hour: 10, label: '10:00–11:00', workingMinutes: 45, target: null, reasonGiven: false },
    ],
  })
  const edit = (hourOf: number, value: string): TargetDraftRow[] => rows.map((row) => (row.hour === hourOf ? { ...row, value } : row))

  it('sends only what changed, each at the version read; an empty row removes a target', () => {
    expect(targetChanges(rows)).toEqual([])
    expect(targetChanges(edit(9, '30'))).toEqual([{ hour: 9, targetPieces: 30, version: 1 }])
    expect(targetChanges(edit(9, ''))).toEqual([{ hour: 9, targetPieces: null, version: 1 }])
    expect(targetChanges(edit(10, '18'))).toEqual([{ hour: 10, targetPieces: 18 }])
    expect(targetsTotal(edit(10, '18'))).toBe(66)
  })

  it('holds Save with its reason: nothing changed, not a number, an hour with a reason going', () => {
    expect(targetsHeld(rows)).toBe('targets.held.nothing')
    expect(targetsHeld(edit(9, 'abc'))).toBe('targets.held.number')
    expect(targetsHeld(edit(9, '-1'))).toBe('targets.held.number')
    expect(targetsHeld(edit(8, ''))).toBe('targets.held.reasonGiven')
    expect(targetsHeld(edit(9, '30'))).toBeNull()
  })
})

describe('the heat map (MES-162)', () => {
  const cell = (code: string, bundles: number, pile = false) => ({ code, bundles, pieces: bundles * 9, stuck: 0, level: 'LOW' as const, pile })
  const map: HeatmapAnswer = {
    asOf: '',
    site: { id: 's', code: 'A1', name: 'A', timeZone: 'Europe/Rome' },
    columns: [
      { code: 'A', name: 'Preparation' },
      { code: 'B', name: 'Assembly' },
    ],
    rows: [
      { line: { id: 'l1', code: 'L1', name: 'One' }, bundles: 9, pieces: 81, stuck: 0, cells: [cell('A', 1), cell('B', 8, true)] },
      { line: null, bundles: 2, pieces: 18, stuck: 0, cells: [cell('A', 2), cell('B', 0)] },
    ],
    max: 8,
    stuckLimitHours: 4,
    capped: false,
  }

  it('gives the DS its arrays, outlines a pile and says it in words', () => {
    const grid = heatGrid(map, null)
    expect(grid.data).toEqual([[1, 8], [2, 0]])
    expect(grid.rowLabels).toEqual(['L1', ''])
    expect(grid.colTitles).toEqual(['Preparation', 'Assembly'])
    expect([...grid.marked]).toEqual(['0:1'])
    expect(grid.piles).toEqual([{ line: 'L1', operation: 'Assembly', bundles: 8 }])
  })

  it('shows only the picked line', () => {
    expect(heatGrid(map, 'l1').rows.map((row) => row.line?.code)).toEqual(['L1'])
    expect(heatGrid(map, 'nope').rows).toEqual([])
  })
})

describe('bundles and the line TV', () => {
  const row: TrackedBundle = { id: 'b1', code: 'B-1', siteId: 's', workOrder: { id: 'w', number: 'WO-1' }, size: '48', quantity: 9, place: 'LINE', next: null, operation: { code: 'A', name: 'Preparation' }, lastScan: { at: '', operation: { code: 'A', name: 'Preparation' }, station: { code: 'ST-1', name: 'One' } }, stuck: { stuck: true, workingHours: 6.5, limitHours: 4 } }

  it('says the last place, or nothing for a bundle never scanned', () => {
    expect(lastPlace(row)).toEqual({ operation: 'Preparation', station: 'ST-1' })
    expect(lastPlace({ ...row, lastScan: null, operation: null })).toEqual({ operation: null, station: null })
  })

  it('opens a bundle in its record, and never links a page not built yet', () => {
    expect(bundleHref('/w/A', row)).toContain('/w/A/')
    expect(bundleHref('/w/A', row)).toContain('b1')
    expect(bundlesHref('/w/A', '?stuck=true') === null || bundlesHref('/w/A', '?stuck=true') === '/w/A/production/bundles?stuck=true').toBe(true)
  })

  it('exports the picked rows as CSV, quoting every cell', () => {
    expect(stuckCsv([row], ['Bundle', 'Order', 'Size', 'Pieces', 'Place', 'Station', 'Hours'])).toBe('"Bundle";"Order";"Size";"Pieces";"Place";"Station";"Hours"\r\n"B-1";"WO-1";"48";"9";"Preparation";"ST-1";"6.5"')
  })

  it('opens the TV of the picked or only line; several lines: the person picks', () => {
    expect(lineTvHref('/w/A', 'l 1')).toBe('/w/A/production/floor/display?line=l%201')
    expect(tvLine([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b')
    expect(tvLine([{ id: 'a' }], null)).toBe('a')
    expect(tvLine([{ id: 'a' }, { id: 'b' }], null)).toBeNull()
    expect(tvLine(null, null)).toBeNull()
  })
})
