import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'

/**
 * The buying office's shared rules (Planning › What to buy & make SCR-055, Purchasing › Purchase orders SCR-058/059,
 * Warehouse › Receipts SCR-061 … 063), pure: what this person may do (permissions and the cost grain), how a failed read
 * or write is said (this app's words, never the API's English), and how quantities and money are written in the
 * person's language. Every buying screen speaks the `buying` catalogue.
 */

/** A part a screen reads: loading, there, failed (its words), gone, or not this person's. */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** A part of a record read beside it: its value, or why it is missing (null both: still loading). */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const PART_LOADING: Part<never> = Object.freeze({ value: null, problem: null })
export const part = <T>(value: T): Part<T> => ({ value, problem: null })

/** Words with their values: a message key of `buying` and its parameters. */
export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

export interface BuyingCan {
  planView: boolean
  planRun: boolean
  planDecide: boolean
  poView: boolean
  poManage: boolean
  poSend: boolean
  stockView: boolean
  receive: boolean
  reverse: boolean
  /** The cost grain: purchase prices and values (a role without it never receives them, and the columns are not drawn). */
  cost: boolean
  materials: boolean
  parties: boolean
  sites: boolean
  lots: boolean
  threads: boolean
}

/** What a person's permissions allow on the buying screens (the API checks every call again). */
export function buyingCan(permissions: readonly string[]): BuyingCan {
  const held = new Set(permissions)
  return {
    planView: held.has('planning.view'),
    planRun: held.has('planning.run'),
    planDecide: held.has('planning.decide'),
    poView: held.has('purchasing.view'),
    poManage: held.has('purchasing.manage'),
    poSend: held.has('purchasing.send'),
    stockView: held.has('inventory.stock.view'),
    receive: held.has('inventory.receive'),
    reverse: held.has('inventory.reverse'),
    cost: held.has('money.cost'),
    materials: held.has('product.materials.view'),
    parties: held.has('parties.view'),
    sites: held.has('inventory.locations.view'),
    lots: held.has('quality.lots.view'),
    threads: held.has('threads.read'),
  }
}

/** A failed read in words (a key of `buying`): no right, no answer, or another fault. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/**
 * A refused write in words: the screen's own words for a path it knows (`pathWords`), else by the kind — changed by
 * someone else (409: read again), no right, gone, a bad request, no answer.
 */
export function writeProblem(error: unknown, pathWords?: (paths: readonly string[], error: { kind: string; code: string }) => Phrase | null): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  const own = pathWords?.(error.issues.map(issuePath), error)
  if (own) return own
  switch (error.kind) {
    case 'conflict':
      return phrase('problem.changed')
    case 'forbidden':
    case 'step_up':
      return phrase('problem.forbidden')
    case 'not_found':
      return phrase('problem.gone')
    case 'invalid':
      return phrase('problem.invalid')
    case 'rate_limited':
      return phrase('problem.slowDown')
    case 'unavailable':
      return phrase('problem.offline')
    default:
      return phrase('problem.write')
  }
}

/** The API's issue paths of an error (none for anything else). */
export const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath) : [])

// ---- numbers ----------------------------------------------------------------------------------------------------------------

/** A decimal string as the API writes it ("420.0000") → a number for display only (never for arithmetic on money). */
export function decimalValue(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** A quantity in the person's language: trailing zeros dropped, at most `decimals` decimals ("420", "12,5"). */
export function quantity(text: string | number | null | undefined, locale: Locale, decimals = 2): string {
  const value = typeof text === 'number' ? text : decimalValue(text)
  if (value === null) return '—'
  return formatNumber(value, locale, { maximumFractionDigits: decimals })
}

/** A money amount in minor units (cents) with its currency ("€ 1.234,50"). */
export function money(minor: number | null | undefined, currency: string, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit price as the API writes it ("4.200000") with its currency, 2 to 4 decimals. */
export function unitPrice(text: string | null | undefined, currency: string, locale: Locale): string {
  const value = decimalValue(text)
  if (value === null) return '—'
  return formatNumber(value, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** A calendar day ("2026-11-16") as a date at noon UTC (no zone can move it to another day). */
export const dayAt = (day: string): string => `${day}T12:00:00Z`

/** Today in a time zone, as a calendar day. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The instant a calendar day starts in a time zone (for "posted today": the API takes an instant). */
export function startOfDayIn(timeZone: string, now: Date = new Date()): string {
  const day = todayIn(timeZone, now)
  // The zone's offset at that day's noon, applied to midnight (good to the minute away from a DST change at midnight).
  const noon = new Date(`${day}T12:00:00Z`)
  const local = new Date(noon.toLocaleString('en-US', { timeZone }))
  const offset = local.getTime() - new Date(noon.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - offset).toISOString()
}

/** Whole days from one calendar day to another (positive: `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------------

const cell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as a CSV (semicolons, as Italian spreadsheet programs read them). */
export function csvOf(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return [header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')
}
