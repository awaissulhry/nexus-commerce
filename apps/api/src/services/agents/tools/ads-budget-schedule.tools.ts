/**
 * ADS AUTONOMY W4-7 (design agent-results/6 §4 "W3-6a") — set-budget-schedule: Claude asks to create, change, pause or
 * delete a budget schedule (Ads › Rules & automation › Budget schedules — not the Owner's Hourly Bids page), through the
 * screen's own services: createBudgetSchedule, patchBudgetSchedule, deleteBudgetSchedule (ads-budget-schedule.service.ts).
 * A schedule sets each of its campaigns' daily budget per time window (an amount, a percent up or down, or a whole day's
 * budget × a multiplier); its cron writes at Amazon when a window opens and gives the budget back when it closes.
 *
 *   create   a schedule, switched on as the screen makes one (or off: enabled false), its campaigns in no other
 *            switched-on schedule (the screen's one-schedule rule refuses it otherwise, naming the other).
 *   update   its name, campaigns (the whole list; a campaign taken out gets its budget back, as the screen does), windows
 *            (every window: they replace them all), time zone, dates; enabled false pauses it (it gives back the budgets
 *            it holds), true switches it back on.
 *   delete   gives back the budgets it holds, then it is gone.
 *
 * The give-back is the screen's own (restoreBudgetScheduleBase): written as the schedule's, only while a campaign still
 * sits at the budget the schedule set (someone's later change is kept), each write carrying the approval as change set.
 * The preview lists each give-back from → to now (scheduleGiveBacks — the same check), and the ones the write gate would
 * refuse (that campaign keeps the schedule's budget, as on the screen).
 *
 * What can raise spend, and the approver's code (ads-budget-kit.ts, the money family rule): a new schedule with a window
 * that can raise a budget, campaigns added to a schedule whose window can raise theirs, a delete or a campaign taken out
 * whose give-back raises a budget the schedule held lower — the code. A window edit of an existing schedule
 * (tune-ad-engine's lever) and a switch on or off with its give-back (turn-up / turn-down-automation's) behave as those
 * tools: listed in `raises`, no code.
 *
 * Undo: a create is deleted; an update is set back (its campaigns, windows, switch and dates as they were); a delete is
 * created again as it was — a new schedule (its record of what it applied is not brought back): reversibility partial.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import {
  budgetScheduleConflict, createBudgetSchedule, deleteBudgetSchedule, patchBudgetSchedule, readBudgetSchedule, readScheduleWindows, scheduleGiveBacks,
  type ClaudeBudgetSchedule, type ScheduleGiveBack,
} from '../../advertising/ads-budget-schedule.service.js'
import { fingerprint, lowers, windowText, type BudgetWindow } from '../../advertising/ads-engine-tune.service.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { approvedRun, BY_RULE_WORDS, canonical, notRun, ruleFactsFor, spOnlyRefusal } from './ads-change-kit.js'
import type { KitItem } from './ads-autonomy-kit.js'
import { budgetLimits, budgetReach, budgetReachNote, budgetRecheck, budgetRuleRefusal, budgetStepUp, codeGate, ID, named, plural, WHY } from './ads-budget-kit.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-budget-schedule'
const OPS = ['create', 'update', 'delete'] as const
const TYPES = ['campaign-budget', 'budget-multiplier'] as const
const MAX_CAMPAIGNS = 100
const LINES_SHOWN = 20
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time is HH:MM')
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 24)
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const input = z.object({
  op: z.enum(OPS).describe('create a schedule, update one (what is given changes), or delete one (it gives back the budgets it holds first)'),
  scheduleId: ID.optional().describe('update / delete: the budget schedule (its Nexus id, from ad-budgets)'),
  name: z.string().trim().min(1).max(120).optional().describe('create: its name (required); update: a new name'),
  type: z.enum(TYPES).optional().describe('create: campaign-budget (a daily budget per time window: set an amount, or raise or lower it by a percent) or budget-multiplier (a whole day\'s budget × a multiplier); campaign-budget when left out. A schedule keeps its type'),
  campaignIds: z.array(ID).min(1).max(MAX_CAMPAIGNS).optional()
    .describe(`create: its campaigns (Nexus ids, up to ${MAX_CAMPAIGNS}); update: the whole new list (a campaign left out is taken out and gets its budget back, as the screen does)`),
  windows: z.array(z.object({
    day: z.coerce.number().int().min(0).max(6).describe('weekday, 0 = Sunday … 6 = Saturday'),
    start: HHMM.optional().describe('HH:MM in the schedule\'s time zone; leave out with end for all day (a multiplier schedule is all day)'),
    end: HHMM.optional().describe('HH:MM'),
    adj: z.enum(['set', 'incPct', 'decPct', 'mult']).optional().describe('campaign-budget: set (the daily budget, in the campaign\'s own currency, e.g. 15.5), incPct or decPct (a percent of its budget before the window); a multiplier schedule: mult (or left out)'),
    value: z.coerce.number().min(0).max(100_000).describe('the amount (in the campaign\'s own currency, a decimal: 15.5), the percent, or the multiplier (×, above 0, at most 10)'),
  })).min(1).max(168).optional().describe('create: its windows; update: every window (they replace them all)'),
  timezone: z.string().trim().min(1).max(64).optional().describe('create: the time zone its windows are in (Europe/Rome when left out, as the screen); update: a new one'),
  startDate: DATE.optional().describe('the first day it runs, YYYY-MM-DD (create: today when left out)'),
  endDate: DATE.nullable().optional().describe('the last day it runs, YYYY-MM-DD; null = it never ends (create: never when left out)'),
  excludeDates: z.array(z.object({ start: DATE.describe('first day, YYYY-MM-DD'), end: DATE.describe('last day, YYYY-MM-DD') })).max(50).optional()
    .describe('days it does not run (blackout ranges); update: the whole new list'),
  enabled: z.boolean().optional().describe('update: false pauses it (it gives back the budgets it holds, as the screen); true switches it back on. create: false makes it switched off'),
  why: WHY,
})
type Args = z.infer<typeof input>

/** A schedule as a change records it, and as `current` reads it back (the undo guard compares the two). */
interface ScheduleState {
  scheduleId: string | null
  name: string
  type: string
  enabled: boolean
  timezone: string
  startDate: string | null
  endDate: string | null
  excludeDates: Array<{ start: string; end: string }>
  campaignIds: string[]
  windows: BudgetWindow[]
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const campaignIdsOf = (v: unknown): string[] => (Array.isArray(v) ? (v as Array<{ id?: unknown }>).map((c) => String(c?.id ?? '')).filter(Boolean) : [])
const windowsOf = (v: unknown): BudgetWindow[] => (Array.isArray(v) ? (v as BudgetWindow[]) : [])
const datesOf = (v: unknown): Array<{ start: string; end: string }> => (Array.isArray(v) ? (v as Array<{ start: string; end: string }>) : [])

function stateOf(s: ClaudeBudgetSchedule): ScheduleState {
  return {
    scheduleId: s.id, name: s.name, type: s.type, enabled: s.enabled, timezone: s.timezone, startDate: day(s.startDate), endDate: s.neverExpire ? null : day(s.endDate),
    excludeDates: datesOf(s.excludeDates), campaignIds: campaignIdsOf(s.campaigns), windows: windowsOf(s.windows),
  }
}

/** The windows as the builder writes them: the fields it knows; a multiplier row is all day (no hours). */
function normalWindows(windows: NonNullable<Args['windows']>, type: string): BudgetWindow[] {
  return windows.map((w) => {
    const allDay = type === 'budget-multiplier' || (w.start == null && w.end == null)
    return Object.fromEntries(Object.entries({
      day: w.day, ...(allDay ? (type === 'budget-multiplier' ? { start: '', end: '' } : {}) : { start: w.start, end: w.end }),
      adj: type === 'budget-multiplier' ? 'mult' : w.adj, value: w.value,
    }).filter(([, v]) => v !== undefined)) as unknown as BudgetWindow
  })
}

/** Why a window list is refused before the save would refuse it (the screen's and tune-ad-engine's rules). */
function windowsRefusal(windows: NonNullable<Args['windows']>, type: string): string | null {
  for (const w of windows) {
    if ((w.start == null) !== (w.end == null)) return `a window needs both start and end, or neither (all day): ${DAY_WORDS[w.day]} ${w.start ?? w.end}`
    if (w.start && w.end && w.start >= w.end) return `a window ends after it starts: ${DAY_WORDS[w.day]} ${w.start}–${w.end}`
    if (type === 'budget-multiplier') {
      if (w.adj && w.adj !== 'mult') return `a multiplier schedule's windows apply a multiplier (adj mult, or left out), not ${w.adj}`
      if (!(w.value > 0 && w.value <= 10)) return `a multiplier is above 0 and at most 10: ${DAY_WORDS[w.day]} ×${w.value}`
    } else if (!w.adj || w.adj === 'mult') return `a campaign-budget window needs adj set, incPct or decPct: ${DAY_WORDS[w.day]}`
  }
  return null
}

/** The campaigns named, as a schedule stores them (the screen's shape), or why one cannot be in a schedule. */
async function scheduleCampaigns(ids: readonly string[]): Promise<{ entries: Array<{ id: string; name: string; marketplace: string | null; adProduct: string | null; dailyBudget: number }>; labels: Map<string, { label: string; marketplace: string | null; currency: string }> } | { refusal: string }> {
  if (new Set(ids).size !== ids.length) return { refusal: 'campaignIds names a campaign twice.' }
  const rows = await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, dailyBudget: true, dailyBudgetCurrency: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { refusal: `Not queued: campaign ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.` }
  const cannot = ids.map((id) => byId.get(id)!).map((c) => ({ c, why: spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name }) ?? (String(c.status) === 'ARCHIVED' ? 'it is archived' : null) })).filter((x) => x.why)
  if (cannot.length) return { refusal: `Not queued: ${named(cannot.map((x) => `campaign "${x.c.name}": ${x.why}`))}.` }
  return {
    entries: ids.map((id) => { const c = byId.get(id)!; return { id: c.id, name: c.name, marketplace: c.marketplace, adProduct: c.adProduct, dailyBudget: Number(c.dailyBudget) } }),
    labels: new Map(rows.map((c) => [c.id, { label: `campaign "${c.name}"`, marketplace: c.marketplace, currency: campaignCurrency(c) }])),
  }
}

/** Every campaign a schedule names, labelled (the ones it holds now, gone ones by id). */
async function labelsOf(ids: readonly string[]) {
  const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, marketplace: true, dailyBudgetCurrency: true } }) : []
  const byId = new Map(rows.map((c) => [c.id, { label: `campaign "${c.name}"`, marketplace: c.marketplace, currency: campaignCurrency(c) }]))
  return new Map(ids.map((id) => [id, byId.get(id) ?? { label: `campaign ${id}`, marketplace: null, currency: 'EUR' }]))
}

interface Planned {
  result: ToolResult
  /** What `execute` sends the screen's service. */
  body?: Record<string, unknown>
  schedule?: ClaudeBudgetSchedule | null
}

/** The request, planned and judged: its preview and the body the service gets. */
async function plan(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<Planned> {
  const refuse = (error: string): Planned => ({ result: { ok: false, error } })
  const existing = a.op === 'create' ? null : a.scheduleId ? await readBudgetSchedule(a.scheduleId) : null
  if (a.op !== 'create') {
    if (!a.scheduleId) return refuse(`Name the budget schedule to ${a.op} (scheduleId), from ad-budgets.`)
    if (!existing) return refuse(`There is no budget schedule ${a.scheduleId} in this business (not found).`)
  }
  const before = existing ? stateOf(existing) : null
  const fieldsGiven = (['name', 'type', 'campaignIds', 'windows', 'timezone', 'startDate', 'endDate', 'excludeDates', 'enabled'] as const).filter((k) => a[k] !== undefined)

  // The schedule after the request, and the body the screen's service gets.
  let after: ScheduleState | null
  const body: Record<string, unknown> = {}
  let entries: Awaited<ReturnType<typeof scheduleCampaigns>> | null = null
  if (a.op === 'delete') {
    if (fieldsGiven.length) return refuse(`op delete takes no values (${fieldsGiven.join(', ')}): it gives back the budgets the schedule holds and deletes it.`)
    after = null
  } else if (a.op === 'create') {
    if (!a.name) return refuse('A new schedule needs a name.')
    if (!a.campaignIds?.length) return refuse('A new schedule needs its campaigns (campaignIds).')
    if (!a.windows?.length) return refuse('A new schedule needs its windows.')
    const type = a.type ?? 'campaign-budget'
    const bad = windowsRefusal(a.windows, type)
    if (bad) return refuse(`Not queued: ${bad}.`)
    entries = await scheduleCampaigns(a.campaignIds)
    if ('refusal' in entries) return refuse(entries.refusal)
    const windows = normalWindows(a.windows, type)
    const startDate = a.startDate ?? new Date().toISOString().slice(0, 10)
    after = { scheduleId: null, name: a.name, type, enabled: a.enabled !== false, timezone: a.timezone ?? 'Europe/Rome', startDate, endDate: a.endDate ?? null, excludeDates: a.excludeDates ?? [], campaignIds: a.campaignIds, windows }
    Object.assign(body, { name: a.name, type, campaigns: entries.entries, windows, timezone: after.timezone, startDate, endDate: after.endDate, neverExpire: after.endDate == null, excludeDates: after.excludeDates })
  } else {
    if (!fieldsGiven.length) return refuse('Nothing to change: give the schedule\'s new name, campaigns, windows, time zone, dates or enabled.')
    if (a.type && a.type !== before!.type) return refuse(`A schedule keeps its type (${before!.type}): create a new one for ${a.type}.`)
    const type = before!.type
    if (a.windows) {
      const bad = windowsRefusal(a.windows, type)
      if (bad) return refuse(`Not queued: ${bad}.`)
    }
    if (a.campaignIds) {
      entries = await scheduleCampaigns(a.campaignIds)
      if ('refusal' in entries) return refuse(entries.refusal)
    }
    after = {
      ...before!,
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.campaignIds ? { campaignIds: a.campaignIds } : {}),
      ...(a.windows ? { windows: normalWindows(a.windows, type) } : {}),
      ...(a.timezone !== undefined ? { timezone: a.timezone } : {}),
      ...(a.startDate !== undefined ? { startDate: a.startDate } : {}),
      ...(a.endDate !== undefined ? { endDate: a.endDate } : {}),
      ...(a.excludeDates !== undefined ? { excludeDates: a.excludeDates } : {}),
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
    }
    if (canonical(after) === canonical(before)) return refuse(`Nothing would change: the schedule "${before!.name}" is already as asked.`)
    // The screen's own PATCH body: only what moves (a campaigns list as the screen sends it, with each one's budget now).
    if (after.name !== before!.name) body.name = after.name
    if (canonical(after.campaignIds) !== canonical(before!.campaignIds) && entries && !('refusal' in entries)) body.campaigns = entries.entries
    if (canonical(after.windows) !== canonical(before!.windows)) body.windows = after.windows
    if (after.timezone !== before!.timezone) body.timezone = after.timezone
    if (after.startDate !== before!.startDate) body.startDate = after.startDate
    if (after.endDate !== before!.endDate) { body.endDate = after.endDate; body.neverExpire = after.endDate == null }
    if (canonical(after.excludeDates) !== canonical(before!.excludeDates)) body.excludeDates = after.excludeDates
    if (after.enabled !== before!.enabled) body.enabled = after.enabled
  }
  // The windows the save would refuse, in its own words (4b: a value it cannot read or out of range).
  if (body.windows) {
    const read = readScheduleWindows(body.windows, after!.type)
    if ('invalid' in read) return refuse(`Not queued: ${read.invalid.error}`)
  }

  // The one-schedule rule (3c): switched on after this, a campaign is in no other switched-on schedule.
  const onAfter = !!after?.enabled
  // A create is switched on as it is made (create, then paused when asked off): it is checked either way.
  if (a.op === 'create' || (onAfter && (body.campaigns || body.enabled === true))) {
    const campaigns = (body.campaigns as unknown) ?? (existing?.campaigns as unknown)
    const conflict = await budgetScheduleConflict(campaigns, existing?.id ?? null)
    if (conflict) return refuse(`Not queued: ${conflict.error}`)
  }

  // What it gives back now: a pause, a delete, campaigns taken out of a switched-on schedule.
  const type = after?.type ?? before!.type
  const removedIds = before && after ? before.campaignIds.filter((id) => !after!.campaignIds.includes(id)) : []
  const letsGo = before?.enabled
    ? (a.op === 'delete' || (after && !after.enabled) ? before.campaignIds : removedIds)
    : []
  const giveBacks: ScheduleGiveBack[] = letsGo.length && existing ? await scheduleGiveBacks(existing, letsGo) : []
  const names = await labelsOf([...new Set([...(before?.campaignIds ?? []), ...(after?.campaignIds ?? [])])])
  const gives = giveBacks.filter((g) => g.act === 'giveBack' && g.liveCents != null && g.baseCents != null)
  const reached = await budgetReach(gives.map((g) => ({ campaignId: g.campaignId, marketplace: names.get(g.campaignId)?.marketplace ?? null, toCents: g.baseCents!, label: names.get(g.campaignId)?.label ?? g.campaignId })), { byRule: true })
  if ('refused' in reached) return refuse(`Not queued: ${reached.refused}`)
  const gateRefused = new Set(reached.gateRefuses.map((r) => r.campaignId))
  const giveBackLines = gives.map((g) => {
    const n = names.get(g.campaignId)!
    return { campaignId: g.campaignId, label: n.label, currency: n.currency, fromCents: g.liveCents!, toCents: g.baseCents!, ...(gateRefused.has(g.campaignId) ? { refusedByGate: reached.gateRefuses.find((r) => r.campaignId === g.campaignId)!.reason } : {}) }
  })
  const keptLines = giveBacks.filter((g) => g.act === 'kept').map((g) => names.get(g.campaignId)!.label)

  // What can raise spend, and which of it needs the approver's code (ads-budget-kit.ts).
  const raisingWindows = (ws: BudgetWindow[]) => ws.filter((w) => !lowers(w, type))
  const coded: string[] = []
  const uncoded: string[] = []
  /** The campaigns whose budget the schedule's windows can raise once this runs (Nexus only now; its cron writes later). */
  const windowRaised = new Set<string>()
  if (a.op === 'create' && onAfter && raisingWindows(after!.windows).length) {
    for (const w of raisingWindows(after!.windows)) coded.push(`window ${windowText(w, type)} can raise a budget`)
    for (const id of after!.campaignIds) windowRaised.add(id)
  }
  if (a.op === 'update' && after && before) {
    const windowRaises: string[] = []
    if (body.windows) {
      const had = new Set(before.windows.map(fingerprint))
      const has = new Set(after.windows.map(fingerprint))
      for (const w of after.windows) if (!had.has(fingerprint(w)) && !lowers(w, type)) windowRaises.push(`window ${windowText(w, type)} can raise a budget`)
      for (const w of before.windows) if (!has.has(fingerprint(w)) && lowers(w, type)) windowRaises.push(`the lowering window ${windowText(w, type)} goes: its budgets come back up`)
    }
    if (body.enabled === true && raisingWindows(after.windows).length) windowRaises.push(`switched back on, its windows can raise budgets (${named(raisingWindows(after.windows).map((w) => windowText(w, type)), 2)})`)
    uncoded.push(...windowRaises)
    if (windowRaises.length && after.enabled) for (const id of after.campaignIds) windowRaised.add(id)
    const added = after.campaignIds.filter((id) => !before.campaignIds.includes(id))
    if (added.length && after.enabled && raisingWindows(after.windows).length) {
      coded.push(`${named(added.map((id) => names.get(id)!.label))} ${added.length === 1 ? 'joins' : 'join'} a schedule whose windows can raise ${added.length === 1 ? 'its' : 'their'} budget`)
      for (const id of added) windowRaised.add(id)
    }
  }
  for (const g of giveBackLines.filter((l) => l.toCents > l.fromCents && !l.refusedByGate)) {
    const words = `${g.label}: its budget comes back up from ${amountLabel(g.fromCents, g.currency)} to ${amountLabel(g.toCents, g.currency)} (the schedule held it lower)`
    // A pause's give-back is turn-down-automation's lever (no code); a delete's or a campaign taken out's is not.
    if (a.op === 'update' && body.enabled === false) uncoded.push(words)
    else coded.push(words)
  }
  const raises = [...coded, ...uncoded]

  // The facts a run by rule is judged on: each give-back (a budget write now), each other campaign it touches (Nexus only).
  const touched = [...new Set([...(after?.campaignIds ?? []), ...(before?.campaignIds ?? [])])]
  const writing = new Map(giveBackLines.filter((g) => !g.refusedByGate).map((g) => [g.campaignId, g]))
  const items: KitItem[] = touched.map((id): KitItem => {
    const g = writing.get(id)
    return g
      ? { entity: { kind: 'campaign', id }, change: { field: 'dailyBudget', fromCents: g.fromCents, toCents: g.toCents } }
      : { entity: { kind: 'campaign', id }, change: { field: 'automation', raises: windowRaised.has(id) }, nexusOnly: true }
  })
  const rule = await ruleFactsFor({
    tool: TOOL, limits: SCHEDULE_LIMITS, items, approvalId: ctx.approvalId ?? null,
    writes: [...writing.values()].map((g) => ({ campaignId: g.campaignId, marketplace: names.get(g.campaignId)?.marketplace ?? null, changes: [{ field: 'dailyBudget', valueCents: g.toCents }], label: g.label })),
  })
  const markets = [...new Set(touched.map((id) => names.get(id)?.marketplace).filter((m): m is string => !!m))].sort()

  const label = `"${after?.name ?? before!.name}"`
  const wordsOf = (ws: BudgetWindow[]) => ws.map((w) => windowText(w, type))
  const stepUp = budgetStepUp(a.op === 'create' ? `creates the budget schedule ${label}, which can raise budgets` : a.op === 'delete' ? `deletes the budget schedule ${label} and gives budgets back up` : `changes the budget schedule ${label} so it can raise budgets`, coded.length ? ['Budgets'] : [])
  const effect = (a.op === 'create'
    ? `Creates the budget schedule ${label} (${type}${onAfter ? ', switched on' : ', switched off'}) for ${plural(after!.campaignIds.length, 'campaign')} with ${plural(after!.windows.length, 'window')}.`
    : a.op === 'delete'
      ? `Deletes the budget schedule ${label}${before!.enabled ? ', after giving back the budgets it holds' : ''}.`
      : `Changes the budget schedule ${label}: ${Object.keys(body).filter((k) => k !== 'neverExpire').map((k) => (k === 'enabled' ? (body.enabled ? 'switched back on' : 'paused') : k === 'campaigns' ? 'its campaigns' : k)).join(', ')}.`)
    + (giveBackLines.length ? ` Gives back ${plural(giveBackLines.filter((g) => !g.refusedByGate).length, 'budget')} now (each to its budget from before the window).` : '')
    + (keptLines.length ? ` ${named(keptLines)} ${keptLines.length === 1 ? 'keeps' : 'keep'} the budget someone set since.` : '')
  const later = after && onAfter ? 'Its cron writes each campaign\'s budget at Amazon when a window opens (every 15 minutes), and gives it back when the window closes.' : ''
  const ref = existing ? { scheduleId: existing.id, name: existing.name } : { scheduleId: null, name: a.name }
  return {
    schedule: existing,
    body,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: a.op,
        ...ref,
        type,
        markets,
        schedule: {
          from: before ? { enabled: before.enabled, campaigns: before.campaignIds.length, windows: wordsOf(before.windows), timezone: before.timezone, startDate: before.startDate, endDate: before.endDate } : null,
          to: after ? { enabled: after.enabled, campaigns: after.campaignIds.length, windows: wordsOf(after.windows), timezone: after.timezone, startDate: after.startDate, endDate: after.endDate } : null,
        },
        campaigns: {
          added: (after?.campaignIds ?? []).filter((id) => !(before?.campaignIds ?? []).includes(id)).map((id) => names.get(id)!.label).slice(0, LINES_SHOWN),
          takenOut: (before?.campaignIds ?? []).filter((id) => !(after?.campaignIds ?? []).includes(id)).map((id) => names.get(id)!.label).slice(0, LINES_SHOWN),
        },
        giveBacks: giveBackLines.slice(0, LINES_SHOWN),
        ...(giveBackLines.length > LINES_SHOWN ? { moreGiveBacks: giveBackLines.length - LINES_SHOWN } : {}),
        ...(keptLines.length ? { keptBySomeoneElse: keptLines.slice(0, LINES_SHOWN) } : {}),
        totals: { campaigns: after?.campaignIds.length ?? 0, givesBack: writing.size, gateRefusesGiveBack: gateRefused.size, kept: keptLines.length },
        raises,
        ...(stepUp ? { stepUp } : {}),
        ...(uncoded.length ? { raisesWithoutCode: 'A window edit (tune-ad-engine) and a switch on or off with its give-back (turn-up / turn-down-automation) move spend without a code there, so here too.' } : {}),
        // Every starting value the person approves: the schedule as it is and every give-back it would make (not its
        // record of what it applied, which its cron rewrites every run).
        basis: hash({ before, giveBacks }),
        reach: reached.reach,
        reachNote: budgetReachNote(reached.reach, later),
        effect,
        undoNote: a.op === 'create'
          ? 'Undo deletes the schedule (it gives back what it holds then).'
          : a.op === 'delete'
            ? 'Undo creates the schedule again as it was: a new schedule, with its campaigns and windows; its record of what it applied is not brought back.'
            : 'Undo sets the schedule back as it was (its name, campaigns, windows, dates and switch), through set-budget-schedule.',
        ...rule,
      },
    },
  }
}

/** set-budget-schedule's limits: nothing by rule by default (no op, no market, no raise). */
const SCHEDULE_LIMITS = budgetLimits(OPS)

async function scheduleStateNow(scheduleId: string | null): Promise<ScheduleState | null> {
  if (!scheduleId) return null
  const s = await readBudgetSchedule(scheduleId)
  return s ? stateOf(s) : null
}

/** The arguments that make a schedule as a state records it (create), or set it back (update). */
function argsOfState(s: ScheduleState, op: 'create' | 'update'): Record<string, unknown> {
  return {
    op,
    ...(op === 'update' ? { scheduleId: s.scheduleId } : { type: s.type }),
    name: s.name, campaignIds: s.campaignIds, windows: s.windows.map((w) => Object.fromEntries(Object.entries(w).filter(([k, v]) => !((k === 'start' || k === 'end') && v === '')))),
    timezone: s.timezone, ...(s.startDate ? { startDate: s.startDate } : {}), endDate: s.endDate, excludeDates: s.excludeDates, enabled: s.enabled,
  }
}

/** Undo: a create deleted, an update set back, a delete created again (a new schedule). */
export const SET_BUDGET_SCHEDULE_UNDO: ToolUndo = {
  current(change) {
    const after = (change.after ?? {}) as { scheduleId?: string | null; state?: ScheduleState | null }
    return scheduleStateNow(after.scheduleId ?? null).then((state) => ({ scheduleId: after.scheduleId ?? null, state }))
  },
  request(change) {
    const before = (change.before ?? {}) as { op?: string; state?: ScheduleState | null }
    const after = (change.after ?? {}) as { scheduleId?: string | null }
    const why = 'undo of an earlier budget schedule change'
    if (before.op === 'create') {
      if (!after.scheduleId) return { refusal: 'This change does not record the schedule it created.' }
      return { tool: TOOL, args: { op: 'delete', scheduleId: after.scheduleId, why } }
    }
    if (!before.state) return { refusal: 'This change does not record the schedule it replaced.' }
    return { tool: TOOL, args: { ...argsOfState(before.state, before.op === 'delete' ? 'create' : 'update'), why } }
  },
}

async function execute(a: Args, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await plan(a, ctx)
  const refusal = budgetRecheck(ctx, fresh.result, ['basis', 'totals'])
  if (refusal) return notRun(refusal)
  const p = fresh.result.preview as { effect: string; reach: unknown }
  const coded = await codeGate(ctx, fresh.result.preview)
  if (coded) return notRun(coded)
  const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const before = fresh.schedule ? stateOf(fresh.schedule) : null
  const opts = { changeSetId: run.changeSetId }
  let scheduleId = fresh.schedule?.id ?? null
  let restore: { restored: number; kept: number; refused: number } | null = null
  if (a.op === 'create') {
    const out = await createBudgetSchedule(fresh.body!, run.actor)
    if ('conflict' in out) return notRun(`Not run: ${out.conflict.error}`)
    if ('invalid' in out) return notRun(`Not run: ${out.invalid.error}`)
    scheduleId = out.schedule.id
    // Asked switched off: as the screen's pause right after it is made (it holds nothing yet, so nothing is given back).
    if (a.enabled === false) await patchBudgetSchedule(scheduleId, { enabled: false }, run.actor, opts)
  } else if (a.op === 'update') {
    const out = await patchBudgetSchedule(scheduleId!, fresh.body!, run.actor, opts)
    if (!out) return notRun('Not run: the schedule is gone. Nothing changed.')
    if ('conflict' in out) return notRun(`Not run: ${out.conflict.error}`)
    if ('invalid' in out) return notRun(`Not run: ${out.invalid.error}`)
    restore = out.restore
  } else {
    const out = await deleteBudgetSchedule(scheduleId!, run.actor, opts)
    if (!out) return notRun('Not run: the schedule is gone already. Nothing changed.')
    restore = out.restore
  }
  const now = await scheduleStateNow(a.op === 'delete' ? null : scheduleId)
  const change: ToolChange = { before: { op: a.op, state: before, changeSetId: run.changeSetId }, after: { scheduleId: a.op === 'delete' ? null : scheduleId, state: now } }
  const data = {
    op: a.op, scheduleId, ...(now ? { enabled: now.enabled, campaigns: now.campaignIds.length, windows: now.windows.length } : {}),
    ...(restore ? { gaveBack: restore } : {}),
    reach: p.reach, changeSetId: run.changeSetId,
    note: restore?.refused ? `${plural(restore.refused, 'give-back')} refused or failed: ${restore.refused === 1 ? 'that campaign keeps' : 'those campaigns keep'} the schedule's budget (approval-status follows the rest).` : 'Saved in Nexus. Its give-backs are queued for Amazon (after the 5-minute cancel window); its cron writes the windows.',
  }
  return { ok: true, data, change }
}

const setBudgetSchedule: AgentTool = {
  name: TOOL,
  title: 'Change a budget schedule',
  input,
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // Its give-backs write at Amazon now; its cron writes the windows later.
  openWorld: true,
  // A deleted schedule comes back as a new one, without its record of what it applied.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: SCHEDULE_LIMITS,
  withinLimits: budgetRuleRefusal,
  undo: SET_BUDGET_SCHEDULE_UNDO,
  description:
    'Create, change, pause or delete an Amazon ads budget schedule, as the Budget schedules screen does (not the Hourly '
    + 'Bids page): a daily budget per time window for its campaigns — an amount, a percent up or down, or a whole day\'s '
    + 'budget × a multiplier. op create (switched on, as the screen makes one; enabled false makes it off), op update '
    + '(name, the whole campaign list, every window, time zone, dates; enabled false pauses it, true switches it back on) '
    + 'or op delete. A pause, a delete and a campaign taken out give back the budget the schedule holds, as the screen '
    + 'does (a budget someone changed since is kept); a campaign is in one switched-on schedule at a time. The preview '
    + 'lists the schedule from → to, every give-back from → to and where it lands (live at Amazon or sandbox), and what '
    + `can raise spend. ${BY_RULE_WORDS} (by default nothing runs by rule). A new schedule with a window that can raise a `
    + 'budget, campaigns added to a raising schedule, or a delete or campaign taken out whose give-back raises a budget is '
    + 'approved with the approver\'s authenticator code (stepUp); a window edit and a switch on or off behave as '
    + 'tune-ad-engine and turn-up / turn-down-automation (listed, no code). Undo puts it back (a deleted schedule comes '
    + 'back as a new one).',
  async handler(args, ctx) {
    return (await plan(args as Args, ctx)).result
  },
  async execute(args, ctx) {
    return execute(args as Args, ctx)
  },
}

export const ADS_BUDGET_SCHEDULE_TOOLS: AgentTool[] = [setBudgetSchedule]
