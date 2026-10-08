/**
 * AD.2 — Operator-write entry point for the Trading Desk.
 *
 * Every PATCH on a Campaign / AdGroup / AdTarget flows through here:
 *   1. UPSERT the local row (operator sees the change immediately)
 *   2. Enqueue an OutboundSyncQueue row with syncType=AD_* and
 *      holdUntil = NOW + 5min (gives a grace window to cancel)
 *   3. Write a CampaignBidHistory audit row (changedBy = "user:<id>"
 *      or "automation:<ruleId>")
 *   4. Add a BullMQ job to adsSyncQueue keyed by the OutboundSyncQueue
 *      row id — the AD.2 worker (ads-sync.worker.ts) consumes it
 *
 * Sandbox-safe: the worker's call to ads-api-client.update* short-
 * circuits in sandbox mode. So even with NEXUS_AMAZON_ADS_MODE unset,
 * an operator can PATCH a campaign, see the OutboundSyncQueue row,
 * undo within 5 min, and see the audit trail — all without touching
 * Amazon.
 *
 * If BullMQ is unavailable (Redis down / not configured in dev), the
 * mutation still succeeds. The OutboundSyncQueue row sits PENDING and
 * the node-cron fallback (existing) drains it on its next tick.
 */

import type { Prisma } from '@prisma/client'
import { createOutboundRow } from '../outbound-rows.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { adsSyncJobId } from '../../lib/job-id.js'
import { isContradictoryOrphan } from '../ads-core/amazon-entity-gone.js'
import {
  IN_FLIGHT_STATES, isBelievablyPending, isBlockingWrite, isTerminal, stateForQueueStatus, type AdSyncType,
} from '../ads-core/ad-mutation-state.js'
import { packEvidence, type AdWriteEvidence } from './ads-evidence.js'
import { SPONSORED_BRANDS, SPONSORED_DISPLAY, SPONSORED_PRODUCTS, adProductOf, adWriteRefusal, type AdProductSource, type AdWrite } from '@nexus/shared/ads-ad-product'
import { bidCostType, marketLimitsOf, marketLimitsRefusal } from '@nexus/shared/ads-market-limits'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { checkAdsWriteGate, entityBoundsDenial, logGateDeny, ownLimitsSentence, sentPastSentence, type EntityBoundsCampaign, type OwnLimit, type OwnLimitKind } from './ads-write-gate.js'
import { NO_LIMITS, bidLimitsFor, limitSources, strategyWords, stepClamp, type StrategyBidLimits, type WriteSources } from './ads-strategy/bids.js'

// Conservative grace window. Operators have 5 min to cancel before
// the worker actually calls Amazon. Override via env for testing.
const GRACE_PERIOD_MS = Number(process.env.NEXUS_ADS_GRACE_MS ?? 5 * 60 * 1000)

export type AdsActor = `user:${string}` | `automation:${string}`

/**
 * SYNC.1 — the scheduling engines may never write `Campaign.status`.
 *
 * The no-pause policy says the engine suppresses with a ~2¢ bid floor and leaves the campaign
 * ENABLED, because a real pause resets Amazon's optimisation. Both engines honour that on the way
 * DOWN. Neither honoured it on the way back UP: each carried a block reading
 *
 *     // Resume only if something ELSE left it paused (we never pause).
 *     if (camp.status === 'PAUSED') → patch { status: 'ENABLED' }, applyImmediately
 *
 * "Something ELSE" includes the operator in Seller Central, and the engine cannot tell the two
 * apart. Measured on prod 2026-08-21: the operator paused campaigns on Amazon, the settings sync
 * pulled PAUSED down correctly at 19:20, and at 19:30 rank-defend pushed ENABLED back up on 20 of
 * them (`AD_ENTITY_STATE_UPDATE`, amz=SUCCESS). The next read then saw Amazon agreeing with us and
 * closed the drift row as resolved — the account had converged in the wrong direction, silently.
 *
 * The resume blocks are deleted. This guard is the reason it cannot come back: the engines suppress
 * through bids, so they have no legitimate campaign-state write, and the ban is enforced where every
 * write path already passes rather than by remembering not to re-add four lines.
 *
 * Scope is deliberately the two CRON actors only. It matches the policy's stated exceptions exactly:
 *   · `user:*`                    — a human clicking Pause/Enable does a real status write.
 *   · `automation:<ruleId>`       — an operator-authored rule (`enable_campaign`, `resume_campaign`)
 *                                   is the operator acting through a rule. Its PAUSE is refused by
 *                                   `isAutomatedPause` below (1f).
 *   · `automation:rank-defend-*`  — REFUSED. Nobody asked for this campaign specifically.
 *   · `automation:dayparting-*`   — REFUSED. Same.
 *
 * Only `status` is refused. These actors legitimately write bids, budgets and placement.
 *
 * ── No exemptions (2a, review 3.3) ──────────────────────────────────────────────────────────────
 *
 * `automation:dayparting-disable` / `-delete` were exempt: one-shot resumes when a person switched a schedule off or
 * deleted it, gated on `AdSchedule.lastApplied === 'PAUSED'`. That was no ownership check: since the no-pause rule
 * the dayparting cron records PAUSED for a closed window it only floored bids, so the resume re-enabled campaigns a
 * person had paused. Both now give back the floored bids instead (rank-release.service.ts) and write no status, so
 * every actor with these prefixes is refused here, the literal verbs included.
 */
const ENGINE_CRON_ACTOR_PREFIXES = ['automation:rank-defend-', 'automation:dayparting-'] as const

export function isSchedulingEngineActor(actor: string): boolean {
  return ENGINE_CRON_ACTOR_PREFIXES.some((p) => actor.startsWith(p))
}

/**
 * 1f — no automation pauses a campaign or an ad group (Owner rule; decision S5, 2026-10-04).
 *
 * SYNC.1 above bans only the two cron engines, and it let operator-authored rules through, so a
 * rule carrying `pause_campaign`, `pause_ad_group`, `pause_all_campaigns`, `dayparting_apply` or
 * `liquidate_aged_stock` could still pause on Amazon. A pause resets Amazon's learning; the house
 * mechanism is a bid floor (`ads-bid-suppression.service.ts`). This is the backstop where every
 * campaign and ad-group write passes, so a pause added to a handler next year is refused here too.
 *
 * Refused: `status: 'PAUSED'` on a CAMPAIGN or AD_GROUP from any `automation:*` actor.
 * Not refused: a person (`user:*`) — the Pause button keeps working; a rule's ENABLED; and target
 * level (`pause_target` stays a Bid rule action, capped below AUTO by the graduation ceiling).
 */
export function isAutomatedPause(actor: string, status: string | null | undefined): boolean {
  return status === 'PAUSED' && actor.startsWith('automation:')
}

/**
 * 1e (CM-9, CM-10, CM-19) — a person's own edit from a campaign-manager screen.
 *
 * `manual` is set only by the routes a person's click reaches: the campaign-manager PATCH routes, bulk-bid, the two
 * placement routes, the bulk sheet upload, the Undo buttons (rollback.service.ts), the add routes (ads-create.service.ts,
 * via isPersonCreate), the negative add routes (ads-negative-kw.service.ts) and the Budget Manager control plane. It is
 * never derived from the actor string, which is free text (`user:cron-budget-pool` was a machine), and it counts only
 * with a `user:` actor, so an engine that passed it by mistake is still an engine. Such an edit:
 *   · passes the account halt and autonomy OFF at the write gate (`GateContext.manual`; every other check binds);
 *   · may set a bid down to Amazon's own minimum in the market rather than Nexus's 5¢ engine floor;
 *   · is not rewritten by the campaign's `maxBidChangePct` step clamp, which exists so a runaway rule cannot 10× a bid;
 *   · on a bid the no-pause floor holds, becomes the bid the restore puts back (`suppressedFromBidCents`).
 */
export function isPersonEdit(manual: unknown, actor: string | null | undefined): boolean {
  return manual === true && typeof actor === 'string' && actor.startsWith('user:')
}

/**
 * The same test for the create and negative services, which carry a bare person id in `userId` — or an engine's whole
 * actor (`automation:<ruleId>`, the rule handlers and blueprints pass theirs there), which is never a person.
 */
export function isPersonCreate(manual: unknown, userId: string | null | undefined): boolean {
  const u = (userId ?? '').trim()
  return isPersonEdit(manual, u.startsWith('user:') || u.startsWith('automation:') ? u : `user:${u || 'anonymous'}`)
}

/** NP — the lowest bid an ordinary (not forced) engine write may set. Nexus's own floor, not Amazon's. */
const ENGINE_BID_FLOOR_CENTS = 5

/**
 * 1e (CM-19) — Amazon's own minimum Sponsored Products bid in this market, in cents (@nexus/shared/ads-market-limits:
 * €0.02 in IT, DE, FR and ES). Null where Nexus has no checked limits row; the write gate refuses those markets at
 * dispatch, and the 5¢ floor stays there.
 * W4-11 — for a Sponsored Brands or Display campaign, that ad product's minimum for how the campaign pays (`costType`:
 * CPC or vCPM); null when the row has none or the cost type is not held (the gate refuses such a bid).
 */
export function amazonMinBidCents(marketplace: string | null | undefined, campaign?: { adProduct?: string | null; type?: string | null; costType?: string | null } | null): number | null {
  const row = marketLimitsOf(normalizeMarketplaceCode(marketplace, '') || marketplace)
  const product = adProductOf(campaign) ?? SPONSORED_PRODUCTS
  const limits = row?.adProducts[product]
  if (!limits) return null
  if (product === SPONSORED_PRODUCTS) return limits.bid.min
  const pays = bidCostType(campaign?.costType)
  return pays === 'CPC' ? limits.bid.min : pays === 'VCPM' ? (limits.vcpmBid?.min ?? null) : null
}

/**
 * The refusal for a bid under the floor that binds this write; null when it may be written. An engine keeps the 5¢
 * floor (`bid_below_floor_5_cents`, which the routes answer with 400). A person may go down to Amazon's minimum, and
 * below it is told so in Amazon's terms (marketLimitsRefusal) — Amazon would reject that bid anyway. The campaign's
 * own min-bid setting (Campaign.minBidCents, bid policies) is judged after this, by boundsRefused, for both.
 */
function bidFloorRefusal(
  cents: number, person: boolean, marketplace: string | null | undefined, field: 'bid' | 'defaultBid',
  /** W4-11 — the campaign: an SB or SD bid's floor is that ad product's minimum. */
  campaign?: { adProduct?: string | null; type?: string | null; costType?: string | null } | null,
): string | null {
  const amazonMin = person ? amazonMinBidCents(marketplace, campaign) : null
  if (amazonMin == null) return cents < ENGINE_BID_FLOOR_CENTS ? 'bid_below_floor_5_cents' : null
  if (cents >= amazonMin) return null
  const market = normalizeMarketplaceCode(marketplace, '') || marketplace
  return marketLimitsRefusal({ market, field, valueMinor: cents, adProduct: adProductOf(campaign), costType: campaign?.costType ?? null })
    ?? `A bid of ${cents}¢ is below Amazon's minimum of ${amazonMin}¢ in ${market}, so nothing was sent to Amazon.`
}

/**
 * 1e (CM-9) — the no-pause floor remembers each bid it lowered (`suppressedFromBidCents`), and `restoreCampaignBids`
 * writes that memory back. A bid a person sets while the floor holds must survive the restore, so his bid replaces the
 * memory: the restore then puts back HIS bid, and a re-floor never lifts a bid above it (refloorBidCents takes the
 * lower). The update helpers write the memory together with his bid; this covers the one case that writes nothing
 * else — a person confirming the value the floor holds ("keep it at 2¢") is no change on Amazon, but it is his bid.
 */
async function keepPersonBidThroughRestore(
  entity: 'AD_GROUP' | 'AD_TARGET', id: string, person: boolean, bidCents: number | null | undefined, remembered: number | null,
): Promise<void> {
  if (!person || bidCents == null || remembered == null || remembered === bidCents) return
  if (entity === 'AD_GROUP') await prisma.adGroup.update({ where: { id }, data: { suppressedFromBidCents: bidCents } })
  else await prisma.adTarget.update({ where: { id }, data: { suppressedFromBidCents: bidCents } })
}

export type AdEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD' | 'PORTFOLIO'

// 1a (CM-4) — one list for the writer, the ads drain and the generic queue processors (ad-mutation-state.ts).
export type { AdSyncType }

export interface FieldChange {
  field: string
  oldValue: string | null
  newValue: string | null
}

export interface MutationOutcome {
  ok: boolean
  outboundQueueId: string | null
  bidHistoryIds: string[]
  /** AD.4 — id of the AdvertisingActionLog row this mutation wrote. */
  actionLogId: string | null
  error: string | null
  /**
   * 3A (Owner decided 2026-10-06) — a person's own write went past one of HIS limits: nothing was written; the screen
   * shows the warning and "Send anyway", which sends the same write again with `confirmOwnLimits`.
   */
  needsConfirmation?: { limits: OwnLimit[] }
  /**
   * ADS AUTONOMY W1-5 — a person's own bid edit (or a Claude request he approved) that moves more than the ads
   * strategy's largest bid change: sent (the step clamp never rewrites his edit, CM-19), and the sentence says whose
   * limit. Also kept on the action log (`evidence.strategyWarning`). The strategy's bid band is one of his own limits
   * and asks for his confirmation instead (`needsConfirmation`).
   */
  warnings?: string[]
}

/** 3A — the answer to a person's write past his own limits: nothing written, his "Send anyway" decides. */
export function needsConfirmationOutcome(limits: OwnLimit[]): MutationOutcome {
  return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: ownLimitsSentence(limits), needsConfirmation: { limits } }
}

/** 3A — the action log's evidence for a write a person sent past his own limits ("sent past <limit> by <person>"). */
function withSentPast(evidence: AdWriteEvidence | null | undefined, past: OwnLimit[], actor: AdsActor): AdWriteEvidence | null {
  if (!past.length) return evidence ?? null
  const seen = new Set<string>()
  const unique = past.filter((l) => (seen.has(l.reason) ? false : (seen.add(l.reason), true)))
  const line = sentPastSentence(unique, actor)
  return { ...(evidence ?? {}), sentPastOwnLimits: evidence?.sentPastOwnLimits ? `${evidence.sentPastOwnLimits}; ${line}` : line }
}

/**
 * W1-5 — the evidence a bid write keeps: the caller's, plus the strategy limits that moved it (`sources`), plus the
 * warning for a person's edit past the strategy's largest change. Null when there is nothing to say.
 */
function withStrategyEvidence(evidence: AdWriteEvidence | null | undefined, sources: WriteSources, warnings: string[]): AdWriteEvidence | null {
  if (!Object.keys(sources).length && !warnings.length) return evidence ?? null
  return {
    ...(evidence ?? {}),
    ...(Object.keys(sources).length ? { sources: { ...(evidence?.sources ?? {}), ...sources } } : {}),
    ...(warnings.length ? { strategyWarning: warnings.join('; ') } : {}),
  }
}

/**
 * 6a — Sponsored Products only (Owner decision S8, 2026-10-04; review G.1).
 *
 * W4-11 — `write` (null = Sponsored Products only, as before): a caller that may change Sponsored Brands and Display
 * (`allowSbSd`: a Claude request, which runs only once approved, by a person or the business's rule) describes its
 * write, and an SB/SD write Nexus sends to their own endpoints (adWriteRefusal) is not refused; the worker routes it
 * there. Every other caller — the engines, rules, schedules, sweeps and the screens' routes — passes none and stays
 * Sponsored Products only.
 *
 * The worker sends every write queued here to a Sponsored Products endpoint (/sp/campaigns, /sp/adGroups, /sp/keywords,
 * /sp/targets, /sp/productAds). A Sponsored Brands or Display id is unknown there: a budget lands nowhere, and a keyword
 * answered "not found" is marked orphaned although it is healthy, which then blocks every later write to it. Native
 * SB/SD updates are not built, so the write is refused here, before the local row, the queue or the audit change —
 * same placement as SYNC.1 / 1f, and loud. `error` carries the shared sentence, which routes show as it is.
 * A campaign whose ad product is not stated is not refused (`Campaign.type` is required; only a partial select lacks it).
 */
/** W4-11 — a Sponsored Brands or Display campaign (the two whose own endpoints Nexus sends some changes to). */
export function isSbSdCampaign(campaign: AdProductSource | null | undefined): boolean {
  const product = adProductOf(campaign)
  return product === SPONSORED_BRANDS || product === SPONSORED_DISPLAY
}

function adProductRefused(
  entity: AdEntityType, entityId: string, actor: string, campaign: AdProductSource | null | undefined, write: AdWrite | null = null,
): MutationOutcome | null {
  const refusal = adWriteRefusal(campaign, write, { unknown: 'allow' })
  if (!refusal) return null
  logger.warn('[ads-mutation] refused a write to a campaign that is not Sponsored Products', {
    entity, entityId, actor, adProduct: adProductOf(campaign),
  })
  return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: refusal }
}

/**
 * 4k — the entity's own bounds, asked BEFORE the local write (review 5.2).
 *
 * The worker's gate asked them only after Nexus had written its copy, so a refused bid or budget was marked SKIPPED
 * and Nexus kept showing a value Amazon never got, while the caller — a rule, a screen, Claude — was told `ok`. The
 * bounds depend on nothing but the entity and the new value, so they are asked here first, with the same
 * lowering-only suppression flag the worker hands the gate (`isSuppressionWrite`): a forced lowering still passes the
 * bid minimum, a forced raise does not. Refused → nothing local, no queue row, no audit row; `error` is the gate's
 * own sentence, and the refusal is recorded where the gate records its own (queueId null). Every other refusal can
 * only be known at dispatch; the worker puts those back (putBackRefusedWrite).
 */
async function boundsRefused(args: {
  entity: AdEntityType
  entityId: string
  campaign: EntityBoundsCampaign & { id: string } | null | undefined
  field: string
  intendedValueCents: number
  isSuppression: boolean
  /** 3A — a person's own write: his bounds ask for confirmation instead of refusing; `past` collects what he confirmed. */
  person?: boolean
  confirmOwnLimits?: boolean
  past?: OwnLimit[]
  /**
   * W1-5 — the ad group the bid lands in (the ads strategy band is its products'), and the strategy limits if already
   * read. The band is one of his own limits: a person's write past it asks for his confirmation like the bounds above.
   */
  adGroupId?: string | null
  strategy?: StrategyBidLimits
}): Promise<MutationOutcome | null> {
  if (!args.campaign) return null
  const denial = await entityBoundsDenial({
    campaignId: args.campaign.id,
    campaign: args.campaign,
    field: args.field,
    intendedValueCents: args.intendedValueCents,
    isSuppression: args.isSuppression,
    adGroupId: args.adGroupId ?? null,
    strategy: args.strategy,
  })
  if (!denial) return null
  if (args.person) {
    const limit: OwnLimit = { limit: denial.deniedAt as OwnLimitKind, reason: denial.reason }
    if (args.confirmOwnLimits) { args.past?.push(limit); return null }
    return needsConfirmationOutcome([limit])
  }
  logGateDeny(
    {
      queueId: null, marketplace: args.campaign.marketplace, payloadValueCents: args.intendedValueCents,
      campaignId: args.campaign.id, entityType: args.entity, entityId: args.entityId,
    },
    denial.reason,
    denial.deniedAt,
  )
  return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: denial.reason }
}

/** The money fields of a write — the same set as the ads worker's `VALUE_FIELDS` (1a): a portfolio id is not money. */
const VALUE_FIELDS = new Set(['bid', 'defaultBid', 'dailyBudget', 'budgetAmount'])

/**
 * CM-10 — the money a write moves, in cents, for the write gate's value cap, computed as the ads worker computes it
 * (`estimatePayloadValueCents`): bids are cents, a daily budget and a portfolio cap are euros, and only money fields count.
 */
export function writeValueCents(fieldChanges: FieldChange[]): number {
  let maxCents = 0
  for (const c of fieldChanges ?? []) {
    if (c.newValue == null || !VALUE_FIELDS.has(c.field)) continue
    const n = Number(c.newValue)
    if (!Number.isFinite(n)) continue
    // W4-12b — a portfolio's cap (budgetAmount) is in major units too, as the worker now counts it.
    maxCents = Math.max(maxCents, Math.round(c.field === 'dailyBudget' || c.field === 'budgetAmount' ? n * 100 : n))
  }
  return maxCents
}

/**
 * CM-10 — a person's edit from a screen (`askGate`) asks the write gate BEFORE Nexus writes its copy.
 *
 * The worker asks the gate only at dispatch, after the screen had already said "Enabled" or "Daily budget → €600": the
 * halt, the live-write allowlist, a pin, a spend ceiling, the day's budget movement, the market limits or the value cap
 * then refused it and the worker put the old value back in silence. This asks the same gate the same question, with
 * what the worker would hand it (the `user:` actor, every field, the money value, the value replaced), and a refusal is
 * answered at once in the gate's own words — nothing written, no queue row, no audit row; recorded as a gate refusal
 * (queueId null). It decides nothing itself: every rule is the gate's, and the worker still asks again at dispatch.
 * Honest writes (2026-10-07) — an engine may ask too: auto-bid passes `askGate`, so a bid the gate refuses (a campaign
 * off the live-write allowlist, a pin, the halt, Amazon's limits) is answered at once, with no local change — before,
 * Nexus showed the refused bid until the worker put the old one back, and the run counted it applied. The gate is
 * handed the engine's actor and no person mark, so it judges the write exactly as at dispatch. The other engines and
 * callers do not pass `askGate` and keep the queue-then-dispatch path.
 */
async function gateRefusedNow(args: {
  askGate?: boolean
  /** BID BRAIN pre-go-live — a retry already refused (and logged) on this data day: refused the same, not logged again. */
  quietRefusal?: boolean
  actor: AdsActor
  entity: AdEntityType
  entityId: string
  campaignId: string | null | undefined
  marketplace: string | null | undefined
  changes: FieldChange[]
  force?: boolean
  /** 1e — the route's person mark: the gate's halt / autonomy-OFF pass is decided there, the same as at dispatch. */
  manual?: boolean
  /** 3A — the person's "Send anyway"; `past` collects the own limits it was confirmed past. */
  confirmOwnLimits?: boolean
  past?: OwnLimit[]
  /** W1-5 — the ad group a bid lands in, as the worker hands it to the gate. */
  adGroupId?: string | null
  /** W4-11 — what the write is, as the worker hands it to the gate (an SB/SD write a caller may send). */
  write?: AdWrite | null
}): Promise<MutationOutcome | null> {
  if (!args.askGate) return null
  const cents = (v: string | null | undefined, euros = false): number | null => {
    const n = v == null || String(v).trim() === '' ? NaN : Number(v)
    return Number.isFinite(n) ? Math.round(euros ? n * 100 : n) : null
  }
  // The worker's choice of the one judged field: the bid, else the budget, else the first.
  const bid = args.changes.find((c) => c.field === 'bid' || c.field === 'defaultBid')
  const budget = bid ? undefined : args.changes.find((c) => c.field === 'dailyBudget')
  const gate = await checkAdsWriteGate({
    marketplace: args.marketplace ?? null,
    payloadValueCents: writeValueCents(args.changes),
    campaignId: args.campaignId ?? null,
    adGroupId: args.adGroupId ?? null,
    field: bid?.field ?? budget?.field ?? args.changes[0]?.field ?? null,
    fields: args.changes.map((c) => c.field),
    intendedValueCents: bid ? cents(bid.newValue) : budget ? cents(budget.newValue, true) : null,
    isSuppression: isSuppressionWrite(args.force === true, args.changes),
    actor: args.actor,
    previousValueCents: budget ? cents(budget.oldValue, true) : null,
    queueId: null,
    // 1e — what the worker hands the gate too (isPersonEdit off the queue row), so the two answers agree.
    manual: isPersonEdit(args.manual, args.actor),
    confirmOwnLimits: args.confirmOwnLimits === true,
    ...(args.write ? { write: args.write } : {}),
  })
  if (gate.allowed !== false) {
    const past = (gate as { pastOwnLimits?: OwnLimit[] }).pastOwnLimits
    if (past?.length) args.past?.push(...past)
    return null
  }
  // 3A — his own limits: nothing written, his "Send anyway" decides.
  if (gate.deniedAt === 'needs_confirmation') return needsConfirmationOutcome(gate.ownLimits ?? [])
  if (!args.quietRefusal) logGateDeny(
    {
      queueId: null, marketplace: args.marketplace ?? null, payloadValueCents: writeValueCents(args.changes),
      campaignId: args.campaignId ?? null, entityType: args.entity, entityId: args.entityId,
    },
    gate.reason,
    gate.deniedAt,
  )
  return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: `Not sent to Amazon: ${gate.reason}` }
}

/** The campaign columns `boundsRefused` reads, for the selects below. */
const BOUNDS_SELECT = {
  minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true, portfolioId: true,
} as const

/**
 * AD.4 — Write a single AdvertisingActionLog row capturing the
 * before/after JSON snapshots. The rollback endpoint walks these to
 * invert each operation. The actor string is stored in `userId` to
 * unify human + automation writes under one column (the audit table
 * needs to round-trip the actor verbatim).
 */
// Exported for the bulksheet create path (AX-IE.9): a create goes through the
// ads-create services, which do not enqueue outbound work and so never reach the
// call sites below — but it still has to join the upload's change set, or Undo
// leaves behind the rows the import invented.
export async function writeAdvertisingActionLog(args: {
  actor: AdsActor
  actionType: string
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'RETAIL_EVENT' | 'PRODUCT_AD'
  entityId: string
  payloadBefore: object
  payloadAfter: object
  outboundQueueId: string | null
  /**
   * AX-IE.6 — groups every write from one operation (a bulksheet upload, say)
   * under a single id so the whole set can be reverted together. `executionId`
   * has an index and no foreign key, so it takes any change-set id; rule
   * executions were simply its first user.
   */
  changeSetId?: string | null
  /**
   * ADX A2 — the measurement the decision rested on. Optional because an operator edit
   * or a rollback genuinely has nothing numeric to say; `packEvidence` returns null
   * rather than `{}` so "no evidence" stays distinguishable from "evidence captured".
   *
   * Until this parameter existed, every write through this function was structurally
   * incapable of recording evidence, whatever the caller knew. Measured on prod
   * 2026-08-05: update_placement_bidding wrote it on 100% of 764 rows because it calls
   * `audit()` directly, while AD_BID_UPDATE wrote it on 0 of 968 — not because the rank
   * engine lacked the numbers, but because there was nowhere to put them.
   */
  evidence?: AdWriteEvidence | null
  /**
   * W4-5 — a write that is never sent (a Nexus-only record removed: nothing at Amazon to change) is SKIPPED from the
   * start, so it never reads as waiting for a queue row it does not have. Default PENDING.
   */
  amazonResponseStatus?: 'PENDING' | 'SKIPPED'
}): Promise<string> {
  const row = await prisma.advertisingActionLog.create({
    data: {
      executionId: args.changeSetId ?? null,
      userId: args.actor,
      actionType: args.actionType,
      entityType: args.entityType,
      entityId: args.entityId,
      payloadBefore: args.payloadBefore,
      payloadAfter: args.payloadAfter,
      outboundQueueId: args.outboundQueueId,
      amazonResponseStatus: args.amazonResponseStatus ?? 'PENDING',
      // `as never` matches the existing audit() writer in ads-create.service.ts: AdWriteEvidence
      // is a closed interface and Prisma's InputJsonValue wants an index signature.
      evidence: (packEvidence(args.evidence) ?? undefined) as never,
    },
    select: { id: true },
  })
  return row.id
}

interface EnqueueArgs {
  entityType: AdEntityType
  entityId: string
  externalId: string | null
  syncType: AdSyncType
  marketplace: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
  applyImmediately: boolean // when true, holdUntil = NOW (no grace)
  /**
   * ADX G1 — deliberate suppression / restore, not optimisation.
   *
   * `force` already meant "bypass the 5¢ floor" locally (NP). It now travels to the
   * write gate as well, because ADX A1 added Campaign.minBidCents and a floor that
   * blocks a safety action is worse than no floor: suppressCampaignBids drives bids to
   * ~2¢, which is how the retail guard, budget stop-over-spend and Min-bid dayparting
   * windows all work under the no-pause rule. Without this the first operator to set a
   * min bound above 2¢ would have silently broken every one of them.
   *
   * The gate skips only the MINIMUM on a forced write. The maximum still binds — a
   * "suppression" that raises a bid is not a suppression.
   *
   * 2.2 — `force` alone does not make a write a suppression at the gate: restores and
   * base-bid deltas set it too, and those raise bids. The worker reads it back off the
   * queue row and the gate is told "suppression" only when `isSuppressionWrite` agrees.
   */
  force?: boolean
  /** 1e — a person's own edit (`isPersonEdit`, already checked). Kept on the queue row's JSON, like `force`; the worker hands it to the gate. */
  manual?: boolean
  /** 3A — the person confirmed "Send anyway" past his own limits; on the queue row's JSON, honoured by the gate only with `manual`. */
  confirmOwnLimits?: boolean
  /** AA-W2-12 — a deliberate pause or archive (see isLetGoWrite). Kept on the queue row's JSON, like `force`; the worker hands it to the gate (and sends a marked archive as Amazon's delete). */
  letsGo?: boolean
  /**
   * W4-11 — a Sponsored Brands or Display write this layer let through (`allowSbSd`, adProductRefused). Kept on the queue
   * row's JSON, like `force`: the worker describes the write to the gate (and routes it to the SB/SD endpoints) only for
   * a row that carries it, so an SB/SD row any other path queued is still refused there.
   */
  sbSd?: boolean
}

async function enqueueOutbound(args: EnqueueArgs): Promise<string> {
  const holdUntil = args.applyImmediately
    ? new Date()
    : new Date(Date.now() + GRACE_PERIOD_MS)
  // AX-ZD.1f — the queue row and its typed rows are now written in ONE
  // transaction. While AdMutation was bookkeeping only, a failed write there
  // was better swallowed than allowed to fail an operator's change. Now that
  // dispatch reads the typed rows, a half-write would be a SILENTLY DROPPED
  // write, which is the worst outcome available. Either both land or neither
  // does and the caller sees the error.
  return prisma.$transaction(async (tx) => {
    const id = await createQueueRow(tx, args, holdUntil)
    await recordAdMutations(tx, id, args, holdUntil)
    return id
  })
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function createQueueRow(tx: Tx, args: EnqueueArgs, holdUntil: Date): Promise<string> {
  const row = await createOutboundRow(tx, {
    data: {
      // Campaign-level entities don't tie to a product/channel listing.
      // Leave both FKs null; the worker reads entityType from payload.
      productId: null,
      channelListingId: null,
      targetChannel: 'AMAZON',
      targetRegion: args.marketplace,
      syncStatus: 'PENDING',
      syncType: args.syncType,
      payload: {
        entityType: args.entityType,
        entityId: args.entityId,
        externalId: args.externalId,
        marketplace: args.marketplace,
        fieldChanges: args.fieldChanges,
        actor: args.actor,
        reason: args.reason,
        // ADX G1 — the worker hands this to the write gate so a deliberate
        // suppression is not blocked by Campaign.minBidCents. 2.2 — the ONLY record
        // of it: the typed rows have no column for it, so the worker reads it here.
        ...(args.force ? { force: true } : {}),
        // 1e — likewise the only record that a person made this edit (the typed rows have no column for it either).
        ...(args.manual ? { manual: true } : {}),
        // 3A — and that he confirmed sending it past his own limits.
        ...(args.manual && args.confirmOwnLimits ? { confirmOwnLimits: true } : {}),
        // AA-W2-12 — and that it is a deliberate pause (isLetGoWrite).
        ...(args.letsGo ? { letsGo: true } : {}),
        // W4-11 — and that this layer let an SB/SD write through (EnqueueArgs.sbSd).
        ...(args.sbSd ? { sbSd: true } : {}),
      } as object,
      holdUntil,
      externalListingId: args.externalId,
    },
    select: { id: true },
  })
  return row.id
}

/**
 * AX-ZD.1 — write one typed `AdMutation` per changed field, alongside the queue row.
 *
 * The queue row carries every field change in a single JSON payload, which is
 * why the drift check cannot ask "is THIS field in flight?" and instead asks
 * "is anything in flight on this campaign?" — hiding real external edits. One
 * row per field is the whole point.
 *
 * AX-ZD.1f — no longer optional, and no longer swallowing. These rows are what
 * dispatch reads, so a missing one is a dropped write rather than a degraded
 * drift signal. It runs inside the enqueue transaction: either the queue row and
 * its typed rows both land, or the operator's PATCH fails loudly.
 */
async function recordAdMutations(
  tx: Tx,
  outboundQueueId: string,
  args: EnqueueArgs,
  holdUntil: Date,
): Promise<void> {
  if (!args.fieldChanges.length) return
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)
  {
    await tx.adMutation.createMany({
      data: dedupeFieldChanges(args.fieldChanges).map((c) => ({
        entityType: args.entityType,
        entityId: args.entityId,
        externalEntityId: args.externalId,
        marketplace: args.marketplace,
        field: c.field,
        intendedValue: str(c.newValue),
        previousValue: str(c.oldValue),
        state: 'PENDING',
        actor: args.actor,
        // The queue row id is the natural idempotency key: the dispatch path is
        // keyed on it, and one (queue row, field) pair is exactly one intent.
        idempotencyKey: `${outboundQueueId}:${c.field}`,
        holdUntil,
        outboundQueueId,
      })),
      skipDuplicates: true,
    })
  }
}

/**
 * AX-ZD.1f — collapse repeated fields, last-wins.
 *
 * The typed rows are keyed `${queueId}:${field}` and inserted with
 * `skipDuplicates`, so a repeated field would keep the FIRST occurrence and drop
 * the rest. The JSON path builds a plain object from the same array, so it keeps
 * the LAST. That is a silent divergence between two paths that must dispatch
 * identically — the operator would see the wrong value applied.
 *
 * No caller sends duplicates today, so this changes nothing now. It exists so
 * the two paths are equivalent by construction rather than by luck, because the
 * failure mode is a wrong bid reaching Amazon with nothing in the logs.
 */
export function dedupeFieldChanges(changes: FieldChange[]): FieldChange[] {
  const byField = new Map<string, FieldChange>()
  for (const c of changes) byField.set(c.field, c) // last wins, matching object-build
  return [...byField.values()]
}

/**
 * AX-ZD.1f — the dispatch payload, read from the typed rows.
 *
 * Dispatch used to parse a JSON blob on the queue row. That blob and the typed
 * rows are two records of one intent and could disagree; this makes the typed
 * rows authoritative and leaves OutboundSyncQueue owning delivery mechanics —
 * retries, dead-lettering, the grace window — which it does well.
 *
 * Returns null when there are no typed rows, and the caller falls back to the
 * blob. That is not defensive padding: rows enqueued before ZD.1 genuinely have
 * none, and dispatching nothing for them would silently drop an operator's
 * change. New rows always have them — the enqueue transaction guarantees it.
 */
export interface DispatchPayload {
  entityType: AdEntityType
  entityId: string
  externalId: string | null
  marketplace: string | null
  fieldChanges: FieldChange[]
  actor: string
  reason: string | null
}

export async function dispatchPayloadFromMutations(
  outboundQueueId: string,
): Promise<DispatchPayload | null> {
  const rows = await prisma.adMutation.findMany({
    where: { outboundQueueId },
    select: {
      entityType: true, entityId: true, externalEntityId: true, marketplace: true,
      field: true, intendedValue: true, previousValue: true, actor: true, state: true,
    },
    orderBy: { field: 'asc' },
  })
  if (!rows.length) return null
  const head = rows[0]!
  return {
    entityType: head.entityType as AdEntityType,
    entityId: head.entityId,
    externalId: head.externalEntityId,
    marketplace: head.marketplace,
    // 1a (CM-5) — a field a newer write replaced is never sent (supersedeOlderWrites). Typed rows that are all
    // superseded still answer a payload (with no changes), never null: null means "pre-ZD.1 row, read the JSON blob",
    // and that blob holds the old values.
    fieldChanges: rows.filter((r) => r.state !== 'SUPERSEDED').map((r) => ({
      field: r.field, oldValue: r.previousValue, newValue: r.intendedValue,
    })),
    actor: head.actor,
    // `reason` is audit prose, never dispatched, and lives on the queue row.
    // Recording it per field would duplicate it N times to no purpose.
    reason: null,
  }
}

/**
 * The fields whose value is money going out — a bid, a budget, a placement % — so that a
 * LOWER value always means less spend. Everything else (status, name, currency, strategy)
 * has no direction, and a write carrying one is never a suppression.
 */
const SPEND_FIELDS = new Set([
  'bid', 'defaultBid', 'dailyBudget', 'PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH',
])

/**
 * 2.2 — may the write gate treat this queued write as a suppression?
 *
 * The gate exempts a suppression from the account halt (and autonomy OFF), the minimum bid
 * bound and the bids authority pin, so the night floor (35→2¢), the retail guard and
 * stop-over-spend still land while automation is stopped.
 *
 * `force` is necessary but NOT sufficient. It means "skip the 5¢ floor and the change clamp"
 * in the mutation layer, and restoreCampaignBids, applyBaseBidDelta and revertBaseBidDelta set
 * it too — writes that can RAISE bids. Handing `force` to the gate as-is would let raises
 * pass a halt. So: force AND every field in the write is a spend field whose new value is
 * strictly below its old one. A raise, an unchanged value (a forced re-sync), an unknown old
 * or new value, or any field without a direction makes it NOT a suppression — fail closed.
 * Owner decision S1: while stopped, only value-lowering writes pass; a restore is refused.
 */
export function isSuppressionWrite(force: boolean, fieldChanges: FieldChange[]): boolean {
  if (!force || !fieldChanges?.length) return false
  // String() because a pre-ZD.1 JSON payload is untyped; '' is unknown, not zero.
  const num = (v: string | null): number | null => {
    const s = v == null ? '' : String(v).trim()
    const n = s === '' ? NaN : Number(s)
    return Number.isFinite(n) ? n : null
  }
  return fieldChanges.every((c) => {
    if (!SPEND_FIELDS.has(c.field)) return false
    const from = num(c.oldValue)
    const to = num(c.newValue)
    return from != null && to != null && to < from
  })
}

/**
 * ADS AUTONOMY AA-W2-12 — the statuses a deliberate pause writes, each with the statuses it may leave: it lets go of the
 * spend the entity had. AA-W2-13 — an archive lets go for good, from enabled or paused.
 */
const LET_GO_STATUSES: Readonly<Record<string, readonly string[]>> = { PAUSED: ['ENABLED'], ARCHIVED: ['ENABLED', 'PAUSED'] }

/**
 * AA-W2-12 — may the write gate treat this queued write as letting go, like a suppression (the halt never holds it)?
 * Only a deliberate pause or archive marks it (`letsGo`: pause-ads, archive-ads; Owner 2026-10-06: a real pause when he
 * allows that kind), and only when every field is a status that stops the entity serving (ENABLED → PAUSED; ENABLED or
 * PAUSED → ARCHIVED, which the worker also sends as Amazon's delete operation). A halt stops the machine from
 * reaching for more; it must never block it from letting go. An enable starts spend again and is never one, and a write
 * without the mark — a rule's or an engine's — is judged as before (isSuppressionWrite). Fail closed.
 */
export function isLetGoWrite(letsGo: boolean, fieldChanges: FieldChange[]): boolean {
  if (!letsGo || !fieldChanges?.length) return false
  return fieldChanges.every((c) => c.field === 'status' && (LET_GO_STATUSES[String(c.newValue)] ?? []).includes(String(c.oldValue)))
}

/** 4k — a queued field's column on its entity, and how its typed value reads back (undefined = cannot be read). */
type FieldColumn = { column: string; value: (v: string | null) => unknown }
const intColumn = (column: string): FieldColumn => ({ column, value: (v) => (v != null && /^-?\d+$/.test(v.trim()) ? Number(v) : undefined) })
const decimalColumn = (column: string): FieldColumn => ({ column, value: (v) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? v.trim() : undefined) })
const textColumn = (column: string, nullable = false): FieldColumn => ({ column, value: (v) => (v != null ? v : nullable ? null : undefined) })
const dateColumn = (column: string): FieldColumn => ({ column, value: (v) => (v == null ? null : Number.isNaN(Date.parse(v)) ? undefined : new Date(v)) })
/** W4-12b — a decimal that may be empty: a portfolio with no cap had no amount, and that is the value put back. */
const nullableDecimalColumn = (column: string): FieldColumn => ({ column, value: (v) => (v == null ? null : decimalColumn(column).value(v)) })
/** Every field the update helpers below write locally, per entity, in their own vocabulary. */
const LOCAL_COLUMNS: Partial<Record<AdEntityType, Record<string, FieldColumn>>> = {
  AD_TARGET: { bid: intColumn('bidCents'), status: textColumn('status') },
  AD_GROUP: { defaultBid: intColumn('defaultBidCents'), status: textColumn('status'), name: textColumn('name') },
  CAMPAIGN: {
    dailyBudget: decimalColumn('dailyBudget'), status: textColumn('status'), name: textColumn('name'),
    portfolioId: textColumn('portfolioId', true), biddingStrategy: textColumn('biddingStrategy'),
    dailyBudgetCurrency: textColumn('dailyBudgetCurrency'), endDate: dateColumn('endDate'),
  },
  PRODUCT_AD: { status: textColumn('status') },
  // W4-12b — a portfolio (updatePortfolioWithSync): a refused or unsent cap no longer stays in Nexus until the next sync.
  PORTFOLIO: {
    name: textColumn('name'), budgetAmount: nullableDecimalColumn('budgetAmount'),
    budgetCurrencyCode: textColumn('budgetCurrencyCode', true), budgetPolicy: textColumn('budgetPolicy', true),
    startDate: dateColumn('startDate'), endDate: dateColumn('endDate'),
  },
}

/**
 * 4k — put a write the gate refused back in Nexus (review 5.2).
 *
 * The update helpers below write Nexus's own copy when they queue a write; the worker asks the gate only at dispatch.
 * Bounds are now asked before that local write (boundsRefused), but the halt, the allowlist, a pin, a spend ceiling
 * and the day's budget movement can only be known at dispatch, so on every gate refusal the worker calls this and
 * each refused field goes back to the value the write replaced. One conditional update per field, matching on the
 * refused value: a newer change — a person, another writer, a sync from Amazon — is never overwritten. A field with
 * no column here is left as it is and named in `kept`. Same workspace context as the worker's job.
 */
export async function putBackRefusedWrite(payload: {
  entityType: string
  entityId: string
  fieldChanges: FieldChange[]
}): Promise<{ restored: string[]; kept: string[] }> {
  const columns = LOCAL_COLUMNS[payload.entityType as AdEntityType]
  const out = { restored: [] as string[], kept: [] as string[] }
  for (const c of dedupeFieldChanges(payload.fieldChanges ?? [])) {
    // String(): a pre-ZD.1 JSON payload is untyped, as in isSuppressionWrite.
    const oldValue = c.oldValue == null ? null : String(c.oldValue)
    const newValue = c.newValue == null ? null : String(c.newValue)
    if (oldValue === newValue) continue // a forced re-push changed nothing locally
    const col = columns?.[c.field]
    const from = col?.value(oldValue)
    const to = col?.value(newValue)
    if (!col || from === undefined || to === undefined) { out.kept.push(c.field); continue }
    const where = { id: payload.entityId, [col.column]: to }
    const data = { [col.column]: from }
    let n = 0
    switch (payload.entityType) {
      case 'AD_TARGET': n = (await prisma.adTarget.updateMany({ where: where as Prisma.AdTargetWhereInput, data: data as Prisma.AdTargetUpdateManyMutationInput })).count; break
      case 'AD_GROUP': n = (await prisma.adGroup.updateMany({ where: where as Prisma.AdGroupWhereInput, data: data as Prisma.AdGroupUpdateManyMutationInput })).count; break
      case 'CAMPAIGN': n = (await prisma.campaign.updateMany({ where: where as Prisma.CampaignWhereInput, data: data as Prisma.CampaignUpdateManyMutationInput })).count; break
      case 'PRODUCT_AD': n = (await prisma.adProductAd.updateMany({ where: where as Prisma.AdProductAdWhereInput, data: data as Prisma.AdProductAdUpdateManyMutationInput })).count; break
      case 'PORTFOLIO': n = (await prisma.amazonAdsPortfolio.updateMany({ where: where as Prisma.AmazonAdsPortfolioWhereInput, data: data as Prisma.AmazonAdsPortfolioUpdateManyMutationInput })).count; break
    }
    ;(n > 0 ? out.restored : out.kept).push(c.field)
  }
  return out
}

/**
 * AX-ZD.1 — project an `OutboundSyncQueue` outcome onto its typed mutations.
 *
 * Called from the worker at every point the queue row's status moves. This is
 * the half that makes the typed record safe to READ from: an unsettled row means
 * "in flight", so a record that is written but never settled would suppress
 * drift on its field indefinitely. `PENDING_TRUST_WINDOW_MS` bounds that failure
 * mode, but settling correctly is what stops it happening at all.
 *
 * Never throws: settlement bookkeeping must not fail a write that already
 * reached Amazon.
 */
export async function settleAdMutations(
  outboundQueueId: string,
  syncStatus: string,
  opts: { isDead?: boolean; error?: string | null } = {},
): Promise<void> {
  const state = stateForQueueStatus(syncStatus, opts.isDead ?? false)
  try {
    await prisma.adMutation.updateMany({
      where: { outboundQueueId, state: { in: [...IN_FLIGHT_STATES] } },
      data: {
        state,
        lastError: opts.error ?? null,
        ...(state === 'IN_FLIGHT' ? { attempts: { increment: 1 } } : {}),
        ...(isTerminal(state) ? { settledAt: new Date() } : {}),
      },
    })
  } catch (err) {
    logger.warn('[AX-ZD.1] mutation settle failed', {
      outboundQueueId, syncStatus, error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * AX-ZD.1e — claim an entity for writing, atomically.
 *
 * Amazon answers two concurrent writes to one entity with HTTP 423
 * ConcurrentModificationException, and the ads worker runs at concurrency 2, so
 * two jobs for the same campaign genuinely overlap.
 *
 * ZD.1b did this as check-then-act and I labelled it a mitigation, on the
 * grounds that a Postgres advisory lock — the natural fix — was unusable here
 * because pgbouncer transaction pooling detaches the lock from the client. That
 * is true of SESSION-scoped locks (`pg_advisory_lock`), which is why
 * `prisma migrate deploy` stalls against this database. It is NOT true of
 * TRANSACTION-scoped locks: `pg_advisory_xact_lock` releases at COMMIT, which is
 * exactly the unit transaction pooling preserves. Measured against this
 * database before relying on it — two concurrent holders serialised cleanly and
 * a try-lock from a second client correctly refused while held.
 *
 * So this is a real claim, not a mitigation.
 *
 * THE LOCK COVERS THE CHECK-AND-SET, NOT THE WRITE. Holding a transaction open
 * across an Amazon call — seconds, with retries — would pin a pooled server
 * connection for the whole round trip and turn a slow Amazon into a database
 * incident. It does not need to: once this commits, our row is IN_FLIGHT, and
 * any other claimer must take the same lock and will see it. The IN_FLIGHT
 * state is the exclusion token; the lock only makes acquiring it indivisible.
 *
 * Returns false when the entity is busy — the caller defers rather than failing,
 * so nothing is lost.
 *
 * VERIFIED BY `scripts/_zd1e-claim-verify.mts`, not by the unit suite. The
 * property that matters is Postgres lock behaviour under real concurrency, and
 * a mocked test would assert only that this function calls the mock. The
 * harness races two claims on one entity against the live database and checks
 * exactly one wins, the loser is refused while the winner is in flight, the
 * loser succeeds once it settles, and a different entity is never blocked.
 */
export async function claimEntityWrite(
  entityType: AdEntityType,
  entityId: string,
  outboundQueueId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Namespaced two-key form so this can never collide with another
      // advisory-lock user (Prisma's migrate lock included).
      const got = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(${ADS_LOCK_CLASS}, hashtext($1)) AS ok`,
        `${entityType}:${entityId}`,
      )
      // Another worker is inside the critical section for this entity right
      // now. Don't wait for it — deferring is cheaper than holding a connection.
      if (!got[0]?.ok) return false

      const blockers = await tx.adMutation.findMany({
        where: { entityType, entityId, state: 'IN_FLIGHT', NOT: { outboundQueueId } },
        select: { state: true, updatedAt: true },
      })
      if (blockers.some((b) => isBlockingWrite(b, now))) return false

      const claimed = await tx.adMutation.updateMany({
        where: { outboundQueueId, state: 'PENDING' },
        data: { state: 'IN_FLIGHT', attempts: { increment: 1 } },
      })
      // A queue row enqueued before ZD.1 has no typed rows, so there is nothing
      // to claim and nothing to exclude on. Let it through: that is exactly the
      // pre-ZD.1 behaviour, and these drain within the retry ladder.
      return claimed.count > 0 || (await legacyRowWithNoMutations(tx, outboundQueueId))
    }, { timeout: 10_000 })
  } catch (err) {
    // Fail OPEN: if we cannot tell, let the write proceed. Amazon's 423 is
    // retryable and visible; a write blocked by a failed bookkeeping query
    // would be neither.
    logger.warn('[AX-ZD.1e] claim failed; proceeding unserialised', {
      outboundQueueId, error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

/** Namespace for ads entity-write advisory locks. */
const ADS_LOCK_CLASS = 4242

/** 1a (CM-5) — the states of a newer write that make an older write to the same field pointless to send. */
const SUPERSEDING_STATES = ['PENDING', 'IN_FLIGHT', 'APPLIED'] as const

/**
 * 1a (CM-5) — a newer write to the same field wins; the older one is never sent.
 *
 * A write that failed with a retryable error (429, 5xx) went back to PENDING and was sent again later, after a newer
 * write to the same field had landed: Amazon then held the OLDER value while Nexus showed the newer one, and the next
 * sync pulled the older value into Nexus, so the latest edit was lost. Two writes queued close together (a person and a
 * rule, or two edits inside the grace window) were both sent, the older one for nothing.
 *
 * The worker calls this right after it claimed the queue row (its typed rows are IN_FLIGHT, so no other dispatch of
 * them runs). Each of the row's fields with a NEWER write for the same entity and field that is queued, being sent or
 * applied is marked SUPERSEDED and left out of the dispatch (`dispatchPayloadFromMutations`). A newer write that failed
 * or was cancelled supersedes nothing: this one is then still the latest intent that can land. Newer = created later;
 * the local copy is written in the same order, so the newest write is the value Nexus shows.
 *
 * `typed: false` — a row from before ZD.1 without typed rows; nothing is decided here.
 */
export async function supersedeOlderWrites(
  outboundQueueId: string,
): Promise<{ typed: boolean; superseded: string[]; remaining: number }> {
  const mine = await prisma.adMutation.findMany({
    where: { outboundQueueId },
    select: { id: true, entityType: true, entityId: true, field: true, state: true, createdAt: true },
  })
  if (!mine.length) return { typed: false, superseded: [], remaining: 0 }
  const live = mine.filter((m) => (IN_FLIGHT_STATES as readonly string[]).includes(m.state))
  if (!live.length) return { typed: true, superseded: [], remaining: 0 }
  const head = live[0]!
  const newer = await prisma.adMutation.findMany({
    where: {
      entityType: head.entityType,
      entityId: head.entityId,
      field: { in: live.map((m) => m.field) },
      state: { in: [...SUPERSEDING_STATES] },
      createdAt: { gt: new Date(Math.min(...live.map((m) => m.createdAt.getTime()))) },
      NOT: { outboundQueueId },
    },
    select: { field: true, createdAt: true },
  })
  const superseded: string[] = []
  for (const m of live) {
    if (!newer.some((n) => n.field === m.field && n.createdAt > m.createdAt)) continue
    const moved = await prisma.adMutation.updateMany({
      where: { id: m.id, state: { in: [...IN_FLIGHT_STATES] } },
      data: {
        state: 'SUPERSEDED',
        settledAt: new Date(),
        lastError: 'superseded: a newer write to this field replaced it before it was sent',
      },
    })
    if (moved.count) superseded.push(m.field)
  }
  return { typed: true, superseded, remaining: live.length - superseded.length }
}

async function legacyRowWithNoMutations(
  tx: { adMutation: { count: (a: unknown) => Promise<number> } },
  outboundQueueId: string,
): Promise<boolean> {
  return (await tx.adMutation.count({ where: { outboundQueueId } })) === 0
}

/**
 * AX-ZD.3b — every in-flight field, for every entity of a type, in ONE query.
 *
 * `pendingWriteFields` asks per entity, which is right for a single campaign and
 * wrong inside the settings-sync loop: that runs per campaign across every
 * profile, so it issued one query per campaign per poll and would grow linearly
 * with the account.
 *
 * Unfiltered by entity on purpose. AdMutation holds only UNDELIVERED writes —
 * everything else has settled to a terminal state — so this set is naturally
 * tiny (normally empty) regardless of how many campaigns exist. `take` is a
 * backstop against a pathological backlog rather than an expected path, and it
 * logs rather than truncating silently, because a silent cap here would quietly
 * stop protecting the entities past the limit.
 */
export async function pendingWriteFieldsByEntity(
  entityType: AdEntityType,
  fields: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (!fields.length) return out
  const LIMIT = 5_000
  try {
    const rows = await prisma.adMutation.findMany({
      where: { entityType, field: { in: [...fields] }, state: { in: [...IN_FLIGHT_STATES] } },
      select: { entityId: true, field: true, state: true, createdAt: true },
      take: LIMIT,
    })
    if (rows.length === LIMIT) {
      logger.warn('[AX-ZD.3b] in-flight mutation set hit the cap; entities beyond it are unprotected this pass', {
        entityType, limit: LIMIT,
      })
    }
    for (const r of rows) {
      if (!isBelievablyPending(r, now)) continue
      const set = out.get(r.entityId) ?? new Set<string>()
      set.add(r.field)
      out.set(r.entityId, set)
    }
    return out
  } catch {
    // Fail OPEN, same as the per-entity form: reporting drift we caused costs a
    // minute, suppressing a real one loses an operator's edit.
    return out
  }
}

/**
 * CM-16 — the local COLUMNS a sync from Amazon must not overwrite, per entity id: the column of every field with an
 * undelivered write (queued, in its grace window, or being sent). Only the 20-minute settings sync held these back;
 * the keyword/target resync and the v1 export ingest wrote Amazon's older value over an operator's queued edit, so
 * the screen showed the old value after a successful save and the engines read it until the next sync.
 *
 * Same source as that hold-back (`pendingWriteFieldsByEntity`, one query, fails open), translated to the column names
 * the syncs write (`bid` → `bidCents`, `defaultBid` → `defaultBidCents`), so a sync can drop them by key with
 * `holdBackPendingFields`.
 */
export async function pendingWriteColumnsByEntity(
  entityType: AdEntityType,
  now: Date = new Date(),
): Promise<Map<string, Set<string>>> {
  const columns = LOCAL_COLUMNS[entityType] ?? {}
  const byField = await pendingWriteFieldsByEntity(entityType, Object.keys(columns), now)
  const out = new Map<string, Set<string>>()
  for (const [entityId, fields] of byField) {
    out.set(entityId, new Set([...fields].map((f) => columns[f]?.column ?? f)))
  }
  return out
}

/** CM-16 — the same, for one entity (a row that changed after a sync took its snapshot). */
export async function pendingWriteColumns(
  entityType: AdEntityType,
  entityId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const columns = LOCAL_COLUMNS[entityType] ?? {}
  const fields = await pendingWriteFields(entityType, entityId, Object.keys(columns), now)
  return new Set([...fields].map((f) => columns[f]?.column ?? f))
}

/**
 * AX-ZD.1 — which of these fields have a write in flight on this entity?
 *
 * The replacement for the campaign-wide JSON scan. One query, field-scoped, so a
 * queued budget change no longer explains away a name edit.
 *
 * Fails OPEN (empty set) on error: if we cannot tell, we report drift rather
 * than suppress it. An operator investigating a drift that turns out to be our
 * own pending write loses a minute; a suppressed drift loses their edit.
 */
export async function pendingWriteFields(
  entityType: AdEntityType,
  entityId: string,
  fields: readonly string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (!fields.length) return new Set()
  try {
    const rows = await prisma.adMutation.findMany({
      where: {
        entityType, entityId,
        field: { in: [...fields] },
        state: { in: [...IN_FLIGHT_STATES] },
      },
      select: { field: true, state: true, createdAt: true },
    })
    return new Set(rows.filter((r) => isBelievablyPending(r, now)).map((r) => r.field))
  } catch {
    return new Set()
  }
}

async function writeBidHistory(args: {
  entityType: AdEntityType
  entityId: string
  campaignId: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
}): Promise<string[]> {
  const ids: string[] = []
  for (const change of args.fieldChanges) {
    const row = await prisma.campaignBidHistory.create({
      data: {
        entityType: args.entityType,
        entityId: args.entityId,
        campaignId: args.campaignId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        changedBy: args.actor,
        reason: args.reason,
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  return ids
}

// Bound on how long we'll wait for the BullMQ enqueue before giving up and
// letting the cron drain handle the row. When Redis is unreachable ioredis
// *hangs* on connect rather than throwing, so a bare try/catch isn't enough —
// without this cap the operator's PATCH response blocked for the full ioredis
// connect timeout (observed as curl HTTP 000 on prod). The row is already
// persisted to OutboundSyncQueue, so timing out here is safe.
const ENQUEUE_TIMEOUT_MS = Number(process.env.NEXUS_ADS_ENQUEUE_TIMEOUT_MS ?? 1500)

async function enqueueBullMQJob(queueRowId: string, syncType: AdSyncType): Promise<void> {
  // Best-effort BullMQ enqueue. If Redis is down/slow or the queue isn't
  // initialized, the row still sits in OutboundSyncQueue and gets drained by
  // the cron fallback (drain-ads-sync). Never block or fail the operator write.
  try {
    const { adsSyncQueue } = await import('../../lib/queue.js')
    const add = adsSyncQueue
      .add(syncType, { queueId: queueRowId, syncType }, { delay: GRACE_PERIOD_MS, jobId: adsSyncJobId(queueRowId) })
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.warn('[ads-mutation] BullMQ enqueue failed (cron drain will handle)', {
          queueRowId, syncType, error: err instanceof Error ? err.message : String(err),
        })
      })
    // Cap the wait — a hung Redis connect must not stall the HTTP response.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, ENQUEUE_TIMEOUT_MS))
    await Promise.race([add, timeout])
  } catch (err) {
    logger.warn('[ads-mutation] BullMQ enqueue setup failed (cron drain will handle)', {
      queueRowId, syncType, error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Update helpers ────────────────────────────────────────────────────

export interface CampaignPatch {
  name?: string
  portfolioId?: string | null
  dailyBudget?: number
  dailyBudgetCurrency?: string
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
  endDate?: Date | null
}

export async function updateCampaignWithSync(args: {
  campaignId: string
  patch: CampaignPatch
  /** ADX A2 — the measurement behind this write; threaded to AdvertisingActionLog.evidence. */
  evidence?: AdWriteEvidence | null
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
  /** 1e — a person's own edit from a screen (see isPersonEdit). Set only by the routes. */
  manual?: boolean
  /** CM-10 — a person's edit from a screen: ask the write gate before writing (gateRefusedNow). */
  askGate?: boolean
  /** 3A — the person's "Send anyway" past his own limits (honoured only for a person's own write). */
  confirmOwnLimits?: boolean
  /** AA-W2-12 — a deliberate pause or archive (pause-ads, archive-ads): the halt does not hold it (isLetGoWrite). Nothing else is skipped. */
  letsGo?: boolean
  /**
   * W4-11 — a Claude request: a Sponsored Brands or Display campaign's daily budget and on/off state are sent to their
   * own endpoints (see adProductRefused). Absent: Sponsored Products only, as before.
   */
  allowSbSd?: boolean
}): Promise<MutationOutcome> {
  const existing = await prisma.campaign.findUnique({
    where: { id: args.campaignId },
    select: {
      ...BOUNDS_SELECT, // 4k
      id: true,
      name: true,
      portfolioId: true,
      externalCampaignId: true,
      marketplace: true,
      dailyBudget: true,
      dailyBudgetCurrency: true,
      status: true,
      biddingStrategy: true,
      endDate: true,
      adProduct: true, // 6a
      type: true,
      budgetJson: true, // W4-11 — an SB lifetime budget is not set from Nexus
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  // 6a — see adProductRefused. W4-11 — the write, described from the patch, for a caller that may change SB/SD.
  const sbSdWrite: AdWrite | null = args.allowSbSd === true
    ? { entity: 'CAMPAIGN', fields: Object.entries(args.patch).filter(([, v]) => v !== undefined).map(([k]) => k), toStatus: args.patch.status ?? null }
    : null
  const notSp = adProductRefused('CAMPAIGN', args.campaignId, args.actor, existing, sbSdWrite)
  if (notSp) return notSp

  // SYNC.1 — see isSchedulingEngineActor. Refuse before the diff, so the refusal does not depend on
  // whether the status happens to differ this tick: an engine asking for a campaign state at all is
  // the thing that is wrong. Refused loudly, because a silent no-op here would look like the write
  // landed and put us straight back to guessing.
  if (args.patch.status != null && isSchedulingEngineActor(args.actor)) {
    logger.warn('[ads-mutation] refused engine campaign-status write', {
      campaignId: args.campaignId, actor: args.actor,
      from: existing.status, to: args.patch.status, reason: args.reason ?? null,
    })
    return {
      ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null,
      error: 'engine_may_not_set_campaign_status',
    }
  }
  // 1f — see isAutomatedPause. Same placement and reasoning as SYNC.1: before the diff, and loud.
  if (isAutomatedPause(args.actor, args.patch.status)) {
    logger.warn('[ads-mutation] refused automated campaign pause', {
      campaignId: args.campaignId, actor: args.actor, from: existing.status, reason: args.reason ?? null,
    })
    return {
      ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null,
      error: 'automation_may_not_pause_campaign',
    }
  }

  // Diff: only audit fields the patch actually changes.
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BUDGET_UPDATE'
  if (args.patch.name != null && args.patch.name !== existing.name) {
    changes.push({
      field: 'name',
      oldValue: existing.name,
      newValue: args.patch.name,
    })
    syncType = 'AD_CAMPAIGN_NAME_UPDATE'
  }
  if (args.patch.portfolioId !== undefined && (args.patch.portfolioId ?? null) !== (existing.portfolioId ?? null)) {
    changes.push({
      field: 'portfolioId',
      oldValue: existing.portfolioId ?? null,
      newValue: args.patch.portfolioId ?? null,
    })
    syncType = 'AD_CAMPAIGN_PORTFOLIO_UPDATE'
  }
  if (args.patch.dailyBudget != null && Number(existing.dailyBudget) !== args.patch.dailyBudget) {
    changes.push({
      field: 'dailyBudget',
      oldValue: String(existing.dailyBudget),
      newValue: String(args.patch.dailyBudget),
    })
    syncType = 'AD_BUDGET_UPDATE'
  }
  if (args.patch.dailyBudgetCurrency && args.patch.dailyBudgetCurrency !== existing.dailyBudgetCurrency) {
    changes.push({
      field: 'dailyBudgetCurrency',
      oldValue: existing.dailyBudgetCurrency,
      newValue: args.patch.dailyBudgetCurrency,
    })
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (args.patch.biddingStrategy && args.patch.biddingStrategy !== existing.biddingStrategy) {
    changes.push({
      field: 'biddingStrategy',
      oldValue: existing.biddingStrategy,
      newValue: args.patch.biddingStrategy,
    })
    syncType = 'AD_BIDDING_STRATEGY_UPDATE'
  }
  if (args.patch.endDate !== undefined && args.patch.endDate?.toISOString() !== existing.endDate?.toISOString()) {
    changes.push({
      field: 'endDate',
      oldValue: existing.endDate?.toISOString() ?? null,
      newValue: args.patch.endDate?.toISOString() ?? null,
    })
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }
  // 3A — a person's own write past his own limits asks for his confirmation; `past` is what he confirmed it past.
  const person = isPersonEdit(args.manual, args.actor)
  const confirmOwnLimits = person && args.confirmOwnLimits === true
  const past: OwnLimit[] = []
  // 4k — see boundsRefused: a budget outside the campaign's own bounds is refused before Nexus writes it.
  if (changes.some((c) => c.field === 'dailyBudget')) {
    const refused = await boundsRefused({
      entity: 'CAMPAIGN', entityId: args.campaignId, campaign: existing, field: 'dailyBudget',
      intendedValueCents: Math.round((args.patch.dailyBudget as number) * 100), isSuppression: false,
      person, confirmOwnLimits, past,
    })
    if (refused) return refused
  }
  const atDispatch = await gateRefusedNow({
    askGate: args.askGate, actor: args.actor, entity: 'CAMPAIGN', entityId: args.campaignId,
    campaignId: existing.id, marketplace: existing.marketplace, changes,
    manual: args.manual, confirmOwnLimits, past, write: sbSdWrite,
  })
  if (atDispatch) return atDispatch

  // Capture payloadBefore snapshot BEFORE we write to local row.
  const payloadBefore = {
    name: existing.name,
    portfolioId: existing.portfolioId,
    dailyBudget: Number(existing.dailyBudget),
    dailyBudgetCurrency: existing.dailyBudgetCurrency,
    status: existing.status,
    biddingStrategy: existing.biddingStrategy,
    endDate: existing.endDate?.toISOString() ?? null,
  }

  // Local write
  const data: Record<string, unknown> = {}
  if (args.patch.name != null) data.name = args.patch.name
  if (args.patch.portfolioId !== undefined) data.portfolioId = args.patch.portfolioId
  if (args.patch.dailyBudget != null) data.dailyBudget = args.patch.dailyBudget
  if (args.patch.dailyBudgetCurrency) data.dailyBudgetCurrency = args.patch.dailyBudgetCurrency
  if (args.patch.status) data.status = args.patch.status
  if (args.patch.biddingStrategy) data.biddingStrategy = args.patch.biddingStrategy
  if (args.patch.endDate !== undefined) data.endDate = args.patch.endDate
  await prisma.campaign.update({ where: { id: args.campaignId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    externalId: existing.externalCampaignId,
    syncType,
    marketplace: existing.marketplace,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
    manual: person,
    confirmOwnLimits,
    letsGo: args.letsGo,
    sbSd: sbSdWrite != null && isSbSdCampaign(existing),
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    campaignId: args.campaignId,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.name != null ? { name: args.patch.name } : {}),
    ...(args.patch.portfolioId !== undefined ? { portfolioId: args.patch.portfolioId } : {}),
    ...(args.patch.dailyBudget != null ? { dailyBudget: args.patch.dailyBudget } : {}),
    ...(args.patch.dailyBudgetCurrency ? { dailyBudgetCurrency: args.patch.dailyBudgetCurrency } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
    ...(args.patch.biddingStrategy ? { biddingStrategy: args.patch.biddingStrategy } : {}),
    ...(args.patch.endDate !== undefined ? { endDate: args.patch.endDate?.toISOString() ?? null } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: syncType,
    entityType: 'CAMPAIGN',
    evidence: withSentPast(args.evidence, past, args.actor),
    entityId: args.campaignId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  // ONE BRAIN AB-2 — a person's own bidding strategy (or a request a person approved) on a campaign the bid brain owns
  // becomes its STRATEGY hold: the stop recipe leaves it alone until the hold ends. Inert unless the brain owns the
  // campaign; never fails this write.
  if (person && changes.some((c) => c.field === 'biddingStrategy')) {
    const { recordStrategyHold } = await import('./bid-brain/brain-holds.js')
    await recordStrategyHold({ campaignId: args.campaignId, actor: args.actor, manual: person, reason: args.reason ?? null })
  }

  await enqueueBullMQJob(outboundQueueId, syncType)

  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

export interface AdGroupPatch {
  defaultBidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  /** CM-15 — a rename, sent to Amazon like the status and the default bid. */
  name?: string
}

export async function updateAdGroupWithSync(args: {
  adGroupId: string
  patch: AdGroupPatch
  /** ADX A2 — the measurement behind this write; threaded to AdvertisingActionLog.evidence. */
  evidence?: AdWriteEvidence | null
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  force?: boolean // NP — bypass the 5¢ floor for deliberate bid suppression/restore
  forceResync?: boolean // WC — push to Amazon even if the local value is unchanged (one-time re-sync of stale Amazon state)
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
  /** 1e — a person's own edit from a screen (see isPersonEdit). Set only by the routes. */
  manual?: boolean
  /**
   * 1e — an Undo (rollback.service.ts): a person's click, but it puts an old value back rather than choosing a new
   * bid, so it does not replace the no-pause floor's memory; reverseOne puts the memory back from the action log.
   */
  reversal?: boolean
  /** CM-10 — a person's edit from a screen: ask the write gate before writing (gateRefusedNow). */
  askGate?: boolean
  /** 3A — the person's "Send anyway" past his own limits (honoured only for a person's own write). */
  confirmOwnLimits?: boolean
  /** AA-W2-12 — a deliberate pause or archive (pause-ads, archive-ads): the halt does not hold it (isLetGoWrite). Unlike `force`, nothing else is skipped. */
  letsGo?: boolean
}): Promise<MutationOutcome> {
  const person = isPersonEdit(args.manual, args.actor)
  const existing = await prisma.adGroup.findUnique({
    where: { id: args.adGroupId },
    select: {
      id: true,
      name: true,
      externalAdGroupId: true,
      defaultBidCents: true,
      suppressedFromBidCents: true, // 1e (CM-9)
      status: true,
      orphanedAt: true,
      campaign: { select: { id: true, marketplace: true, name: true, adProduct: true, type: true, ...BOUNDS_SELECT } },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  // 6a — see adProductRefused.
  const notSp = adProductRefused('AD_GROUP', args.adGroupId, args.actor, existing.campaign)
  if (notSp) return notSp
  // 1f — see isAutomatedPause: an automation lowers an ad group's bids, it never pauses it.
  if (isAutomatedPause(args.actor, args.patch.status)) {
    logger.warn('[ads-mutation] refused automated ad-group pause', {
      adGroupId: args.adGroupId, actor: args.actor, from: existing.status, reason: args.reason ?? null,
    })
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'automation_may_not_pause_ad_group' }
  }
  // AX2.0 — same guard as AdTarget: Amazon says this ad group is gone, so stop
  // regenerating writes for it. `force` is the operator's re-test path.
  if (existing.orphanedAt && !args.force) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'entity_orphaned' }
  }
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.defaultBidCents != null && (args.forceResync || args.patch.defaultBidCents !== existing.defaultBidCents)) {
    changes.push({
      field: 'defaultBid',
      oldValue: String(existing.defaultBidCents),
      newValue: String(args.patch.defaultBidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  // CM-15 — a rename was a local `prisma.adGroup.update` in the route: never sent to Amazon, no audit row, and the v1
  // ingest wrote Amazon's name back within two hours. It now travels like the other two fields. A name-only change
  // rides AD_ENTITY_STATE_UPDATE because that type is on every list that dispatches, drains and reclaims ad writes
  // (the campaign rename's own type is not yet — CM-4); the worker sends whatever fields the row carries.
  const newName = args.patch.name?.trim()
  if (newName && newName !== existing.name) {
    changes.push({ field: 'name', oldValue: existing.name, newValue: newName })
    if (changes.length === 1) syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    // 1e (CM-9) — see keepPersonBidThroughRestore: a person confirming the bid the floor holds keeps it.
    await keepPersonBidThroughRestore('AD_GROUP', args.adGroupId, person && !args.reversal, args.patch.defaultBidCents, existing.suppressedFromBidCents)
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }

  // Floor on bid — AD.3's automation handler reuses this; same
  // safety belongs in the user path so a slip-up can't zero impressions.
  // 1e (CM-19) — a person's floor is Amazon's own minimum in the market (bidFloorRefusal).
  const belowFloor = !args.force && args.patch.defaultBidCents != null
    ? bidFloorRefusal(args.patch.defaultBidCents, person, existing.campaign?.marketplace, 'defaultBid')
    : null
  if (belowFloor) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: belowFloor,
    }
  }
  // 3A — see updateCampaignWithSync.
  const confirmOwnLimits = person && args.confirmOwnLimits === true
  const past: OwnLimit[] = []
  // 4k — see boundsRefused. W1-5 — with the ads strategy band of this ad group's products.
  if (changes.some((c) => c.field === 'defaultBid')) {
    const refused = await boundsRefused({
      entity: 'AD_GROUP', entityId: args.adGroupId, campaign: existing.campaign, field: 'defaultBid',
      intendedValueCents: args.patch.defaultBidCents as number, isSuppression: isSuppressionWrite(args.force === true, changes),
      person, confirmOwnLimits, past, adGroupId: args.adGroupId,
    })
    if (refused) return refused
  }
  const atDispatch = await gateRefusedNow({
    askGate: args.askGate, actor: args.actor, entity: 'AD_GROUP', entityId: args.adGroupId,
    campaignId: existing.campaign?.id, marketplace: existing.campaign?.marketplace, changes, force: args.force,
    manual: args.manual, confirmOwnLimits, past, adGroupId: args.adGroupId,
  })
  if (atDispatch) return atDispatch

  // 1e (CM-9) — a person's bid on an ad group the no-pause floor holds is the bid the restore puts back. The memory it
  // replaces is kept in the action log (both payloads), so an Undo of this edit puts the memory back too.
  const replacesMemory = person && !args.reversal && !args.force && args.patch.defaultBidCents != null
    && existing.suppressedFromBidCents != null && existing.suppressedFromBidCents !== args.patch.defaultBidCents
  const payloadBefore = {
    name: existing.name,
    defaultBidCents: existing.defaultBidCents,
    status: existing.status,
    ...(replacesMemory ? { suppressedFromBidCents: existing.suppressedFromBidCents } : {}),
  }

  const data: Record<string, unknown> = {}
  if (args.patch.defaultBidCents != null) data.defaultBidCents = args.patch.defaultBidCents
  if (args.patch.status) data.status = args.patch.status
  if (replacesMemory) data.suppressedFromBidCents = args.patch.defaultBidCents
  if (newName) data.name = newName
  await prisma.adGroup.update({ where: { id: args.adGroupId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    externalId: existing.externalAdGroupId,
    syncType,
    marketplace: existing.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
    force: args.force,
    manual: person,
    confirmOwnLimits,
    letsGo: args.letsGo,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    campaignId: existing.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.defaultBidCents != null ? { defaultBidCents: args.patch.defaultBidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
    ...(replacesMemory ? { suppressedFromBidCents: args.patch.defaultBidCents } : {}),
    ...(newName ? { name: newName } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: syncType,
    entityType: 'AD_GROUP',
    evidence: withSentPast(args.evidence, past, args.actor),
    entityId: args.adGroupId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

// AF.5 — product ad enable/pause. Status-only (product ads carry no bid).
export async function updateProductAdWithSync(args: {
  productAdId: string
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
  /** 1e — a person's own edit from a screen (see isPersonEdit). Set only by the routes. */
  manual?: boolean
  /** CM-10 — a person's edit from a screen: ask the write gate before writing (gateRefusedNow). */
  askGate?: boolean
  /** 3A — the person's "Send anyway" past his own limits (honoured only for a person's own write). */
  confirmOwnLimits?: boolean
  /** AA-W2-12 — a deliberate pause or archive (pause-ads, archive-ads): the halt does not hold it (isLetGoWrite). Nothing else is skipped. */
  letsGo?: boolean
}): Promise<MutationOutcome> {
  const existing = await prisma.adProductAd.findUnique({
    where: { id: args.productAdId },
    select: { id: true, externalAdId: true, status: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true, name: true, adProduct: true, type: true } } } } },
  })
  if (!existing) return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  // 6a — see adProductRefused.
  const notSp = adProductRefused('PRODUCT_AD', args.productAdId, args.actor, existing.adGroup?.campaign)
  if (notSp) return notSp
  if (args.status === existing.status) return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }

  const changes: FieldChange[] = [{ field: 'status', oldValue: existing.status, newValue: args.status }]
  const atDispatch = await gateRefusedNow({
    askGate: args.askGate, actor: args.actor, entity: 'PRODUCT_AD', entityId: args.productAdId,
    campaignId: existing.adGroup?.campaign?.id, marketplace: existing.adGroup?.campaign?.marketplace, changes,
    manual: args.manual,
  })
  if (atDispatch) return atDispatch
  await prisma.adProductAd.update({ where: { id: args.productAdId }, data: { status: args.status } })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'PRODUCT_AD',
    entityId: args.productAdId,
    externalId: existing.externalAdId,
    syncType: 'AD_ENTITY_STATE_UPDATE',
    marketplace: existing.adGroup?.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
    manual: isPersonEdit(args.manual, args.actor),
    letsGo: args.letsGo,
  })
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: 'AD_ENTITY_STATE_UPDATE',
    entityType: 'PRODUCT_AD',
    entityId: args.productAdId,
    payloadBefore: { status: existing.status },
    payloadAfter: { status: args.status },
    outboundQueueId,
  })
  await enqueueBullMQJob(outboundQueueId, 'AD_ENTITY_STATE_UPDATE')
  return { ok: true, outboundQueueId, bidHistoryIds: [], actionLogId, error: null }
}

export interface AdTargetPatch {
  bidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}

export async function updateAdTargetWithSync(args: {
  adTargetId: string
  patch: AdTargetPatch
  /** ADX A2 — the measurement behind this write; threaded to AdvertisingActionLog.evidence. */
  evidence?: AdWriteEvidence | null
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  force?: boolean // NP — bypass the change-clamp + 5¢ floor for deliberate bid suppression/restore
  forceResync?: boolean // WC — push to Amazon even if the local value is unchanged (one-time re-sync of stale Amazon state)
  /** AX-IE.6 — tag this write as part of a revertible change set. */
  changeSetId?: string | null
  /**
   * NEG.3 — override the ledger's actionType.
   *
   * `actionType` is hard-coded to `syncType` here, so an archive and a bid change are the same
   * row in `AdvertisingActionLog` and a retirement is indistinguishable from any other state
   * update. Defaulted to the existing behaviour, so every other caller is byte-identical; the
   * retire path passes `retire_negative` so NEG.8 has something to filter on.
   */
  actionType?: string | null
  /** 1e — a person's own edit from a screen (see isPersonEdit). Set only by the routes. */
  manual?: boolean
  /**
   * 1e — an Undo (rollback.service.ts): a person's click, but it puts an old value back rather than choosing a new
   * bid, so it does not replace the no-pause floor's memory; reverseOne puts the memory back from the action log.
   */
  reversal?: boolean
  /** CM-10 — a person's edit from a screen: ask the write gate before writing (gateRefusedNow). */
  askGate?: boolean
  /** BID BRAIN pre-go-live — with askGate: a retry already refused today is refused the same, without a second refusal record. */
  quietRefusal?: boolean
  /** 3A — the person's "Send anyway" past his own limits (honoured only for a person's own write). */
  confirmOwnLimits?: boolean
  /** AA-W2-12 — a deliberate pause or archive (pause-ads, archive-ads): the halt does not hold it (isLetGoWrite). Unlike `force`, nothing else is skipped. */
  letsGo?: boolean
  /**
   * D4 — a stop (bulk-ad-bid-change's stop row): a LOWERING to the ads strategy's stop bid, the Owner's temporary stop
   * (low bids, never a pause). Not a step of the bid's pace: the largest change per action does not clamp it, and the
   * gate judges it as the lowering-only stop it is (isSuppressionWrite: the lowest bid does not bind it, as it does
   * not bind a floor). Never a raise: a stop that does not lower the bid is refused. Unlike `force`, nothing else is
   * skipped (the orphan mark, the 5¢ floor, a person's floor memory).
   */
  stop?: boolean
  /**
   * W4-11 — a Claude request: a Sponsored Brands or Display keyword's or target's bid and on/off state, and the retire
   * of an SB negative keyword or SD negative product target, are sent to their own endpoints (see adProductRefused).
   * Absent: Sponsored Products only, as before.
   */
  allowSbSd?: boolean
}): Promise<MutationOutcome> {
  const person = isPersonEdit(args.manual, args.actor)
  const existing = await prisma.adTarget.findUnique({
    where: { id: args.adTargetId },
    select: {
      id: true,
      externalTargetId: true,
      bidCents: true,
      suppressedFromBidCents: true, // 1e (CM-9)
      status: true,
      orphanedAt: true,
      orphanReason: true, // WF.1 — needed to tell a real orphan from a routing artefact
      kind: true,
      isNegative: true,   // NEG.3 — the third routing axis; a negative's id is not a /sp/keywords id
      negativeLevel: true,
      adGroup: {
        select: { id: true, campaign: { select: { id: true, marketplace: true, dynamicBidding: true, name: true, adProduct: true, type: true, costType: true, ...BOUNDS_SELECT } } },
      },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  // 6a — see adProductRefused. Before the orphan check below, which may itself clear a mark (a local write), and
  // before anything is queued: an SB keyword sent to /sp/keywords comes back "not found" and would be marked orphaned.
  // W4-11 — the write, described from the patch, for a caller that may change SB/SD (the worker routes it to their endpoints).
  const sbSdWrite: AdWrite | null = args.allowSbSd === true
    ? {
        entity: 'AD_TARGET',
        fields: [args.patch.bidCents != null ? 'bid' : null, args.patch.status ? 'status' : null],
        toStatus: args.patch.status ?? null, kind: existing.kind, isNegative: existing.isNegative, negativeLevel: existing.negativeLevel,
      }
    : null
  const notSp = adProductRefused('AD_TARGET', args.adTargetId, args.actor, existing.adGroup?.campaign, sbSdWrite)
  if (notSp) return notSp

  // AX2.0 — Amazon has already told us this target does not exist. Enqueueing
  // again just recreates the dead write: this is the loop that produced 662
  // dead-lettered rows from 23 targets, ~23/day for 26 days. Refuse at the
  // chokepoint so EVERY caller (rank-defend, dayparting, bulk, manual) is
  // covered, and no queue row or Amazon call is generated.
  //
  // `force` is the deliberate operator override — a repair path may push to
  // re-test whether the entity is back, and a success clears orphanedAt.
  if (existing.orphanedAt && !args.force) {
    // WF.1 — but first: is the mark self-contradictory? An AUTO/PRODUCT target orphaned for a
    // missing KEYWORD (or the reverse) records our old routing fault, not Amazon's inventory, and
    // such a mark can never clear itself — it blocks the very write whose success would remove it.
    // Withdraw the unsupported conclusion and let this write go to the now-correct endpoint; if
    // the entity really is gone, the worker re-orphans it with an accurate reason.
    if (isContradictoryOrphan(existing.orphanReason, existing.kind, existing.isNegative)) {
      await prisma.adTarget.update({ where: { id: args.adTargetId }, data: { orphanedAt: null, orphanReason: null } })
      logger.info('[ads-mutation] cleared a self-contradictory orphan mark — re-testing against Amazon', {
        adTargetId: args.adTargetId, kind: existing.kind, was: existing.orphanReason,
      })
    } else {
      return {
        ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null,
        error: 'entity_orphaned',
      }
    }
  }

  // W1-5 — the ads strategy's bid limits for this target's ad group (the safer value across its products), read once
  // for the step clamp and the bounds below. One indexed read when the market's strategy sets no bid field.
  const campaignOfTarget = existing.adGroup?.campaign
  const strategy: StrategyBidLimits = args.patch.bidCents != null && campaignOfTarget
    ? await bidLimitsFor({ marketplace: campaignOfTarget.marketplace, adGroupId: existing.adGroup!.id, campaignId: campaignOfTarget.id })
    : NO_LIMITS
  const sources: WriteSources = {}
  const warnings: string[] = []
  // D4 — a stop only lowers (see `stop`); a lowering-only forced write at the gate.
  const stop = args.stop === true && args.patch.bidCents != null
  if (stop && !(args.patch.bidCents! < existing.bidCents)) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: `a stop only lowers a bid: ${args.patch.bidCents}¢ is not below ${existing.bidCents}¢` }
  }
  const forcedLowering = args.force === true || stop

  // Apex A.2a — clamp the requested bid to the campaign's max-change-% guardrail
  // (when set). Caps how far a single bid move can swing from the current bid, so a
  // runaway rule can't 10× a bid in one step.
  // Applied before the diff so the audit trail records the clamped value.
  // 1e (CM-19) — not to a person's own edit: it rewrote his bid without a word, and a
  // brake may stop automation, not second-guess his click. Engines and rules keep it.
  // W1-5 — the largest change is the LOWER of the campaign's and the ads strategy's (stepClamp, the same arithmetic as
  // Claude's preview, ads-change-kit.ts); a bid asked for inside the strategy band stays inside it. A person's own edit
  // past the strategy's largest change is sent, with a warning (never rewritten, never held for a confirmation). W4-4 — a
  // Claude request a person approved carries his mark (approvedRun) and goes the same way: the card warned him first.
  if (!args.force && !stop && args.patch.bidCents != null && existing.bidCents > 0) {
    if (!person) {
      const step = stepClamp(existing.bidCents, args.patch.bidCents, campaignOfTarget?.dynamicBidding, strategy)
      if (step.by === 'strategy' && step.cents !== args.patch.bidCents) Object.assign(sources, limitSources({ ...NO_LIMITS, maxChangePct: strategy.maxChangePct }))
      if (step.bandHeld) Object.assign(sources, limitSources({ ...NO_LIMITS, [step.bandHeld.side === 'max' ? 'maxBidCents' : 'minBidCents']: step.bandHeld.limit }))
      args.patch.bidCents = step.cents
    } else if (strategy.maxChangePct && stepClamp(existing.bidCents, args.patch.bidCents, null, { ...NO_LIMITS, maxChangePct: strategy.maxChangePct }).cents !== args.patch.bidCents) {
      const pct = Math.round((Math.abs(args.patch.bidCents - existing.bidCents) / existing.bidCents) * 100)
      warnings.push(`a ${pct} % change (${existing.bidCents}¢ → ${args.patch.bidCents}¢) is more than the largest bid change ${strategy.maxChangePct.value} % (${strategyWords(strategy.maxChangePct.source)}); sent, because a person made or approved it`)
    }
  }

  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.bidCents != null && (args.forceResync || args.patch.bidCents !== existing.bidCents)) {
    changes.push({
      field: 'bid',
      oldValue: String(existing.bidCents),
      newValue: String(args.patch.bidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    // 1e (CM-9) — see keepPersonBidThroughRestore: a person confirming the bid the floor holds keeps it.
    await keepPersonBidThroughRestore('AD_TARGET', args.adTargetId, person && !args.reversal, args.patch.bidCents, existing.suppressedFromBidCents)
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }
  // 1e (CM-19) — a person's floor is Amazon's own minimum in the market (bidFloorRefusal); an engine's stays 5¢.
  const belowFloor = !args.force && args.patch.bidCents != null
    ? bidFloorRefusal(args.patch.bidCents, person, existing.adGroup?.campaign?.marketplace, 'bid', existing.adGroup?.campaign)
    : null
  if (belowFloor) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: belowFloor,
    }
  }
  // 4k — see boundsRefused. After the change clamp, so the bid judged is the bid that would be written.
  // 3A — see updateCampaignWithSync.
  const confirmOwnLimits = person && args.confirmOwnLimits === true
  const past: OwnLimit[] = []
  // W1-5 — with the ads strategy band read above (one of his own limits: a person confirms past it, 3A).
  if (changes.some((c) => c.field === 'bid')) {
    const refused = await boundsRefused({
      entity: 'AD_TARGET', entityId: args.adTargetId, campaign: existing.adGroup?.campaign, field: 'bid',
      intendedValueCents: args.patch.bidCents as number, isSuppression: isSuppressionWrite(forcedLowering, changes),
      person, confirmOwnLimits, past, adGroupId: existing.adGroup?.id ?? null, strategy,
    })
    if (refused) return refused
  }
  const atDispatch = await gateRefusedNow({
    askGate: args.askGate, quietRefusal: args.quietRefusal, actor: args.actor, entity: 'AD_TARGET', entityId: args.adTargetId,
    campaignId: existing.adGroup?.campaign?.id, marketplace: existing.adGroup?.campaign?.marketplace, changes, force: forcedLowering,
    manual: args.manual, confirmOwnLimits, past, adGroupId: existing.adGroup?.id ?? null, write: sbSdWrite,
  })
  if (atDispatch) return atDispatch

  // 1e (CM-9) — a person's bid on a target the no-pause floor holds is the bid the restore puts back. The memory it
  // replaces is kept in the action log (both payloads), so an Undo of this edit puts the memory back too.
  const replacesMemory = person && !args.reversal && !args.force && args.patch.bidCents != null
    && existing.suppressedFromBidCents != null && existing.suppressedFromBidCents !== args.patch.bidCents
  const payloadBefore = {
    bidCents: existing.bidCents,
    status: existing.status,
    ...(replacesMemory ? { suppressedFromBidCents: existing.suppressedFromBidCents } : {}),
  }

  const data: Record<string, unknown> = {}
  if (args.patch.bidCents != null) data.bidCents = args.patch.bidCents
  if (args.patch.status) data.status = args.patch.status
  if (replacesMemory) data.suppressedFromBidCents = args.patch.bidCents
  await prisma.adTarget.update({ where: { id: args.adTargetId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    externalId: existing.externalTargetId,
    syncType,
    marketplace: existing.adGroup?.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
    // D4 — a stop rides the queue row's lowering-only mark, so the worker's gate judges it as one (isSuppressionWrite).
    force: forcedLowering,
    manual: person,
    confirmOwnLimits,
    letsGo: args.letsGo,
    sbSd: sbSdWrite != null && isSbSdCampaign(existing.adGroup?.campaign),
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    campaignId: existing.adGroup?.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.bidCents != null ? { bidCents: args.patch.bidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
    ...(replacesMemory ? { suppressedFromBidCents: args.patch.bidCents } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    changeSetId: args.changeSetId ?? null,
    actor: args.actor,
    actionType: args.actionType ?? syncType,
    entityType: 'AD_TARGET',
    evidence: withStrategyEvidence(withSentPast(args.evidence, past, args.actor), sources, warnings),
    entityId: args.adTargetId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  // BID BRAIN BB-6 — a person's bid (or a request a person approved) on a campaign the brain owns becomes its hold; a
  // hand-back ends it. Inert unless the brain owns the campaign; never fails this write.
  if (args.patch.bidCents != null && person) {
    const { recordBrainHold } = await import('./bid-brain/brain-holds.js')
    await recordBrainHold({ campaignId: existing.adGroup?.campaign?.id, targetId: args.adTargetId, actor: args.actor, manual: person, changeSetId: args.changeSetId ?? null, handBack: args.evidence?.handBack === 'auto-bid', reason: args.reason ?? null })
  }

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null, ...(warnings.length ? { warnings } : {}) }
}

// ── Bulk target bid update ─────────────────────────────────────────────

export interface BulkBidEntry {
  adTargetId: string
  bidCents: number
  /** W1-5 — the measurement and the sources behind this bid (an engine's proposal); kept on its action log row. */
  evidence?: AdWriteEvidence | null
  /** D4 — a stop: a lowering to the ads strategy's stop bid (updateAdTargetWithSync `stop`). */
  stop?: boolean
}

export interface BulkBidOutcome {
  applied: number
  skipped: number
  failed: number
  outcomes: MutationOutcome[]
  chunks: number
}

// Amazon Ads bulk endpoints limit ~1k entities per call. We chunk
// here so a single operator action (e.g. "bid +20% on 4k keywords")
// translates into 4 sequential OutboundSyncQueue rows + 4 BullMQ
// jobs rather than a single oversized payload.
const AMAZON_BULK_CHUNK = 1000

export async function bulkUpdateAdTargetBids(args: {
  entries: BulkBidEntry[]
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  /**
   * SG.10 (additive) — stamp every write in this batch with ONE change-set id, so the batch is
   * reversible as a unit: `AdvertisingActionLog.executionId` IS the change set, and
   * `rollbackByActionLogId` follows it to reverse all its siblings. Without it a bid batch is N
   * unrelated writes and an "Undo" offered on any one of them would silently revert 1 of N.
   * Omitted ⇒ previous behaviour exactly (each write its own set).
   */
  changeSetId?: string | null
  /** 1e — a person's own edit from a screen (see isPersonEdit). Set only by the bulk-bid route. */
  manual?: boolean
  /** 3A — ask the gate now (a person's bulk edit), and his "Send anyway" past his own limits. */
  askGate?: boolean
  confirmOwnLimits?: boolean
  /** W4-11 — a Claude request (bulk-ad-bid-change): SB/SD keyword and target bids too (updateAdTargetWithSync). */
  allowSbSd?: boolean
}): Promise<BulkBidOutcome> {
  const out: BulkBidOutcome = {
    applied: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    chunks: 0,
  }
  for (let i = 0; i < args.entries.length; i += AMAZON_BULK_CHUNK) {
    const chunk = args.entries.slice(i, i + AMAZON_BULK_CHUNK)
    out.chunks += 1
    for (const entry of chunk) {
      const outcome = await updateAdTargetWithSync({
        adTargetId: entry.adTargetId,
        patch: { bidCents: entry.bidCents },
        actor: args.actor,
        reason: args.reason ?? null,
        applyImmediately: args.applyImmediately ?? false,
        changeSetId: args.changeSetId ?? null,
        manual: args.manual,
        askGate: args.askGate,
        confirmOwnLimits: args.confirmOwnLimits,
        ...(args.allowSbSd ? { allowSbSd: true } : {}),
        evidence: entry.evidence ?? null,
        ...(entry.stop ? { stop: true } : {}),
      })
      out.outcomes.push(outcome)
      if (outcome.ok && outcome.outboundQueueId) out.applied += 1
      else if (outcome.ok) out.skipped += 1
      else out.failed += 1
    }
  }
  return out
}

/**
 * AX-IE.2 — portfolio update, on the same rails as every other ad write.
 *
 * Rides updateOutbound → ads-write-gate → the outbox exactly like campaigns do,
 * so the live-write gate, the grace window, the audit log and the rollback path
 * all apply unchanged. A portfolio moves budget, so it must not get a private
 * path around the gate.
 *
 * State is NOT writable here: Amazon marks it "(Informational only)" on its own
 * Portfolios sheet.
 */
export interface PortfolioPatch {
  name?: string
  budgetAmount?: number
  budgetCurrencyCode?: string
  budgetPolicy?: string
  startDate?: string | null
  endDate?: string | null
}

export async function updatePortfolioWithSync(args: {
  portfolioId: string
  patch: PortfolioPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
  changeSetId?: string | null
}): Promise<MutationOutcome> {
  const existing = await prisma.amazonAdsPortfolio.findUnique({ where: { id: args.portfolioId } })
  if (!existing) return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'portfolio_not_found' }

  const changes: FieldChange[] = []
  const data: Record<string, unknown> = {}
  // startDate/endDate are DateTime columns but the sheet carries YYYY-MM-DD.
  // Compare on the date part or every run reports a change it cannot settle.
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null
      : v instanceof Date ? v.toISOString().slice(0, 10)
        : String(v)
  const track = (field: string, oldValue: unknown, newValue: unknown, column: string): void => {
    if (newValue === undefined) return
    if (str(oldValue) === str(newValue)) return
    data[column] = newValue
    changes.push({ field, oldValue: str(oldValue), newValue: str(newValue) })
  }
  track('name', existing.name, args.patch.name, 'name')
  track('budgetAmount', existing.budgetAmount == null ? null : Number(existing.budgetAmount), args.patch.budgetAmount, 'budgetAmount')
  track('budgetCurrencyCode', existing.budgetCurrencyCode, args.patch.budgetCurrencyCode, 'budgetCurrencyCode')
  track('budgetPolicy', existing.budgetPolicy, args.patch.budgetPolicy, 'budgetPolicy')
  const asDate = (v: string | null | undefined): Date | undefined =>
    v === undefined ? undefined : v ? new Date(`${v}T00:00:00.000Z`) : undefined
  track('startDate', existing.startDate, asDate(args.patch.startDate), 'startDate')
  track('endDate', existing.endDate, asDate(args.patch.endDate), 'endDate')

  if (!changes.length) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: null }
  }

  const payloadBefore = {
    name: existing.name,
    budgetAmount: existing.budgetAmount == null ? null : Number(existing.budgetAmount),
    budgetCurrencyCode: existing.budgetCurrencyCode,
    budgetPolicy: existing.budgetPolicy,
    startDate: existing.startDate,
    endDate: existing.endDate,
  }

  await prisma.amazonAdsPortfolio.update({ where: { id: existing.id }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'PORTFOLIO',
    entityId: existing.id,
    externalId: existing.externalPortfolioId ?? null,
    syncType: 'AD_PORTFOLIO_UPDATE',
    // The portfolio model carries profileId, not marketplace, and the worker
    // resolves the write gate + profile from marketplace. Look it up rather
    // than leaving it null, or the write is refused as unattributable.
    marketplace: (await prisma.amazonAdsConnection.findFirst({
      where: { profileId: existing.profileId }, select: { marketplace: true },
    }))?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately === true,
  })

  const actionLogId = await writeAdvertisingActionLog({
    actor: args.actor,
    actionType: 'AD_PORTFOLIO_UPDATE',
    entityType: 'CAMPAIGN', // the audit table's enum has no PORTFOLIO member yet
    entityId: existing.id,
    payloadBefore,
    payloadAfter: { ...payloadBefore, ...data },
    outboundQueueId,
    changeSetId: args.changeSetId ?? null,
  })

  await enqueueBullMQJob(outboundQueueId, 'AD_PORTFOLIO_UPDATE')
  return { ok: true, outboundQueueId, bidHistoryIds: [], actionLogId, error: null }
}

// AD.4 hook — operator cancel within grace window. Flips
// syncStatus=CANCELLED so the BullMQ worker sees it and skips.
export async function cancelPendingMutation(outboundQueueId: string): Promise<{
  ok: boolean
  error: string | null
  /** CM-28 — the fields Nexus put back to the value the cancelled write replaced, and the ones it left (newer value). */
  restored?: string[]
  kept?: string[]
}> {
  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: outboundQueueId },
    select: { id: true, syncStatus: true, holdUntil: true, payload: true },
  })
  if (!row) return { ok: false, error: 'not_found' }
  if (row.syncStatus !== 'PENDING') return { ok: false, error: `not_pending:${row.syncStatus}` }
  if (row.holdUntil && row.holdUntil <= new Date()) {
    return { ok: false, error: 'grace_expired' }
  }
  // Compare-and-set: only a row still PENDING (and still inside its window) is cancelled, so a row the worker took
  // meanwhile is never marked cancelled (and put back) while it is being sent. W3-2 — the worker claims with the same
  // compare-and-set (PENDING → IN_PROGRESS, ads-sync.worker.ts), so exactly one of the two wins.
  const cancelled = await prisma.outboundSyncQueue.updateMany({
    where: { id: outboundQueueId, syncStatus: 'PENDING', OR: [{ holdUntil: null }, { holdUntil: { gt: new Date() } }] },
    data: { syncStatus: 'CANCELLED' },
  })
  if (cancelled.count === 0) return { ok: false, error: 'not_pending:CHANGED' }
  // CM-28 — the update helpers write Nexus's own copy when they queue a write, so a cancelled write left Nexus showing
  // a value Amazon never got (and nothing converges an ad group's default bid or a campaign's portfolio). Put each
  // field back the way a gate refusal is put back: only where Nexus still holds the cancelled value, so a newer
  // change is never overwritten. Same order as the worker: put back, then settle. Never fails the cancel.
  let put: { restored: string[]; kept: string[] } = { restored: [], kept: [] }
  try {
    const payload = (await dispatchPayloadFromMutations(outboundQueueId).catch(() => null))
      ?? (row.payload as unknown as DispatchPayload | null)
    if (payload?.entityType && payload.entityId) put = await putBackRefusedWrite(payload)
  } catch (err) {
    logger.warn('[ads-mutation] could not put back a cancelled write', {
      outboundQueueId, error: err instanceof Error ? err.message : String(err),
    })
  }
  // AX-ZD.1 — release the typed rows too. A cancelled intent that stayed
  // PENDING would keep suppressing drift on its fields for the full trust
  // window, which is exactly the bug this model exists to remove.
  await settleAdMutations(outboundQueueId, 'CANCELLED')
  // W4-12 — and its action log: left PENDING, the change feed and undo read a cancelled write as one that landed.
  await prisma.advertisingActionLog
    .updateMany({ where: { outboundQueueId, amazonResponseStatus: 'PENDING' }, data: { amazonResponseStatus: 'CANCELLED' } })
    .catch(() => { /* audit-update failure must not fail the cancel */ })
  return { ok: true, error: null, restored: put.restored, kept: put.kept }
}
