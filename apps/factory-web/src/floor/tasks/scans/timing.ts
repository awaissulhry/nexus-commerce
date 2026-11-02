/**
 * Start, pause, finish on SCR-090 (design floor.operation "Start, pause, finish"; MES-087 start, -088 pause, -089 resume,
 * -091 hand back, -092 pieces so far; Owner answer F3): the work in hand's own clock, as `GET /production/terminal/state`
 * answers it, and what the tablet knows after an action queued offline. Pure, so the tests hold it. Finish is never one of
 * these: a report needs no Start and stays one tap. No pace or target anywhere (Statuto dei Lavoratori art. 4): the
 * operator sees the clock of the bundle in hand, nothing else.
 */

export const TIMING_KINDS = ['START', 'PAUSE', 'RESUME', 'HAND_BACK', 'PARTIAL'] as const
export type TimingKind = (typeof TIMING_KINDS)[number]
export type TimingState = 'NOT_STARTED' | 'RUNNING' | 'PAUSED' | 'REPORTED'

export interface Timing {
  readonly state: TimingState
  /** The open work is the viewer's (at a station site: this station's). */
  readonly mine: boolean
  readonly startedAt: string | null
  readonly runningSince: string | null
  readonly secondsBefore: number
  readonly pausedAt: string | null
  readonly pauseReasonCode: string | null
  readonly pausedAtClockOut: boolean
  readonly piecesSoFar: number
  readonly people: number
  readonly actions: readonly TimingKind[]
}

export const NOT_STARTED: Timing = Object.freeze({ state: 'NOT_STARTED', mine: false, startedAt: null, runningSince: null, secondsBefore: 0, pausedAt: null, pauseReasonCode: null, pausedAtClockOut: false, piecesSoFar: 0, people: 1, actions: Object.freeze(['START']) as readonly TimingKind[] })

/** Which action bar the bundle's timing asks for. */
export type TimingBar = 'start' | 'running' | 'paused' | 'other'

export function barOf(timing: Timing | null): TimingBar {
  if (!timing) return 'start'
  if (timing.state === 'NOT_STARTED') return timing.actions.includes('START') ? 'start' : 'other'
  if (!timing.mine) return 'other'
  if (timing.state === 'RUNNING') return 'running'
  if (timing.state === 'PAUSED') return 'paused'
  return 'other'
}

/** The bundle's clock for the DS FloorElapsed: `since` is the running part on the tablet's clock (`skewMs` = tablet − server). */
export function clockOf(timing: Timing, skewMs: number): { readonly since: number | null; readonly carriedMs: number; readonly paused: boolean } {
  const paused = timing.state === 'PAUSED' || timing.runningSince === null
  return { since: paused ? null : Date.parse(timing.runningSince!) + skewMs, carriedMs: timing.secondsBefore * 1000, paused }
}

/** How far the tablet's clock is from the server's, from one answer's server time (ms). */
export const skewOf = (serverTime: string, now: Date): number => now.getTime() - Date.parse(serverTime)

// ---- what the tablet knows after an action it queued (offline: the answer comes later) --------------------------------------

export function afterStart(timing: Timing | null, at: Date, people = 1): Timing {
  const base = timing ?? NOT_STARTED
  return { ...base, state: 'RUNNING', mine: true, startedAt: base.startedAt ?? at.toISOString(), runningSince: at.toISOString(), pausedAt: null, pauseReasonCode: null, pausedAtClockOut: false, people, actions: ['PAUSE', 'PARTIAL', 'HAND_BACK'] }
}

export function afterPause(timing: Timing, reasonCode: string, at: Date): Timing {
  const ran = timing.runningSince ? Math.max(0, Math.round((at.getTime() - Date.parse(timing.runningSince)) / 1000)) : 0
  return { ...timing, state: 'PAUSED', runningSince: null, secondsBefore: timing.secondsBefore + ran, pausedAt: at.toISOString(), pauseReasonCode: reasonCode, actions: ['RESUME', 'PARTIAL', 'HAND_BACK'] }
}

export function afterResume(timing: Timing, at: Date): Timing {
  return { ...timing, state: 'RUNNING', runningSince: at.toISOString(), pausedAt: null, pauseReasonCode: null, pausedAtClockOut: false, actions: ['PAUSE', 'PARTIAL', 'HAND_BACK'] }
}

/**
 * The most "pieces so far" may say (MES-092: with earlier ones fewer than the bundle's garments: the last piece is the
 * report's), and the least (one). 0: nothing to report so far.
 */
export function piecesLeft(quantity: number, timing: Timing | null): number {
  return Math.max(0, quantity - (timing?.piecesSoFar ?? 0) - 1)
}

// ---- open work (Home's "Unfinished on this tablet", the scan step's Continue) ------------------------------------------------

export interface OpenItem {
  readonly bundleId: string
  readonly bundleCode: string
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly state: TimingState
  readonly pausedAt: string | null
  readonly runningSince: string | null
  readonly pausedAtClockOut: boolean
}

/** Paused work comes back as "Paused: B-000123 at Op 30 since 11:58"; what still runs as "Running". REPORTED never comes. */
export function resumeRows(items: readonly OpenItem[]): readonly OpenItem[] {
  return items.filter((item) => item.state === 'RUNNING' || item.state === 'PAUSED')
}
