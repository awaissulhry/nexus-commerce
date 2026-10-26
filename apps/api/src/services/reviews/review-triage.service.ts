/**
 * MCP full control 07 O7 — the review desk's triage (RX.2), moved out of routes/reviews.routes.ts so the review desk
 * and Claude's `triage-reviews` write one way: status, assignee, tags and note. The code is the route's own: the route
 * answers exactly as before (routes/order-desk-update-parity.vitest.test.ts). It runs in the caller's business.
 */

import prisma from '../../db.js'

export const TRIAGE_STATUSES = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED'] as const

/** `status: null` clears it (an undo putting back a review that had none). */
export type TriageInput = { status?: string | null; assignee?: string | null; tags?: string[]; note?: string | null }

/** Triage one review: 'invalid_status', 'not_found', or the review as it is now. */
export async function triageReview(id: string, b: TriageInput) {
  if (b.status && !(TRIAGE_STATUSES as readonly string[]).includes(b.status)) return { error: 'invalid_status' as const }
  const existing = await prisma.review.findUnique({ where: { id }, select: { id: true } })
  if (!existing) return { error: 'not_found' as const }
  const data: Record<string, unknown> = { triageUpdatedAt: new Date() }
  if (b.status !== undefined) data.triageStatus = b.status
  if (b.assignee !== undefined) data.assignee = b.assignee
  if (b.tags !== undefined) data.triageTags = b.tags
  if (b.note !== undefined) data.triageNote = b.note
  const review = await prisma.review.update({ where: { id }, data })
  return { review }
}

/**
 * Reviews Inbox bulk bar — Assign, Tag or Set status on the rows `planInboxBulk` kept (already checked: visible, and
 * the action changes them). Returns how many rows changed. A tag is added to each row's own tags.
 */
export async function applyBulkTriage(
  action: 'assign' | 'tag' | 'status',
  value: string | null,
  rows: { id: string; triageTags: string[] }[],
): Promise<number> {
  if (rows.length === 0) return 0
  const triageUpdatedAt = new Date()
  const ids = rows.map((r) => r.id)
  if (action === 'assign') {
    return (await prisma.review.updateMany({ where: { id: { in: ids } }, data: { assignee: value, triageUpdatedAt } })).count
  }
  if (action === 'status') {
    if (!value || !(TRIAGE_STATUSES as readonly string[]).includes(value)) return 0
    return (await prisma.review.updateMany({ where: { id: { in: ids } }, data: { triageStatus: value, triageUpdatedAt } })).count
  }
  if (!value) return 0
  let changed = 0
  for (const row of rows) {
    if (row.triageTags.includes(value)) continue
    await prisma.review.update({ where: { id: row.id }, data: { triageTags: [...row.triageTags, value], triageUpdatedAt } })
    changed += 1
  }
  return changed
}
