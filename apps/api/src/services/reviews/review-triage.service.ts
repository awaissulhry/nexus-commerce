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
