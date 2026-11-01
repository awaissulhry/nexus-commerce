import { describe, expect, it } from 'vitest'
import {
  CLOCK_OUT_PAUSE,
  clockOutWarning,
  continueWords,
  isReported,
  minutesText,
  openOperationFor,
  openStretchOf,
  pauseReasonRefusal,
  piecesRefusal,
  piecesSoFarOf,
  qualificationRefusal,
  secondsSoFar,
  stretchesOf,
  teamMembers,
  teamRefusal,
  timedOfRow,
  timingRefusal,
  timingViewOf,
  type TimingRow,
} from './rules'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 … MES-094, MES-117): the stretches of a bundle at an operation from
 * its rows, the screen's state, the refusals in words. Made-up ids and times. The law: Statuto dei Lavoratori art. 4 —
 * nothing here groups or totals by person; another person's work is "another person".
 */

const T0 = new Date('2026-11-17T08:00:00.000Z')
const min = (n: number) => new Date(T0.getTime() + n * 60_000)
const ANNA = 'worker-anna'
const BRUNO = 'worker-bruno'
const SEW1 = 'station-sew-1'
let serial = 0
const row = (kind: string, minute: number, extra: Partial<TimingRow> = {}): TimingRow => ({
  id: `scan-${String(++serial).padStart(4, '0')}`,
  kind,
  correctsId: null,
  goodQuantity: 0,
  scrapQuantity: 0,
  reworkQuantity: 0,
  pauseReasonCode: kind === 'PAUSE' ? 'MATERIAL_WAIT' : null,
  workerId: ANNA,
  stationId: SEW1,
  deviceId: 'tablet-1',
  deviceTime: null,
  serverTime: min(minute),
  ...extra,
})
const place = { bundleCode: 'B-000123', operation: { seq: 30, name: 'Sew' } }
const anna = { workerId: ANNA, stationId: SEW1 }

describe('stretches of a bundle at an operation', () => {
  it('start, pause with a reason, resume and the report: the minutes leave the pause out (MES-087, -088, -089)', () => {
    const rows = [row('START', 0), row('PAUSE', 10), row('RESUME', 25), row('REPORT', 40, { goodQuantity: 20 })]
    const [stretch] = stretchesOf(rows)
    expect(stretch!.open).toBeNull()
    expect(stretch!.secondsClosed).toBe(25 * 60)
    expect(stretch!.pauses).toEqual([{ scanId: rows[1]!.id, code: 'MATERIAL_WAIT', at: min(10), to: min(25), seconds: 15 * 60 }])
    expect(stretch!.closedBy).toEqual({ scanId: rows[3]!.id, kind: 'REPORT', at: min(40) })
    expect(timedOfRow([stretch!], rows[3]!.id)).toEqual({ seconds: 1500, personSeconds: 1500, runs: 2, pauses: 1 })
    expect(minutesText(1500)).toBe('25.00')
    expect(minutesText(90)).toBe('1.50')
  })

  it('a one-tap report closes no stretch (F3: finishing needs no start)', () => {
    const rows = [row('REPORT', 5, { goodQuantity: 20 })]
    expect(stretchesOf(rows)).toEqual([])
    expect(timedOfRow([], rows[0]!.id)).toBeNull()
    expect(isReported(rows)).toBe(true)
  })

  it('a team counts once per member; the minutes are the stretch’s, never grouped by person (MES-094)', () => {
    const start = row('START', 0)
    const rows = [start, row('PARTIAL', 30, { goodQuantity: 8 })]
    const stretches = stretchesOf(rows, new Map([[start.id, [ANNA, BRUNO, 'worker-carla']]]))
    expect(stretches[0]!.secondsClosed).toBe(1800)
    expect(stretches[0]!.personSecondsClosed).toBe(5400)
    expect(piecesSoFarOf(rows)).toBe(8)
  })

  it('the tablet’s time counts when it can be believed (offline work), else the server’s', () => {
    const rows = [row('START', 30, { deviceTime: min(0) }), row('HAND_BACK', 31, { deviceTime: min(12) })]
    expect(stretchesOf(rows)[0]!.secondsClosed).toBe(12 * 60)
    // A tablet clock an hour ahead of the server is not believed: the server's time counts.
    const ahead = [row('START', 0, { deviceTime: min(60) }), row('HAND_BACK', 5)]
    expect(stretchesOf(ahead)[0]!.secondsClosed).toBe(5 * 60)
  })

  it('a stretch handed back is closed and keeps its time; anyone may start again (MES-091)', () => {
    const rows = [row('START', 0), row('HAND_BACK', 20), row('START', 30, { workerId: BRUNO }), row('PAUSE', 35, { workerId: BRUNO })]
    const stretches = stretchesOf(rows)
    expect(stretches.map((stretch) => [stretch.workerId, stretch.secondsClosed, stretch.open])).toEqual([
      [ANNA, 1200, null],
      [BRUNO, 300, 'PAUSED'],
    ])
    expect(openStretchOf(stretches)?.workerId).toBe(BRUNO)
    expect(secondsSoFar(openStretchOf(stretches)!, min(50)).seconds).toBe(300)
  })
})

describe('what the operation screen shows (no pace, no target)', () => {
  it('not started → Start; running → Pause, Not all good, Hand back; paused → Resume', () => {
    expect(timingViewOf([], anna)).toMatchObject({ state: 'NOT_STARTED', actions: ['START'], mine: false })
    const running = [row('START', 0), row('PAUSE', 5), row('RESUME', 8)]
    expect(timingViewOf(running, anna)).toMatchObject({ state: 'RUNNING', mine: true, runningSince: min(8), secondsBefore: 300, actions: ['PAUSE', 'PARTIAL', 'HAND_BACK'] })
    const paused = [row('START', 0), row('PAUSE', 5, { pauseReasonCode: CLOCK_OUT_PAUSE })]
    expect(timingViewOf(paused, anna)).toMatchObject({ state: 'PAUSED', pausedAtClockOut: true, pauseReasonCode: CLOCK_OUT_PAUSE, actions: ['RESUME', 'PARTIAL', 'HAND_BACK'] })
    expect(timingViewOf([row('REPORT', 3, { goodQuantity: 1 })], anna)).toMatchObject({ state: 'REPORTED', actions: [] })
  })

  it('another person’s open work offers nothing and names nobody', () => {
    const view = timingViewOf([row('START', 0, { workerId: BRUNO })], anna)
    expect(view).toMatchObject({ state: 'RUNNING', mine: false, actions: [] })
    expect(JSON.stringify(view)).not.toContain(BRUNO)
  })
})

describe('refusals in words', () => {
  const facts = (rows: TimingRow[], subject = anna) => ({ rows, subject, place, scanSubject: 'WORKER' as const })

  it('start while work is open: your own running or paused, or another person’s', () => {
    expect(timingRefusal('START', facts([]))).toBeNull()
    expect(timingRefusal('START', facts([row('START', 0)]))?.code).toBe('ALREADY_RUNNING')
    expect(timingRefusal('START', facts([row('START', 0), row('PAUSE', 1)]))?.code).toBe('PAUSED_RESUME')
    const other = timingRefusal('START', facts([row('START', 0, { workerId: BRUNO })]))!
    expect(other.code).toBe('OPEN_BY_OTHER')
    expect(other.message).toContain('Another person')
    expect(other.message).not.toContain(BRUNO)
    expect(other.final).toBe(false)
  })

  it('pause, resume, hand back and pieces so far need one’s own open work', () => {
    expect(timingRefusal('PAUSE', facts([]))?.code).toBe('NOT_STARTED')
    expect(timingRefusal('PAUSE', facts([row('START', 0), row('PAUSE', 1)]))?.code).toBe('ALREADY_PAUSED')
    expect(timingRefusal('RESUME', facts([row('START', 0)]))?.code).toBe('ALREADY_RUNNING')
    expect(timingRefusal('HAND_BACK', facts([row('START', 0, { workerId: BRUNO })]))?.code).toBe('OPEN_BY_OTHER')
    expect(timingRefusal('PARTIAL', facts([row('START', 0), row('PAUSE', 1)]))).toBeNull()
    expect(timingRefusal('RESUME', facts([row('START', 0), row('HAND_BACK', 1)]))?.code).toBe('NOT_STARTED')
  })

  it('a station-only site speaks of the station', () => {
    const station = { workerId: null, stationId: SEW1 }
    const refusal = timingRefusal('START', { rows: [row('START', 0, { workerId: null })], subject: station, place, scanSubject: 'STATION' })!
    expect(refusal.code).toBe('ALREADY_RUNNING')
    expect(refusal.message).toMatch(/^This station/)
  })

  it('pieces so far: from 1, the earlier ones too below the bundle (MES-092)', () => {
    expect(piecesRefusal(0, { earlier: 0, bundleQuantity: 20, place })?.code).toBe('NO_PIECES')
    expect(piecesRefusal(19, { earlier: 0, bundleQuantity: 20, place })).toBeNull()
    expect(piecesRefusal(12, { earlier: 8, bundleQuantity: 20, place })?.message).toContain('at most 11 more')
    expect(piecesRefusal(1, { earlier: 19, bundleQuantity: 20, place })?.code).toBe('PIECES_TOO_MANY')
  })

  it('a pause reason is an active code of the PAUSE list, never the system’s own (MES-088)', () => {
    expect(pauseReasonRefusal('MATERIAL_WAIT', { active: true, needsDetail: false }, null)).toBeNull()
    expect(pauseReasonRefusal('OTHER', { active: true, needsDetail: true }, null)?.code).toBe('NOTE_NEEDED')
    expect(pauseReasonRefusal('OTHER', { active: true, needsDetail: true }, 'Needle broke')).toBeNull()
    expect(pauseReasonRefusal('OLD', { active: false, needsDetail: false }, null)?.code).toBe('PAUSE_REASON_UNKNOWN')
    expect(pauseReasonRefusal(CLOCK_OUT_PAUSE, { active: true, needsDetail: false }, null)?.code).toBe('PAUSE_REASON_SYSTEM')
  })

  it('a team is the tablet’s crew, at most four, each with the notice acknowledged; never at a station-only site (MES-094)', () => {
    const base = { scanSubject: 'WORKER' as const, crew: [ANNA, BRUNO], acknowledged: new Set([ANNA, BRUNO]) }
    expect(teamRefusal({ ...base, asked: [] })).toBeNull()
    expect(teamRefusal({ ...base, asked: teamMembers([BRUNO], ANNA) })).toBeNull()
    expect(teamMembers([BRUNO, ANNA, BRUNO], ANNA)).toEqual([ANNA, BRUNO])
    expect(teamRefusal({ ...base, asked: [ANNA, 'worker-dario'] })?.code).toBe('TEAM_NOT_IN_CREW')
    expect(teamRefusal({ ...base, acknowledged: new Set([ANNA]), asked: [ANNA, BRUNO] })?.code).toBe('TEAM_NOTICE')
    expect(teamRefusal({ ...base, scanSubject: 'STATION', asked: [ANNA, BRUNO] })?.code).toBe('TEAM_AT_STATION_SITE')
    expect(teamRefusal({ ...base, asked: ['a', 'b', 'c', 'd', 'e'] })?.code).toBe('TEAM_TOO_LARGE')
  })

  it('which open operation a pause or resume means; one bundle at a time', () => {
    const sew = { id: 'op-30', seq: 30, name: 'Sew' }
    const press = { id: 'op-40', seq: 40, name: 'Press' }
    expect(openOperationFor('PAUSE', [{ operation: sew, state: 'RUNNING' }, { operation: press, state: 'PAUSED' }], 'B-1')).toEqual({ ok: true, operation: sew })
    expect(openOperationFor('RESUME', [{ operation: sew, state: 'RUNNING' }, { operation: press, state: 'PAUSED' }], 'B-1')).toEqual({ ok: true, operation: press })
    const both = openOperationFor('HAND_BACK', [{ operation: sew, state: 'RUNNING' }, { operation: press, state: 'PAUSED' }], 'B-1')
    expect(both.ok ? null : both.refusal.code).toBe('CHOOSE_OPERATION')
    const none = openOperationFor('PAUSE', [], 'B-1')
    expect(none.ok ? null : none.refusal.code).toBe('NOT_STARTED')
  })

  it('the qualification check at the start: a skill hold is the team leader’s to override, an authorisation never (B-W2b-39)', () => {
    expect(qualificationRefusal({ mode: 'WARN', overridable: true, message: 'm', fix: 'f' })).toBeNull()
    expect(qualificationRefusal({ mode: 'STRICT', overridable: true, message: 'Not qualified.', fix: 'Ask.' })).toMatchObject({ code: 'NOT_QUALIFIED', final: false })
    expect(qualificationRefusal({ mode: 'STRICT', overridable: true, message: 'Not qualified.', fix: 'Ask.' })!.fix).toContain('team leader')
    expect(qualificationRefusal({ mode: 'STRICT', overridable: false, message: 'Not authorised.', fix: 'Ask.' })?.code).toBe('NOT_AUTHORISED')
  })
})

describe('words for the clock-out and the next sign-in (MES-117)', () => {
  it('says what a clock-out pauses and offers to continue', () => {
    expect(clockOutWarning([])).toBeNull()
    expect(clockOutWarning([place])).toBe('Your open bundle B-000123 will be paused.')
    expect(continueWords(place)).toBe('Continue bundle B-000123 at Op 30?')
  })
})
