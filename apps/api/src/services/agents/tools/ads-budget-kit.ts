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
 *   code     the money family rule (lead, Wave B): a request that can raise spend through a lever no older Claude tool
 *            moves without a code carries `stepUp` — the approver's fresh authenticator code (or, by the business's rule,
 *            only where its limits allow raises). A lever an older tool already moves without one behaves exactly like
 *            that tool: a campaign's daily budget (set-campaign-budget), a schedule's windows and a pool's values
 *            (tune-ad-engine), switching a schedule on or off with its give-back (turn-up / turn-down-automation), a
 *            campaign's lowest and highest daily budget (set-ad-guardrail). Those raises are listed in `raises` and warned,
 *            and need no code.
 *   recheck  `execute` re-runs the dry run and refuses when where it lands, or a value the person approved, moved.
 *   limits   by default nothing runs by rule (maxItems 0, no op listed, no market listed, no raise); each loosening is a
 *            limit the business sets (Settings › AI › Claude), which itself needs the code.
 */
import { z } from 'zod'
import { checkLiveReach } from './ads-tool-guards.js'
import { canonical, ownLimitsNote, ruleRefusal, type StoredReach } from './ads-change-kit.js'
import { adKitLimits } from './ads-autonomy-kit.js'
import { STEP_UP_NEEDS, stepUpApproval, type StepUp } from '../step-up-approval.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

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
