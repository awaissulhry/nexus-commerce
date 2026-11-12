import type { Tone } from '@nexus/ui/primitives'
import type { HistoryAction, HistoryLine } from './api'

/**
 * The record panels' Approvals: the history (B-W2b-307; PLT-104; design shell.panels "the record panels get Approvals", the
 * review's History tab of home.approvals). Every approval of the record — the approval engine's requests and the domain
 * approvals with their own tables (a quote's, a change order's, an operation's SMV versions, an NCR's decisions, a scrap
 * above the limit, a timesheet, an inspection plan's and a work instruction's versions) — newest first, through ONE read
 * (B-W2b-282's registry). Pure, so the tests hold it.
 */

export const NAMESPACE = 'approvals-depth'

/**
 * The record types whose approvals the API's registry reads (platform/approvals/history: the domain sources, then each
 * registered kind's subject), each with the record's own view permissions the API asks (any of them, over the record's
 * place). Another type answers 404, and so does a record the reader may not view: the panel reads only what it may (an
 * approver of a purchase order without purchasing.view reads the request's own lines in the review instead).
 */
export const HISTORY_RECORD_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Quote: ['quotes.view'],
  ChangeOrder: ['product.changes.view'],
  Operation: ['product.routing.view'],
  Nonconformance: ['quality.ncr.view'],
  OperationScan: ['production.scrap.view'],
  TimesheetApproval: ['people.timesheets.hr', 'people.timesheets.team'],
  InspectionPlan: ['quality.plans.view'],
  WorkInstruction: ['production.instructions.view'],
  PurchaseOrder: ['purchasing.view'],
})
export const hasApprovalHistory = (recordType: string): boolean => Object.hasOwn(HISTORY_RECORD_TYPES, recordType)
/** The reader holds a view permission of the record's type (the API still checks its place). */
export const mayReadHistory = (recordType: string, held: ReadonlySet<string>): boolean => (HISTORY_RECORD_TYPES[recordType] ?? []).some((permission) => held.has(permission))

export type HistoryRead =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly problem: 'forbidden' | 'unavailable' }
  | { readonly status: 'ready'; readonly lines: readonly HistoryLine[]; readonly more: boolean; readonly loadingMore?: boolean }

export interface ApprovalHistoryModel {
  readonly read: HistoryRead
  /** approvals.view: without it the section is absent (never a locked box). */
  readonly allowed: boolean
  /** "Now", for the times ("2 min ago"). */
  readonly now?: number
}

export interface ApprovalHistoryActions {
  onRetry?: () => void
  onMore?: () => void
}

/** Each action's tone: a yes and a signature are good news, a no and a stale request need attention. */
export const ACTION_TONE: Readonly<Record<HistoryAction, Tone>> = Object.freeze({
  REQUESTED: 'info',
  COMMENTED: 'neutral',
  APPROVED: 'success',
  SIGNED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
  STALE: 'warning',
})

/**
 * The line in words (a key of `approvals-depth` and its params): who did what — "You approved", "Lucia signed it as
 * 'Released'", "The system: it changed since it was asked".
 */
export function lineWords(line: Pick<HistoryLine, 'action' | 'by' | 'meaning'>): { readonly key: string; readonly params: Readonly<Record<string, string>> } {
  const who = line.by.kind === 'SYSTEM' ? 'system' : line.by.me ? 'me' : 'other'
  const action = line.action === 'APPROVED' && line.meaning ? 'APPROVED_AS' : line.action
  return { key: `history.line.${action}.${who}`, params: { name: line.by.name, ...(line.meaning ? { meaning: line.meaning } : {}) } }
}

/** The muted line under it: the words a person wrote (a note, a comment, why not), with the reason's code before them. */
export function lineDetail(line: Pick<HistoryLine, 'words' | 'reasonCode'>): string | null {
  const words = line.words?.trim() || null
  if (line.reasonCode && words) return `${line.reasonCode} · ${words}`
  return line.reasonCode ?? words
}

/** An API failure as the panel says it. */
export function historyProblem(status: number | null): 'forbidden' | 'unavailable' {
  return status === 403 ? 'forbidden' : 'unavailable'
}
