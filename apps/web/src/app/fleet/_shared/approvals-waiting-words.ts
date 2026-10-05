/**
 * The words of `ApprovalsWaiting` — the one line other pages show about approvals (Owner, 2026-10-05).
 *
 * "Other pages may show that approvals are waiting; none of them may decide one"
 * (docs/2026-08-07-naf-aq-approvals-page.md). Settings › AI and the Fleet overview used to list the requests with
 * Approve and Reject; now each says only how many need a person, and links to the Approvals page, where they are
 * decided. Pure, so the vitest reads every sentence without a browser.
 *
 * The numbers are the API's (`GET /api/agent/fleet/approvals/queue/counts`, `QueueCounts`): `needsYou` is waiting +
 * back to you, `failed` is the failed requests still open. They are the same numbers the Approvals page's strip shows.
 */
import type { QueueCounts } from '@nexus/shared/approval-queue'

export const APPROVALS_HREF = '/fleet/approvals'
export const OPEN_APPROVALS = 'Open Approvals'
export const NOTHING_NEEDS_YOU = 'Nothing needs you right now.'
export const COUNT_NOT_READ = 'Nexus could not read the approvals count.'

export type WaitingCounts = Pick<QueueCounts, 'needsYou' | 'failed'>

/** What the line shows: still reading, the read failed, something waits, or nothing does. */
export type WaitingLine =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'attention'; text: string }
  | { kind: 'clear'; text: string }

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "8 requests need you · 1 failed", "1 request needs you", "2 requests failed", or "Nothing needs you right now." */
export function approvalsWaitingText(counts: WaitingCounts): string {
  const needsYou = Math.max(0, counts.needsYou)
  const failed = Math.max(0, counts.failed)
  const parts: string[] = []
  if (needsYou > 0) parts.push(`${needsYou} ${plural(needsYou, 'request needs', 'requests need')} you`)
  if (failed > 0) parts.push(needsYou > 0 ? `${failed} failed` : `${failed} ${plural(failed, 'request', 'requests')} failed`)
  return parts.length > 0 ? parts.join(' · ') : NOTHING_NEEDS_YOU
}

/**
 * The line for the component's state. A failed read says so, even when an earlier read worked: an old number shown
 * as if it were today's could read as "nothing needs you" when something does.
 */
export function approvalsWaitingLine(read: { counts: WaitingCounts | null; failed: boolean }): WaitingLine {
  if (read.failed) return { kind: 'error', text: COUNT_NOT_READ }
  if (!read.counts) return { kind: 'loading' }
  const text = approvalsWaitingText(read.counts)
  return read.counts.needsYou > 0 || read.counts.failed > 0 ? { kind: 'attention', text } : { kind: 'clear', text }
}

/** The answer of `/queue/counts`, or null when it is not one (an older API, an error body). */
export function readWaitingCounts(body: unknown): WaitingCounts | null {
  if (!body || typeof body !== 'object') return null
  const { needsYou, failed } = body as Record<string, unknown>
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  return isCount(needsYou) && isCount(failed) ? { needsYou, failed } : null
}
