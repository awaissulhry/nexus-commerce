/**
 * MCP full control 07 O7 — the customer desk's writes, moved out of routes/customers.routes.ts so the Customers page and
 * Claude's `update-customer` write one way: a note (add, delete), the tags, and the manual risk review. The code is the
 * routes' own: the routes answer exactly as before (routes/order-desk-update-parity.vitest.test.ts). Every write runs in
 * the caller's business (row-level security).
 */

import prisma from '../../db.js'

export const MANUAL_REVIEW_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const

/** Adds a note: 'invalid' without text, 'not_found' without the customer. */
export async function addCustomerNote(customerId: string, body: { body?: string; pinned?: boolean; authorEmail?: string | null; authorUserId?: string | null }) {
  if (!body.body || body.body.trim() === '') return { status: 'invalid' as const }
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } })
  if (!customer) return { status: 'not_found' as const }
  const note = await prisma.customerNote.create({
    data: {
      customerId,
      body: body.body.trim(),
      pinned: body.pinned ?? false,
      authorEmail: body.authorEmail ?? null,
      ...(body.authorUserId ? { authorUserId: body.authorUserId } : {}),
    },
  })
  return { status: 'created' as const, note }
}

/** Edits a note's text or pin; null when the customer has no such note. */
export async function updateCustomerNote(customerId: string, noteId: string, body: { body?: string; pinned?: boolean }) {
  const existing = await prisma.customerNote.findFirst({ where: { id: noteId, customerId } })
  if (!existing) return null
  return prisma.customerNote.update({
    where: { id: noteId },
    data: {
      body: body.body !== undefined ? body.body.trim() : undefined,
      pinned: body.pinned !== undefined ? body.pinned : undefined,
    },
  })
}

/** Deletes a note; false when the customer has no such note. */
export async function deleteCustomerNote(customerId: string, noteId: string): Promise<boolean> {
  const existing = await prisma.customerNote.findFirst({ where: { id: noteId, customerId } })
  if (!existing) return false
  await prisma.customerNote.delete({ where: { id: noteId } })
  return true
}

/** Replaces the customer's tags (replace-array semantics, as the page sends them). */
export async function setCustomerTags(customerId: string, tags: string[]) {
  const updated = await prisma.customer.update({ where: { id: customerId }, data: { tags } })
  return { id: updated.id, tags: updated.tags }
}

/** O.22 — the manual risk review: PENDING, APPROVED, REJECTED, or null (none). */
export async function setManualReviewState(customerId: string, state: string | null) {
  return prisma.customer.update({
    where: { id: customerId },
    data: { manualReviewState: state },
    select: { id: true, manualReviewState: true },
  })
}
