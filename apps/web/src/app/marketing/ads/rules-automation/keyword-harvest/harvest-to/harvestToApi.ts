/**
 * "Harvest to…" — taking back a change set before it ran, on the shared client's calls (lane HTO, 2026-10-11).
 *
 * An approved harvest waits a short undo window before it goes to Amazon (the Approvals page's own rule: AP.4). Inside
 * that window — or while the sweep has not picked it up — `POST /api/agent/fleet/approvals/:id/undo` puts it back to
 * "waiting"; the page then rejects it (`POST /api/advertising/harvest/waiting/decide`), so nothing is sent and nothing is
 * left waiting. Once it runs, the undo is a harvest undo (`POST /api/advertising/harvest/undo`).
 */
import { decideWaiting, takeBackApproval } from '../_shared/harvestApi'
import type { RequestStatus } from '../_shared/types'

/** Plain words for a refusal to take back. */
export function takeBackWords(words: string): string {
  return /too late|already (executing|executed|applied|done)/i.test(words) ? 'It is going to Amazon now: Undo again in a moment' : words
}

/**
 * Take back a change set that has not run: an approved one is un-approved first, then it is rejected (nothing sent,
 * nothing left waiting). A request still waiting for an approval is just rejected.
 */
export async function takeBack(approvalId: string, status: RequestStatus): Promise<{ ok: true } | { ok: false; words: string; unapproved: boolean }> {
  const unapprove = status !== 'queued'
  if (unapprove) {
    const back = await takeBackApproval(approvalId)
    if (!back.ok) return { ok: false, words: takeBackWords(back.words), unapproved: false }
  }
  // Un-approved but not rejected = it waits for approval again: the caller says so (`unapproved`).
  const out = await decideWaiting([{ approvalId, decide: 'reject' }], 'Taken back on the Keyword Harvest page before it ran')
  if (!out.ok) return { ok: false, words: out.words, unapproved: unapprove }
  const r = out.data.results[0]
  return r?.ok ? { ok: true } : { ok: false, words: r?.error ?? 'Not taken back', unapproved: unapprove }
}
