import { Decimal } from 'decimal.js'
import type { ApprovalField } from '../../approvals/rules'
import { decimalText } from '../../product/units/units'
import type { SheetCategory, LineSource } from '../sheet-components/components'
import { six } from '../sheet-components/rules'

/**
 * Cost sheet versions (B-W2b-420; FIN-014, FIN-015; design products.styles › Cost "Cost sheet versions and approval"), pure:
 * the series a version belongs to, the refusals in words, the facts its approval tests and the changes a request shows.
 *
 *   series      one style, company and season (or none): `costsheet:<style>:<company>:<season | none>`; its versions are
 *               numbered 1, 2, 3 … (`sheetVersion`; `version` stays the row's compare-and-set counter)
 *   states      DRAFT (written and edited, deleted while nobody built on it) → APPROVED (approved by someone other than its
 *               maker, through the approval engine's COST_SHEET request, and locked: prices are released from it) → FROZEN
 *               (no longer in force: a newer version approved in its place, its season closed, or taken back)
 *   a change    of an approved or frozen version is a new version (a copy, or written again from the components)
 *
 * The database (B-W2b-378's guards) holds the same rules for every login; these words come first.
 */

export const COST_SHEET_STATES = ['DRAFT', 'APPROVED', 'FROZEN'] as const
export type CostSheetState = (typeof COST_SHEET_STATES)[number]
export const FREEZE_REASONS = ['SUPERSEDED', 'SEASON_CLOSED', 'WITHDRAWN'] as const
export type FreezeReason = (typeof FREEZE_REASONS)[number]
/** Where a new version's lines come from: the revision's components now, or a copy of a version of the series. */
export const VERSION_SOURCES = ['COMPONENTS', 'COPY'] as const
export type VersionSource = (typeof VERSION_SOURCES)[number]

/** The approval engine's kind of a version's request for its yes (factory-domain approvals/rules APPROVAL_TASK_KINDS). */
export const COST_SHEET_KIND = 'COST_SHEET' as const

/** The series of a style's cost for a company and a season (or none): exactly the database's key. */
export const costSheetKey = (styleId: string, companyId: string, seasonId: string | null): string => `costsheet:${styleId}:${companyId}:${seasonId ?? 'none'}`

export const VERSION_REFUSALS = [
  'LOCKED',
  'FROZEN',
  'NOT_APPROVED',
  'NO_LINES',
  'LEFT_OUT',
  'SEASON_CLOSED',
  'OWN_SHEET',
  'NO_APPROVER',
  'OTHER_SERIES',
  'OTHER_REVISION',
  'COPIED_FROM',
  'BASE_SIZE',
  'NOTHING_CHANGES',
  'OTHER_STYLE',
  'SAME_SHEET',
  'OTHER_CURRENCY',
  'NO_COMPANY',
  'INCOMPLETE',
  'DATABASE',
] as const
export type VersionRefusal = (typeof VERSION_REFUSALS)[number]

export const VERSION_REFUSAL_WORDS: Readonly<Record<VersionRefusal, string>> = Object.freeze({
  LOCKED: 'This version is approved and locked: it is never edited. A change is a new version.',
  FROZEN: 'This version is frozen: it changes no more. A change is a new version.',
  NOT_APPROVED: 'Only the approved version of a series is taken back.',
  NO_LINES: 'This version has no line: there is nothing to approve.',
  LEFT_OUT: 'The components left inputs out when this version was written: write them again once they are there, or type lines for them and say they cover what was left out.',
  SEASON_CLOSED: 'The season of this version is closed: a version is made and approved for an open season (or none).',
  OWN_SHEET: 'Nobody approves a cost sheet they made: someone else in the office approves it.',
  NO_APPROVER: 'No office role approves cost sheets: give a role costing.sheets.approve and approvals.decide (Admin › Roles), or switch on an approval rule for cost sheets.',
  OTHER_SERIES: 'A new version is copied from a version of the same style, company and season.',
  OTHER_REVISION: 'A copy keeps the revision of the version it copies: for another revision, write the new version from its components.',
  COPIED_FROM: 'A later version was copied from this draft: it stays.',
  BASE_SIZE: "The base size is a size of the style's range.",
  NOTHING_CHANGES: 'Nothing changes.',
  OTHER_STYLE: 'Two versions of one style are compared.',
  SAME_SHEET: 'Pick two different versions to compare.',
  OTHER_CURRENCY: 'The two versions are in different currencies: their figures are not compared, only their lines.',
  NO_COMPANY: 'This style is every company’s: say which company the cost sheet is for.',
  INCOMPLETE: 'Some inputs of the components are missing: give them, or write the version leaving them out.',
  DATABASE: 'The database refused the cost sheet.',
})

/** The words of a LEFT_OUT refusal with how many inputs were left out. */
export const leftOutWords = (count: number): string =>
  `The components left ${count === 1 ? '1 input' : `${count} inputs`} out when this version was written: write them again once they are there, or type lines for them and say they cover what was left out.`

const UUID = / ?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const SHEET = /^costing: (cost sheet |the company, style, revision, season, version, currency and base size of cost sheet |the base size )/

/**
 * The database's own refusal of a cost sheet row (factory-db …_cost_sheets_w2b_guards: "costing: cost sheet …", check_violation)
 * in words: a write that reached it past the command's checks (a race) answers 409 with a code, never a 500. Null for another
 * message.
 */
export function databaseVersionRefusal(message: string): { readonly code: VersionRefusal; readonly message: string } | null {
  if (!SHEET.test(message)) return null
  const words = message.slice('costing: '.length).replace(UUID, '').replace(/ {2,}/g, ' ').trim()
  const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)}${words.endsWith('.') ? '' : '.'}`
  if (/is approved and locked/.test(message)) return { code: 'LOCKED', message: sentence }
  if (/is frozen: it changes no more/.test(message)) return { code: 'FROZEN', message: sentence }
  if (/approved by someone other than the person who made it/.test(message)) return { code: 'OWN_SHEET', message: sentence }
  if (/has no line: there is nothing to approve/.test(message)) return { code: 'NO_LINES', message: sentence }
  if (/for a season that is closed/.test(message)) return { code: 'SEASON_CLOSED', message: sentence }
  return { code: 'DATABASE', message: sentence }
}

/** Whether a line's cost reads a percent of other lines (overhead, freight, duty, a commission). */
export const isPercentLine = (line: { readonly pct: string | null }): boolean => line.pct !== null

// ---- the approval's facts (the COST_SHEET kind) ----------------------------------------------------------------------------

/** What a COST_SHEET rule may test. Costs with the cost grain, the target price with the price grain, margins with the margin grain. */
export const COST_SHEET_FIELDS: readonly ApprovalField[] = Object.freeze([
  { id: 'baseCost', label: { en: 'cost at the base size', it: 'costo alla taglia base' }, kind: 'number', grain: 'cost', min: 0 },
  { id: 'weightedCost', label: { en: 'weighted cost of the size mix', it: 'costo ponderato sul mix taglie' }, kind: 'number', grain: 'cost', min: 0 },
  { id: 'targetPrice', label: { en: 'target price', it: 'prezzo obiettivo' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'targetMarginPct', label: { en: 'target margin', it: 'margine obiettivo' }, kind: 'number', grain: 'margin' },
  { id: 'marginAtTarget', label: { en: 'margin at the target price', it: 'margine al prezzo obiettivo' }, kind: 'number', grain: 'margin' },
  { id: 'costChangePct', label: { en: 'cost change on the version in force (%)', it: 'variazione del costo sulla versione in vigore (%)' }, kind: 'number', unit: '%' },
  { id: 'sheetVersion', label: { en: 'version', it: 'versione' }, kind: 'number', unit: null, min: 1 },
  { id: 'firstVersion', label: { en: 'first version of the series', it: 'prima versione della serie' }, kind: 'yesNo' },
  { id: 'leftOut', label: { en: 'inputs left out', it: 'dati lasciati fuori' }, kind: 'number', unit: null, min: 0 },
  { id: 'styleCode', label: { en: 'style code', it: 'codice modello' }, kind: 'text' },
  { id: 'seasonCode', label: { en: 'season code', it: 'codice stagione' }, kind: 'text' },
])

/** The margin a price earns on a cost, percent of the price, 2 places; null without both or with no price. */
export function marginPctOf(price: string | null, cost: string | null): string | null {
  if (price === null || cost === null) return null
  const p = new Decimal(price)
  if (!p.gt(0)) return null
  return decimalText(p.minus(cost).dividedBy(p).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
}

/** How much a cost moved on another, percent of the other, 2 places; null without both or on a zero. */
export function changePctOf(cost: string | null, before: string | null): string | null {
  if (cost === null || before === null) return null
  const b = new Decimal(before)
  if (b.isZero()) return null
  return decimalText(new Decimal(cost).minus(b).dividedBy(b).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
}

/** A decimal text as a rule's number fact (a money fact is a number; null stays null). */
export const factNumber = (value: string | null): number | null => (value === null ? null : Number(value))

/** The lines of a sheet as the fingerprint covers them: every figure as text, in their order. */
export interface SnapshotLine {
  readonly seq: number
  readonly category: SheetCategory
  readonly source: LineSource
  readonly sourceRecordId: string | null
  readonly itemId: string | null
  readonly size: string | null
  readonly quantity: string
  readonly unitCost: string
  readonly cost: string
  readonly pct: string | null
}

/** Σ of costs, 6 places. */
export const sumCost = (values: readonly string[]): string => six(values.reduce((sum, value) => sum.plus(value), new Decimal(0)))
