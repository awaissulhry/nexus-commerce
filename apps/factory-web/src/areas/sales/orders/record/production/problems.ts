import type { OrderProduction, Words } from '../overview/api'
import type { OrderIssue } from './api'
import { firstLineOf } from './asks'

/**
 * F-PT-301 / F-PT-302 (order PRODUCTION tab, 10-design §6; bugs B27–B31) — Problems & holds, without a screen: what waits for an
 * answer (the order's issues from the ONE issues list — read with orders.view, B31 — open ones, the most due first: the kind in the
 * API's words, who asked, the excerpt, the due day and whether it is late, how far it escalated, who answers) and the order's quality in
 * plain words (the final checks, the verdict first, each by its own inspection — B28 — with its defects per class; the NCRs with
 * severity, stage and title). What stops it is Overview's own strips (whereStripsOf + stripDoorsOf), never a second rule.
 */

export interface WaitingAnswer {
  readonly id: string
  readonly source: OrderIssue['source']
  readonly kindWords: Words
  /** The work order it was raised on (its number); null: on the order itself. */
  readonly workOrder: string | null
  readonly at: string
  readonly by: string | null
  readonly due: string
  readonly late: boolean
  readonly escalated: Words | null
  /** Who answers: the reader, someone else, nobody yet (lists name no person); null: no task. */
  readonly answers: 'ME' | 'SOMEONE_ELSE' | 'NOT_SET' | null
  readonly excerpt: string | null
  readonly messageId: string | null
}

/** The open issues of the order, the most due first (late first, then by due day). */
export function waitingAnswersOf(issues: readonly OrderIssue[] | null | undefined, today: string): WaitingAnswer[] {
  return [...(issues ?? [])]
    .filter((issue) => issue.status === 'OPEN')
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.raisedAt.localeCompare(b.raisedAt))
    .map((issue) => ({
      id: issue.id,
      source: issue.source,
      kindWords: issue.sourceWords,
      workOrder: issue.record.type === 'WorkOrder' ? issue.record.label : null,
      at: issue.raisedAt,
      by: issue.askedBy?.name ?? null,
      due: issue.dueOn,
      late: issue.dueOn < today,
      escalated: issue.escalation && issue.escalation.step > 0 ? issue.escalation.words : null,
      answers: issue.task?.assignee ?? null,
      excerpt: firstLineOf(issue.excerpt),
      messageId: issue.messageId ?? null,
    }))
}

type Final = NonNullable<NonNullable<OrderProduction['quality']>['final']>[number]
type Ncr = NonNullable<NonNullable<OrderProduction['quality']>['ncrs']>[number]

export interface FinalCheck {
  readonly key: string
  /** The inspection's id (B-PT-008; null: an older answer) — a nonconformance is raised from it. */
  readonly inspectionId: string | null
  readonly number: string | null
  readonly status: 'PASSED' | 'FAILED' | 'WAITING'
  readonly checked: number
  /** Inspected so far (B-PT-008; null: not sent or not counted) and the lot. */
  readonly inspected: number | null
  readonly lot: number | null
  readonly defects: { readonly critical: number; readonly major: number; readonly minor: number } | null
  readonly on: string | null
  /** Its work order also makes other customers' work: "covers other work too — not for the customer". */
  readonly shared: boolean
}

/** The final checks, the newest first; each its own inspection (B28: a failed one and its re-inspection are two rows). */
export function finalChecksOf(final: readonly Final[] | null | undefined): FinalCheck[] | null {
  if (!final) return null
  return [...final]
    .sort((a, b) => (b.on ?? '').localeCompare(a.on ?? ''))
    .map((row, index) => ({
      key: row.id ?? `${row.workOrderId}-${index}`,
      inspectionId: row.id ?? null,
      number: row.number,
      status: row.status === 'PASSED' || row.status === 'FAILED' ? row.status : 'WAITING',
      checked: row.sampleSize,
      inspected: row.inspectedCount ?? null,
      lot: row.lotSize ?? null,
      defects: row.defects ?? null,
      on: row.on,
      shared: row.sharedWorkOrder ?? false,
    }))
}

/** The quality verdict first: a failed check beats a waiting one beats a passed one; null: no final check yet. */
export function qualityVerdictOf(checks: readonly FinalCheck[] | null): 'FAILED' | 'WAITING' | 'PASSED' | null {
  if (!checks || checks.length === 0) return null
  if (checks.some((check) => check.status === 'FAILED')) return 'FAILED'
  if (checks.some((check) => check.status === 'WAITING')) return 'WAITING'
  return 'PASSED'
}

/** The NCRs, the most severe first. */
const SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR']
export function ncrsOf(ncrs: readonly Ncr[] | null | undefined): Ncr[] | null {
  if (!ncrs) return null
  return [...ncrs].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || a.number.localeCompare(b.number, 'en', { numeric: true }))
}
