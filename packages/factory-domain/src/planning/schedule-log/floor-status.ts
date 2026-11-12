import { clockText } from '../../production/scans/rules'
import { openStretchOf, stretchesOf, type TimingRow } from '../../production/terminal/rules'

/**
 * The colour of a bar on the planning board from the floor (B-W2b-329; PLN-133 "Board status colours"; design planning.board
 * "Schedule": "Bars: … progress fill and colours (W2b): not started, running, paused, done"), pure. A bar books one operation
 * of a work order (a whole-order part: the operations its lane does); its state is what the floor's scans say now:
 *
 *   DONE         every garment is through the operation(s): nothing left there
 *   RUNNING      a bundle is being worked there now (an open stretch that runs: production/terminal's START or RESUME), or
 *                work is under way: garments are through it, more are left and nothing is paused (a site that finishes with
 *                one tap, Owner answer F3, never starts a stretch)
 *   PAUSED       bundles there are paused (an open stretch whose last row is a PAUSE) and none is being worked
 *   NOT_STARTED  no scan of any kind there yet
 *
 * The progress fill is the garments through it of the work order's garments (a part: those through every operation its lane
 * does). Per bar and work order only: the scans' workers and stations are read to tell their stretches apart, never shown,
 * counted or grouped (Statuto dei Lavoratori art. 4; Owner answers W1, F2). A pause says its reason's code, never who paused.
 */

export const FLOOR_STATES = ['NOT_STARTED', 'RUNNING', 'PAUSED', 'DONE'] as const
export type FloorState = (typeof FLOOR_STATES)[number]

/** A scan row of a bundle at an operation (any kind), as the timing reads it. */
export type FloorScanRow = TimingRow & { readonly bundleId: string }

/** One operation a bar books: its work order's garments, those still to do there, its scans. */
export interface FloorOperationFacts {
  readonly garments: number
  readonly remaining: number
  readonly rows: readonly FloorScanRow[]
}

export interface FloorStatus {
  readonly state: FloorState
  /** Garments through it (a part: through every operation of it), of the work order's (or the part's) garments. */
  readonly done: number
  readonly of: number
  /** Whole percent, rounded down (100 only when done). */
  readonly pct: number
  /** Bundles being worked there now, and bundles paused there now. */
  readonly runningBundles: number
  readonly pausedBundles: number
  /** RUNNING with a bundle worked now: since when the first of them runs; PAUSED: since the latest pause; else null. */
  readonly since: Date | null
  /** PAUSED: the latest pause's reason code (the PAUSE reason list's: never who paused). */
  readonly pauseReasonCode: string | null
  /** The last scan there (any kind). */
  readonly lastScanAt: Date | null
}

const byBundle = (rows: readonly FloorScanRow[]): Map<string, FloorScanRow[]> => {
  const out = new Map<string, FloorScanRow[]>()
  for (const row of rows) out.set(row.bundleId, [...(out.get(row.bundleId) ?? []), row])
  return out
}

/** The state of a bar booking these operations (one: a bar; several: a whole-order part), `of` its garments. */
export function floorStatusOf(operations: readonly FloorOperationFacts[], of?: number): FloorStatus {
  const total = Math.max(0, of ?? operations.reduce((most, operation) => Math.max(most, operation.garments), 0))
  // Garments through every operation of it: the operation with the least done sets it.
  const through = operations.length === 0 ? 0 : Math.min(...operations.map((operation) => Math.max(0, operation.garments - operation.remaining)))
  const done = Math.min(total, through)
  let running = 0
  let paused = 0
  let runningSince: Date | null = null
  let pausedSince: Date | null = null
  let pauseReasonCode: string | null = null
  let lastScanAt: Date | null = null
  for (const operation of operations) {
    for (const row of operation.rows) if (lastScanAt === null || row.serverTime > lastScanAt) lastScanAt = row.serverTime
    if (operation.remaining === 0) continue
    for (const rows of byBundle(operation.rows).values()) {
      const open = openStretchOf(stretchesOf(rows))
      if (!open) continue
      if (open.open === 'RUNNING') {
        running += 1
        const from = open.runs.find((run) => run.to === null)?.from ?? open.startedAt
        if (runningSince === null || from < runningSince) runningSince = from
      } else {
        paused += 1
        const pause = open.pauses.at(-1)
        if (pause && (pausedSince === null || pause.at > pausedSince)) {
          pausedSince = pause.at
          pauseReasonCode = pause.code || null
        }
      }
    }
  }
  const finished = operations.length > 0 && total > 0 && operations.every((operation) => operation.remaining === 0)
  const started = lastScanAt !== null || done > 0
  const state: FloorState = finished ? 'DONE' : running > 0 ? 'RUNNING' : paused > 0 ? 'PAUSED' : started ? 'RUNNING' : 'NOT_STARTED'
  const pct = total === 0 ? 0 : finished ? 100 : Math.min(99, Math.floor((done * 100) / total))
  return {
    state,
    done: finished ? total : done,
    of: total,
    pct,
    runningBundles: running,
    pausedBundles: paused,
    since: state === 'RUNNING' ? runningSince : state === 'PAUSED' ? pausedSince : null,
    pauseReasonCode: state === 'PAUSED' ? pauseReasonCode : null,
    lastScanAt,
  }
}

const garments = (count: number): string => `${count} garment${count === 1 ? '' : 's'}`
const bundles = (count: number): string => `${count} bundle${count === 1 ? '' : 's'}`

/** The state in words (English, for logs and the API's own callers; a screen says its own words from the codes and numbers). */
export function floorStatusWords(status: FloorStatus, timeZone: string): string {
  const progress = `${status.done} of ${garments(status.of)} done`
  switch (status.state) {
    case 'DONE':
      return `Done: ${status.of} of ${garments(status.of)}.`
    case 'NOT_STARTED':
      return `Not started: ${progress}.`
    case 'PAUSED':
      return `Paused${status.since ? ` since ${clockText(status.since, timeZone)}` : ''}${status.pauseReasonCode ? ` (${status.pauseReasonCode})` : ''}: ${progress}, ${bundles(status.pausedBundles)} paused.`
    default:
      return status.runningBundles > 0
        ? `Running: ${progress}, ${bundles(status.runningBundles)} being worked${status.since ? ` since ${clockText(status.since, timeZone)}` : ''}.`
        : `Under way: ${progress}; no bundle is being worked now.`
  }
}
