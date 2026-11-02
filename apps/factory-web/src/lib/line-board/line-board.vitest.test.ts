import { describe, expect, it } from 'vitest'
import { STATION_BOARD_LOOKS } from '@nexus/factory-domain/production/boards/board'
import { ApiError } from '../api/errors'
import { BOARD, EMPTY_BOARD } from './fixtures'
import { BOARD_VIEWS, boardNoteLines, boardProblemOf, hourBars, isStale, POLL_MS, reasonWords, ROTATE_MS, STALE_MS, stepView, waitingOperations } from './model'
import { boardSchema } from './schema'

describe('the line TV board (SCR-173): three views turning, a stale board says so', () => {
  it('turns every 20 s through the three views, round and round, reading every 10 s, stale after 60 s', () => {
    expect([ROTATE_MS, POLL_MS, STALE_MS]).toEqual([20_000, 10_000, 60_000])
    expect(BOARD_VIEWS).toEqual(['output', 'stations', 'wip'])
    expect([stepView(0, 1), stepView(2, 1), stepView(0, -1)]).toEqual([1, 0, 2])
  })

  it('is stale only after a good read a minute ago; a board that never read has nothing to be stale about', () => {
    expect(isStale(null, 1_000_000)).toBe(false)
    expect(isStale(1_000_000, 1_000_000 + STALE_MS - 1)).toBe(false)
    expect(isStale(1_000_000, 1_000_000 + STALE_MS)).toBe(true)
  })

  it('says why there is no board from what the API refused', () => {
    const refused = (code: string) => new ApiError('conflict', 409, 'conflict', 'refused', null, [{ path: `refusal/${code}` }])
    expect(boardProblemOf(refused('NOT_A_BOARD'))).toBe('notABoard')
    expect(boardProblemOf(refused('NO_LINE'))).toBe('noLine')
    expect(boardProblemOf(new ApiError('signed_out', 401, 'unauthenticated', 'gone'))).toBe('signedOut')
    expect(boardProblemOf(new ApiError('forbidden', 403, 'forbidden', 'no'))).toBe('noAccess')
    expect(boardProblemOf(new ApiError('not_found', 404, 'not_found', 'no'))).toBe('noAccess')
    expect(boardProblemOf(new ApiError('unavailable', 503, 'unavailable', 'later'))).toBe('offline')
    expect(boardProblemOf(new Error('network'))).toBe('offline')
  })
})

describe('what the board draws', () => {
  it('puts the bars and the hourly target on one scale; a short hour keeps its reason code', () => {
    const bars = hourBars(BOARD.output.hours)
    expect(bars).toHaveLength(BOARD.output.hours.length)
    expect(bars[1]).toMatchObject({ tick: '07', donePct: 100, targetPct: 96 })
    expect(bars[2]).toMatchObject({ short: true, done: 16, target: 24, reason: { code: 'BREAKDOWN' } })
    expect(hourBars(EMPTY_BOARD.output.hours)).toEqual([])
    expect(hourBars([{ hour: 8, label: '08:00–09:00', state: 'OVER', done: 0, targetPieces: null, short: false, reason: null }])[0]).toMatchObject({ donePct: 0, targetPct: null })
  })

  it('speaks a reason in the screen’s language, and shows the operations with bundles, most first', () => {
    const reason = BOARD.output.hours[2]!.reason!
    expect(reasonWords(reason, 'it')).toBe('Guasto macchina')
    expect(reasonWords(reason, 'en')).toBe('Machine breakdown')
    expect(reasonWords({ ...reason, labelI18n: {} }, 'en')).toBe('Machine breakdown')
    expect(waitingOperations(BOARD.wip.operations).map((row) => row.code)).toEqual(['CUC-ASS', 'RIF', 'CUC-PRE'])
  })

  it('shows a note’s words as written, and an empty text as none', () => {
    expect(boardNoteLines(BOARD.note!)).toEqual({ topics: ['MATERIAL', 'QUALITY'], text: BOARD.note!.text })
    expect(boardNoteLines({ ...BOARD.note!, topics: ['MACHINES', 'NOT_A_TOPIC'] }).topics).toEqual(['MACHINES'])
    expect(boardNoteLines({ ...BOARD.note!, text: '   ' }).text).toBeNull()
  })

  it('holds the made-up board to the API’s shape, every look to the domain’s, and names nobody', () => {
    expect(boardSchema.parse(BOARD)).toEqual(BOARD)
    for (const station of BOARD.stations) expect(station.look).toMatchObject(STATION_BOARD_LOOKS[station.state])
    expect(JSON.stringify(BOARD)).not.toMatch(/worker|operator|employee|person/i)
  })
})
