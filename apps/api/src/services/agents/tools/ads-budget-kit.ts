/**
 * ADS AUTONOMY W4-7 — what Claude's budget tools share (set-monthly-ad-budget, set-budget-schedule, set-budget-pool,
 * restore-budget-baselines, and set-campaign-budget's list form): where a budget write lands, the approver's code for a
 * raise, the re-check in `execute`, and the limits a business sets for running them by its rule.
 *
 *   reach    a write of a daily budget lands where Amazon's write gate says, per campaign (`budgetReach`): live on a
 *            profile, or sandbox; one the gate refuses as the approver's own click is refused and not queued, as
 *            set-campaign-budget does. His own limits it goes past (the campaign's budget bounds, a spend ceiling, the
 *            day's budget move) are WARNED on the card and approving sends it anyway (4A + 3A). A change of a plan, a
 *            schedule or a pool is Nexus only now (`reach` null): its engine writes at Amazon on its next run.
 *   code     the Owner's code rule (ads-code-rule.ts, 2026-10-07): every budget lever is a day-to-day door — a raise is
 *            listed in `raises`, said in the effect, warned on the card past his own limits, and a person's approval
 *            sends it with no authenticator code. Each tool still decides it in ONE helper (`…NeedsCode`), so a change of
 *            the rule is one line: `codeRuleOf(door)`. A lever an older tool already moves without a code names that tool
 *            (a campaign's daily budget: set-campaign-budget; a schedule's windows and a pool's values: tune-ad-engine;
 *            a schedule switched with its give-back: turn-up / turn-down-automation; a campaign's lowest and highest daily
 *            budget: set-ad-guardrail).
 *   recheck  `execute` re-runs the dry run and refuses when where it lands, or a value the person approved, moved.
 *   limits   by default nothing runs by rule (maxItems 0, no op listed, no market listed, no raise); each loosening is a
 *            limit the business sets (Settings › AI › Claude), which itself needs the code.
 */
import { z } from 'zod'
import { checkLiveReach } from './ads-tool-guards.js'
import { canonical, ownLimitsNote, ruleRefusal, type StoredReach } from './ads-change-kit.js'
import { adKitLimits } from './ads-autonomy-kit.js'
import { STEP_UP_NEEDS, stepUpApproval, type StepUp } from '../step-up-approval.js'
import { addsSpendWords, needsCode, type CodeDoor } from './ads-code-rule.js'
import type { ToolContext, ToolResult } from '../tool-types.js'
import type { LimitFacts } from './ads-autonomy-kit.js'

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
/** "a, b and 3 more". */
export function named(list: readonly string[], shown = 3): string {
  const head = list.slice(0, shown)
  return list.length > shown ? `${head.join(', ')} and ${list.length - shown} more` : head.join(', ')
}

export const MARKET = z.string().trim().toUpperCase().min(2).max(20)
export const ID = z.string().trim().min(1).max(64)
export const WHY = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')

// ── Where a budget write lands ────────────────────────────────────────────────────────────────────

/** One daily budget a request writes now: the campaign, its market, the value it sets (minor units), what a person calls it. */
export interface BudgetWrite { campaignId: string; marketplace: string | null; toCents: number; label: string }

/**
 * Where these budget writes land, every campaign asked (sorted, so the answer is stable): live on the profiles named, or
 * sandbox; his own limits each goes past, named by campaign. `byRule`: the writes are an engine's (a schedule's give-back,
 * as the screen's) — a refusal then does not refuse the request, it is returned per campaign (`gateRefuses`), as the
 * screen counts a refused give-back. Null `reach`: no write.
 */
export async function budgetReach(writes: readonly BudgetWrite[], opts: { byRule?: boolean } = {}): Promise<
  { reach: StoredReach | null; gateRefuses: Array<{ campaignId: string; label: string; reason: string }> } | { refused: string }
> {
  const profiles = new Set<string>()
  const past: Array<{ limit: string; reason: string }> = []
  const gateRefuses: Array<{ campaignId: string; label: string; reason: string }> = []
  let landed = 0
  for (const w of [...writes].sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1))) {
    const reach = await checkLiveReach({ campaignId: w.campaignId, marketplace: w.marketplace, changes: [{ field: 'dailyBudget', valueCents: w.toCents }], ...(opts.byRule ? { byRule: true } : {}) })
    if (reach.reach === 'refused') {
      if (!opts.byRule) return { refused: `${w.label}: Amazon's write gate refuses it — ${reach.reason}` }
      gateRefuses.push({ campaignId: w.campaignId, label: w.label, reason: reach.reason })
      continue
    }
    landed++
    if (reach.reach === 'live') {
      profiles.add(reach.profileId)
      for (const l of reach.pastOwnLimits ?? []) past.push({ limit: l.limit, reason: `${w.label}: ${l.reason}` })
    }
  }
  if (!landed) return { reach: null, gateRefuses }
  const reach: StoredReach = profiles.size
    ? { reach: 'live', profileId: [...profiles].sort().join(','), ...(past.length ? { pastOwnLimits: past } : {}) }
    : { reach: 'sandbox' }
  return { reach, gateRefuses }
}

/** The sentence beside the change: where its budget writes land now, and that its engine writes later. */
export function budgetReachNote(reach: StoredReach | null, later: string): string {
  if (!reach) return `Nexus only now: nothing is sent to Amazon by this change. ${later}`.trim()
  const base = reach.reach === 'live'
    ? `Its budget writes are sent to Amazon after approval (Amazon Ads profile ${reach.profileId}).`
    : 'Its budget writes are recorded in Nexus only: Amazon ads writes are not live (sandbox), so nothing reaches Amazon.'
  const over = ownLimitsNote(reach)
  return [base, over, later].filter(Boolean).join(' ')
}

// ── The approver's code ───────────────────────────────────────────────────────────────────────────

/** How a request that needs the code is approved, in one sentence (its stepUp). */
export const BUDGET_CODE_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked '
  + 'confirms it in Claude with theirs. By the business\'s rule only where this tool\'s limits allow a raise (allowRaise, off by default; '
  + 'switching it on needs the code too).'

/**
 * Whether a raise through a lever needs the approver's code — each tool decides it in ONE helper (its `…NeedsCode`), so a
 * change of the Owner's code rule is one line: `code: true` where it asks for the code; `code: false` for a day-to-day
 * raise, naming the older tool that already moves that lever without one (`as`), when there is one.
 */
export type CodeRule = { code: true } | { code: false; as?: string }

/** The Owner's code rule (ads-code-rule.ts) for one door: the code, or a day-to-day raise (no code). */
export function codeRuleOf(door: CodeDoor): CodeRule {
  return needsCode(door) ? { code: true } : { code: false }
}

/** The sentence a budget request's effect ends with when it can raise spend (no silent raise); empty when none. */
export function budgetRaiseWords(raises: readonly string[], coded: readonly string[]): string {
  return addsSpendWords(raises, coded.length > 0)
}

/** One way a request can raise spend: the lever (what the code rule reads) and the sentence a person reads. */
export interface Raise<L extends string> { lever: L; why: string }

/**
 * Every raise listed (`raises`: what the limits and the card read, whatever the code rule), the ones that need the code
 * (`coded`, for stepUp), and the others with the older tool they behave like (`raisesWithoutCode`, absent when none).
 */
export function splitRaises<L extends string>(all: ReadonlyArray<Raise<L>>, rule: (lever: L) => CodeRule) {
  const coded: string[] = []
  const without: string[] = []
  for (const r of all) {
    const decided = rule(r.lever)
    if (decided.code === true) coded.push(r.why)
    else without.push(`${r.why} — no code${decided.as ? `, as with ${decided.as}` : ' (a day-to-day raise)'}`)
  }
  return { raises: all.map((r) => r.why), coded, ...(without.length ? { raisesWithoutCode: without } : {}) }
}

/** The stepUp a preview carries when approving it needs the approver's code; null when nothing in it needs one. */
export function budgetStepUp(what: string, coded: readonly string[]): StepUp | null {
  return coded.length ? { what, raises: [...new Set(coded)], needs: STEP_UP_NEEDS, how: BUDGET_CODE_HOW } : null
}

/**
 * `execute` of a request whose fresh dry run still needs the code: approved with a fresh code by a person who holds
 * settings.security.manage now, or run by the business's rule (its limits let the raise run: withinLimits held it).
 * Null when it may run.
 */
export async function codeGate(ctx: ToolContext, preview: unknown): Promise<string | null> {
  if (!(preview as { stepUp?: unknown } | null)?.stepUp) return null
  if (ctx.decidedVia === 'auto') return null
  const coded = await stepUpApproval(ctx)
  return 'refusal' in coded ? coded.refusal : null
}

// ── The re-check in `execute` ─────────────────────────────────────────────────────────────────────

const where = (r: unknown) => (r == null ? 'Nexus only' : (r as StoredReach).reach === 'live' ? `live (profile ${(r as { profileId: string }).profileId})` : 'sandbox')

/**
 * `execute`'s re-check, on every approve path: the dry run still passes, its writes land where the person was told (or
 * still nowhere), and none of the values he approved moved. Null when it may run.
 */
export function budgetRecheck(ctx: ToolContext, fresh: ToolResult, material: readonly string[]): string | null {
  if (!fresh.ok) return `Not run: ${fresh.error ?? 'it is no longer a valid change'}`
  const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
  const now = (fresh.preview ?? {}) as Record<string, unknown>
  if (!('reach' in before)) return 'Not run: the request it carries out holds no preview to check against. Ask for it again.'
  if (canonical(before.reach) !== canonical(now.reach ?? null)) {
    const bare = (r: unknown) => canonical(r == null ? null : { ...(r as StoredReach), pastOwnLimits: undefined })
    if (bare(before.reach) === bare(now.reach ?? null)) {
      const over = ownLimitsNote((now.reach ?? {}) as StoredReach)
      return `Not run: the limits it goes past changed after you approved it.${over ? ` ${over.replace(' Approving it sends it anyway.', '')}` : ''} Ask for it again to see the warning first.`
    }
    return `Not run: it was approved as ${where(before.reach)}, and it would now be ${where(now.reach)}.`
  }
  const moved = material.filter((key) => key in before && canonical(before[key]) !== canonical(now[key]))
  return moved.length ? `Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the values as they are now.` : null
}

// ── Limits: what may run by the business's rule ───────────────────────────────────────────────────

/**
 * The limits of a budget tool with ops: the kit's (maxItems 0 — nothing runs by rule until a person types a number), the
 * ops and markets that may run by rule (none by default), and whether a change that can raise spend may (never by
 * default). `extra`: the tool's own.
 */
export function budgetLimits<O extends readonly [string, ...string[]], S extends z.ZodRawShape>(ops: O, extra?: S) {
  return adKitLimits({ maxItems: 0 }, {
    ops: z.array(z.enum(ops)).max(ops.length).default([])
      .describe(`the ops that may run by rule (${ops.join(', ')}); empty = none, every request waits for a person`),
    markets: z.array(MARKET).max(30).default([])
      .describe('the markets where it may run by rule; empty = none'),
    allowRaise: z.boolean().default(false)
      .describe('let a change that can raise spend run by rule (a bigger budget, a brake lifted, a give-back, more campaigns in a raising window); never by default'),
    ...(extra ?? ({} as S)),
  })
}

/** What every budget tool's preview carries for its limits check, beside the kit's facts. */
export interface BudgetRulePreview {
  op?: string
  /** The markets it acts in (a pool create names none). */
  markets?: string[]
  /** Every way it can raise spend, in words; empty when none. */
  raises?: string[]
}

/** Pure — a budget tool's `withinLimits`: the kit's checks and the gate as a run by rule, then the op, the markets, a raise. */
export function budgetRuleRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const ruled = ruleRefusal(preview, limits)
  if (ruled) return ruled
  const p = (preview ?? {}) as BudgetRulePreview
  const ops = Array.isArray(limits.ops) ? (limits.ops as string[]) : []
  if (!p.op || !ops.includes(p.op)) return `op ${p.op ?? '?'} does not run by rule here (this tool's limits list ${ops.length ? ops.join(', ') : 'no op'}); a person decides`
  const markets = Array.isArray(limits.markets) ? (limits.markets as string[]) : []
  const outside = (p.markets ?? []).filter((m) => !markets.includes(m))
  if (outside.length) return `it acts in ${outside.join(', ')}, where this tool's limits let nothing run by rule (markets: ${markets.length ? markets.join(', ') : 'none'}); a person decides`
  if (!Array.isArray(p.raises)) return 'the preview does not say whether it can raise spend; a person decides'
  if (p.raises.length && limits.allowRaise !== true) return `it can raise spend (${named(p.raises, 2)}); this tool's limits let no raise run by rule (allowRaise is off); a person decides`
  return null
}

// ── What else moves these campaigns' budgets ──────────────────────────────────────────────────────

/** One campaign and every automation that also moves it: rules and hourly schedules (the kit's), budget schedules, pools. */
export interface AlsoChangedBy { campaignId: string; label: string; by: string[] }

/**
 * The budget schedules (switched on) and budget pools each campaign is in, by campaign id — the engines the kit's
 * `engineOwned` (rules and hourly schedules) does not name. `except`: the schedule or pool the request itself changes.
 */
export async function budgetEnginesOf(campaignIds: readonly string[], except: { scheduleId?: string | null; poolId?: string | null } = {}) {
  const ids = new Set(campaignIds)
  const out = new Map<string, { schedules: Array<{ id: string; name: string }>; pool: { id: string; name: string; level: string } | null }>()
  if (!ids.size) return out
  const { listBudgetSchedules } = await import('../../advertising/ads-budget-schedule.service.js')
  const { poolsOfCampaigns } = await import('../../advertising/ads-budget-pool.service.js')
  const [schedules, pools] = await Promise.all([listBudgetSchedules(), poolsOfCampaigns([...ids])])
  const at = (id: string) => out.get(id) ?? out.set(id, { schedules: [], pool: null }).get(id)!
  for (const s of schedules) {
    if (!s.enabled || s.id === except.scheduleId) continue
    for (const c of Array.isArray(s.campaigns) ? (s.campaigns as Array<{ id?: unknown }>) : []) {
      if (typeof c?.id === 'string' && ids.has(c.id)) at(c.id).schedules.push({ id: s.id, name: s.name })
    }
  }
  for (const [id, p] of pools) if (p.poolId !== except.poolId) at(id).pool = { id: p.poolId, name: p.poolName, level: p.level }
  return out
}

/**
 * Every campaign of the request another automation also moves: the kit's rules and hourly schedules (`limitFacts.
 * engineOwned`) and the budget schedules and pools (`budgetEnginesOf`), each named — at most 20 campaigns listed.
 */
export function alsoChangedByOf(facts: Pick<LimitFacts, 'engineOwned'>, engines: Awaited<ReturnType<typeof budgetEnginesOf>>, labels: ReadonlyMap<string, string>): AlsoChangedBy[] {
  const out = new Map<string, AlsoChangedBy>()
  for (const o of facts.engineOwned) out.set(o.campaignId, { campaignId: o.campaignId, label: o.label, by: [...o.by] })
  for (const [id, e] of engines) {
    const row = out.get(id) ?? { campaignId: id, label: labels.get(id) ?? `campaign ${id}`, by: [] }
    row.by.push(...e.schedules.map((s) => `budget schedule "${s.name}"`), ...(e.pool ? [`budget pool "${e.pool.name}" (${e.pool.level})`] : []))
    if (row.by.length) out.set(id, row)
  }
  return [...out.values()].slice(0, 20)
}
