/**
 * MCP full control A3 (docs/mcp-full-control/sections/01-ads.md §3 "Rules every change tool follows", §4) — the
 * guards every Claude ad change tool runs in its preview (`handler`) and again in `execute`. Pure where possible; the
 * two reads (the gate, the bound automations) are named as such.
 *
 *   live reach      `checkAdsWriteGate` (read-only) with the campaign id, every field and the value, handed over as the
 *                   ads worker hands them → live | sandbox | refused:<reason>. A refused request is not queued, and
 *                   execute refuses when the answer changed since the preview. That closes the gap where the worker's
 *                   gate ran after Nexus was written and a deny left Nexus ≠ Amazon (live defect #4).
 *   suppression     a bid write never RAISES a suppressed target: one with `suppressedFromBidCents` set (the no-pause
 *                   floor's memory), or one at ≤ 3¢ without that flag (floored by another path). The two are counted
 *                   apart. Only a suppression a person set (`bidsSuppressedBy` `user:…`) may be lifted, never an
 *                   engine's. (The Owner's rule: a temporary stop is low bids — a real pause is pause-ads.)
 *   currency        amounts are minor units of the campaign's own currency (`Campaign.dailyBudgetCurrency`), labelled
 *                   with it and never converted.
 *   actor / reason  `user:<approverId>`, `Claude request <approvalId>: <why>` (`… (run by rule): <why>` when the
 *                   business's rule decided it, AA-W2-6).
 *   bound rules     the enabled rules bound to the campaign and its enabled schedules: they may change it again.
 */
import { checkAdsWriteGate, type GateContext, type GateDecision, type GateDeniedAt, type OwnLimit } from '../../advertising/ads-write-gate.js'
import type { AdWrite } from '@nexus/shared/ads-ad-product'
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { automationsBoundToCampaign } from '../../advertising/rule-campaign-binding.service.js'
import { isRuleApprovedRun } from '../tool-types.js'

// ── Live reach ──────────────────────────────────────────────────────────────────────────────────

export type LiveReach =
  | { reach: 'live'; profileId: string; /** 4A + 3A — his own limits it goes past, for the card. */ pastOwnLimits?: OwnLimit[] }
  | { reach: 'sandbox' }
  | { reach: 'refused'; deniedAt: GateDeniedAt; reason: string }

/** One write as a change tool means it: the campaign, and each field it changes with its new value in minor units. */
export interface AdWriteIntent {
  /** Nexus Campaign.id — the allowlist, pins and bounds bind to it. */
  campaignId: string
  /** W1-5 — the ad group a bid lands in: the ads strategy's bid band is its products' (the worker hands the gate the same). */
  adGroupId?: string | null
  marketplace: string | null
  /** Bids in cents; `dailyBudget` in minor units of the campaign's currency (the gate's cents). */
  changes: Array<{ field: string; valueCents: number | null }>
  /** A deliberate suppression or restore (no-pause): exempt from the minimum bid bound and the halt only. */
  isSuppression?: boolean
  /** A negative keyword: the term, so keyword protection binds. */
  keywordText?: string | null
  isNegation?: boolean
  /** 4A — the write is a rule's, not the approver's (an applied automation suggestion): judged as a machine's write. */
  byRule?: boolean
  /**
   * W4-11 — what the write is (adWriteRefusal), as the ads worker describes a write the mutation layer let through for a
   * Sponsored Brands or Display campaign. A tool that sends SB/SD changes says it; absent, SB/SD stays refused (6a).
   */
  write?: AdWrite | null
}

const BID_FIELDS = new Set(['bid', 'defaultBid'])

/**
 * The gate context the ads worker builds for the same write (ads-sync.worker.ts): the bid field is the bounded one the
 * gate judges, else the budget, else the first; the pins see every field; the value cap sees the largest value.
 */
export function gateContextFor(intent: AdWriteIntent): GateContext {
  const finite = (v: number | null) => (v != null && Number.isFinite(v) ? v : null)
  const bid = intent.changes.find((c) => BID_FIELDS.has(c.field))
  const budget = bid ? undefined : intent.changes.find((c) => c.field === 'dailyBudget')
  const judged = bid ?? budget ?? intent.changes[0]
  const values = intent.changes.map((c) => finite(c.valueCents)).filter((v): v is number => v != null)
  return {
    marketplace: intent.marketplace,
    campaignId: intent.campaignId,
    ...(intent.adGroupId ? { adGroupId: intent.adGroupId } : {}),
    field: judged?.field ?? null,
    fields: intent.changes.map((c) => c.field),
    intendedValueCents: finite(bid?.valueCents ?? budget?.valueCents ?? null),
    payloadValueCents: values.length ? Math.max(...values.map((v) => Math.round(v))) : 0,
    isSuppression: intent.isSuppression === true,
    ...(intent.isNegation ? { isNegation: true, keywordText: intent.keywordText ?? null } : {}),
    ...(intent.write ? { write: intent.write } : {}),
    // 4A (Owner decided 2026-10-06) — a change tool writes once a person approves it, and his approval counts as his
    // own click: judged as his write (a halt, autonomy OFF, pins and the allowlist do not stop it), and past his own
    // limits it says so (pastOwnLimits → the card's warning) because approving is his "Send anyway". A run a standing
    // rule approved is the machine's write: its re-check is judged as one (isRuleApprovedRun).
    ...(intent.byRule === true || isRuleApprovedRun() ? {} : { manual: true, confirmOwnLimits: true }),
  }
}

/** The gate's answer in the three words a preview shows. Pure. */
export function liveReachOf(decision: GateDecision): LiveReach {
  if (decision.allowed === false) return { reach: 'refused', deniedAt: decision.deniedAt, reason: decision.reason }
  if (decision.mode !== 'live') return { reach: 'sandbox' }
  const past = (decision as { pastOwnLimits?: OwnLimit[] }).pastOwnLimits
  return { reach: 'live', profileId: decision.profileId, ...(past?.length ? { pastOwnLimits: past } : {}) }
}

export function reachLabel(reach: LiveReach): string {
  return reach.reach === 'refused' ? `refused: ${reach.reason}` : reach.reach
}

/** Read-only: would this write reach Amazon now? */
export async function checkLiveReach(intent: AdWriteIntent): Promise<LiveReach> {
  return liveReachOf(await checkAdsWriteGate(gateContextFor(intent)))
}

/**
 * Execute's re-check: null when the answer is the one the approver saw, else the refusal sentence. A write approved as
 * sandbox must not turn live (nor the reverse), and a live one must reach the same Amazon Ads profile.
 */
export function reachChanged(approved: LiveReach, now: LiveReach): string | null {
  if (approved.reach === now.reach) {
    if (approved.reach === 'live' && now.reach === 'live' && approved.profileId !== now.profileId) {
      return `approved for Amazon Ads profile ${approved.profileId}, but it would now reach profile ${now.profileId} — not run`
    }
    if (approved.reach !== 'refused') return null
  }
  return `approved as ${reachLabel(approved)}, but it would now be ${reachLabel(now)} — not run`
}

// ── Suppression ─────────────────────────────────────────────────────────────────────────────────

/** A bid at or below this, without the suppression flag, is treated as floored: a write may not raise it. */
export const LOW_BID_UNFLAGGED_CENTS = 3

export interface BidTarget {
  id: string
  bidCents: number
  suppressedFromBidCents: number | null
}

export type SuppressionVerdict = 'ok' | 'suppressed' | 'low-unflagged'

/** Whether moving this target to `newBidCents` would raise a suppressed bid. Lowering or holding is never refused. */
export function suppressionOf(target: BidTarget, newBidCents: number): SuppressionVerdict {
  if (newBidCents <= target.bidCents) return 'ok'
  if (target.suppressedFromBidCents != null) return 'suppressed'
  if (target.bidCents <= LOW_BID_UNFLAGGED_CENTS) return 'low-unflagged'
  return 'ok'
}

/** The writes a tool may make, and the two kinds it may not, counted apart. Order is kept in each list. */
export function splitBySuppression<W extends { target: BidTarget; newBidCents: number }>(writes: W[]) {
  const allowed: W[] = [], suppressed: W[] = [], lowUnflagged: W[] = []
  for (const write of writes) {
    const verdict = suppressionOf(write.target, write.newBidCents)
    ;(verdict === 'ok' ? allowed : verdict === 'suppressed' ? suppressed : lowUnflagged).push(write)
  }
  return { allowed, suppressed, lowUnflagged, counts: { allowed: allowed.length, suppressed: suppressed.length, lowUnflagged: lowUnflagged.length } }
}

/**
 * Null when a restore may lift this campaign's suppression; else why not. Only a person's (`user:…`) may be lifted.
 * #513 review — `stopHolds`: the owners of the stops declared as STOP holds (a campaign the bid brain owns): each is a
 * suppression too, and a person's restore ends every one, so each must be a person's.
 */
export function liftSuppressionRefusal(campaign: { bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null }, stopHolds: readonly string[] = []): string | null {
  const owners = [...(campaign.bidsSuppressedAt ? [campaign.bidsSuppressedBy] : []), ...stopHolds]
  if (!owners.length) return 'its bids are not suppressed'
  const other = owners.find((by) => !by?.startsWith('user:'))
  if (other === undefined) return null
  return `its bids were suppressed by ${other || 'an unrecorded actor'}; only a suppression a person set may be lifted here`
}

// ── Currency ────────────────────────────────────────────────────────────────────────────────────

/** The campaign's own currency. The schema defaults it to EUR; a row read without it is EUR too. */
export function campaignCurrency(campaign: { dailyBudgetCurrency?: string | null }): string {
  return campaign.dailyBudgetCurrency?.trim() || 'EUR'
}

/** Minor units in that currency, e.g. `SEK 12.34`. Never converted. */
export function amountLabel(minorUnits: number, currency: string): string {
  return `${currency} ${(minorUnits / 100).toFixed(2)}`
}

// ── Actor and reason ────────────────────────────────────────────────────────────────────────────

/** The approver, as the ads audit records a person. */
export function claudeActor(approverId: string): AdsActor {
  const id = approverId.trim()
  if (!id) throw new Error('an approver is required: a Claude ad change runs as the person who approved it')
  return `user:${id}`
}

/** AA-W2-6 — `byRule`: the business's rule decided it, not a person (ToolContext.decidedVia `auto`); the Change Log says so. */
export function claudeReason(approvalId: string, why: string, opts: { byRule?: boolean } = {}): string {
  if (!approvalId.trim()) throw new Error('an approval id is required: a Claude ad change names the request it came from')
  const said = why.trim()
  if (!said) throw new Error('a reason is required: a Claude ad change says why')
  return `Claude request ${approvalId.trim()}${opts.byRule ? ' (run by rule)' : ''}: ${said}`
}

// ── Bound rules ─────────────────────────────────────────────────────────────────────────────────

export type BoundAutomation =
  | { kind: 'rule'; id: string; name: string; binding: string }
  | { kind: 'schedule'; id: string; name: string }

/** Read-only: the enabled rules bound to the campaign and its enabled schedules, which may change it again. */
export async function boundAutomationsFor(campaignId: string): Promise<BoundAutomation[]> {
  const { rules, schedules } = await automationsBoundToCampaign(campaignId)
  return [
    ...rules.map((r): BoundAutomation => ({ kind: 'rule', id: r.id, name: r.name, binding: r.kind })),
    ...schedules.map((s): BoundAutomation => ({ kind: 'schedule', id: s.id, name: s.name })),
  ]
}
