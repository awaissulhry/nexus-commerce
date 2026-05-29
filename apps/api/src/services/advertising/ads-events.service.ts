/**
 * AX3.14 — Advertising Events log.
 *
 * A unified timeline of every change to the ad account — bid moves, budget
 * changes, pauses, promotions, negatives — sourced from AdvertisingActionLog.
 * Each event shows what changed, who/what triggered it (operator vs
 * automation vs system), the affected entity, and outcome. Operators can also
 * drop a custom annotation (e.g. "raised budgets for Prime Day") onto the
 * timeline for context alongside automated changes.
 */

import prisma from '../../db.js'

export interface AdEvent {
  id: string; time: string; eventType: string; changeResult: string
  source: 'Operator' | 'Automation' | 'System'; affectLevel: string; entityId: string
  user: string | null; status: string | null; rolledBack: boolean
}

function summarise(actionType: string, before: unknown, after: unknown): string {
  const a = (after ?? {}) as Record<string, unknown>
  const b = (before ?? {}) as Record<string, unknown>
  const eur = (c: unknown) => (typeof c === 'number' ? `€${(c / 100).toFixed(2)}` : null)
  if (a.note) return String(a.note)
  if (a.proposedBidCents != null || a.bidCents != null) return `bid → ${eur(a.proposedBidCents ?? a.bidCents)}`
  if (a.newDailyBudget != null || a.dailyBudget != null) return `budget → €${Number(a.newDailyBudget ?? a.dailyBudget).toFixed(2)}/d`
  if (a.percent != null) return `${Number(a.percent) >= 0 ? '+' : ''}${a.percent}%`
  if (a.status) return `${b.status ? `${b.status} → ` : ''}${a.status}`
  if (a.discountPct != null) return `${a.discountPct}% promo`
  if (a.adjustments) return 'placement bid adjustments'
  if (a.externalId !== undefined) return 'created'
  return actionType.replace(/_/g, ' ')
}

export async function listEvents(opts: { limit?: number; source?: string; entityType?: string } = {}): Promise<{ events: AdEvent[] }> {
  const rows = await prisma.advertisingActionLog.findMany({
    where: { ...(opts.entityType ? { entityType: opts.entityType } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.min(opts.limit ?? 200, 500),
    select: { id: true, createdAt: true, actionType: true, entityType: true, entityId: true, userId: true, executionId: true, amazonResponseStatus: true, rolledBackAt: true, payloadBefore: true, payloadAfter: true },
  })
  let events: AdEvent[] = rows.map((r) => ({
    id: r.id, time: r.createdAt.toISOString(), eventType: r.actionType,
    changeResult: summarise(r.actionType, r.payloadBefore, r.payloadAfter),
    source: r.executionId ? 'Automation' : r.userId ? 'Operator' : 'System',
    affectLevel: r.entityType, entityId: r.entityId, user: r.userId, status: r.amazonResponseStatus, rolledBack: !!r.rolledBackAt,
  }))
  if (opts.source) events = events.filter((e) => e.source === opts.source)
  return { events }
}

export async function addCustomEvent(input: { note: string; entityType?: string; entityId?: string; userId?: string }) {
  return prisma.advertisingActionLog.create({
    data: { actionType: 'custom_event', entityType: input.entityType ?? 'CUSTOM', entityId: input.entityId ?? '-', payloadBefore: {}, payloadAfter: { note: input.note } as object, amazonResponseStatus: 'SUCCESS', userId: input.userId ?? 'user' },
  })
}
