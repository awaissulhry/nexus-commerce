import type { ScanRead } from '../../scan/scan-model'
import { codeKey } from '../shared/as-of'
import type { TickState } from '../shared/view/TaskParts'

/**
 * Count on the floor (SCR-178, B-W2b-310 on B-W2b-299's API; design floor.count; SCM-228), as rules without a screen or a
 * network: what to count (the site's running counts' bins), the bin scanned (its lines, blind: never the expected quantity
 * before Bin done), what a scanned unit is on the bin (a hide's tag counts its area, a roll's tag its length, a lot's label or a
 * material without a label asks its quantity on the pad), the big numeral (units scanned in the bin), the units kept on this
 * tablet while it is offline, the differences after Bin done with their tones, and the words a refusal needs. Quantities are
 * the API's decimal text in the item's base unit: shown and compared, never valued (no money on the floor). Pure, so the tests
 * hold them.
 */

export const COUNT_PASSES = ['COUNT', 'RECOUNT'] as const
export type CountPass = (typeof COUNT_PASSES)[number]

export interface CountRef {
  readonly id: string
  readonly number: string
  /** CYCLE, YEAR_END … (factory-domain inventory/counts STOCK_COUNT_KINDS). */
  readonly kind: string
  readonly status: string
  /** Moves of its lines wait until each is counted (SCM-226). */
  readonly freezeMoves: boolean
}

export interface CountPlace {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly labelCode: string | null
}

/** A row of "What to count": a bin of a running count with lines to count (or to recount). */
export interface ToCountBin {
  readonly count: CountRef
  readonly location: CountPlace
  readonly kind: CountPass
  readonly lines: number
  readonly since: string
  /** A recount this person may not do (they counted it): shown, never offered. */
  readonly yours: boolean
}

export interface ToCount {
  readonly asOf: string
  readonly bins: readonly ToCountBin[]
}

export interface BinLine {
  readonly lineId: string
  readonly seq: number
  /** SNAPSHOT: what the bin held at the start; ADDED: a unit found that was not expected. */
  readonly origin: 'SNAPSHOT' | 'ADDED'
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly uom: string; readonly tracking: string }
  readonly lot: { readonly id: string; readonly code: string } | null
  readonly hide: { readonly id: string; readonly code: string } | null
  /** The pass it is scanned in now; null: counted (finished). */
  readonly pass: CountPass | null
  readonly scans: number
  readonly scanned: string
}

/** A bin scanned: the running counts that count it, the one counted here, its lines (blind). */
export interface BinRead {
  readonly location: CountPlace
  readonly counts: readonly CountRef[]
  readonly count: CountRef | null
  readonly lines: readonly BinLine[]
}

export interface ScanAnswer {
  readonly scanId: string
  readonly count: CountRef
  readonly line: BinLine
  /** The unit was not expected in this bin: its line was added. */
  readonly added: boolean
  readonly quantity: string
}

export const DIFFERENCE_KINDS = ['MATCH', 'MISSING', 'EXTRA', 'SHORT', 'OVER'] as const
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number]

export interface Difference {
  readonly lineId: string
  readonly seq: number
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly uom: string }
  readonly lot: { readonly id: string; readonly code: string } | null
  readonly hide: { readonly id: string; readonly code: string } | null
  readonly pass: CountPass
  readonly expected: string
  readonly scanned: string
  readonly scans: number
  readonly difference: string
  readonly kind: DifferenceKind
}

export interface BinDone {
  readonly count: CountRef
  readonly location: CountPlace
  readonly differences: readonly Difference[]
  /** "No difference." */
  readonly none: boolean
  /** Moves into or out of the bin since the count started (a note on the differences step). */
  readonly movedSinceStart: number
  readonly note: { readonly en: string; readonly it: string } | null
}

export interface Finished {
  readonly count: CountRef
  readonly location: CountPlace
  readonly differences: readonly Difference[]
  /** The lines another person recounts (the recount rule asked them now). */
  readonly recountsAsked: readonly { readonly lineId: string; readonly seq: number }[]
  readonly lines: number
  readonly counted: number
}

// ---- numbers -----------------------------------------------------------------------------------------------------------

export const num = (value: string | number | null | undefined): number => {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Count units are whole; length, area, mass and volume take two decimals on the pad. */
const COUNT_UOMS = new Set(['PCS', 'PAIR', 'SET', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'])
export const decimalsOf = (uom: string | null | undefined): number => (uom && COUNT_UOMS.has(uom) ? 0 : 2)

/** A pad number as the API's decimal text (at most four decimals). */
export const quantityText = (value: number, decimals: number): string => value.toFixed(Math.max(0, Math.min(4, decimals)))

// ---- what to count -------------------------------------------------------------------------------------------------------

/** The rows the person may open (a recount of their own count is shown, never offered), recounts first as the API sends them. */
export const openBins = (toCount: ToCount | null): readonly ToCountBin[] => (toCount ? toCount.bins.filter((bin) => !bin.yours) : [])

/** The label a bin is scanned by (its label code, else its code). */
export const placeCodeOf = (place: Pick<CountPlace, 'code' | 'labelCode'>): string => place.labelCode ?? place.code

const sameCode = (a: string | null | undefined, b: string) => a !== null && a !== undefined && codeKey(a) === codeKey(b)

/** A row of "What to count" a scanned bin label names (offline: what the tablet read), or null. */
export function binOfCode(toCount: ToCount | null, code: string): ToCountBin | null {
  return openBins(toCount).find((bin) => sameCode(bin.location.labelCode, code) || sameCode(bin.location.code, code)) ?? null
}

/** A bin with nothing left to count in it: every line counted (the office asks a recount to count it again). */
export const binCounted = (bin: Pick<BinRead, 'lines'>): boolean => bin.lines.length > 0 && bin.lines.every((line) => line.pass === null)

/** The pass a bin is counted in: a recount when any line is recounted, else the count. */
export const passOf = (bin: Pick<BinRead, 'lines'>): CountPass => (bin.lines.some((line) => line.pass === 'RECOUNT') ? 'RECOUNT' : 'COUNT')

// ---- scan every unit -------------------------------------------------------------------------------------------------------

/** A unit scanned while the tablet is offline: kept in its queue, counted here until the office's answer comes. */
export interface KeptUnit {
  readonly clientEventId: string
  readonly code: string | null
  /** The line it counts on this tablet's copy of the bin (null: none the tablet knows: the office matches it). */
  readonly lineId: string | null
  readonly quantity: string | null
}

/** The big numeral: units scanned in the bin, in the pass each line is counted in, plus what this tablet keeps. */
export function unitsScanned(bin: Pick<BinRead, 'lines'> | null, kept: readonly KeptUnit[] = []): number {
  return (bin?.lines ?? []).reduce((sum, line) => sum + (line.pass === null ? 0 : line.scans), 0) + kept.length
}

/** A line's units and quantity with this tablet's kept units added (offline). */
export function lineTally(line: BinLine, kept: readonly KeptUnit[]): { scans: number; scanned: number; kept: number } {
  const mine = kept.filter((unit) => unit.lineId === line.lineId)
  return { scans: line.scans + mine.length, scanned: num(line.scanned) + mine.reduce((sum, unit) => sum + num(unit.quantity), 0), kept: mine.length }
}

export type ScannedUnit =
  /** A hide's tag (its area), a roll's or a remnant's (their length, area): counted by the scan, 0 taps. */
  | { readonly kind: 'tag'; readonly code: string; readonly line: BinLine | null }
  /** A lot's label: its quantity first, on the pad. */
  | { readonly kind: 'quantity'; readonly code: string; readonly line: BinLine }
  /** Nothing the bin's lines name: the office decides (a unit found here, or a refusal in words). */
  | { readonly kind: 'ask'; readonly code: string }

/**
 * What a code scanned into a bin is. A hide, roll or remnant tag counts by its scan. A lot's label on a line counted by quantity
 * asks how much it holds. Anything else goes to the office as scanned: a unit found that was not expected is added as its own
 * line, a lot label the bin does not know asks its quantity in the answer (the pad then opens), an unknown label is refused.
 */
export function unitOfScan(bin: Pick<BinRead, 'lines'>, read: ScanRead): ScannedUnit {
  const code = read.code
  const open = bin.lines.filter((line) => line.pass !== null)
  const byHide = open.find((line) => sameCode(line.hide?.code, code)) ?? bin.lines.find((line) => sameCode(line.hide?.code, code)) ?? null
  if (byHide || (read.kind === 'label' && (read.type === 'hide' || read.type === 'roll' || read.type === 'remnant'))) return { kind: 'tag', code, line: byHide }
  const byLot = open.find((line) => line.hide === null && sameCode(line.lot?.code, code))
  if (byLot) return { kind: 'quantity', code, line: byLot }
  return { kind: 'ask', code }
}

/** The lines the number pad may count: not counted yet, without a tag of their own (a hide is counted by its tag). */
export const padLines = (bin: Pick<BinRead, 'lines'>): readonly BinLine[] => bin.lines.filter((line) => line.pass !== null && line.hide === null)

/** What the pad counts: a line (an item without a label) or a lot's label (its quantity), in its unit. */
export type PadTarget =
  | { readonly kind: 'line'; readonly lineId: string; readonly uom: string }
  | { readonly kind: 'code'; readonly code: string; readonly lineId: string | null; readonly uom: string | null }

export interface CountPad {
  readonly target: PadTarget
  readonly value: number | null
}

export interface PadBounds {
  readonly min: number
  readonly decimals: number
}

/** The pad's bounds: more than nothing, in the unit's steps (a count has no upper bound: what is there is there). */
export function padBounds(uom: string | null | undefined): PadBounds {
  const decimals = decimalsOf(uom)
  return { min: 1 / 10 ** decimals, decimals }
}

/** The bin after a unit's answer: its line replaced (or added, for a unit not expected here). */
export function withLine(bin: BinRead, line: BinLine): BinRead {
  const found = bin.lines.some((entry) => entry.lineId === line.lineId)
  return { ...bin, lines: found ? bin.lines.map((entry) => (entry.lineId === line.lineId ? line : entry)) : [...bin.lines, line] }
}

/** The last unit, as the strip under the scan field shows it (the two ticks; amber for one counted already). */
export type CountLast =
  | { readonly kind: 'counted'; readonly code: string | null; readonly item: string; readonly quantity: string; readonly uom: string; readonly added: boolean; readonly ticks: TickState; readonly clientEventId: string | null }
  | { readonly kind: 'kept'; readonly code: string | null; readonly item: string | null; readonly quantity: string | null; readonly uom: string | null; readonly ticks: TickState; readonly clientEventId: string }
  | { readonly kind: 'already'; readonly code: string }

// ---- differences --------------------------------------------------------------------------------------------------------

/** Missing and extra units are the count's real news; a short or an over lot is a difference too; a match is fine. */
export const DIFFERENCE_TONE: Readonly<Record<DifferenceKind, 'danger' | 'warning' | 'success'>> = {
  MISSING: 'danger',
  EXTRA: 'warning',
  SHORT: 'warning',
  OVER: 'warning',
  MATCH: 'success',
}

/** The differences first (missing, extra, short, over), then what matches, each in the bin's line order. */
const DIFFERENCE_ORDER: readonly DifferenceKind[] = ['MISSING', 'EXTRA', 'SHORT', 'OVER', 'MATCH']

export function differenceRows(differences: readonly Difference[]): { readonly differ: readonly Difference[]; readonly match: readonly Difference[] } {
  const rank = (kind: DifferenceKind) => DIFFERENCE_ORDER.indexOf(kind)
  const sorted = [...differences].sort((a, b) => rank(a.kind) - rank(b.kind) || a.seq - b.seq)
  return { differ: sorted.filter((row) => row.kind !== 'MATCH'), match: sorted.filter((row) => row.kind === 'MATCH') }
}

/** What a unit is called on the screen: its tag, else its lot, else its material's code. */
export const unitName = (row: { readonly hide: { readonly code: string } | null; readonly lot: { readonly code: string } | null; readonly item: { readonly code: string } }): string => row.hide?.code ?? row.lot?.code ?? row.item.code

// ---- refusals -------------------------------------------------------------------------------------------------------------

/**
 * The refusals the screen says in its own words (apps/factory-api counts-depth scans.ts `refusal/<CODE>`; NOT_A_PLACE: no place of
 * this site carries the label; NO_COUNT_HERE: no running count counts the bin; BADGE: a badge that opens nothing). ALREADY_COUNTED is
 * no full-screen refusal: the strip says it in amber and the next scan goes on.
 */
export const COUNT_REFUSALS = [
  'NOT_COUNTING',
  'OUTSIDE_COUNT',
  'UNKNOWN_LABEL',
  'NAME_THE_HIDE',
  'NOT_IN_BIN',
  'SCAN_THE_HIDE',
  'LINE_COUNTED',
  'ALREADY_COUNTED',
  'OWN_RECOUNT',
  'QUANTITY',
  'NOTHING_TO_FINISH',
  'NOT_A_PLACE',
  'NO_COUNT_HERE',
  'BADGE',
] as const
export type CountRefusal = (typeof COUNT_REFUSALS)[number]

export const knownRefusal = (code: string): code is CountRefusal => (COUNT_REFUSALS as readonly string[]).includes(code)
