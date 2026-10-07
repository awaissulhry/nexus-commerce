/**
 * ADS AUTONOMY W4-7 (design agent-results/6 §4 "W3-6a") — the Budget Manager's monthly plan, and its restore to
 * baseline, for Claude, through the screens' own services:
 *
 *   set-monthly-ad-budget     one market's plan for one month (Ads › Budget Manager): its monthly budget, Auto Pacing,
 *                             Stop Over Spend and the per-day calendar (upsertBudgetPlan), the plan removed
 *                             (deleteBudgetPlan), and the "More" view's lowest and highest daily budget per campaign
 *                             (setCampaignLimit — the same columns set-ad-guardrail campaign-budget-bounds and the
 *                             Campaigns grid write). Nexus only now: the budget engine acts on the plan every 30 minutes,
 *                             as its own mode allows (the preview names it). A raise through the plan (a bigger budget,
 *                             the cap removed, Stop Over Spend off, Auto Pacing switched or its calendar changed, the plan
 *                             removed) needs the approver's code — no older tool moves a plan; a campaign's limits
 *                             loosened behave as set-ad-guardrail (listed and warned, no code). Undo: the plan and the
 *                             limits as they were, through this tool.
 *   restore-budget-baselines  the Budget page's "Restore to baseline": each campaign's daily budget back to the baseline
 *                             a person captured (restoreBudgetBaselines, the route's own code), written as the approver
 *                             through the write gate. A campaign's daily budget is set-campaign-budget's lever, so it
 *                             behaves as that tool: a raise is warned past the day's budget move and his own limits, and
 *                             approving sends it, with no code. Undo: set-campaign-budget puts each budget back.
 *
 * Both follow ads-budget-kit.ts and the W2 contract: preview first, refused and not queued when Amazon's write gate
 * refuses a write; run only as an approved request (as the approver, changeSetId = the approval on every budget write),
 * re-checked in `execute`; strategy-bound (the `budget` kind); by default nothing runs by rule.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { budgetBoundsProblem, budgetPlanFor, currentMonth, deleteBudgetPlan, setCampaignLimit, upsertBudgetPlan, type ClaudeBudgetPlan } from '../../advertising/ads-budget-manager.service.js'
import { restoreBudgetBaselines } from '../../advertising/ads-budget-baseline.service.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { approvedRun, BY_RULE_WORDS, canonical, notRun, ruleFactsFor, ruleRefusal, spOnlyRefusal, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, STEP_PCT_LIMITS, type KitItem } from './ads-autonomy-kit.js'
import {
  alsoChangedByOf, budgetEnginesOf, budgetLimits, budgetReach, budgetReachNote, budgetRecheck, budgetRuleRefusal, budgetStepUp, codeGate, ID, MARKET, named,
  plural, splitRaises, WHY, type CodeRule, type Raise,
} from './ads-budget-kit.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 24)
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20

// ── set-monthly-ad-budget ─────────────────────────────────────────────────────────────────────────

const PLAN_TOOL_NAME = 'set-monthly-ad-budget'
const PLAN_OPS = ['set', 'remove'] as const

interface PlanValues { monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean; calendar: Array<{ day: number; pct: number }> }
interface LimitRow { campaignId: string; minCents: number | null; maxCents: number | null }
/** What a change of this tool records, and what `current` reads back (the undo guard compares the two). */
interface PlanState { market: string; month: string; plan: PlanValues | null; limits: LimitRow[] }

const NO_PLAN: PlanValues = { monthlyBudgetCents: 0, autoPacing: false, stopOverSpend: false, calendar: [] }
const valuesOf = (p: ClaudeBudgetPlan | null): PlanValues | null => (p
  ? { monthlyBudgetCents: p.monthlyBudgetCents, autoPacing: p.autoPacing, stopOverSpend: p.stopOverSpend, calendar: Array.isArray(p.calendar) ? (p.calendar as PlanValues['calendar']) : [] }
  : null)
const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }
const onOff = (on: boolean) => (on ? 'on' : 'off')

const planInput = z.object({
  op: z.enum(PLAN_OPS).default('set').describe('set (create the plan, or change what is given) or remove (delete the month\'s plan; campaignLimits may still be given)'),
  market: MARKET.describe('the Amazon market code (IT, DE, FR …: business-overview lists them)'),
  month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM').optional().describe('the month, YYYY-MM: this month when left out; this month or a later one'),
  monthlyBudgetCents: z.coerce.number().int().min(0).max(100_000_000).optional()
    .describe("the month's budget, in minor units of the market's currency (never converted); 0 = no cap: Auto Pacing and Stop Over Spend then act on nothing (the ads strategy's own monthly cap still binds)"),
  autoPacing: z.boolean().optional()
    .describe("Auto Pacing: when the market is projected over its cap, the budget engine spreads what is left of it over the days left, campaign by campaign, by each campaign's share of spend — up as well as down, within each campaign's lowest and highest budget"),
  stopOverSpend: z.boolean().optional()
    .describe('Stop Over Spend: once the month\'s spend reaches the cap, the engine drops the market\'s bids to about the 2-cent floor (never a pause) until the 1st; switched off, it gives the bids it floored back'),
  calendar: z.array(z.object({
    day: z.coerce.number().int().min(1).max(31).describe('the day of the month'),
    pct: z.coerce.number().min(0).max(100).describe('its share of the month, in percent'),
  })).max(31).optional().describe("the month's share per day in percent, every day of the month, adding up to 100 (a tentpole day gets more); [] = an even split"),
  campaignLimits: z.array(z.object({
    campaignId: ID.describe('the campaign (Nexus id, campaignId in ad-campaigns), in this market'),
    minCents: z.coerce.number().int().min(100).max(100_000_000).nullable().describe('its lowest daily budget in minor units of its currency (at least 100); null = none'),
    maxCents: z.coerce.number().int().min(100).max(100_000_000).nullable().describe('its highest daily budget in minor units of its currency (at least 100); null = none'),
  })).max(100).optional()
    .describe("the Budget Manager's More view: each campaign's lowest and highest daily budget (the columns set-ad-guardrail campaign-budget-bounds and the Campaigns grid set; the write gate and Auto Pacing keep to them), up to 100"),
  why: WHY,
})
type PlanArgs = z.infer<typeof planInput>

/** The limits each campaign named has now, in its own shape, with what a person calls it (the order asked; name null: not found). */
async function limitsNow(ids: readonly string[]) {
  const rows = ids.length
    ? await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, marketplace: true, status: true, dailyBudgetCurrency: true, minBudgetCents: true, maxBudgetCents: true } })
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => {
    const r = byId.get(id)
    return r ? { id, name: r.name, market: r.marketplace, status: String(r.status), currency: campaignCurrency(r), minCents: r.minBudgetCents ?? null, maxCents: r.maxBudgetCents ?? null } : { id, name: null, market: null, status: null, currency: 'EUR', minCents: null, maxCents: null }
  })
}

/** The plan and the named campaigns' limits as they are now (what a change records as `after`, and `current` reads). */
async function planStateNow(market: string, month: string, campaignIds: readonly string[]): Promise<PlanState> {
  const [plan, limits] = await Promise.all([budgetPlanFor(market, month), limitsNow(campaignIds)])
  return { market, month, plan: valuesOf(plan), limits: limits.map((l) => ({ campaignId: l.id, minCents: l.minCents, maxCents: l.maxCents })) }
}

/** The ways a plan request can raise spend: the lever its code rule reads. */
type PlanLever = 'monthlyBudget' | 'capRemoved' | 'stopOverSpendOff' | 'autoPacing' | 'calendar' | 'planRemoved' | 'campaignLimits'

/**
 * THE code rule of set-monthly-ad-budget (ads-budget-kit.ts CodeRule): no older Claude tool moves a market's monthly plan,
 * so a raise through it needs the approver's code; a campaign's lowest and highest daily budget are set-ad-guardrail's
 * lever (campaign-budget-bounds), without one.
 */
function planNeedsCode(lever: PlanLever): CodeRule {
  return lever === 'campaignLimits' ? { code: false, as: 'set-ad-guardrail (campaign-budget-bounds)' } : { code: true }
}

/** Why a campaign's limits move can raise spend, in words (set-ad-guardrail's campaign-budget-bounds rule), or null. */
function limitRaise(label: string, from: LimitRow, to: LimitRow, currency: string): string | null {
  const money = (c: number | null) => (c == null ? 'none' : amountLabel(c, currency))
  const parts: string[] = []
  if (from.maxCents != null && (to.maxCents == null || to.maxCents > from.maxCents)) parts.push(`its highest daily budget ${money(from.maxCents)} → ${money(to.maxCents)} lets its budget go higher`)
  if (to.minCents != null && (from.minCents == null || to.minCents > from.minCents)) parts.push(`its lowest daily budget ${money(from.minCents)} → ${money(to.minCents)} holds its spend up`)
  return parts.length ? `${label}: ${parts.join('; ')}` : null
}

/** The plan change, planned and judged: its preview. */
async function planPreview(a: PlanArgs, ctx: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const refuse = (error: string): ToolResult => ({ ok: false, error })
  const month = a.month ?? currentMonth()
  if (month < currentMonth()) return refuse(`${month} is over: a plan is set for this month (${currentMonth()}) or a later one.`)

  // The campaigns named first (a campaign of another business reads as not found, before anything about the market is
  // said); their limits from → to (unchanged ones are left as they are, and counted).
  const asked = [...new Map((a.campaignLimits ?? []).map((l) => [l.campaignId, l])).values()]
  if (asked.length !== (a.campaignLimits ?? []).length) return refuse('campaignLimits names a campaign twice.')
  const now = await limitsNow(asked.map((l) => l.campaignId))
  const missing = now.filter((l) => l.name == null).map((l) => l.id)
  if (missing.length) return refuse(`Not queued: campaign ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.`)
  const elsewhere = now.filter((l) => l.market !== a.market)
  if (elsewhere.length) return refuse(`Not queued: ${named(elsewhere.map((l) => `campaign "${l.name}" (${l.market ?? 'no market'})`))} ${elsewhere.length === 1 ? 'is' : 'are'} not in ${a.market}.`)
  const archived = now.filter((l) => l.status === 'ARCHIVED')
  if (archived.length) return refuse(`Not queued: ${named(archived.map((l) => `campaign "${l.name}"`))} ${archived.length === 1 ? 'is' : 'are'} archived: the Budget Manager sets no limit on an archived campaign.`)
  // The market, once the campaigns named are found in it (a market this business has no Marketplace row for is not one of its own).
  let currency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
  } catch (e) {
    return refuse(`Market ${a.market} not found in this business: ${(e as Error).message}`)
  }
  const money = (cents: number) => amountLabel(cents, currency)
  const plan = await budgetPlanFor(a.market, month)
  const from = valuesOf(plan)
  const planFields = (['monthlyBudgetCents', 'autoPacing', 'stopOverSpend', 'calendar'] as const).filter((k) => a[k] !== undefined)

  // The plan, from → to.
  let to: PlanValues | null
  if (a.op === 'remove') {
    if (!plan) return refuse(`Nothing to remove: ${a.market} has no budget plan for ${month}.`)
    if (planFields.length) return refuse(`op remove takes no plan values (${planFields.join(', ')}): it deletes the plan. Use op set to change it.`)
    to = null
  } else {
    to = { ...(from ?? NO_PLAN), ...Object.fromEntries(planFields.map((k) => [k, a[k]])) } as PlanValues
    if (a.calendar?.length) {
      const dim = daysIn(month)
      const days = a.calendar.map((c) => c.day)
      if (days.some((d) => d > dim)) return refuse(`${month} has ${dim} days: the calendar names day ${Math.max(...days)}.`)
      if (new Set(days).size !== days.length) return refuse('The calendar names a day twice.')
      if (days.length !== dim) return refuse(`The calendar gives every day of ${month} its share: ${dim} days, not ${days.length} (or [] for an even split).`)
      const sum = a.calendar.reduce((s, c) => s + c.pct, 0)
      if (Math.abs(sum - 100) > 0.5) return refuse(`The calendar's shares add up to ${Math.round(sum * 100) / 100} %, not 100 %.`)
      to.calendar = [...a.calendar].sort((x, y) => x.day - y.day)
    }
  }

  const limitLines: Array<{ campaignId: string; label: string; currency: string; from: LimitRow; to: LimitRow }> = []
  for (const l of asked) {
    const problem = budgetBoundsProblem(l.minCents, l.maxCents)
    const row = now.find((x) => x.id === l.campaignId)!
    if (problem) return refuse(`Not queued: campaign "${row.name}": ${problem}`)
    const fromRow = { campaignId: l.campaignId, minCents: row.minCents, maxCents: row.maxCents }
    const toRow = { campaignId: l.campaignId, minCents: l.minCents, maxCents: l.maxCents }
    if (canonical(fromRow) !== canonical(toRow)) limitLines.push({ campaignId: l.campaignId, label: `campaign "${row.name}"`, currency: row.currency, from: fromRow, to: toRow })
  }
  const planMoves = a.op === 'remove' || canonical(from) !== canonical(to)
  if (!planMoves && !limitLines.length) return refuse(`Nothing would change: the ${a.market} plan for ${month} and the limits named are already as asked.`)

  // Every way it can raise spend (each listed, whatever the code rule).
  const f = from ?? NO_PLAN
  const capped = (v: PlanValues | null) => !!v && v.monthlyBudgetCents > 0 && (v.stopOverSpend || v.autoPacing)
  const found: Array<Raise<PlanLever>> = []
  if (planMoves) {
    if (to) {
      if (f.monthlyBudgetCents > 0 && to.monthlyBudgetCents > f.monthlyBudgetCents && capped(to)) found.push({ lever: 'monthlyBudget', why: `the monthly budget rises from ${money(f.monthlyBudgetCents)} to ${money(to.monthlyBudgetCents)}: Stop Over Spend and Auto Pacing act at the higher cap` })
      if (f.monthlyBudgetCents > 0 && to.monthlyBudgetCents === 0 && capped(from)) found.push({ lever: 'capRemoved', why: `the cap of ${money(f.monthlyBudgetCents)} goes (0 = no cap): the engine stops and paces this market no more` })
      if (f.stopOverSpend && !to.stopOverSpend && f.monthlyBudgetCents > 0) found.push({ lever: 'stopOverSpendOff', why: 'Stop Over Spend switched off: the engine gives back the bids it floored and floors none at the cap' })
      if (f.autoPacing !== to.autoPacing && to.monthlyBudgetCents > 0) found.push({ lever: 'autoPacing', why: to.autoPacing ? 'Auto Pacing switched on: when the market is projected over its cap it sets each campaign\'s budget by its share of spend, up as well as down' : 'Auto Pacing switched off: it lowers no budget when the market is projected over its cap' })
      if (canonical(f.calendar) !== canonical(to.calendar) && to.autoPacing && to.monthlyBudgetCents > 0) found.push({ lever: 'calendar', why: 'a new calendar moves each day\'s share of the month: a day\'s pace can rise' })
    } else if (capped(from)) {
      found.push({ lever: 'planRemoved', why: `the plan goes: its cap of ${money(f.monthlyBudgetCents)} stops and paces this market no more (the ads strategy's own monthly cap still binds)` })
    }
  }
  const planRaises = found.length > 0
  for (const l of limitLines) {
    const why = limitRaise(l.label, l.from, l.to, l.currency)
    if (why) found.push({ lever: 'campaignLimits', why })
  }
  const { raises, coded, raisesWithoutCode } = splitRaises(found, planNeedsCode)

  // The facts a run by rule is judged on: the market's plan, each campaign's limits — Nexus only.
  const items: KitItem[] = [
    ...(planMoves ? [{ entity: { kind: 'products' as const, market: a.market, productIds: [], label: `the ${a.market} budget plan for ${month}` }, change: { field: 'automation' as const, raises: planRaises }, nexusOnly: true }] : []),
    ...limitLines.map((l) => ({ entity: { kind: 'campaign' as const, id: l.campaignId }, change: { field: 'automation' as const, raises: !!limitRaise(l.label, l.from, l.to, l.currency) }, nexusOnly: true })),
  ]
  const rule = await ruleFactsFor({ tool: PLAN_TOOL_NAME, limits: PLAN_LIMITS, items, writes: [], approvalId: ctx.approvalId ?? null })
  // What else moves the named campaigns' budgets (rules, hourly schedules, budget schedules, pools).
  const limitLabels = new Map(limitLines.map((l) => [l.campaignId, l.label]))
  const alsoChangedBy = alsoChangedByOf(rule.limitFacts, await budgetEnginesOf([...limitLabels.keys()]), limitLabels)
  // TODO(W4-12 #465): once `consequencesFor` is on main, say "Nexus only" for every plan change (the engine writes later).
  const { budgetEnforceMode } = await import('../../advertising/ads-budget-enforce.service.js')
  const engine = await budgetEnforceMode()

  const planWords = (v: PlanValues | null) => (v
    ? `${v.monthlyBudgetCents ? money(v.monthlyBudgetCents) : 'no cap'}, Auto Pacing ${onOff(v.autoPacing)}, Stop Over Spend ${onOff(v.stopOverSpend)}, ${v.calendar.length ? 'its own calendar' : 'an even split'}`
    : 'no plan')
  const changes = [
    ...(planMoves && from?.monthlyBudgetCents !== to?.monthlyBudgetCents ? [{ label: 'Monthly budget', from: from ? (from.monthlyBudgetCents ? money(from.monthlyBudgetCents) : 'no cap') : 'no plan', to: to ? (to.monthlyBudgetCents ? money(to.monthlyBudgetCents) : 'no cap') : 'no plan' }] : []),
    ...(planMoves && to && from?.autoPacing !== to.autoPacing ? [{ label: 'Auto Pacing', from: onOff(f.autoPacing), to: onOff(to.autoPacing) }] : []),
    ...(planMoves && to && from?.stopOverSpend !== to.stopOverSpend ? [{ label: 'Stop Over Spend', from: onOff(f.stopOverSpend), to: onOff(to.stopOverSpend) }] : []),
    ...(planMoves && to && canonical(f.calendar) !== canonical(to.calendar) ? [{ label: 'Calendar', from: f.calendar.length ? 'its own calendar' : 'an even split', to: to.calendar.length ? 'a new calendar' : 'an even split' }] : []),
  ]
  const limitWords = (l: LimitRow, cur: string) => `lowest ${l.minCents == null ? 'none' : amountLabel(l.minCents, cur)}, highest ${l.maxCents == null ? 'none' : amountLabel(l.maxCents, cur)}`
  const limitList = limitLines.map((l) => ({ campaignId: l.campaignId, label: l.label, currency: l.currency, from: limitWords(l.from, l.currency), to: limitWords(l.to, l.currency), fromLimits: l.from, toLimits: l.to }))
  const stepUp = budgetStepUp(`raises spend through the ${a.market} budget plan for ${month}`, coded.length ? ['Monthly budget'] : [])
  const later = `The budget engine reads the plan every 30 minutes — now: ${engine.sentence}`
  const effect = (a.op === 'remove'
    ? `Removes the ${a.market} budget plan for ${month} (${planWords(from)}).`
    : planMoves ? `${from ? 'Changes' : 'Creates'} the ${a.market} budget plan for ${month}: ${planWords(from)} → ${planWords(to)}.` : `Keeps the ${a.market} budget plan for ${month} as it is.`)
    + (limitLines.length ? ` Sets the lowest and highest daily budget of ${plural(limitLines.length, 'campaign')}: ${named(limitLines.map((l) => l.label))}.` : '')
    + ' Nexus only now.'
  return {
    ok: true,
    preview: {
      action: PLAN_TOOL_NAME,
      op: a.op,
      market: a.market,
      markets: [a.market],
      month,
      currency,
      plan: { from, to, planId: plan?.id ?? null },
      changes,
      campaignLimits: limitList.slice(0, LINES_SHOWN),
      ...(limitList.length > LINES_SHOWN ? { moreCampaignLimits: limitList.length - LINES_SHOWN } : {}),
      totals: { planChanges: planMoves ? 1 : 0, campaignLimits: limitLines.length, alreadyAsAsked: asked.length - limitLines.length },
      raises,
      ...(stepUp ? { stepUp } : {}),
      ...(raisesWithoutCode ? { raisesWithoutCode } : {}),
      alsoChangedBy,
      engine: { label: engine.label, sentence: engine.sentence },
      // Every starting value the person approves: the plan as it is, and every named campaign's limits.
      basis: hash({ from, limits: now.map((l) => [l.id, l.minCents, l.maxCents]) }),
      reach: null,
      reachNote: budgetReachNote(null, later),
      effect,
      undoNote: a.op === 'remove' || !from
        ? 'Undo puts the plan back as it was (a plan it created is removed again) and each campaign\'s limits, through set-monthly-ad-budget.'
        : 'Undo sets the plan and each campaign\'s limits back as they were, through set-monthly-ad-budget.',
      ...rule,
    },
  }
}

/** set-monthly-ad-budget's limits: nothing by rule by default; a raise of the monthly budget only within maxMonthlyRaisePct. */
const PLAN_LIMITS = budgetLimits(PLAN_OPS, {
  maxMonthlyRaisePct: z.number().min(0).max(100).default(0)
    .describe('the largest raise of a monthly budget, in percent, that may run by rule (with allowRaise); 0 = none'),
})

/** set-monthly-ad-budget's own check, after the shared ones: a raise of the monthly budget within its percent. */
function planRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const shared = budgetRuleRefusal(preview, limits)
  if (shared) return shared
  const p = preview as { plan?: { from?: PlanValues | null; to?: PlanValues | null } }
  const from = p.plan?.from?.monthlyBudgetCents ?? 0
  const to = p.plan?.to?.monthlyBudgetCents ?? 0
  if (from > 0 && to > from) {
    const pct = Math.round(((to - from) / from) * 10_000) / 100
    const max = typeof limits.maxMonthlyRaisePct === 'number' ? limits.maxMonthlyRaisePct : 0
    if (pct > max) return `it raises the monthly budget by ${pct} %, more than the ${max} % this tool's limits let run by rule; a person decides`
  }
  return null
}

/** Undo: the plan and the limits as they were, through this tool (a plan it created is removed again). */
export const SET_MONTHLY_AD_BUDGET_UNDO: ToolUndo = {
  current(change) {
    const after = (change.after ?? {}) as Partial<PlanState>
    return planStateNow(String(after.market ?? ''), String(after.month ?? ''), (after.limits ?? []).map((l) => l.campaignId))
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<PlanState> & { planChanged?: boolean }
    if (!before.market || !before.month) return { refusal: 'This change does not record the plan it replaced.' }
    const limits = before.limits ?? []
    const args: Record<string, unknown> = { market: before.market, month: before.month, why: 'undo of an earlier budget plan change' }
    if (before.planChanged === false) {
      if (!limits.length) return { refusal: 'This change records nothing to put back.' }
      return { tool: PLAN_TOOL_NAME, args: { ...args, op: 'set', campaignLimits: limits } }
    }
    const plan = before.plan
    return {
      tool: PLAN_TOOL_NAME,
      args: plan
        ? { ...args, op: 'set', ...plan, ...(limits.length ? { campaignLimits: limits } : {}) }
        : { ...args, op: 'remove', ...(limits.length ? { campaignLimits: limits } : {}) },
    }
  },
}

async function planExecute(a: PlanArgs, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await planPreview(a, ctx)
  const refusal = budgetRecheck(ctx, fresh, ['basis'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { month: string; plan: { from: PlanValues | null; to: PlanValues | null; planId: string | null }; totals: { planChanges: number }; effect: string }
  const coded = await codeGate(ctx, fresh.preview)
  if (coded) return notRun(coded)
  const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  // Every limit asked, not only the lines the preview lists.
  const allLimits = [...new Map((a.campaignLimits ?? []).map((l) => [l.campaignId, l])).values()]
  const before = await planStateNow(a.market, p.month, allLimits.map((l) => l.campaignId))
  const failed: string[] = []
  if (p.totals.planChanges) {
    if (a.op === 'remove') {
      if (p.plan.planId) await deleteBudgetPlan(p.plan.planId)
    } else {
      // The screen's own save: the fields given (an existing plan keeps the others), created when the month has none.
      const given = Object.fromEntries((['monthlyBudgetCents', 'autoPacing', 'stopOverSpend'] as const).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      await upsertBudgetPlan({
        ...(p.plan.planId ? { id: p.plan.planId } : {}), marketplace: a.market, month: p.month, ...given,
        ...(a.calendar !== undefined ? { calendar: p.plan.to?.calendar ?? [] } : {}),
        createdBy: run.actor,
      })
    }
  }
  for (const l of allLimits) {
    const was = before.limits.find((x) => x.campaignId === l.campaignId)
    if (was && was.minCents === l.minCents && was.maxCents === l.maxCents) continue
    const out = await setCampaignLimit({ marketplace: a.market, month: p.month, campaignId: l.campaignId, minCents: l.minCents, maxCents: l.maxCents, createdBy: run.actor })
    if (!out.ok) failed.push(`campaign ${l.campaignId} (${out.error ?? 'refused'})`)
  }
  const after = await planStateNow(a.market, p.month, allLimits.map((l) => l.campaignId))
  const change: ToolChange = { before: { ...before, planChanged: p.totals.planChanges > 0, changeSetId: run.changeSetId }, after }
  const data = { market: a.market, month: p.month, plan: after.plan, campaignLimits: after.limits.length, changeSetId: run.changeSetId, note: 'Saved in Nexus. The budget engine reads it on its next run (every 30 minutes), as its own mode allows.' }
  if (failed.length) return { ok: false, data, change, error: `Partly run: ${plural(failed.length, 'campaign limit')} refused — ${named(failed)}. The rest ran; undo-change puts back what ran.` }
  return { ok: true, data, change }
}

const setMonthlyAdBudget: AgentTool = {
  name: PLAN_TOOL_NAME,
  title: 'Set a monthly ad budget',
  input: planInput,
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // The budget engine acts on the plan at Amazon on its next run (budget pacing, the stop at the cap).
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: PLAN_LIMITS,
  withinLimits: planRefusal,
  undo: SET_MONTHLY_AD_BUDGET_UNDO,
  description:
    'Set one Amazon market\'s budget plan for one month, as the Budget Manager does (Ads › Budget Manager): the month\'s '
    + 'budget in the market\'s currency (0 = no cap), Auto Pacing, Stop Over Spend and the per-day calendar (op set, '
    + 'created when the month has none), or remove the plan (op remove); and, as its "More" view, each campaign\'s lowest '
    + 'and highest daily budget (campaignLimits, up to 100: the same columns set-ad-guardrail campaign-budget-bounds '
    + 'sets). Nexus only now: the budget engine acts on the plan every 30 minutes, as its own mode allows (the preview '
    + `says which), and the ads strategy's own monthly cap binds beside it. ${BY_RULE_WORDS} (by default nothing runs by `
    + 'rule). A change through the plan that can raise spend — a bigger budget, the cap removed, Stop Over Spend switched '
    + 'off, Auto Pacing switched or its calendar changed, the plan removed — is approved with the approver\'s '
    + 'authenticator code (stepUp); a campaign\'s limits loosened are listed in raises and need no code, as with '
    + 'set-ad-guardrail. The preview shows the plan from → to, each campaign\'s limits from → to, what can raise spend '
    + 'and the engine\'s mode. A past month is refused. Undo sets the plan and the limits back.',
  async handler(args, ctx) {
    return planPreview(args as PlanArgs, ctx)
  },
  async execute(args, ctx) {
    return planExecute(args as PlanArgs, ctx)
  },
}

// ── restore-budget-baselines ──────────────────────────────────────────────────────────────────────

const BASELINE_TOOL_NAME = 'restore-budget-baselines'
const MAX_CAMPAIGNS = 100

const baselineInput = z.object({
  campaignIds: z.array(ID).min(1).max(MAX_CAMPAIGNS).describe(`the campaigns (Nexus ids, campaignId in ad-campaigns) whose daily budget goes back to its baseline (budgetBaselineCents in ad-campaigns), up to ${MAX_CAMPAIGNS}`),
  why: WHY,
})

/**
 * THE code rule of restore-budget-baselines (ads-budget-kit.ts CodeRule): a campaign's daily budget is set-campaign-budget's
 * lever, without a code — a raise is listed, warned past his own limits, and approving sends it.
 */
function baselineNeedsCode(_lever: 'campaignBudget'): CodeRule {
  return { code: false, as: 'set-campaign-budget' }
}

/** One campaign of the request, as Nexus holds it now. */
interface BaselineLine { campaignId: string; label: string; marketplace: string | null; currency: string; fromCents: number; toCents: number | null; does: 'restore' | 'skip'; why?: string }

async function baselinePreview(args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; lines: BaselineLine[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, lines: [] as BaselineLine[] })
  const ids = [...new Set(((args.campaignIds as string[] | undefined) ?? []).map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return refuse('Name the campaigns: campaignIds.')
  const rows = await prisma.campaign.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, dailyBudget: true, dailyBudgetCurrency: true, budgetBaselineCents: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return refuse(`Not queued: campaign ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.`)
  const cannot = ids.map((id) => byId.get(id)!).map((c) => ({ c, why: spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name }) ?? (String(c.status) === 'ARCHIVED' ? 'it is archived: its budget spends no more' : null) })).filter((x) => x.why)
  if (cannot.length) return refuse(`Not queued: ${named(cannot.map((x) => `campaign "${x.c.name}": ${x.why}`))}.`)
  const lines: BaselineLine[] = ids.map((id) => {
    const c = byId.get(id)!
    const fromCents = Math.round(Number(c.dailyBudget) * 100)
    const base = { campaignId: id, label: `campaign "${c.name}"`, marketplace: c.marketplace, currency: campaignCurrency(c), fromCents, toCents: c.budgetBaselineCents ?? null }
    if (c.budgetBaselineCents == null) return { ...base, does: 'skip' as const, why: 'no baseline captured' }
    if (c.budgetBaselineCents === fromCents) return { ...base, does: 'skip' as const, why: 'already at baseline' }
    return { ...base, does: 'restore' as const }
  })
  const restoring = lines.filter((l) => l.does === 'restore')
  if (!restoring.length) return refuse(`Nothing would change: ${named(lines.map((l) => `${l.label} (${l.why})`))}.`)

  // Where the writes land: as the approver's own click (a gate refusal is not queued, as set-campaign-budget).
  const reached = await budgetReach(restoring.map((l) => ({ campaignId: l.campaignId, marketplace: l.marketplace, toCents: l.toCents!, label: l.label })))
  if ('refused' in reached) return refuse(`Not queued: ${reached.refused}`)
  const reach = reached.reach as StoredReach
  const items: KitItem[] = restoring.map((l) => ({ entity: { kind: 'campaign', id: l.campaignId }, change: { field: 'dailyBudget', fromCents: l.fromCents, toCents: l.toCents! } }))
  const writes: RuleWrite[] = restoring.map((l) => ({ campaignId: l.campaignId, marketplace: l.marketplace, changes: [{ field: 'dailyBudget', valueCents: l.toCents! }], label: l.label }))
  const rule = await ruleFactsFor({ tool: BASELINE_TOOL_NAME, limits: BASELINE_LIMITS, items, writes, approvalId: ctx.approvalId ?? null })
  const found: Array<Raise<'campaignBudget'>> = restoring.filter((l) => l.toCents! > l.fromCents).map((l) => ({ lever: 'campaignBudget', why: `${l.label}: ${amountLabel(l.fromCents, l.currency)} → ${amountLabel(l.toCents!, l.currency)}` }))
  const { raises, coded, raisesWithoutCode } = splitRaises(found, baselineNeedsCode)
  const stepUp = budgetStepUp(`raises ${plural(coded.length, 'campaign budget')} back to ${coded.length === 1 ? 'its' : 'their'} baseline`, coded.length ? ['Budgets'] : [])
  // What else moves these budgets (rules, hourly schedules, budget schedules, pools): they may move them again.
  const labels = new Map(restoring.map((l) => [l.campaignId, l.label]))
  const alsoChangedBy = alsoChangedByOf(rule.limitFacts, await budgetEnginesOf([...labels.keys()]), labels)
  const shown = restoring.map((l) => ({ campaignId: l.campaignId, label: l.label, marketplace: l.marketplace, currency: l.currency, fromCents: l.fromCents, toCents: l.toCents! }))
  const skipped = lines.filter((l) => l.does === 'skip').map((l) => ({ campaignId: l.campaignId, label: l.label, why: l.why! }))
  const effect = `Sets the daily budget of ${plural(restoring.length, 'campaign')} back to its baseline: ${named(restoring.map((l) => `${l.label} ${amountLabel(l.fromCents, l.currency)} → ${amountLabel(l.toCents!, l.currency)}`))}.`
    + (skipped.length ? ` ${plural(skipped.length, 'campaign')} left as ${skipped.length === 1 ? 'it is' : 'they are'} (${named(skipped.map((s) => `${s.label}: ${s.why}`))}).` : '')
  return {
    lines,
    result: {
      ok: true,
      preview: {
        action: BASELINE_TOOL_NAME,
        op: 'restore',
        markets: [...new Set(restoring.map((l) => l.marketplace).filter((m): m is string => !!m))].sort(),
        changes: shown.slice(0, LINES_SHOWN),
        ...(shown.length > LINES_SHOWN ? { moreChanges: shown.length - LINES_SHOWN } : {}),
        skipped,
        totals: { restoring: restoring.length, skipped: skipped.length, raising: raises.length },
        raises,
        ...(stepUp ? { stepUp } : {}),
        ...(raisesWithoutCode ? { raisesWithoutCode } : {}),
        alsoChangedBy,
        basis: hash(lines.map((l) => [l.campaignId, l.fromCents, l.toCents])),
        reach,
        reachNote: budgetReachNote(reach, ''),
        effect,
        undoNote: 'Undo puts each campaign\'s daily budget back as it was, through set-campaign-budget (its list form).',
        ...rule,
      },
    },
  }
}

/** restore-budget-baselines' limits: set-campaign-budget's raise and cut steps; nothing by rule until a person sets maxItems. */
const BASELINE_LIMITS = adKitLimits({ maxItems: 0 }, STEP_PCT_LIMITS)

/** Undo: each budget back as it was, through set-campaign-budget's list form. */
export const RESTORE_BUDGET_BASELINES_UNDO: ToolUndo = {
  async current(change) {
    const campaigns = ((change.after as { campaigns?: Array<{ campaignId: string }> } | null)?.campaigns) ?? []
    const rows = campaigns.length ? await prisma.campaign.findMany({ where: { id: { in: campaigns.map((c) => c.campaignId) } }, select: { id: true, dailyBudget: true } }) : []
    const byId = new Map(rows.map((r) => [r.id, Math.round(Number(r.dailyBudget) * 100)]))
    return { campaigns: campaigns.map((c) => ({ campaignId: c.campaignId, dailyBudgetCents: byId.get(c.campaignId) ?? null })) }
  },
  request(change) {
    const before = ((change.before as { campaigns?: Array<{ campaignId: string; dailyBudgetCents: number }> } | null)?.campaigns) ?? []
    if (!before.length) return { refusal: 'This change does not record the budgets it replaced.' }
    return { tool: 'set-campaign-budget', args: { campaigns: before.map((c) => ({ campaignId: c.campaignId, dailyBudgetCents: c.dailyBudgetCents })), why: 'undo of a restore to baseline' } }
  },
}

const restoreBudgetBaselinesTool: AgentTool = {
  name: BASELINE_TOOL_NAME,
  title: 'Restore budgets to baseline',
  input: baselineInput,
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BASELINE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits),
  undo: RESTORE_BUDGET_BASELINES_UNDO,
  description:
    `Set the daily budget of Amazon Sponsored Products campaigns (up to ${MAX_CAMPAIGNS}) back to the baseline a person `
    + 'captured (budgetBaselineCents in ad-campaigns; set-ad-guardrail campaign-budget-bounds sets one), as the Budget '
    + 'page\'s "Restore to baseline" does, through its own code: one gated write per campaign, in its own currency. A '
    + 'campaign with no baseline, or already at it, is left as it is (listed). A campaign\'s daily budget is '
    + 'set-campaign-budget\'s lever, so it behaves as that tool: the campaign\'s own budget bounds, a spend ceiling and '
    + 'the day\'s budget move warn the person who approves it, and approving sends it; no authenticator code. '
    + `${BY_RULE_WORDS} (by default nothing runs by rule). The preview lists each campaign from → to, the raises, where it `
    + 'lands (live at Amazon or sandbox) and the rules that may move it again. Refused, and not queued, when a campaign is '
    + 'not found, archived or not Sponsored Products, or when Amazon\'s write gate refuses a write. Undo puts each budget '
    + 'back through set-campaign-budget.',
  async handler(args, ctx) {
    return (await baselinePreview(args, ctx)).result
  },
  async execute(args, ctx) {
    const { result: fresh, lines } = await baselinePreview(args, ctx)
    const refusal = budgetRecheck(ctx, fresh, ['basis', 'totals'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { reach: StoredReach; effect: string }
    const coded = await codeGate(ctx, fresh.preview)
    if (coded) return notRun(coded)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const restoring = lines.filter((l) => l.does === 'restore')
    const out = await restoreBudgetBaselines(restoring.map((l) => l.campaignId), run.actor, { changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, reason: run.reason })
    const ran = out.results.filter((r) => r.outcome === 'restored').map((r) => r.id)
    const before = restoring.filter((l) => ran.includes(l.campaignId)).map((l) => ({ campaignId: l.campaignId, dailyBudgetCents: l.fromCents }))
    const change = ran.length
      ? { before: { campaigns: before, changeSetId: run.changeSetId }, after: await RESTORE_BUDGET_BASELINES_UNDO.current({ before: null, after: { campaigns: before } }) }
      : undefined
    const failed = out.results.filter((r) => r.outcome === 'failed')
    const data = { restored: out.restored, failed: out.failed, reach: p.reach, changeSetId: run.changeSetId, note: 'Queued for Amazon: each write is sent after the 5-minute cancel window. approval-status follows them.' }
    if (!ran.length) return notRun(`Not run: every restore was refused by the write — ${named(failed.map((r) => `campaign "${r.name}" (${r.why ?? 'refused'})`))}. Nothing changed.`)
    if (failed.length) return { ok: false, data, change, error: `Partly run: ${ran.length} restored, ${failed.length} refused by the write — ${named(failed.map((r) => `campaign "${r.name}" (${r.why ?? 'refused'})`))}. undo-change puts back what ran.` }
    return { ok: true, data, change }
  },
}

export const ADS_BUDGET_PLAN_TOOLS: AgentTool[] = [setMonthlyAdBudget, restoreBudgetBaselinesTool]
