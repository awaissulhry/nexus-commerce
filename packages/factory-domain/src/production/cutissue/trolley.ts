import type { Language } from '../../inventory/rolls/rolls'
import { orderStop, type RecutWorkOrder } from '../rework/recut'
import { pendingWords, type SecondaryKind } from './secondary'

/**
 * Cut issue to sewing (B-W2b-117; MES-048 "Cut issue to sewing"; design floor.fabriccut "Send to sewing" — "Scan bundles into
 * trolley T-3; 'Send 12 bundles to Line 2'. At the line: scanning the trolley label confirms receipt; differences flagged." —,
 * live "Line confirms receipt → the trolley shows 'Received'"), pure. A trolley is a CutIssue (B-W2b-85) named by its label
 * ("T-3", no spaces): LOADING → SENT → RECEIVED, or LOADING → CANCELLED.
 *
 *   load     a bundle scanned onto the trolley: the trolley's open issue at the site, or a new LOADING one (its line: the one
 *            named, else the line the bundle's work order is planned on). The bundle: ACTIVE, of a RELEASED or IN_PROGRESS work
 *            order that is not held, past every secondary process (none waits or runs: they are a route step), and on no other
 *            open trolley. A trolley that was sent takes nothing until the line received it.
 *   unload   a bundle taken off while the trolley is loading (a wrong scan).
 *   send     LOADING → SENT, with one bundle at least ("Send 12 bundles to Line 2"); the line may change until then.
 *   receive  at the line, the trolley's label scanned: SENT → RECEIVED; each bundle received, but those named missing (a
 *            difference, kept in words on the trolley). A tablet at a station of another line is refused.
 *   cancel   LOADING → CANCELLED with the reason (the bundles are free again).
 *
 * One trolley label is on one open issue at a time (LOADING or SENT), and a bundle on one open trolley at a time: the API's rules
 * (the database cannot copy them into the isolation tests). Nothing here carries money or names who carried or received.
 */

export const CUT_ISSUE_STATUSES = ['LOADING', 'SENT', 'RECEIVED', 'CANCELLED'] as const
export type CutIssueStatus = (typeof CUT_ISSUE_STATUSES)[number]
/** A trolley still in use: being loaded, or on its way. */
export const OPEN_CUT_ISSUE_STATUSES = ['LOADING', 'SENT'] as const satisfies readonly CutIssueStatus[]

export const TROLLEY_LIMITS = Object.freeze({
  /** A trolley label's characters. */
  code: 20,
  /** Bundles on one trolley. */
  bundles: 200,
  reason: 300,
  /** Rows of a list. */
  rows: 200,
})

/** A trolley's label as scanned or typed: trimmed, upper case. */
export const trolleyCodeOf = (code: string): string => code.trim().toUpperCase()

/** What is wrong with a trolley label (null: it is one): letters, digits and . _ - / , no spaces, at most 20. */
export function trolleyCodeProblem(code: string): string | null {
  if (code === '') return 'Scan the trolley’s label.'
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(code) || code.length > TROLLEY_LIMITS.code) return `${code} is not a trolley label: letters and digits, no spaces, at most ${TROLLEY_LIMITS.code}.`
  return null
}

export const TROLLEY_REFUSALS = [
  'NOT_A_TROLLEY',
  'TROLLEY_SENT',
  'NO_OPEN_TROLLEY',
  'TROLLEY_NOT_LOADING',
  'TROLLEY_NOT_SENT',
  'TROLLEY_EMPTY',
  'TROLLEY_FULL',
  'LINE_NEEDED',
  'LINE_NOT_ACTIVE',
  'BUNDLE_NOT_ACTIVE',
  'WORK_ORDER_NOT_OPEN',
  'WORK_ORDER_ON_HOLD',
  'PROCESS_PENDING',
  'ON_THIS_TROLLEY',
  'ON_ANOTHER_TROLLEY',
  'NOT_ON_TROLLEY',
  'OTHER_LINE',
] as const
export type TrolleyRefusalCode = (typeof TROLLEY_REFUSALS)[number]

export interface TrolleyRefusal {
  readonly code: TrolleyRefusalCode
  readonly message: string
}

export const TROLLEY_WARNINGS = ['PLANNED_ON_OTHER_LINE'] as const
export type TrolleyWarningCode = (typeof TROLLEY_WARNINGS)[number]
export interface TrolleyWarning {
  readonly code: TrolleyWarningCode
  readonly message: string
}

export interface OpenIssue {
  readonly trolleyCode: string
  readonly status: CutIssueStatus
  readonly bundles: number
}

/** Why the trolley takes no bundle now (null: it does). `issue` is the trolley's open issue (null: a new one is opened). */
export function trolleyLoadRefusal(issue: OpenIssue | null, code: string): TrolleyRefusal | null {
  if (issue?.status === 'SENT') return { code: 'TROLLEY_SENT', message: `Trolley ${code} is on its way to a line: it is loaded again once the line received it.` }
  if (issue && issue.bundles >= TROLLEY_LIMITS.bundles) return { code: 'TROLLEY_FULL', message: `Trolley ${code} carries ${TROLLEY_LIMITS.bundles} bundles: send it, and load another.` }
  return null
}

export interface LoadFacts {
  readonly trolleyCode: string
  readonly workOrder: RecutWorkOrder
  readonly bundle: { readonly code: string; readonly status: string }
  /** The bundle's secondary processes still waiting or running. */
  readonly pending: readonly { readonly kind: SecondaryKind }[]
  /** The open trolley the bundle is on already (null: none). */
  readonly onTrolley: string | null
}

/** Why the bundle does not go onto the trolley (null: it does). */
export function bundleLoadRefusal(facts: LoadFacts): TrolleyRefusal | null {
  if (facts.bundle.status !== 'ACTIVE') return { code: 'BUNDLE_NOT_ACTIVE', message: `Bundle ${facts.bundle.code} is voided: it goes to no line.` }
  const stop = orderStop(facts.workOrder, { held: 'its bundles go to sewing once the hold is lifted', closed: 'bundles go to sewing for released or running work orders' })
  if (stop) return stop
  if (facts.onTrolley === facts.trolleyCode) return { code: 'ON_THIS_TROLLEY', message: `Bundle ${facts.bundle.code} is on trolley ${facts.trolleyCode} already.` }
  if (facts.onTrolley) return { code: 'ON_ANOTHER_TROLLEY', message: `Bundle ${facts.bundle.code} is on trolley ${facts.onTrolley}: take it off there first.` }
  const pending = pendingWords(facts.bundle.code, facts.pending, 'en')
  if (pending) return { code: 'PROCESS_PENDING', message: pending }
  return null
}

/** The line a new trolley goes to: the one named, else the line the bundle's work order is planned on (null: ask for one). */
export function lineOfLoad(named: string | null | undefined, planned: string | null): string | null {
  return named ?? planned
}

/** A line the trolley is sent to: ACTIVE, of the site. */
export function lineRefusal(line: { readonly code: string; readonly status: string; readonly sameSite: boolean } | null): TrolleyRefusal | null {
  if (!line) return { code: 'LINE_NEEDED', message: 'Say which line the trolley goes to.' }
  if (!line.sameSite || line.status !== 'ACTIVE') return { code: 'LINE_NOT_ACTIVE', message: `Line ${line.code} is not an active line of this site: a trolley goes to an active line.` }
  return null
}

/** The work order is planned on another line than the trolley's (a warning: the trolley may still go there). */
export function lineWarnings(trolleyLine: { readonly id: string; readonly code: string }, bundle: { readonly code: string }, plannedLine: { readonly id: string; readonly code: string } | null): TrolleyWarning[] {
  if (!plannedLine || plannedLine.id === trolleyLine.id) return []
  return [{ code: 'PLANNED_ON_OTHER_LINE', message: `Bundle ${bundle.code}'s work order is planned on line ${plannedLine.code}, not ${trolleyLine.code}.` }]
}

/** Why the trolley is not sent (null: it is). */
export function sendRefusal(issue: OpenIssue | null, code: string): TrolleyRefusal | null {
  if (!issue) return { code: 'NO_OPEN_TROLLEY', message: `Trolley ${code} is not being loaded: scan its bundles first.` }
  if (issue.status !== 'LOADING') return { code: 'TROLLEY_NOT_LOADING', message: `Trolley ${code} is on its way already.` }
  if (issue.bundles === 0) return { code: 'TROLLEY_EMPTY', message: `Trolley ${code} carries no bundle: scan its bundles first.` }
  return null
}

/** Why the trolley is not received at this line (null: it is). `here` is the tablet's line (null: the office, or a tablet on no line). */
export function receiveRefusal(issue: OpenIssue | null, code: string, trolleyLine: { readonly id: string; readonly code: string } | null, here: { readonly id: string; readonly code: string } | null): TrolleyRefusal | null {
  if (!issue) return { code: 'NO_OPEN_TROLLEY', message: `Trolley ${code} is not on its way to a line.` }
  if (issue.status !== 'SENT') return { code: 'TROLLEY_NOT_SENT', message: `Trolley ${code} is still being loaded: it is received once it was sent.` }
  if (here && trolleyLine && here.id !== trolleyLine.id) return { code: 'OTHER_LINE', message: `Trolley ${code} goes to line ${trolleyLine.code}; this tablet is at line ${here.code}.` }
  return null
}

/** Why a bundle is not taken off (null: it is). */
export function unloadRefusal(issue: OpenIssue | null, code: string, bundleCode: string, onIt: boolean): TrolleyRefusal | null {
  if (!issue) return { code: 'NO_OPEN_TROLLEY', message: `Trolley ${code} is not being loaded.` }
  if (issue.status !== 'LOADING') return { code: 'TROLLEY_NOT_LOADING', message: `Trolley ${code} was sent: its bundles stay on it.` }
  if (!onIt) return { code: 'NOT_ON_TROLLEY', message: `Bundle ${bundleCode} is not on trolley ${code}.` }
  return null
}

/** The differences found at the line, in words (stored on the trolley; null: none). */
export function differencesText(missing: readonly string[], unknown: readonly string[]): string | null {
  const parts = [...(missing.length > 0 ? [`Not found on the trolley: ${missing.join(', ')}.`] : []), ...(unknown.length > 0 ? [`Named missing but not on it: ${unknown.join(', ')}.`] : [])]
  return parts.length === 0 ? null : parts.join(' ')
}

export type TrolleyNext = 'LOAD' | 'RECEIVE' | 'NONE'

/** What a scan of the trolley's label does: load it (none open, or one loading), receive it (sent), nothing else. */
export function nextTrolleyStep(issue: Pick<OpenIssue, 'status'> | null): TrolleyNext {
  if (!issue || issue.status === 'LOADING') return 'LOAD'
  return issue.status === 'SENT' ? 'RECEIVE' : 'NONE'
}

/** "Send 12 bundles to L2" / "Invia 12 fasci alla linea L2". */
export function sendWords(bundles: number, lineCode: string, language: Language): string {
  return language === 'it' ? `Invia ${bundles} ${bundles === 1 ? 'fascio' : 'fasci'} alla linea ${lineCode}` : `Send ${bundles} ${bundles === 1 ? 'bundle' : 'bundles'} to line ${lineCode}`
}
