import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_CHANGES_APPROVE, PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import type { ApproverOptionsView, ReleasedList, ReleasedQuery } from '@nexus/factory-domain/product/changes/screens'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, personMay, readOrderFor } from './store'

/**
 * B-W2b-244 (Changes & versions, SCR-117): two reads the screens need, added in the smallest marked way beside B-W2b-226's
 * (contracts: factory-domain product/changes/screens.ts).
 *
 *   GET /product/released-versions                    product.changes.view: style revisions released (RELEASED, or OBSOLETE
 *                                                     since), newest first, of the styles of every company the caller
 *                                                     reads changes of (and tenant-wide styles); each with the change
 *                                                     order that released it and the revision it replaced
 *   GET /product/change-orders/:id/approver-options   product.changes.manage: the ACTIVE office people holding
 *                                                     product.changes.approve over the order's company by their live roles
 *                                                     (as setApprovers checks them), never its author
 */

const RELEASED_LIMIT = 100
const MAX_PEOPLE = 500

/** GET /product/released-versions */
export async function listReleased(caller: CommandCaller, query: ReleasedQuery): Promise<ReleasedList> {
  const context = officeOf(caller)
  const limit = query.limit ?? RELEASED_LIMIT
  const styleScope = scopeWhere(actorOf(context), PRODUCT_CHANGES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput
  const q = query.q
  const where: Prisma.StyleRevisionWhereInput = {
    AND: [
      { status: { in: ['RELEASED', 'OBSOLETE'] }, releasedAt: { not: null } },
      { style: styleScope },
      query.styleId ? { styleId: query.styleId } : {},
      q
        ? {
            OR: [
              { style: { code: { contains: q, mode: 'insensitive' } } },
              { style: { name: { contains: q, mode: 'insensitive' } } },
              { changeOrdersTo: { some: { status: 'RELEASED', number: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {},
    ],
  }
  return caller.withClient(async (db) => {
    const found = await db.styleRevision.findMany({
      where,
      orderBy: [{ releasedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, styleId: true, revision: true, status: true, releasedAt: true, releasedById: true, effectiveFrom: true, changeNote: true, style: { select: { id: true, code: true, name: true } } },
    })
    const page = found.slice(0, limit)
    const orders = page.length
      ? await db.changeOrder.findMany({ where: { status: 'RELEASED', toRevisionId: { in: page.map((row) => row.id) } }, select: { id: true, number: true, title: true, toRevisionId: true, fromRevisionId: true } })
      : []
    const orderOf = new Map(orders.map((order) => [order.toRevisionId!, order]))
    // The revision each replaced: the change order's from-revision, else the style's newest earlier one released before.
    const earlier = page.length
      ? await db.styleRevision.findMany({
          where: { styleId: { in: [...new Set(page.map((row) => row.styleId))] }, status: { in: ['RELEASED', 'OBSOLETE'] } },
          select: { id: true, styleId: true, revision: true },
          orderBy: [{ revision: 'desc' }, { id: 'asc' }],
        })
      : []
    const revisionOf = new Map(earlier.map((row) => [row.id, row]))
    const rows = page.map((row) => {
      const order = orderOf.get(row.id) ?? null
      const from = order ? revisionOf.get(order.fromRevisionId) : earlier.find((other) => other.styleId === row.styleId && other.revision < row.revision)
      return {
        style: { id: row.style.id, code: row.style.code, name: row.style.name },
        revision: { id: row.id, revision: row.revision, status: row.status },
        previous: from ? { id: from.id, revision: from.revision } : null,
        releasedAt: toUtcIso(row.releasedAt!),
        releasedById: row.releasedById,
        effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString().slice(0, 10) : null,
        changeNote: row.changeNote,
        changeOrder: order ? { id: order.id, number: order.number, title: order.title } : null,
      }
    })
    return { rows, complete: found.length <= limit }
  })
}

/** GET /product/change-orders/:id/approver-options */
export async function approverOptions(caller: CommandCaller, changeOrderId: string): Promise<ApproverOptionsView> {
  const { context, row } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const users = await db.user.findMany({ where: { status: 'ACTIVE', id: { not: row.authorId } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: MAX_PEOPLE })
    const people: { id: string; name: string }[] = []
    for (const user of users) {
      if (await personMay(db, context.tenantId, user.id, PRODUCT_CHANGES_APPROVE, row.companyId, now)) people.push({ id: user.id, name: user.displayName })
    }
    people.sort((a, b) => a.name.localeCompare(b.name, 'it') || a.id.localeCompare(b.id))
    return { people, authorId: row.authorId }
  })
}
