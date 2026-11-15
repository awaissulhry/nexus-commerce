import { isApiError } from '../../../../lib/api/errors'
import { refusalOf, words, type Read, type Words } from '../queue/shared/depth'
import type { DispatchAbilities } from '../pickup/dispatch'
import type { CarrierDay, CloseOutcome, EndOfDay } from './api'

/**
 * End of day, pure (SCR-651 / SCR-652; design warehouse.shipments pop-up sh-eod "per carrier: parcels handed over today; the
 * manifest preview", "Close the day and print manifests", the band action "End of day (W2b manifest)"; tab sh-tab-manifest
 * "End-of-day manifest PDF — the driver signs the paper"): which carriers a close takes, what holds it, each carrier's state
 * and each outcome in words; and the selection row's "Mark handed over" (design sh-grid#4, manual carriers): which picked
 * shipments go, what holds it, each outcome in words. The refusal list mirrors factory-domain shipping/manifest/rules.ts (a
 * server-only module); the tests hold them equal.
 */

export const DAY_SHEET_REFUSALS = ['FUTURE_DAY', 'TOO_OLD', 'NOTHING_TO_CLOSE', 'ALREADY_CLOSED', 'DAY_CHANGED', 'NOT_CLOSED'] as const
export type DaySheetRefusal = (typeof DAY_SHEET_REFUSALS)[number]
/** The days back a close still reaches (factory-domain DAY_SHEET_LOOKBACK_DAYS). */
export const LOOKBACK_DAYS = 7

/** The days a person may close: the site's today and the seven before it (newest first). */
export function closableDays(today: string): string[] {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  return Array.from({ length: LOOKBACK_DAYS + 1 }, (_, back) => new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10))
}

/** A carrier's day in one word: closed (by a person or the system), open with something to close, or nothing handed over. */
export function carrierState(carrier: CarrierDay): 'closed' | 'closedBySystem' | 'toClose' | 'nothing' {
  if (carrier.sheet?.state === 'CLOSED') return carrier.sheet.closedBy === 'SYSTEM' ? 'closedBySystem' : 'closed'
  return carrier.may.close.allowed ? 'toClose' : 'nothing'
}

/** Why a carrier cannot be closed now, in words (null: it may). */
export function carrierHeld(carrier: CarrierDay): Words | null {
  if (carrier.may.close.allowed) return null
  return words(`eod.refusal.${carrier.may.close.refusal?.code ?? 'NOTHING_TO_CLOSE'}`)
}

/** Why "Close the day and print manifests" is held (null: it may be pressed). */
export function closeHeld(day: EndOfDay, chosen: readonly string[], can: Pick<DispatchAbilities, 'manage'>, busy: boolean): Words | null {
  if (!can.manage) return words('eod.held.noRight')
  if (busy) return words('eod.held.busy')
  if (day.day > day.today) return words('eod.refusal.FUTURE_DAY')
  const closable = day.carriers.filter((carrier) => carrier.may.close.allowed).map((carrier) => carrier.carrierCode)
  if (closable.length === 0) return words(day.carriers.some((carrier) => carrier.sheet?.state === 'CLOSED') ? 'eod.held.allClosed' : 'eod.held.nothing')
  if (!chosen.some((code) => closable.includes(code))) return words('eod.held.noneChosen')
  return null
}

/** The carriers a close takes at first: every one with something to close (the API's `toClose`). */
export const startChosen = (day: EndOfDay): string[] => day.carriers.filter((carrier) => carrier.may.close.allowed).map((carrier) => carrier.carrierCode)

/** A close's outcome for one carrier, in words. */
export function outcomeWords(outcome: CloseOutcome): { words: Words; tone: 'success' | 'warning' | 'danger' } {
  if (!outcome.closed) return { words: words(`eod.refusal.${outcome.refusal?.code ?? 'NOTHING_TO_CLOSE'}`), tone: 'danger' }
  if (outcome.printProblem) return { words: words('eod.outcome.notPrinted', { shipments: outcome.shipments ?? 0, parcels: outcome.parcels ?? 0 }), tone: 'warning' }
  if (outcome.printJob) return { words: words('eod.outcome.printed', { shipments: outcome.shipments ?? 0, parcels: outcome.parcels ?? 0 }), tone: 'success' }
  return { words: words('eod.outcome.closed', { shipments: outcome.shipments ?? 0, parcels: outcome.parcels ?? 0 }), tone: 'success' }
}

/** The window of a closed sheet's PDF (a new tab: the driver signs the paper). */
export const manifestHref = (prefix: string, manifestId: string): string => `${prefix}/warehouse/shipments/manifest?manifest=${encodeURIComponent(manifestId)}`

export interface EndOfDayModel {
  readonly siteId: string
  /** The day asked (null: the site's today). */
  readonly day: string | null
  readonly read: Read<EndOfDay>
  /** The carriers ticked for the close. */
  readonly chosen: readonly string[]
  /** Print each sheet on the site's A4 printer (default on). */
  readonly print: boolean
  readonly busy: boolean
  readonly problem: Words | null
  /** The close's outcomes, once it ran. */
  readonly outcomes: readonly CloseOutcome[] | null
  /** The preview open: the carrier and its PDF. */
  readonly preview: { readonly carrierCode: string; readonly pdf: Read<Uint8Array> } | null
  readonly can: Pick<DispatchAbilities, 'manage'>
  readonly prefix: string
}

export interface EndOfDayActions {
  onDay?: (day: string) => void
  onChoose?: (carrierCode: string, on: boolean) => void
  onPrint?: (on: boolean) => void
  onPreview?: (carrierCode: string | null) => void
  onClose?: () => void
  onGo?: () => void
  onRetry?: () => void
}

// ---- Mark handed over (the selection row) --------------------------------------------------------------------------------------

/** A picked row, as the W1 list and the queue's grids know it (the DDT only where the row carries it). */
export interface HandOverPick {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly transportBy: string
  readonly version?: number
  /** The live DDT (W1's rows; the search's number); undefined: the row does not say (the API checks). */
  readonly ddt?: unknown
}

/**
 * The picked shipments a hand-over sends: packed, not collected by the customer's own carrier (that needs who collected,
 * the plate and the signed DDT, in the shipment), and with a DDT where the row says. The API checks the rest (labels a
 * carrier needs, holds) and refuses in words.
 */
export function handOverOf(picked: readonly HandOverPick[]): { readonly go: HandOverPick[]; readonly skipped: { readonly row: HandOverPick; readonly why: Words }[] } {
  const go: HandOverPick[] = []
  const skipped: { row: HandOverPick; why: Words }[] = []
  for (const row of picked) {
    if (row.status !== 'PACKED') skipped.push({ row, why: words(row.status === 'DRAFT' ? 'handOver.why.notPacked' : 'handOver.why.notOpen') })
    else if (row.transportBy === 'RECIPIENT') skipped.push({ row, why: words('handOver.why.collects') })
    else if (row.ddt === null) skipped.push({ row, why: words('handOver.why.noDdt') })
    else go.push(row)
  }
  return { go, skipped }
}

/** Why "Mark handed over" is held on the selection row (null: it may be pressed). */
export function handOverHeld(picked: readonly HandOverPick[], can: Pick<DispatchAbilities, 'manage'>): Words | null {
  if (!can.manage) return words('handOver.held.noRight')
  return handOverOf(picked).go.length === 0 ? words('handOver.held.none') : null
}

/** One shipment's hand-over outcome. */
export interface HandOverOutcome {
  readonly id: string
  readonly number: string
  readonly state: 'done' | 'refused' | 'skipped'
  readonly words: Words
}

/** A refused hand-over in words: the API's code when it names one, else what kind of refusal it was. */
export function handOverRefusal(error: unknown): Words {
  const code = refusalOf(error)
  if (code === 'INCOMPLETE') return words('handOver.why.collects')
  if (code === 'ON_HOLD' || code === 'QUALITY_HOLD') return words('handOver.why.held')
  if (!isApiError(error)) return words('handOver.why.failed')
  if (error.kind === 'conflict' || error.kind === 'invalid') return words('handOver.why.notReady')
  if (error.kind === 'forbidden') return words('handOver.held.noRight')
  if (error.kind === 'not_found') return words('handOver.why.gone')
  return words('handOver.why.failed')
}

export interface HandOverModel {
  readonly picked: readonly HandOverPick[]
  readonly busy: boolean
  readonly outcomes: readonly HandOverOutcome[] | null
  readonly can: Pick<DispatchAbilities, 'manage'>
}
