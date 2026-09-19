import prisma from '../../db.js'
import { requireWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'

/**
 * Shared stock — tell the owners of the business in context (the bell). Research rule 8: every
 * refusal and every cross-business change reaches a person; it is never only logged.
 *
 * One unread notice per person, type and entity: a second notice about the same thing is folded
 * into the unread one instead of stacked on top of it. Never throws — a notice that cannot be
 * written is logged, and the change it describes stands.
 */
export interface PoolNotice {
  type: string
  severity: 'info' | 'success' | 'warn' | 'danger'
  title: string
  body?: string | null
  entityType: string
  entityId: string
  /** A bare path; the bell's router adds the business prefix. */
  href?: string | null
  meta?: Record<string, unknown>
}

export async function notifyOwners(notice: PoolNotice): Promise<{ created: number; deduped: number }> {
  try {
    const { workspaceId } = requireWorkspace()
    const owners = await prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } },
      select: { userId: true },
    })
    let created = 0
    let deduped = 0
    for (const { userId } of owners) {
      const unread = await prisma.notification.findFirst({
        where: { userId, type: notice.type, entityType: notice.entityType, entityId: notice.entityId, readAt: null },
        select: { id: true },
      })
      if (unread) { deduped++; continue }
      await prisma.notification.create({
        data: {
          userId,
          type: notice.type,
          severity: notice.severity,
          title: notice.title,
          body: notice.body ?? null,
          entityType: notice.entityType,
          entityId: notice.entityId,
          href: notice.href ?? null,
          ...(notice.meta ? { meta: notice.meta as never } : {}),
        },
      })
      created++
    }
    return { created, deduped }
  } catch (error) {
    logger.warn('[stock-pool-notify] failed', { type: notice.type, error: String(error).slice(0, 160) })
    return { created: 0, deduped: 0 }
  }
}
