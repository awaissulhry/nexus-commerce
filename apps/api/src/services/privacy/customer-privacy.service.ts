/**
 * MCP full control 07 O6 — the buyers' privacy requests a business has received, read only.
 *
 * Today these are the eBay account-deletion notices Nexus matched to one of the business's orders (`ErasureRequest`,
 * written by cx/ingress/ebay-erasure-review.ts, status REVIEW_REQUIRED until a person decides in Nexus). The list holds
 * no personal data at all: ids, channel, how the notice was matched, status and dates, and the Nexus order it was
 * matched to (its id and channel order number). The notice itself (user name, e-mail) never leaves its quarantine.
 * Deciding, erasing and exporting are never Claude's (plan 07 §3, 09 §2): they stay a person's click in Nexus.
 */

import prisma from '../../db.js'

export interface PrivacyRequestFilter {
  status?: string
  channel?: string
}

/** The requests that match, newest first, from just after `after` (keyset on createdAt, id). */
export async function listPrivacyRequests(filter: PrivacyRequestFilter, page: { take: number; after?: { createdAt: Date; id: string } | null }) {
  const where = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.channel ? { channel: filter.channel } : {}),
  }
  const after = page.after
    ? { OR: [{ createdAt: { lt: page.after.createdAt } }, { createdAt: page.after.createdAt, id: { lt: page.after.id } }] }
    : {}
  const [total, byStatus, rows] = await Promise.all([
    prisma.erasureRequest.count({ where }),
    prisma.erasureRequest.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.erasureRequest.findMany({
      where: { AND: [where, after] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.take,
      select: {
        id: true,
        channel: true,
        environment: true,
        matchBasis: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        evidenceOrder: { select: { id: true, channel: true, channelOrderId: true } },
      },
    }),
  ])
  return {
    total,
    byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
    rows,
  }
}
