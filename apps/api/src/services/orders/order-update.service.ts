/**
 * MCP full control 07 O7 — the order desk's own writes on an order, moved out of routes/orders.routes.ts so the Orders
 * page and Claude's `update-order` write one way: a note (add, edit, delete), the order's tags, and "mark delivered".
 * The code is the routes' own: the routes answer exactly as before (routes/order-desk-update-parity.vitest.test.ts).
 * Every write runs in the caller's business (row-level security): another business's order is not found.
 */

import prisma from '../../db.js'

export type NoteInput = { body?: string; pinned?: boolean; authorEmail?: string | null; authorUserId?: string | null }

/** Adds a note: 'invalid' without text, 'not_found' without the order. */
export async function addOrderNote(orderId: string, body: NoteInput) {
  if (!body.body || body.body.trim() === '') return { status: 'invalid' as const }
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })
  if (!order) return { status: 'not_found' as const }
  const note = await prisma.orderNote.create({
    data: {
      orderId,
      body: body.body.trim(),
      pinned: body.pinned ?? false,
      authorEmail: body.authorEmail ?? null,
      ...(body.authorUserId ? { authorUserId: body.authorUserId } : {}),
    },
  })
  return { status: 'created' as const, note }
}

/** Edits a note's text or pin; null when the order has no such note. */
export async function updateOrderNote(orderId: string, noteId: string, body: { body?: string; pinned?: boolean }) {
  const existing = await prisma.orderNote.findFirst({ where: { id: noteId, orderId } })
  if (!existing) return null
  return prisma.orderNote.update({
    where: { id: noteId },
    data: {
      body: body.body !== undefined ? body.body.trim() : undefined,
      pinned: body.pinned !== undefined ? body.pinned : undefined,
    },
  })
}

/** Deletes a note; false when the order has no such note. */
export async function deleteOrderNote(orderId: string, noteId: string): Promise<boolean> {
  const existing = await prisma.orderNote.findFirst({ where: { id: noteId, orderId } })
  if (!existing) return false
  await prisma.orderNote.delete({ where: { id: noteId } })
  return true
}

/**
 * RV.2.4 — the operator's manual delivery: deliveredAt with source MANUAL (the Amazon sync's higher-authority guard
 * never overwrites it) and status DELIVERED. Null when the order does not exist.
 */
export async function markOrderDelivered(orderId: string, deliveredAt: Date) {
  try {
    return await prisma.order.update({
      where: { id: orderId },
      data: { deliveredAt, deliveredAtSource: 'MANUAL', status: 'DELIVERED' },
      select: { id: true, channelOrderId: true, deliveredAt: true, deliveredAtSource: true, status: true },
    })
  } catch (error: any) {
    if (error?.code === 'P2025') return null
    throw error
  }
}

/** The order's tags by name, sorted. */
export async function orderTagNames(orderId: string): Promise<string[]> {
  const rows = await prisma.orderTag.findMany({ where: { orderId }, select: { tag: { select: { name: true } } } })
  return rows.map((row) => row.tag.name).sort()
}

/**
 * 07 O7 — adds and removes tags on an order by name. Only tags the business already has (Settings › Tags) are put on:
 * an unknown name is refused, never created. Returns the names that do not exist, and the order's tags after.
 */
export async function setOrderTags(orderId: string, add: string[], remove: string[]) {
  const names = [...new Set([...add, ...remove])]
  const tags = names.length ? await prisma.tag.findMany({ where: { name: { in: names } }, select: { id: true, name: true } }) : []
  const byName = new Map(tags.map((tag) => [tag.name, tag.id]))
  const unknown = add.filter((name) => !byName.has(name))
  if (unknown.length) return { unknown, tags: await orderTagNames(orderId) }
  for (const name of add) {
    await prisma.orderTag.upsert({
      where: { orderId_tagId: { orderId, tagId: byName.get(name)! } },
      create: { orderId, tagId: byName.get(name)! },
      update: {},
    })
  }
  const removeIds = remove.map((name) => byName.get(name)).filter((id): id is string => !!id)
  if (removeIds.length) await prisma.orderTag.deleteMany({ where: { orderId, tagId: { in: removeIds } } })
  return { unknown: [], tags: await orderTagNames(orderId) }
}
