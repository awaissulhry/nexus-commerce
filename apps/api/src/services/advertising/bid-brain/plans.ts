/**
 * BID BRAIN BB-7 — the loaders of an hourly plan's hour for the campaigns the brain owns, and its receipts. What the hour
 * means for the bids is plan-hour.ts (pure).
 */
import prisma from '../../../db.js'
import { resolveActiveTargetKey, type ScheduleWindow } from '../rank-controller.js'
import { hourWindow, type PlanHour } from './plan-hour.js'

/**
 * Each owned campaign's plan hour now (`clockNow`: the database clock, as rank-defend reads it). Campaigns without a
 * goal-mode schedule are absent.
 */
export async function loadPlanHours(campaignIds: readonly string[], clockNow: Date): Promise<Map<string, PlanHour>> {
  const out = new Map<string, PlanHour>()
  if (!campaignIds.length) return out
  const { applyTargetOverrides, isGoalMode, nowInTz, pickActiveEvents, toSpec } = await import('../../../jobs/ad-rank-defend.job.js')
  const schedules = (await prisma.adSchedule.findMany({
    where: { campaignId: { in: [...campaignIds] }, enabled: true },
    select: { id: true, campaignId: true, name: true, windows: true, timezone: true, defaultTargetKey: true, targetOverrides: true, groupId: true, group: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })).filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  if (!schedules.length) return out
  const groupIds = [...new Set(schedules.map((s) => s.groupId).filter((g): g is string => !!g))]
  const events = groupIds.length
    ? await prisma.rankScheduleEvent.findMany({
      where: { groupId: { in: groupIds }, enabled: true, startsAt: { lte: clockNow }, endsAt: { gt: clockNow } },
      select: { groupId: true, windows: true, defaultTargetKey: true, name: true, startsAt: true, endsAt: true },
    })
    : []
  const eventByGroup = pickActiveEvents(events.map((e) => ({ ...e, enabled: true })), clockNow)
  const resolved = schedules.map((s) => {
    const ev = s.groupId ? eventByGroup.get(s.groupId) : undefined
    const { day, hour } = nowInTz(s.timezone || 'Europe/Rome', 0, clockNow)
    const windows = (ev ? ev.windows : s.windows) as ScheduleWindow[]
    const baseline = ev ? ev.defaultTargetKey : s.defaultTargetKey
    const key = resolveActiveTargetKey(windows, baseline, day, hour)
    // Owner decision A (10-10) — the hours of today the current target runs: "held to 15¢ by the plan at 14:00–16:00".
    const window = hourWindow(Array.from({ length: 24 }, (_, h) => resolveActiveTargetKey(windows, baseline, day, h) ?? null), hour)
    return { s, ev, key, window }
  })
  const keys = [...new Set(resolved.map((r) => r.key).filter((k): k is string => !!k))]
  const targets = keys.length ? await prisma.rankTarget.findMany({ where: { key: { in: keys } } }) : []
  const targetByKey = new Map(targets.map((t) => [t.key, t]))
  for (const { s, ev, key, window } of resolved) {
    if (out.has(s.campaignId)) continue
    const specOf = (k: string) => {
      const t = targetByKey.get(k)
      return t ? applyTargetOverrides(toSpec(t as never), s.targetOverrides as never) : null
    }
    const target = key ? targetByKey.get(key) : undefined
    out.set(s.campaignId, {
      scheduleId: s.id,
      name: s.group?.name ?? s.name,
      key,
      spec: target ? specOf(key!) : null,
      event: ev?.name ?? null,
      window,
    })
  }
  return out
}

/** Stamp the plans the brain ran this tick (AdSchedule.lastEvaluatedAt / lastApplied), one UPDATE per resolved key. */
export async function stampPlanReceipts(hours: ReadonlyMap<string, PlanHour>, at: Date): Promise<void> {
  if (!hours.size) return
  const { groupReceipts } = await import('../../../jobs/ad-rank-defend.job.js')
  const receipts = new Map([...hours.values()].map((h) => [h.scheduleId, h.spec ? h.key : null]))
  for (const [key, ids] of groupReceipts(receipts)) {
    await prisma.adSchedule.updateMany({ where: { id: { in: ids } }, data: { lastEvaluatedAt: at, lastApplied: key } }).catch(() => undefined)
  }
}
