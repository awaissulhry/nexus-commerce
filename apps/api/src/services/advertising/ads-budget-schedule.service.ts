/**
 * R14 (MCP full control, part 06) — a budget schedule's edit and delete, moved unchanged out of
 * `PATCH` / `DELETE /advertising/budget-schedules/:id` (advertising.routes.ts), so tune-ad-engine edits a schedule's
 * windows and turn-down-automation switches one off through the same code — with the same give-back (W4): a schedule
 * disabled or deleted while it holds a budget gives that budget back. The routes answer byte for byte as before
 * (automation-tune-route-parity.vitest.test.ts), plus 3b's `kept` count in the give-back result.
 */
import type { BudgetSchedule } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'
import type { BSApplied } from '../../jobs/ad-budget-schedule.job.js'

/**
 * 3b — what a pause or a delete did with each campaign the schedule set a budget on:
 *   · `restored` — given back: the budget from just before the window is queued for Amazon;
 *   · `kept`     — someone changed the budget since this schedule set it, so their change stays;
 *   · `refused`  — the give-back was refused or failed, so the campaign keeps the schedule's budget.
 * A campaign already at that budget, or one this schedule never changed, counts in none of them.
 */
export interface BudgetScheduleRestore { restored: number; kept: number; refused: number }

/**
 * W4 (2026-08-20) — a schedule being DELETED or DISABLED mid-window must give the budgets back.
 *
 * The executor's revert is convergent ("outside every window → base"), so it only reverts
 * schedules it can still SEE: `findMany({ enabled: true })`. Deleting an active schedule — or
 * flipping `enabled` off — removed it from that set with its boost still applied, and nothing
 * would ever restore the base. Dayparting's own delete route has resumed campaigns since RC2.T3;
 * budget never did.
 *
 * 3b — the executor's own check (`giveBackCheck`, ad-budget-schedule.job.ts), so the two can never
 * disagree:
 *   · the base is the budget recorded just before the window opened (records written before 3b:
 *     the creation-time snapshot) — no longer the rules' captured baseline (review 6.3);
 *   · it gives back only a budget the schedule SET and still holds — a campaign whose window was
 *     refused, or that it only found already on target, is not touched (review 6.5);
 *   · a manual override wins — if the live budget is no longer the value THIS schedule set,
 *     someone else moved it since, and re-fighting them is the §3 precedence decision this route
 *     must not take on its own. It is counted as `kept`.
 * Best-effort per campaign, same as dayparting's resume.
 */
export async function restoreBudgetScheduleBase(s: { id: string; campaigns: unknown; lastApplied: unknown }): Promise<BudgetScheduleRestore> {
  const camps = Array.isArray(s.campaigns) ? s.campaigns as Array<{ id: string; dailyBudget?: number | null }> : []
  const last = (s.lastApplied as Record<string, BSApplied> | null) ?? {}
  let restored = 0, kept = 0, refused = 0
  if (camps.length === 0) return { restored, kept, refused }
  const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
  const { giveBackCheck, ownCentsOf } = await import('../../jobs/ad-budget-schedule.job.js')
  for (const c of camps) {
    const prev = last[c.id]
    if (ownCentsOf(prev) == null) continue // this schedule never set it
    const campaign = await prisma.campaign.findUnique({ where: { id: c.id }, select: { dailyBudget: true, status: true } })
    if (!campaign || campaign.status === 'ARCHIVED') continue
    const liveCents = Math.round(Number(campaign.dailyBudget ?? 0) * 100)
    const check = giveBackCheck(prev, liveCents, c.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null)
    if (check.act === 'kept') { kept++; continue } // moved by someone else since — their write wins
    if (check.act !== 'giveBack' || check.baseCents == null) continue
    const target = check.baseCents / 100
    try {
      // 🔴 BSP-P3 — the second of the two bare call sites. `updateCampaignWithSync` returns
      // `{ ok:false }` rather than throwing ([[reference_mutation_outcome_returned_not_thrown]]),
      // so this `catch` never saw a refusal and the route reported a restore that never happened.
      // The `as never` casts are gone: they are what hid the return type from review.
      const outcome = await updateCampaignWithSync({
        campaignId: c.id,
        patch: { dailyBudget: target },
        actor: `automation:budget-schedule-${s.id}`,
        reason: 'budget schedule removed or disabled — give back the budget before the window',
        applyImmediately: true,
        // 3b — the entry this gives back, for the history (the gate reads the action log, not this).
        ...(prev?.windowKey ? { evidence: { giveBackOf: prev.windowKey.replace(/#restore$/, '') } } : {}),
      })
      // `.ok` is three-way: `no_changes` is ok:true and enqueues nothing, so counting it as a
      // restore would overstate what this route gave back. Same branch as the executor's.
      if (outcome.ok && outcome.error !== 'no_changes') restored++
      else if (!outcome.ok) { refused++; logger.warn('[budget-schedule] restore refused', { scheduleId: s.id, campaignId: c.id, error: outcome.error }) }
    } catch { refused++ /* best-effort, mirrors dayparting's resume */ }
  }
  return { restored, kept, refused }
}

/** PATCH /advertising/budget-schedules/:id. null = not found (the route's 404), as any failure inside always was. */
export async function patchBudgetSchedule(id: string, b: Record<string, unknown>, actor: AdsActor): Promise<{ schedule: BudgetSchedule; restore: BudgetScheduleRestore | null } | null> {
  const data: Record<string, unknown> = {}
  // BSP-B5 sweep — `autoRefill` dropped from the accepted set for the reason given in POST (advertising.routes.ts).
  for (const k of ['name', 'type', 'campaigns', 'windows', 'timezone', 'chartPrefs', 'neverExpire', 'excludeDates', 'enabled']) if (b[k] !== undefined) data[k] = b[k]
  // BSP.2 (§2.2) — same sanitisation as create: an array or nothing.
  if (data.excludeDates !== undefined && !Array.isArray(data.excludeDates)) data.excludeDates = []
  if (b.startDate !== undefined) data.startDate = b.startDate ? new Date(String(b.startDate)) : null
  if (b.endDate !== undefined) data.endDate = b.endDate ? new Date(String(b.endDate)) : null
  try {
    // W4 — read before write, so a disable can give back what THIS schedule applied.
    const before = data.enabled === false
      ? await prisma.budgetSchedule.findUnique({ where: { id }, select: { id: true, enabled: true, campaigns: true, lastApplied: true } })
      : null
    const schedule = await prisma.budgetSchedule.update({ where: { id }, data })
    // Disable AFTER the update: the executor only reads enabled schedules, so once the row says
    // enabled:false the cron cannot race this restore by re-applying the window.
    // BSP-P3 — the outcome is REPORTED now: "paused" and "paused, and 3 campaigns kept the boost
    // because the restore was refused" are different facts and the operator gets the second one.
    const restore = before?.enabled === true ? await restoreBudgetScheduleBase(before) : null
    await prisma.advertisingActionLog.create({
      data: {
        userId: actor,
        actionType: 'budget_schedule_update', entityType: 'BUDGET_SCHEDULE', entityId: id,
        payloadBefore: {}, payloadAfter: { fields: Object.keys(data), enabled: schedule.enabled },
        amazonResponseStatus: 'SUCCESS',
      },
    }).catch(() => { /* best-effort */ })
    return { schedule, restore }
  } catch { return null }
}

/** DELETE /advertising/budget-schedules/:id. null = not found (the route's 404). */
export async function deleteBudgetSchedule(id: string, actor: AdsActor): Promise<{ ok: true; restore: BudgetScheduleRestore | null } | null> {
  try {
    const gone = await prisma.budgetSchedule.delete({ where: { id } })
    // W4 — restore base AFTER the delete (the executor can no longer see the row, so it cannot
    // re-apply mid-restore). Before this, deleting a schedule mid-window left the boosted
    // budget in place forever — the one writer that knew the base was gone.
    // BSP-P3 — and the outcome is reported rather than assumed.
    const restore = gone.enabled ? await restoreBudgetScheduleBase(gone) : null
    await prisma.advertisingActionLog.create({
      data: {
        userId: actor,
        actionType: 'budget_schedule_delete', entityType: 'BUDGET_SCHEDULE', entityId: id,
        payloadBefore: { name: gone.name, type: gone.type, enabled: gone.enabled }, payloadAfter: {},
        amazonResponseStatus: 'SUCCESS',
      },
    }).catch(() => { /* best-effort */ })
    return { ok: true, restore }
  } catch { return null }
}
