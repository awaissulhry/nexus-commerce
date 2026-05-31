/**
 * TD.0 — automation notifications. Fans an automation event out to every
 * operator's notification bell (the existing Notification model / /api/
 * notifications feed). Used by the `notify` rule action, the circuit-breaker,
 * and halt/resume events so a 24/7 agent's decisions are always observable.
 * Best-effort: a notification failure never breaks an automation run.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface AutomationNotice {
  type: string
  severity?: 'info' | 'success' | 'warn' | 'danger'
  title: string
  body?: string
  href?: string
  meta?: Record<string, unknown>
}

export async function notifyAutomation(n: AutomationNotice): Promise<number> {
  try {
    const users = await prisma.userProfile.findMany({ select: { id: true }, take: 100 })
    if (users.length === 0) return 0
    await prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: n.type,
        severity: n.severity ?? 'info',
        title: n.title,
        body: n.body ?? null,
        href: n.href ?? '/marketing/trading-desk/automation',
        meta: (n.meta ?? undefined) as never,
      })),
    })
    return users.length
  } catch (e) {
    logger.warn('[ads-automation-notify] failed', { error: String(e).slice(0, 140) })
    return 0
  }
}
