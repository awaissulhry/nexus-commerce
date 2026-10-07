/**
 * R14 (MCP full control, part 06) — a budget schedule's edit and delete, moved unchanged out of
 * `PATCH` / `DELETE /advertising/budget-schedules/:id` (advertising.routes.ts), so tune-ad-engine edits a schedule's
 * windows and turn-down-automation switches one off through the same code — with the same give-back (W4): a schedule
 * disabled or deleted while it holds a budget gives that budget back. The routes answer byte for byte as before
 * (automation-tune-route-parity.vitest.test.ts), plus 3b's `kept` count in the give-back result.
 *
 * 3c — the create moved here too (`POST`, same answers), and two rules were added (review 6.5, 6.8):
 *   · a campaign taken out of a switched-on schedule gets its budget back, with the same check as a pause;
 *   · a campaign is in one switched-on budget schedule at a time (Owner S13): a create, a campaigns edit or a
 *     re-enable that would put it in a second one is refused, and the answer names the other schedule (409).
 */
import type { BudgetSchedule } from '@prisma/client'
import { checkDecimal, DECIMAL_RANGE, type DecimalRange } from '@nexus/shared/ads-number'
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
 * W4-7 — what Claude's set-budget-schedule adds to a save the screen makes the same way: the approval its give-backs
 * carry as their change set. Absent on every screen save (the routes pass none), so their writes are unchanged.
 */
export interface ScheduleWriteOptions { changeSetId?: string }

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
export async function restoreBudgetScheduleBase(s: { id: string; campaigns: unknown; lastApplied: unknown }, opts: ScheduleWriteOptions = {}): Promise<BudgetScheduleRestore> {
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
        // W4-7 — a give-back a Claude request caused carries its approval (delivery and undo find it); the screen's carry none.
        ...(opts.changeSetId ? { changeSetId: opts.changeSetId } : {}),
      })
      // `.ok` is three-way: `no_changes` is ok:true and enqueues nothing, so counting it as a
      // restore would overstate what this route gave back. Same branch as the executor's.
      if (outcome.ok && outcome.error !== 'no_changes') restored++
      else if (!outcome.ok) { refused++; logger.warn('[budget-schedule] restore refused', { scheduleId: s.id, campaignId: c.id, error: outcome.error }) }
    } catch { refused++ /* best-effort, mirrors dayparting's resume */ }
  }
  return { restored, kept, refused }
}

type ScheduleCampaign = { id: string; name?: string | null; dailyBudget?: number | null }
const campaignsOf = (v: unknown): ScheduleCampaign[] =>
  Array.isArray(v) ? (v as ScheduleCampaign[]).filter((c) => c != null && typeof c.id === 'string' && c.id !== '') : []

/** 3c — a create, edit or re-enable refused because a campaign is already in another switched-on budget schedule. */
export interface BudgetScheduleConflict {
  /** The sentence the screen shows: which campaigns, which schedule, what to do. */
  error: string
  scheduleId: string
  scheduleName: string
  campaignIds: string[]
}

/**
 * 3c (review 6.8, Owner S13) — is any of these campaigns already in ANOTHER switched-on budget schedule?
 *
 * Two schedules on one campaign fight: each records the budget it found and gives back its own, so the older one's
 * give-back reset the budget inside the newer one's window, and the newer one then stood down. One schedule per
 * campaign removes the fight instead of ranking the two. A switched-off schedule does not count — it holds nothing
 * (its pause gave the budgets back) — which is why switching one back on is checked too.
 */
export async function budgetScheduleConflict(campaigns: unknown, exceptId: string | null): Promise<BudgetScheduleConflict | null> {
  const mine = new Map(campaignsOf(campaigns).map((c) => [c.id, c]))
  if (mine.size === 0) return null
  const others = await prisma.budgetSchedule.findMany({
    where: { kind: 'BUDGET', enabled: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, campaigns: true },
    orderBy: { createdAt: 'asc' },
  })
  const hits = others
    .map((o) => ({ o, shared: campaignsOf(o.campaigns).filter((c) => mine.has(c.id)) }))
    .filter((h) => h.shared.length > 0)
  if (hits.length === 0) return null
  const { o, shared } = hits[0]
  const names = shared.map((c) => `“${mine.get(c.id)?.name || c.name || c.id}”`)
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  const who = shared.length === 1 ? `The campaign ${list} is` : `${shared.length} campaigns (${list}) are`
  const more = hits.length > 1 ? ` ${hits.length - 1} other budget schedule${hits.length === 2 ? '' : 's'} also hold${hits.length === 2 ? 's' : ''} some of these campaigns.` : ''
  return {
    error: `${who} already in the budget schedule “${o.name}”. A campaign can be in one switched-on budget schedule at a time: take ${shared.length === 1 ? 'it' : 'them'} out of “${o.name}”, or pause that schedule, first.${more}`,
    scheduleId: o.id,
    scheduleName: o.name,
    campaignIds: shared.map((c) => c.id),
  }
}

/** 4b — a create or edit refused because a window's value cannot be read or is out of range (the route's 400). */
export interface BudgetScheduleInvalid { error: string }

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Each adjustment's words and range. A set budget is at least €1, Amazon's lowest daily budget. */
const WINDOW_VALUE: Record<string, { words: string; range: DecimalRange }> = {
  set: { words: 'Set budget to (€)', range: { min: 1 } },
  incPct: { words: 'Increase budget by (%)', range: DECIMAL_RANGE.increasePct },
  decPct: { words: 'Decrease budget by (%)', range: DECIMAL_RANGE.decreasePct },
}
const MULTIPLIER_VALUE = { words: 'Multiplier (×)', range: DECIMAL_RANGE.multiplier }

/**
 * 4b (review 4.1) — a schedule's window values, read and range-checked before anything is stored.
 *
 * The builder sent `Number(value) || 0` and the executor read the same way, so a decimal comma or a typo became 0:
 * "Set budget 15,50" put €1 (Amazon's floor) on every picked campaign. Now "15,50" is 15.5, a value that cannot be
 * read or is out of range refuses the whole save with a sentence naming the window, and each stored value is the
 * number it says (every reader — the executor, tune-ad-engine, the screen — then sees a number). `type` is the
 * schedule's, from the body or the stored row. Anything that is not a list of windows is left as it was. W4-7 — exported:
 * set-budget-schedule refuses at its preview what the save would refuse, in the same words.
 */
export function readScheduleWindows(windows: unknown, type: unknown): { windows: unknown } | { invalid: BudgetScheduleInvalid } {
  if (!Array.isArray(windows)) return { windows }
  const out: unknown[] = []
  for (const w of windows as Array<Record<string, unknown> | null>) {
    if (w == null || typeof w !== 'object') { out.push(w); continue }
    const spec = type === 'budget-multiplier' ? MULTIPLIER_VALUE : WINDOW_VALUE[String(w.adj ?? '')]
    const when = `${WEEKDAY[Number(w.day)] ?? `Day ${String(w.day)}`} ${w.start && w.end ? `${String(w.start)}–${String(w.end)}` : '(all day)'}`
    const check = checkDecimal(w.value, `${when}: ${spec?.words ?? 'the value'}`, spec?.range ?? {}, spec != null)
    if (check.ok === false) return { invalid: { error: check.error } }
    out.push(check.value != null ? { ...w, value: check.value } : w)
  }
  return { windows: out }
}

/**
 * POST /advertising/budget-schedules, moved unchanged out of advertising.routes.ts (3c) — plus the one-schedule rule:
 * a new schedule is switched on, so a campaign already in another switched-on schedule refuses the create.
 * The route checks the name (400) before it calls this.
 */
export async function createBudgetSchedule(b: Record<string, unknown>, actor: AdsActor): Promise<{ schedule: BudgetSchedule } | { conflict: BudgetScheduleConflict } | { invalid: BudgetScheduleInvalid }> {
  const read = readScheduleWindows(b.windows, b.type) // 4b — before anything else is checked or written
  if ('invalid' in read) return read
  const conflict = await budgetScheduleConflict(b.campaigns, null)
  if (conflict) return { conflict }
  const schedule = await prisma.budgetSchedule.create({ data: {
    name: String(b.name), kind: 'BUDGET', type: (b.type as string) ?? 'CAMPAIGN_BUDGET',
    campaigns: (b.campaigns as object) ?? [], windows: (read.windows as object) ?? [],
    timezone: (b.timezone as string) ?? 'Europe/Rome', chartPrefs: (b.chartPrefs as object) ?? {},
    startDate: b.startDate ? new Date(String(b.startDate)) : null,
    endDate: b.endDate ? new Date(String(b.endDate)) : null,
    // BSP.2 (§2.2) — only an ARRAY of ranges is a blackout list. The old `?? []` let the
    // builder's boolean `false` through into a Json column documented as `[{start,end}]`.
    neverExpire: b.neverExpire !== false, excludeDates: Array.isArray(b.excludeDates) ? b.excludeDates : [],
    /**
     * 🔴 BSP-B5 sweep — `autoRefill` is NOT read from the body any more.
     *
     * The column has zero readers: `ad-budget-schedule.job.ts` never consults it, the builder
     * never sends it, and BSP.2 removed its grid column for exactly that reason. Accepting a
     * value the system cannot honour is the same false wiring one layer down — an API caller
     * could set it, see it echoed back, and reasonably believe something would refill. The
     * column stays (dropping it is a destructive migration and H10 does have the feature), but
     * it is now writable only by a future executor that actually implements it.
     */
  } })
  // BSP.2 (§2.6) — the schedule's own edit history was unrecorded (unlike the rank side's
  // RankScheduleVersion). One audit row per CRUD; best-effort, never fails the write.
  await prisma.advertisingActionLog.create({
    data: {
      userId: actor,
      actionType: 'budget_schedule_create', entityType: 'BUDGET_SCHEDULE', entityId: schedule.id,
      payloadBefore: {}, payloadAfter: { name: schedule.name, type: schedule.type, enabled: schedule.enabled },
      amazonResponseStatus: 'SUCCESS',
    },
  }).catch(() => { /* audit must never fail the write it describes */ })
  return { schedule }
}

/**
 * PATCH /advertising/budget-schedules/:id. null = not found (the route's 404), as any failure inside always was;
 * `conflict` = 3c's one-schedule rule refused the edit (the route's 409) and nothing was changed; `invalid` = 4b, a
 * window value that cannot be read or is out of range (the route's 400), and nothing was changed.
 */
export async function patchBudgetSchedule(id: string, b: Record<string, unknown>, actor: AdsActor, opts: ScheduleWriteOptions = {}): Promise<{ schedule: BudgetSchedule; restore: BudgetScheduleRestore | null } | { conflict: BudgetScheduleConflict } | { invalid: BudgetScheduleInvalid } | null> {
  const data: Record<string, unknown> = {}
  // BSP-B5 sweep — `autoRefill` dropped from the accepted set for the reason given in createBudgetSchedule.
  for (const k of ['name', 'type', 'campaigns', 'windows', 'timezone', 'chartPrefs', 'neverExpire', 'excludeDates', 'enabled']) if (b[k] !== undefined) data[k] = b[k]
  // BSP.2 (§2.2) — same sanitisation as create: an array or nothing.
  if (data.excludeDates !== undefined && !Array.isArray(data.excludeDates)) data.excludeDates = []
  if (b.startDate !== undefined) data.startDate = b.startDate ? new Date(String(b.startDate)) : null
  if (b.endDate !== undefined) data.endDate = b.endDate ? new Date(String(b.endDate)) : null
  // 4b — new windows are read against the schedule's type: the one this edit sets, or the stored one.
  if (data.windows !== undefined) {
    const type = b.type !== undefined ? b.type
      : (await prisma.budgetSchedule.findUnique({ where: { id }, select: { type: true } }).catch(() => null))?.type
    if (type === undefined) return null
    const read = readScheduleWindows(data.windows, type)
    if ('invalid' in read) return read
    data.windows = read.windows
  }
  const editsCampaigns = data.campaigns !== undefined
  try {
    // W4 — read before write, so a disable can give back what THIS schedule applied.
    // 3c — and so a campaigns edit can give back the campaigns it takes out, and an edit or a re-enable can be checked.
    const before = data.enabled !== undefined || editsCampaigns
      ? await prisma.budgetSchedule.findUnique({ where: { id }, select: { id: true, enabled: true, campaigns: true, lastApplied: true } })
      : null
    // 3c (Owner S13) — still switched on after this edit, with new campaigns or just switched back on: one schedule per campaign.
    const onAfter = data.enabled !== undefined ? data.enabled === true : before?.enabled === true
    if (before && onAfter && (editsCampaigns || !before.enabled)) {
      const conflict = await budgetScheduleConflict(editsCampaigns ? data.campaigns : before.campaigns, id)
      if (conflict) return { conflict }
    }
    const schedule = await prisma.budgetSchedule.update({ where: { id }, data })
    // Disable AFTER the update: the executor only reads enabled schedules, so once the row says
    // enabled:false the cron cannot race this restore by re-applying the window.
    // BSP-P3 — the outcome is REPORTED now: "paused" and "paused, and 3 campaigns kept the boost
    // because the restore was refused" are different facts and the operator gets the second one.
    // 3c (review 6.5) — a campaign taken out of a switched-on schedule is given back the same way, AFTER the update
    // for the same reason: the executor only reads the schedule's campaigns, so it can no longer re-apply the window.
    // Before, the executor simply stopped seeing it and its boost stayed for good.
    const staying = new Set(editsCampaigns ? campaignsOf(data.campaigns).map((c) => c.id) : [])
    const removed = editsCampaigns && before ? campaignsOf(before.campaigns).filter((c) => !staying.has(c.id)) : []
    const restore = before?.enabled !== true ? null
      : data.enabled === false ? await restoreBudgetScheduleBase(before, opts)
      : removed.length > 0 ? await restoreBudgetScheduleBase({ id, campaigns: removed, lastApplied: before.lastApplied }, opts)
      : null
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
export async function deleteBudgetSchedule(id: string, actor: AdsActor, opts: ScheduleWriteOptions = {}): Promise<{ ok: true; restore: BudgetScheduleRestore | null } | null> {
  try {
    const gone = await prisma.budgetSchedule.delete({ where: { id } })
    // W4 — restore base AFTER the delete (the executor can no longer see the row, so it cannot
    // re-apply mid-restore). Before this, deleting a schedule mid-window left the boosted
    // budget in place forever — the one writer that knew the base was gone.
    // BSP-P3 — and the outcome is reported rather than assumed.
    const restore = gone.enabled ? await restoreBudgetScheduleBase(gone, opts) : null
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

// ── W4-7 — reads for Claude's set-budget-schedule and ad-budgets (nothing here writes) ──────────────────────

/** One budget schedule as Claude reads it, or null (not found, or not a budget schedule). */
export async function readBudgetSchedule(id: string) {
  return prisma.budgetSchedule.findFirst({
    where: { id, kind: 'BUDGET' },
    select: {
      id: true, name: true, type: true, enabled: true, campaigns: true, windows: true, timezone: true, startDate: true, endDate: true,
      neverExpire: true, excludeDates: true, lastApplied: true, lastEvaluatedAt: true, createdAt: true, updatedAt: true,
    },
  })
}
export type ClaudeBudgetSchedule = NonNullable<Awaited<ReturnType<typeof readBudgetSchedule>>>

/** Every budget schedule of the business, by name. */
export async function listBudgetSchedules() {
  return prisma.budgetSchedule.findMany({
    where: { kind: 'BUDGET' },
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, type: true, enabled: true, campaigns: true, windows: true, timezone: true, startDate: true, endDate: true,
      neverExpire: true, excludeDates: true, lastApplied: true, lastEvaluatedAt: true, createdAt: true, updatedAt: true,
    },
  })
}

/** What one campaign would get back if the schedule let go of it now (a pause, a delete, taken out of it). */
export interface ScheduleGiveBack {
  campaignId: string
  /** giveBack: back to its base; kept: someone moved it since the schedule set it (their change stays); nothing: it holds nothing. */
  act: 'giveBack' | 'kept' | 'nothing'
  liveCents: number | null
  baseCents: number | null
}

/**
 * What letting go of these campaigns would give back now, per campaign — the very check the give-back makes
 * (`giveBackCheck`, ad-budget-schedule.job.ts), read only. `only`: the campaigns let go (default: all of them). An
 * archived or missing campaign gets nothing back, as in restoreBudgetScheduleBase.
 */
export async function scheduleGiveBacks(s: { campaigns: unknown; lastApplied: unknown }, only?: readonly string[]): Promise<ScheduleGiveBack[]> {
  const wanted = only ? new Set(only) : null
  const camps = campaignsOf(s.campaigns).filter((c) => !wanted || wanted.has(c.id))
  if (!camps.length) return []
  const last = (s.lastApplied as Record<string, BSApplied> | null) ?? {}
  const { giveBackCheck } = await import('../../jobs/ad-budget-schedule.job.js')
  const rows = await prisma.campaign.findMany({ where: { id: { in: camps.map((c) => c.id) } }, select: { id: true, dailyBudget: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  return camps.map((c) => {
    const campaign = byId.get(c.id)
    if (!campaign || campaign.status === 'ARCHIVED') return { campaignId: c.id, act: 'nothing' as const, liveCents: null, baseCents: null }
    const liveCents = Math.round(Number(campaign.dailyBudget ?? 0) * 100)
    const check = giveBackCheck(last[c.id], liveCents, c.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null)
    return { campaignId: c.id, act: check.act, liveCents, baseCents: check.baseCents }
  })
}
