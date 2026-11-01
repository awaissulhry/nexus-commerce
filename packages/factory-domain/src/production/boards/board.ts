import type { FloorLook } from '../../auth/floor/literacy'
import type { StationCallState } from '../calls/rules'

/**
 * The line TV board (B-W2b-50; ANA-007, MES-166; design floor.display SCR-173 "Output today", "Stations", "Work in
 * progress", "Quality", "From the team leader"), pure: what the board says of a station, the line's DHU and the team
 * leader's note. Read-only, no one signed in, line totals only (Statuto dei Lavoratori art. 4; Owner answer F2): no name,
 * no output per station, no money (a display has no grain at all).
 *
 *   station   by colour, shape and word (MES-147: never colour alone): MACHINE_DOWN (a machine at it is down, under
 *             maintenance or not to be used) before CALLING (an open call nobody is on the way to) before COMING (someone
 *             is on the way) before CLEAR.
 *   DHU       defects per hundred units, of the line today, from what W1/W2a record (the plan's default for
 *             floor.display › Quality until the in-line checks of W2b-2 feed it): defects = the garments the line's
 *             stations sent to scrap or rework today (each scan line counts garments, so one defect a garment), units =
 *             the garments out of the line today and those scrapped; 100 × defects / units, one decimal; null when no
 *             unit was made.
 *   note      the team leader's words for the line: its latest handover note of the day (B-W2b-49 writes them), hidden
 *             when there is none (the design: "empty: Hidden"); topics as tiles, the text as written.
 */

export const STATION_BOARD_STATES = ['MACHINE_DOWN', 'CALLING', 'COMING', 'CLEAR'] as const
export type StationBoardState = (typeof STATION_BOARD_STATES)[number]

/** A shape beside the colour, so the state never rests on colour alone. */
export const BOARD_SHAPES = ['OCTAGON', 'TRIANGLE', 'CIRCLE', 'SQUARE'] as const
export type BoardShape = (typeof BOARD_SHAPES)[number]

export interface StationBoardLook extends FloorLook {
  readonly shape: BoardShape
}

export const STATION_BOARD_LOOKS: Readonly<Record<StationBoardState, StationBoardLook>> = Object.freeze({
  MACHINE_DOWN: { icon: 'alert-octagon', tone: 'danger', shape: 'OCTAGON' },
  CALLING: { icon: 'bell', tone: 'warning', shape: 'TRIANGLE' },
  COMING: { icon: 'user-check', tone: 'info', shape: 'CIRCLE' },
  CLEAR: { icon: 'check', tone: 'success', shape: 'SQUARE' },
})

/** The statuses of a machine that is down for the board (plant's Machine.status). */
export const MACHINE_DOWN_STATUSES = ['DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const

export function stationBoardState(input: { readonly call: StationCallState; readonly machineDown: boolean }): StationBoardState {
  if (input.machineDown) return 'MACHINE_DOWN'
  if (input.call === 'CALLING') return 'CALLING'
  if (input.call === 'COMING') return 'COMING'
  return 'CLEAR'
}

export interface LineQuality {
  readonly defects: number
  readonly units: number
  /** Defects per hundred units, one decimal (a string, as every decimal the API sends); null without units. */
  readonly dhu: string | null
}

export function lineQuality(day: { readonly good: number; readonly scrap: number; readonly rework: number }): LineQuality {
  const defects = Math.max(0, day.scrap) + Math.max(0, day.rework)
  const units = Math.max(0, day.good) + Math.max(0, day.scrap)
  if (units === 0) return { defects, units, dhu: null }
  return { defects, units, dhu: (Math.round((defects * 1000) / units) / 10).toFixed(1) }
}

export interface NoteCandidate {
  readonly shiftLabel: string
  readonly topics: readonly string[]
  readonly text: string | null
  readonly updatedAt: Date
}

/** The note the board shows: the latest of the day's notes that says something (a topic or words), else none. */
export function boardNoteOf<Note extends NoteCandidate>(notes: readonly Note[]): Note | null {
  const said = notes.filter((note) => note.topics.length > 0 || (note.text ?? '').trim() !== '')
  if (said.length === 0) return null
  return [...said].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!
}
