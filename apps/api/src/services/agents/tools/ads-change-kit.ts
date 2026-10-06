/**
 * MCP full control A4–A10 (docs/mcp-full-control/sections/01-ads.md §3 "Rules every change tool follows") — what
 * every Amazon ad change tool does the same way, in its dry run (`handler`) and again in `execute`, on top of the A3
 * guards (ads-tool-guards.ts):
 *
 *   run as         an approved request only: `execute` needs the approval it carries out (`ToolContext.approvalId`),
 *                  writes as the person who approved it (`user:<approverId>`), names the request in the audit
 *                  (`Claude request <approvalId>: <why>`; `… (run by rule): …` when the business's rule decided it),
 *                  and stamps every write with `changeSetId = approvalId` — so delivery (approval-status) and undo find
 *                  exactly its rows.
 *   by rule        AA-W2-6 — a strategy-bound tool also asks the write gate how it judges the change as a run by rule
 *                  (a machine's write: the allowlist, pins and the person's own limits refuse it, #401), so a change the
 *                  gate would refuse then is never let run by rule — it waits for a person instead of failing.
 *   live reach     the preview stores where the write would land (live, on which Amazon Ads profile, or sandbox); a
 *                  refusal is not queued. `execute` checks again and refuses when the answer changed (d2 = A: live
 *                  only on a campaign already on the live-write allowlist — the gate's own default-deny).
 *   pre-switch     a request queued before these tools could run carries no stored reach: it is never run (d1 = A),
 *                  and the approval sweep expires it (approval-inbox.service.ts).
 *   stale          `execute` re-runs the dry run and refuses when a starting value the person approved has moved.
 *   SP only        phase 1 changes Sponsored Products campaigns only.
 */
import type { z } from 'zod'
import prisma from '../../../db.js'
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { boundAutomationsFor, checkLiveReach, claudeActor, claudeReason, type AdWriteIntent, type BoundAutomation, type LiveReach } from './ads-tool-guards.js'
import { FIELDS } from '@nexus/shared/permissions'
import { buildLimitFacts, commonRefusal, LIMIT_FACTS_MONEY, limitsNote, type KitItem, type LimitFacts } from './ads-autonomy-kit.js'
import type { FieldPermission, ToolContext, ToolResult } from '../tool-types.js'
import { adProductRefusal } from '@nexus/shared/ads-ad-product'
import { stepClamp, strategyWords, limitWords, type StepClamp, type StrategyBidLimits } from '../../advertising/ads-strategy/bids.js'

// ── Running as an approved request ────────────────────────────────────────────────────────────────

export interface ApprovedRun {
  actor: AdsActor
  reason: string
  changeSetId: string
  /**
   * 4A (Owner decided 2026-10-06) — a person approved it: the write carries his manual mark (passes a halt, autonomy
   * OFF, pins and the allowlist, like his own click), and his approval is his "Send anyway" past his own limits — the
   * card showed them before he approved (`ownLimitsNote`). False for a run a standing rule approved.
   */
  manual: boolean
  confirmOwnLimits: boolean
}

/** The actor, the audit reason and the change set an approved run writes with — or why it may not run. */
export function approvedRun(ctx: ToolContext, why: string): ApprovedRun | { refusal: string } {
  const approvalId = ctx.approvalId?.trim()
  if (!approvalId) return { refusal: 'an ad change runs only as an approved request (no approval was handed to it)' }
  const approver = ctx.userId?.trim()
  if (!approver) return { refusal: 'an approved ad change runs as the person who approved it, and this run names no person' }
  const said = why.trim() || 'no reason given'
  // AA-W2-6 — a run the business's rule decided says so in the audit, so the Change Log tells it from a person's approval.
  const byRule = ctx.decidedVia === 'auto'
  const reason = ctx.via === 'claude'
    ? claudeReason(approvalId, said, { byRule })
    : `${ctx.via === 'fleet' ? 'Fleet request' : 'Approved request'} ${approvalId}${byRule ? ' (run by rule)' : ''}: ${said}`
  const person = ctx.approvedByPerson === true
  return { actor: claudeActor(approver), reason, changeSetId: approvalId, manual: person, confirmOwnLimits: person }
}

// ── Live reach, stored with the preview ───────────────────────────────────────────────────────────

/** Where an approved write lands, as the preview stores it: never a refusal (a refused request is not queued). */
export type StoredReach = ({ reach: 'live'; profileId: string } | { reach: 'sandbox' }) & {
  /** 4A + 3A — his own limits this request goes past (shown on the card; approving sends it anyway). */
  pastOwnLimits?: Array<{ limit: string; reason: string }>
}

export function storedReach(reach: Exclude<LiveReach, { reach: 'refused' }>): StoredReach {
  const past = reach.reach === 'live' && reach.pastOwnLimits?.length ? { pastOwnLimits: reach.pastOwnLimits } : {}
  return reach.reach === 'live' ? { reach: 'live', profileId: reach.profileId, ...past } : { reach: 'sandbox' }
}

/** The sentence the approver reads beside the change. */
export function reachNote(reach: StoredReach): string {
  const base = reach.reach === 'live'
    ? `live: after approval it is sent to Amazon (Amazon Ads profile ${reach.profileId}).`
    : 'sandbox: after approval it is recorded in Nexus only. Amazon ads writes are not live, so nothing reaches Amazon.'
  const over = ownLimitsNote(reach)
  return over ? `${base} ${over}` : base
}

/**
 * 4A + 3A — the over-limit warning the approval card shows BEFORE he approves: the request goes past his own limits
 * (bounds, bid policies, spend ceilings, the daily budget-move limit, the value cap), and approving it sends it anyway.
 * Null when it passes none.
 */
export function ownLimitsNote(reach: { pastOwnLimits?: Array<{ reason: string }> }): string | null {
  const past = reach.pastOwnLimits ?? []
  return past.length ? `Warning — this goes past your own limits: ${past.map((l) => l.reason).join('; ')}. Approving it sends it anyway.` : null
}

/**
 * AA-W2-9 — `restrictedFields` of a strategy-bound tool a person without ad-spend view may use: the money of its facts
 * (LIMIT_FACTS_MONEY) and the lines that say it (`limitsNote`), less its own keys it already showed to anyone who may
 * use it (`shown`: hiding them now would change what such a person sees of the change itself).
 */
export function strategyFactsMoney(shown: readonly string[] = []): Readonly<Record<string, FieldPermission>> {
  const money = Object.fromEntries(Object.entries(LIMIT_FACTS_MONEY).filter(([key]) => !shown.includes(key))) as Record<string, FieldPermission>
  return { ...money, limitsNote: FIELDS.financialsAdspendView }
}

/** The words every strategy-bound ad tool says about who decides (N3: honest about the rule, never "always a person"). */
export const BY_RULE_WORDS = 'A person approves it in Nexus — unless this business lets it run by its rule inside its limits and the ads strategy'

/** What to do about a refusal, by the gate's own reason code. */
const UNBLOCK: Record<string, string> = {
  campaign_allowlist: 'Only campaigns on the live-write allowlist take approved changes: ask for set-campaign-live-writes first.',
  authority_pin: 'Someone holds this by hand (a pin): it is lifted in Nexus, not here.',
  automation_halted: 'Ads automation is stopped: it is resumed in the Ads Control Room.',
  entity_bounds: 'The campaign\'s own bid or budget bounds, a bid policy or the ads strategy\'s bid band refuse this value: ask for a value inside them.',
  connection: 'No production Amazon Ads connection with writes enabled serves this market.',
  connection_writes: 'Writes are not enabled for this Amazon Ads profile.',
  keyword_protected: 'The term is protected against negation.',
  product_protected: 'The ads strategy protects this product: no engine, rule or schedule negates its ASIN. A person adding it himself is warned and may send it anyway.',
  spend_ceiling: 'A spend ceiling refuses a raise this large today.',
  budget_day_move: 'The budget has already moved as far as allowed today.',
  value_cap: 'The value is above the cap for one write.',
}

/** A refused request, said plainly: not queued, why, and what would unblock it. */
export function reachRefusal(reach: Extract<LiveReach, { reach: 'refused' }>): string {
  return `Not queued: ${gateRefusal(reach)}`
}

/** The gate's refusal and how to unblock it, as one sentence (a batch names several, each after its item). */
export function gateRefusal(reach: Extract<LiveReach, { reach: 'refused' }>): string {
  return `Amazon's write gate refuses it — ${reach.reason}. ${UNBLOCK[reach.deniedAt] ?? ''}`.trim()
}

/** The reach the person approved, from the stored preview; null for a request made before these tools could run. */
export function approvedReachOf(approvedPreview: unknown): StoredReach | null {
  const reach = (approvedPreview as { reach?: unknown } | null | undefined)?.reach as StoredReach | undefined
  if (!reach || typeof reach !== 'object') return null
  if (reach.reach === 'live' && typeof reach.profileId === 'string') {
    // 4A + 3A — the own limits the card warned about are part of what he approved.
    const past = Array.isArray(reach.pastOwnLimits) && reach.pastOwnLimits.length ? { pastOwnLimits: reach.pastOwnLimits } : {}
    return { reach: 'live', profileId: reach.profileId, ...past }
  }
  if (reach.reach === 'sandbox') return { reach: 'sandbox' }
  return null
}

/** Refuses a run whose request was made before ad changes could run (d1): it is never run, and the sweep expires it. */
export const PRE_SWITCH_REFUSAL = 'Not run: this request was made before approved ad changes could reach Amazon. Ask for it again; the new request shows where it lands.'

/** The JSON of a value, keys sorted (jsonb re-orders keys), for comparing a stored preview with a fresh one. */
export function canonical(value: unknown): string {
  const plain = JSON.stringify(value ?? null)
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

/**
 * `execute`'s re-check, on every approve path: the request was made after the switch, the dry run still passes, the
 * write still lands where the person was told, and none of the starting values they approved moved. Null when it may
 * run; otherwise the sentence that refuses it.
 */
export function recheck(ctx: ToolContext, fresh: ToolResult, material: readonly string[]): string | null {
  const approved = approvedReachOf(ctx.approvedPreview)
  if (!approved) return PRE_SWITCH_REFUSAL
  if (!fresh.ok) return `Not run: ${fresh.error ?? 'it is no longer a valid change'}`
  const now = (fresh.preview ?? {}) as Record<string, unknown>
  const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
  if (canonical(now.reach) !== canonical(approved)) {
    // 4A + 3A — same destination, but the own limits it goes past are not the ones the card warned him about.
    const where = (r: unknown) => canonical({ ...(r as StoredReach | undefined), pastOwnLimits: undefined })
    if (where(now.reach) === where(approved)) {
      const over = ownLimitsNote((now.reach ?? {}) as StoredReach)
      return `Not run: the limits it goes past changed after you approved it.${over ? ` ${over.replace(' Approving it sends it anyway.', '')}` : ''} Ask for it again to see the warning first.`
    }
    const said = (r: unknown) => ((r as StoredReach | undefined)?.reach === 'live' ? `live (profile ${(r as { profileId: string }).profileId})` : 'sandbox')
    return `Not run: it was approved as ${said(approved)}, and it would now be ${said(now.reach)}.`
  }
  const moved = material.filter((key) => key in before && canonical(before[key]) !== canonical(now[key]))
  if (moved.length) return `Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the values as they are now.`
  return null
}

// ── Shared facts ──────────────────────────────────────────────────────────────────────────────────

/**
 * Phase 1 changes Sponsored Products campaigns only (SB negatives are blocked upstream; SD has none). 6a — the shared
 * ad product and sentence the mutation layer and the write gate refuse with; an unknown ad product is refused here.
 */
export function spOnlyRefusal(campaign: { type?: string | null; adProduct?: string | null; name?: string | null }): string | null {
  return adProductRefusal(campaign)
}

/** The enabled rules and schedules bound to the campaign: they may change it again after this change. */
export async function alsoChangedBy(campaignId: string): Promise<{ automations: BoundAutomation[]; note: string | null }> {
  const automations = (await boundAutomationsFor(campaignId)).slice(0, 10)
  return {
    automations,
    note: automations.length ? `${automations.length} enabled rule${automations.length === 1 ? '' : 's'} or schedule${automations.length === 1 ? '' : 's'} bound to this campaign may change it again.` : null,
  }
}

/**
 * The bid the mutation service will actually write for a requested one: the largest change per action — the LOWER of
 * the campaign's max-change-% guardrail (`dynamicBidding.maxBidChangePct`) and, W1-5, the ads strategy's largest bid
 * change for the target's ad group — applied to the current bid (ads-mutation.service.ts updateAdTargetWithSync). The
 * same function (stepClamp), so the preview shows the value that lands.
 */
export function changeClampedBid(currentBidCents: number, wantedCents: number, dynamicBidding: unknown, strategy?: StrategyBidLimits | null): number {
  return stepClamp(currentBidCents, wantedCents, dynamicBidding, strategy).cents
}

/** W1-5 — what moved a previewed bid off the one asked for, in words (the step clamp's answer, `stepClamp`). */
export function stepClampWords(step: StepClamp, strategy?: StrategyBidLimits | null): string {
  if (step.bandHeld) return limitWords(step.bandHeld.side, step.bandHeld.limit)
  if (step.by === 'strategy' && strategy?.maxChangePct) return `the largest bid change ${step.pct} % (${strategyWords(strategy.maxChangePct.source)})`
  return 'the campaign\'s max-change guardrail'
}

/** An approved run that could not run, as the gate expects it (ok:false; the request goes back to waiting). */
export const notRun = (error: string): ToolResult => ({ ok: false, error })

// ── By rule (AA-W2-6): what a strategy-bound tool's preview carries, and its limits check ────────

/** One write as the gate judges it, with what a person calls where it lands (`campaign "…"`). */
export type RuleWrite = AdWriteIntent & { label?: string }

/** What a strategy-bound tool's dry run adds to its preview, beside its own fields. */
export interface RuleFacts {
  /** The facts its limits are judged on (ads-autonomy-kit.ts): the strategy where it lands, this change counted, today. */
  limitFacts: LimitFacts
  /** Each limit, its value, this change's value and its source, as the Approvals page and Claude read them. */
  limitsNote: string[]
  /**
   * The write gate's refusal of these writes as a run by rule (a machine's write: the allowlist, pins and the
   * person's own limits refuse it), or null when it lets them all through. `reach` is how it judges a person's
   * approval (his own click, 4A): it does not say this.
   */
  ruleGate: string | null
}

/**
 * The write gate's answer for these writes as a run by rule: null when it lets every one through, else the first
 * refusal as a sentence. Read-only.
 */
export async function ruleGateRefusal(writes: readonly RuleWrite[]): Promise<string | null> {
  for (const { label, ...intent } of writes) {
    const reach = await checkLiveReach({ ...intent, byRule: true })
    if (reach.reach === 'refused') return `${label ? `${label}: ` : ''}Amazon's write gate refuses it as a run by rule — ${reach.reason}`
  }
  return null
}

/** The limits this business set for a tool (Settings › AI › Claude), for the note; the defaults when none are stored. */
async function toolLimitsHere(tool: string, limits: z.ZodObject): Promise<Record<string, unknown>> {
  const row = await prisma.agentTool.findFirst({ where: { name: tool }, select: { claudeLimits: true } })
  const parsed = row?.claudeLimits && typeof row.claudeLimits === 'object' ? limits.strict().safeParse(row.claudeLimits) : null
  return (parsed?.success ? parsed.data : limits.parse({})) as Record<string, unknown>
}

/**
 * A strategy-bound tool's dry run: the limit facts of every item it changes (a bulk change: every row, not only the
 * lines its preview shows), the note, and the write gate's answer as a run by rule. `approvalId`: the request a dry run
 * re-checks (ToolContext.approvalId), not counted in today's ledger.
 */
export async function ruleFactsFor(input: { tool: string; limits: z.ZodObject; items: readonly KitItem[]; writes: readonly RuleWrite[]; approvalId?: string | null }): Promise<RuleFacts> {
  const limitFacts = await buildLimitFacts({ tool: input.tool, items: input.items, approvalId: input.approvalId })
  const ruleGate = await ruleGateRefusal(input.writes)
  return { limitFacts, limitsNote: limitsNote(limitFacts, await toolLimitsHere(input.tool, input.limits)), ruleGate }
}

/**
 * Pure — a strategy-bound tool's `withinLimits`, before its own row checks: the common checks (C1–C7, every row inside
 * its scope's strategy, the steps, the month), then the write gate as a run by rule. A preview without the gate's
 * answer is never inside.
 */
export function ruleRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const common = commonRefusal(preview, limits)
  if (common) return common
  const p = preview as { ruleGate?: unknown }
  if (!('ruleGate' in p)) return 'the write gate was not asked how it judges this change as a run by rule; a person decides'
  return typeof p.ruleGate === 'string' ? `${p.ruleGate}; a person decides` : null
}
