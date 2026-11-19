import type { Issue } from '../core/errors'
import { businessDate, type BusinessDate } from '../core/time'

/**
 * B-OP-032 (order page N5; review R-2, R-9, R-10, R-23): "Record a shipment made elsewhere", pure. Goods that left with a
 * paper DDT written outside Nexus (a van that left before the office booked it, a subcontractor's delivery …) are recorded as
 * a shipment made ELSEWHERE: one command makes it with its lines, how it travelled and its paper DDT, and moves it DRAFT →
 * SHIPPED at the time it left (Shipment.origin ELSEWHERE; the …_order_page_guards hold the same rules for every login).
 *
 *   released    only garments quality released ship (as every shipment: the line guard's cap); the day it left is not before
 *               the release that covers its garments (per cell: the releases in time order, the first whose running sum
 *               covers what this cell has on other shipments plus these)
 *   when        not in the future (the database's 5 minutes of tolerance), at most 60 days back
 *   paper DDT   its number (1 to 40 characters on one line, as printed) and date, dated on or before the day it left
 *               (Europe/Rome); required unless an immediate invoice travelled with the goods instead (ddtRequired false,
 *               R-23); recorded once per customer (R-10: "That DDT number and date are already recorded.", never naming
 *               a customer). Nexus issues NO DDT number of it.
 *   serials     a serial-tracked style's garments each name their serial (Q31)
 *   holds       R-9: refused while the customer's account is on hold or its credit is held, unless a person who may release
 *               holds (shipping.holds.release) types why — then it is recorded with that reason (audit + an office line on
 *               each order's thread). Missing PPE documents never refuse a fact that already happened: recorded, with a
 *               warning line on the thread.
 *
 * Field problems carry a code (the screens word it themselves); refusals are 409 with the issue path `refusal/<CODE>`.
 */

export const ELSEWHERE_LIMITS = Object.freeze({
  daysBack: 60,
  futureSkewMs: 5 * 60_000,
  ddtNumber: 40,
  /** FatturaPA's NumeroDDT (the invoice cites the paper DDT, B-OP-033): longer numbers are recorded, not cited. */
  invoiceDdtNumber: 20,
  reason: 500,
  note: 2000,
})

const DAY_MS = 86_400_000

export const ELSEWHERE_PROBLEMS = ['NO_LINES', 'FUTURE', 'TOO_OLD', 'BEFORE_RELEASE', 'NOT_RELEASED', 'DDT_REQUIRED', 'DDT_NUMBER', 'DDT_AFTER_LEFT', 'SERIALS'] as const
export type ElsewhereProblemCode = (typeof ELSEWHERE_PROBLEMS)[number]

export interface ElsewhereProblem extends Issue {
  readonly code: ElsewhereProblemCode
}

/** Why recording is refused as a whole (409 `refusal/<CODE>`). */
/**
 * HELD: the customer is on hold (account or credit) and the person may not release holds; REASON_REQUIRED: they may, and
 * did not say why; DDT_NUMBER_USED: that paper DDT is recorded already (for this customer, R-10); NEXUS_DDT: a Nexus DDT of
 * a shipment made elsewhere.
 */
export const ELSEWHERE_REFUSALS = ['HELD', 'REASON_REQUIRED', 'DDT_NUMBER_USED', 'NEXUS_DDT'] as const
export type ElsewhereRefusalCode = (typeof ELSEWHERE_REFUSALS)[number]
export const elsewhereRefusalPath = (code: ElsewhereRefusalCode): string => `refusal/${code}`

/** The words of each refusal (English; the screens word the code themselves). R-10: DDT_NUMBER_USED names no customer. */
export const ELSEWHERE_WORDS: Readonly<Record<Exclude<ElsewhereRefusalCode, 'NEXUS_DDT'>, string>> = Object.freeze({
  HELD: 'The customer is on hold: only a person who may release holds records a shipment made elsewhere now, with the reason.',
  REASON_REQUIRED: 'The customer is on hold: say why the goods were let go anyway.',
  DDT_NUMBER_USED: 'That DDT number and date are already recorded.',
})

/** 409 words for a Nexus DDT of a shipment made elsewhere (no second fiscal number). */
export const nexusDdtWords = (paper: { readonly number: string } | null): string =>
  paper ? `This shipment left with paper DDT n. ${paper.number}: Nexus issues no DDT of it.` : 'This shipment left with an immediate invoice instead of a DDT: Nexus issues no DDT of it.'

/** A cell's quality release, as these rules read it. */
export interface ReleaseAt {
  readonly quantity: number
  /** When it was released (ISO). */
  readonly at: string
}

/**
 * The release that covers `need` garments of a cell (the cell's releases in time order: the first whose running sum reaches
 * `need`), as its time; null when the releases do not reach it (the cap says how many can ship).
 */
export function coveringReleaseAt(releases: readonly ReleaseAt[], need: number): string | null {
  if (need <= 0) return null
  let sum = 0
  for (const release of [...releases].sort((a, b) => a.at.localeCompare(b.at))) {
    sum += release.quantity
    if (sum >= need) return release.at
  }
  return null
}

/** A line of the recording, as these rules read it. */
export interface ElsewhereCell {
  readonly workOrderSizeId: string
  /** "WO-0042 BLK 52": the words of a problem. */
  readonly label: string
  readonly quantity: number
  /** Garments this cell can still ship (released − reversed − on shipments). */
  readonly shippable: number
  /** The release that covers these garments (coveringReleaseAt over what the cell has on shipments plus these); null: none. */
  readonly releasedAt: string | null
  readonly serialTracked: boolean
  /** The serials named for it. */
  readonly serials: number
}

export interface ElsewhereInput {
  /** When the goods left (ISO). */
  readonly shippedAt: string
  readonly externalDdt: { readonly number: string; readonly date: BusinessDate } | null
  /** false: an immediate invoice travelled with the goods instead of a DDT (R-23). */
  readonly ddtRequired: boolean
  readonly cells: readonly ElsewhereCell[]
}

const oneLine = (value: string): boolean => !/[\r\n\t\u0000-\u001f\u007f]/.test(value)

/** The paper DDT number as recorded: trimmed (the per-customer key compares it so). */
export const paperDdtNumber = (value: string): string => value.trim()

/** The day a shipment left, as the database compares a paper DDT's date with it (Europe/Rome). */
export const leftOn = (shippedAt: string): BusinessDate => businessDate(new Date(shippedAt))

/** The earliest moment the goods may have left: the latest covering release of its lines (null: one is not covered). */
export function earliestLeaving(cells: readonly Pick<ElsewhereCell, 'releasedAt'>[]): string | null {
  if (cells.some((cell) => cell.releasedAt === null)) return null
  return cells.reduce<string | null>((latest, cell) => (latest === null || cell.releasedAt! > latest ? cell.releasedAt : latest), null)
}

/**
 * Every problem of a recording (empty: it may be recorded), with its field path and code. `now`: the server's clock (the
 * screens use theirs for the live rules; the API decides).
 */
export function elsewhereProblems(input: ElsewhereInput, now: Date, at = 'body'): ElsewhereProblem[] {
  const problems: ElsewhereProblem[] = []
  const push = (code: ElsewhereProblemCode, path: string, message: string) => problems.push({ code, path, message })
  const left = Date.parse(input.shippedAt)
  if (input.cells.length === 0) push('NO_LINES', `${at}/lines`, 'Name the garments that left.')
  if (!Number.isFinite(left)) {
    push('FUTURE', `${at}/shippedAt`, 'Say when the goods left.')
  } else {
    if (left > now.getTime() + ELSEWHERE_LIMITS.futureSkewMs) push('FUTURE', `${at}/shippedAt`, 'The goods cannot have left in the future.')
    if (left < now.getTime() - ELSEWHERE_LIMITS.daysBack * DAY_MS) push('TOO_OLD', `${at}/shippedAt`, `A shipment made elsewhere is recorded at most ${ELSEWHERE_LIMITS.daysBack} days after it left.`)
  }
  input.cells.forEach((cell, index) => {
    const path = `${at}/lines/${index}`
    if (cell.quantity > cell.shippable) push('NOT_RELEASED', `${path}/quantity`, `Only released garments ship: ${cell.label} has ${cell.shippable} released and on no shipment.`)
    else if (cell.releasedAt === null) push('NOT_RELEASED', `${path}/quantity`, `Only released garments ship: ${cell.label} is not released.`)
    else if (Number.isFinite(left) && left < Date.parse(cell.releasedAt)) push('BEFORE_RELEASE', `${at}/shippedAt`, `${cell.label} was released on ${cell.releasedAt.slice(0, 10)}: the goods cannot have left before.`)
    if (cell.serialTracked && cell.serials !== cell.quantity) push('SERIALS', `${path}/serials`, `${cell.label} is serial-tracked: name the serial of each garment (${cell.serials} of ${cell.quantity}).`)
  })
  const ddt = input.externalDdt
  if (ddt === null) {
    if (input.ddtRequired) push('DDT_REQUIRED', `${at}/externalDdt`, 'Type the number and date of the paper DDT that went with the goods, or say that an immediate invoice travelled instead.')
  } else {
    const number = paperDdtNumber(ddt.number)
    if (number.length === 0 || number.length > ELSEWHERE_LIMITS.ddtNumber || !oneLine(number)) push('DDT_NUMBER', `${at}/externalDdt/number`, `A paper DDT number is 1 to ${ELSEWHERE_LIMITS.ddtNumber} characters on one line, as printed.`)
    if (Number.isFinite(left) && ddt.date > leftOn(input.shippedAt)) push('DDT_AFTER_LEFT', `${at}/externalDdt/date`, 'The paper DDT is dated on or before the day the goods left.')
  }
  return problems
}

/** What the holds of the customer say now: its account hold's words, whether its credit is held. */
export interface ElsewhereHolds {
  readonly accountHold: string | null
  readonly creditHeld: boolean
}

export const isHeld = (holds: ElsewhereHolds): boolean => holds.accountHold !== null || holds.creditHeld

/**
 * R-9: recording while the customer is held — null: it may be recorded (not held, or overridden by a person with the
 * right who said why); else the refusal's code and words.
 */
export function holdRefusal(holds: ElsewhereHolds, override: { readonly mayRelease: boolean; readonly reason: string | null | undefined }): { readonly code: 'HELD' | 'REASON_REQUIRED'; readonly message: string } | null {
  if (!isHeld(holds)) return null
  const why = holds.accountHold ? `${holds.accountHold} ` : ''
  if (!override.mayRelease) return { code: 'HELD', message: `${why}${ELSEWHERE_WORDS.HELD}` }
  if ((override.reason?.trim() ?? '').length === 0) return { code: 'REASON_REQUIRED', message: `${why}${ELSEWHERE_WORDS.REASON_REQUIRED}` }
  return null
}

/** The office line on each order's thread when a hold was overridden (the company's language). */
export function overrideLineOf(input: { readonly shipment: string; readonly reason: string; readonly ddt: string | null }, locale: 'it' | 'en'): string {
  const paper = input.ddt ? (locale === 'it' ? ` (DDT cartaceo ${input.ddt})` : ` (paper DDT ${input.ddt})`) : ''
  return locale === 'it'
    ? `${input.shipment}${paper} è registrata come fatta altrove mentre il cliente era bloccato. Motivo: ${input.reason}`
    : `${input.shipment}${paper} was recorded as made elsewhere while the customer was on hold. Reason: ${input.reason}`
}

/** The office line on each order's thread when PPE documents were not on file (recorded, never refused). */
export function documentsLineOf(input: { readonly shipment: string; readonly missing: readonly string[] }, locale: 'it' | 'en'): string {
  return locale === 'it'
    ? `${input.shipment} è partita senza tutti i documenti DPI in archivio: ${input.missing.join(' ')}`
    : `${input.shipment} left without every PPE document on file: ${input.missing.join(' ')}`
}

/** Whether the paper DDT number can be cited on the e-invoice as it is (FatturaPA NumeroDDT: 20 characters, plain ASCII). */
export const citableOnInvoice = (number: string): boolean => number.length <= ELSEWHERE_LIMITS.invoiceDdtNumber && /^[\x20-\x7e]+$/.test(number)
