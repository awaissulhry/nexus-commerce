/**
 * AD.4 — Single chokepoint for Amazon Ads API write authorization.
 *
 * Live writes require ALL of:
 *   1. NEXUS_AMAZON_ADS_MODE=live (deploy-wide env flag)
 *   2. AmazonAdsConnection.mode === 'production' AND writesEnabledAt != null
 *   3. payload value ≤ NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS (default 50000 = €500)
 *
 * Failure flips the mutation to dry-run mode (worker logs the deny +
 * marks the OutboundSyncQueue row SKIPPED with a `[ADS-WRITE-GATE-DENY]`
 * tag in errorMessage). Defense-in-depth alongside:
 *   - rule.dryRun (rule-level)
 *   - rule.maxValueCentsEur (per-execution)
 *   - rule.maxDailyAdSpendCentsEur (per-day SUM)
 *
 * Called by ads-sync.worker.ts before every live API call.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { adsMode } from './ads-api-client.js'
import { dimensionsForWrite, pinDenial, type AuthorityDimension } from './ads-authority-pins.js'

export type GateDeniedAt =
  | 'env'
  | 'connection'
  | 'connection_writes'
  | 'value_cap'
  | 'campaign_allowlist'
  | 'daily_cap'
  // ADX A1 — bounds live on the entity (Campaign.minBidCents/maxBidCents) rather
  // than inside a rule, so they bind every engine automatically.
  | 'entity_bounds'
  // ADX A1 — an operator-protected term may not be negated by any automation.
  | 'keyword_protected'
  // ACR.0.7 — the account is halted (anomaly breaker or operator) or autonomy is OFF.
  | 'automation_halted'
  // ACR.1.2b — the campaign's placement/bids/budget is pinned: held by hand.
  | 'authority_pin'
  // AUTO.A7 — a per-SCOPE spend ceiling (AdSpendCeiling: campaign ⊂ line ⊂ portfolio ⊂ market)
  // refuses a budget increase that would take today's authorised increases past its cap.
  | 'spend_ceiling'
  // AUTO.P0 guard ④ — cumulative daily MOVEMENT on one campaign's budget, across every writer.
  // The only budget guard keyed to the ENTITY rather than to a rule, which is why it is the one
  // that survives the pacer, a budget schedule, and a rule nobody has written yet.
  | 'budget_day_move'

export type GateDecision =
  | { allowed: true; mode: 'sandbox' }
  | { allowed: true; mode: 'live'; profileId: string }
  | { allowed: false; reason: string; deniedAt: GateDeniedAt }

export interface GateContext {
  marketplace: string | null
  payloadValueCents: number
  // Apex A.2a — when provided, the gate enforces the per-campaign live-write
  // allowlist (default-deny) + the maxWritesPerDay guardrail. The worker
  // resolves this from the mutated entity; campaign *creation* flows omit it
  // (there's no campaign to allowlist yet). `null` means the worker tried to
  // resolve a campaign for an existing-entity mutation and failed → deny in
  // live mode, so an unattributable write can never slip through.
  campaignId?: string | null

  // ── ADX A1 ────────────────────────────────────────────────────────────────
  /** The single field being changed ('bid' | 'defaultBid' | 'dailyBudget' | …). */
  field?: string | null

  // ── ACR.1.2b ──────────────────────────────────────────────────────────────
  /**
   * EVERY field this write changes. `field` above stays what it always was — the one
   * bounded bid field the A1 bounds judge — and this is the whole list.
   *
   * The distinction matters: a payload can carry several changes, and the worker has
   * always surfaced exactly one of them to the gate. An authority pin checked against
   * that single field would hold on the single-field payloads a test naturally writes
   * and silently let a multi-field payload through. Falls back to `field` when a caller
   * supplies only the old shape, so nothing regresses.
   */
  fields?: Array<string | null | undefined> | null
  /**
   * The dimension this write belongs to, when the caller knows it and no field name
   * carries it. `updatePlacementBidding` pushes multipliers inline rather than through
   * the queue, so it has no `fieldChanges` to derive from and names its dimension here.
   */
  dimension?: AuthorityDimension | null
  /** Intended new value in cents, when the field is numeric. */
  intendedValueCents?: number | null
  /** The keyword text, when this write negates a term. */
  keywordText?: string | null
  /** True when the write adds a negative keyword / suppresses a term. */
  isNegation?: boolean
  /**
   * ADX G1 — a deliberate bid suppression or restore (`force` in the mutation layer),
   * not an optimisation. Exempts the write from the MINIMUM bid bound only.
   *
   * suppressCampaignBids drives bids to ~2¢, which is how the retail guard, budget
   * stop-over-spend and Min-bid dayparting windows all suppress delivery under the
   * no-pause rule. A1 added Campaign.minBidCents; without this exemption the first
   * operator to set a min above 2¢ would have silently disabled every one of them —
   * a floor blocking a safety action is worse than no floor.
   *
   * The MAXIMUM still binds: a "suppression" that raises a bid is not a suppression.
   */
  isSuppression?: boolean
}

/** Fields whose value is a bid in cents, and therefore subject to entity bid bounds. */
const BID_FIELDS = new Set(['bid', 'defaultBid'])

/** Normalise a keyword for protection matching: lowercase, collapse whitespace. */
export function normaliseTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function maxWriteValueCents(): number {
  const v = Number(process.env.NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS)
  if (Number.isFinite(v) && v > 0) return v
  return 50_000 // €500 default
}

/** UTC calendar day as 'YYYY-MM-DD' — the bucket key for the daily-write cap. */
export function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Resolve whether a queued mutation may hit Amazon's live API.
 *
 * Sandbox short-circuits with `allowed: true, mode: 'sandbox'` — the
 * worker still calls ads-api-client which itself short-circuits, so
 * the DB-side writes complete but no external HTTP fires.
 */
export async function checkAdsWriteGate(ctx: GateContext): Promise<GateDecision> {
  // Sandbox path — env says we're not in live mode at all.
  if (adsMode() === 'sandbox') {
    return { allowed: true, mode: 'sandbox' }
  }

  /**
   * ACR.0.7 — the halt binds HERE, at the one door every write passes.
   *
   * It used to bind in each engine, and only two of them ever implemented it:
   * `ads-auto-bid` and `ads-auto-harvest`. Measured on prod 2026-08-05 while the
   * breaker was tripped ("264 actions in the last hour, limit 250"), the very next
   * `ad-rank-defend` tick still reported `evaluated=33 applied=21`, budget
   * enforcement still ran `(LIVE)`, and the drain kept delivering. A stop button
   * that four engines have never heard of is not a stop button.
   *
   * Same reasoning that put bid bounds on the entity rather than in a rule: a
   * chokepoint cannot be forgotten by an engine written next year.
   *
   * SUPPRESSION IS EXEMPT, following the ADX G1 precedent exactly. Suppression
   * drives bids to ~2¢ and is how the retail guard, budget stop-over-spend and
   * Min-bid windows stop delivery under the no-pause rule. Blocking it during a
   * halt would freeze bids HIGH at the moment we have most reason to want them
   * low — the halt would increase spend. A halt stops the machine from reaching
   * for more; it must never block it from letting go.
   */
  const { getAutomationState } = await import('./ads-automation-state.service.js')
  const state = await getAutomationState()
  if (state.effectivelyStopped && !ctx.isSuppression) {
    const why = state.haltReason
      ? `halted: ${state.haltReason}`
      : state.autonomy === 'OFF' ? 'account autonomy is OFF' : 'automation is stopped'
    return {
      allowed: false,
      reason: `ads automation is stopped (${why}) — resume in the Control Room to allow writes`,
      deniedAt: 'automation_halted',
    }
  }

  // Env says live, but operator must also enable per-connection writes.
  if (!ctx.marketplace) {
    return {
      allowed: false,
      reason: 'no marketplace on payload — cannot resolve AmazonAdsConnection',
      deniedAt: 'connection',
    }
  }
  // CX.3b — through the one resolver. It reads the connection core's ConnectionScope
  // and falls back to this exact row query, so the gate's decision is unchanged while
  // the source moves. `mode` and `writesEnabledAt` are the OPERATOR's permission to
  // spend, so the routes that set them mirror onto the scope as they write — this gate
  // must never read a snapshot that nothing keeps current.
  const { adsProfileFor } = await import('./ads-profile-resolver.js')
  const conn = await adsProfileFor(ctx.marketplace)
  if (!conn) {
    return {
      allowed: false,
      reason: `no active Amazon Ads profile for marketplace=${ctx.marketplace}`,
      deniedAt: 'connection',
    }
  }
  if (conn.mode !== 'production') {
    return {
      allowed: false,
      reason: `Amazon Ads connection mode=${conn.mode} (needs production)`,
      deniedAt: 'connection',
    }
  }
  if (conn.writesEnabledAt == null) {
    return {
      allowed: false,
      reason: 'writes are not enabled for this Amazon Ads profile — the operator must enable them explicitly',
      deniedAt: 'connection_writes',
    }
  }

  // Apex A.2a — per-campaign allowlist (default-deny). When the worker passes a
  // campaignId (every existing-entity bid/state mutation), the campaign must be
  // explicitly on the allowlist. `undefined` = a creation flow with no campaign
  // to gate → skip this check. `null` = resolution failed → deny.
  //
  // ADX G5 — this is now a real containment layer rather than a claim. Every one of
  // the account's 216 campaigns was allowlisted, so "default-deny" denied nothing.
  // Measured over 90 days, 134 of them (133 PAUSED, 1 ARCHIVED) had received zero
  // writes and held no enabled schedule; those are now denied, leaving 82 — the
  // ENABLED set, which still covers all 33 scheduled campaigns.
  //
  // FOOTGUN: re-enabling a PAUSED campaign does NOT re-allowlist it. The write will
  // be denied here with this exact reason, which is visible and recoverable — flip it
  // back via PATCH /advertising/campaigns/:id/live-writes. That is the intended
  // trade: an explicit deny an operator can see beats a silent write they cannot.
  if (ctx.campaignId !== undefined) {
    if (!ctx.campaignId) {
      return {
        allowed: false,
        reason: 'could not resolve a campaign for this live mutation — refusing unattributable write',
        deniedAt: 'campaign_allowlist',
      }
    }
    const campaign = await prisma.campaign.findUnique({
      where: { id: ctx.campaignId },
      select: {
        liveBidWritesEnabled: true, dynamicBidding: true, liveBidWritesToday: true, liveBidWritesDay: true,
        minBidCents: true, maxBidCents: true,
        // ACR.1.2b — same read, so a pin costs no extra query.
        pinPlacement: true, pinBids: true, pinBudget: true, pinNote: true,
        // AUTO.A7 — same read again: the spend-ceiling check needs the current budget (for the
        // increase delta) and the campaign's containing scopes.
        dailyBudget: true, portfolioId: true, marketplace: true,
        // BUD.2 — the budget bounds, enforced below beside the bid bounds.
        minBudgetCents: true, maxBudgetCents: true,
      },
    })
    if (!campaign?.liveBidWritesEnabled) {
      return {
        allowed: false,
        reason: `campaign ${ctx.campaignId} is not on the live-write allowlist (Campaign.liveBidWritesEnabled=false)`,
        deniedAt: 'campaign_allowlist',
      }
    }

    /**
     * ACR.1.2b — per-dimension authority pins, checked BEFORE the bounds.
     *
     * Order is deliberate, following the halt-before-allowlist precedent: a pin is the
     * broader refusal ("automation may not write this dimension at all") and a bound the
     * narrower one ("not that far"). Report the bound first and an operator clearing it
     * would be told the wrong thing about why their campaign is quiet.
     *
     * This binds EVERY write through the gate, including an operator's own PATCH from the
     * Ad Manager — deliberately. The gate cannot reliably tell a person from an engine:
     * `actor` is free text, and a third of the advertising audit log carried a NULL actor
     * as recently as 2026-08-04 (see ads-create.service.ts). A pin that trusted that
     * string would be honoured exactly as often as the string happened to be right, which
     * is the decorative-control defect this phase exists to remove. Unpinning is one click
     * and is itself audited.
     */
    const dimensions = dimensionsForWrite({
      fields: ctx.fields?.length ? ctx.fields : [ctx.field],
      dimension: ctx.dimension ?? null,
    })
    const pinned = pinDenial(campaign, {
      dimensions,
      isSuppression: ctx.isSuppression,
      campaignId: ctx.campaignId,
    })
    if (pinned) {
      return { allowed: false, reason: pinned.reason, deniedAt: 'authority_pin' }
    }

    // ADX A1 — entity bid bounds. Deliberately a DENY rather than a silent clamp:
    // clamping would rewrite an engine's intent without telling anyone, and the whole
    // point of this phase is that the operator can see why something did not happen.
    // A denial leaves the bid where it was, which is the safe direction for both a
    // ceiling (refuse the raise) and a floor (refuse the cut).
    //
    // BID.S5 — the bounds resolve at FOUR grains now, most specific first PER SIDE:
    // the Campaign column ?? LINE ?? PORTFOLIO ?? MARKET (`AdBidPolicy`). The campaign
    // column stays the strongest word, so every pre-existing row behaves exactly as
    // before; the policy walk runs only when a side is null on the campaign AND any
    // policy rows exist. The refusal names its source — a bound whose origin is a
    // mystery is a bound the operator clears in the wrong place.
    if (ctx.field && BID_FIELDS.has(ctx.field) && Number.isFinite(ctx.intendedValueCents ?? NaN)) {
      const v = ctx.intendedValueCents as number
      let effMax: { cents: number; source: string } | null =
        campaign.maxBidCents != null ? { cents: campaign.maxBidCents, source: `Campaign.maxBidCents on ${ctx.campaignId}` } : null
      let effMin: { cents: number; source: string } | null =
        campaign.minBidCents != null ? { cents: campaign.minBidCents, source: `Campaign.minBidCents on ${ctx.campaignId}` } : null
      if (effMax == null || effMin == null) {
        const policy = await resolveBidPolicy(ctx.campaignId, campaign.portfolioId, campaign.marketplace)
        if (effMax == null && policy.max) effMax = { cents: policy.max.cents, source: policy.max.label }
        if (effMin == null && policy.min) effMin = { cents: policy.min.cents, source: policy.min.label }
      }
      if (effMax != null && v > effMax.cents) {
        return {
          allowed: false,
          reason: `bid ${v}¢ exceeds the ${effMax.cents}¢ ceiling (${effMax.source})`,
          deniedAt: 'entity_bounds',
        }
      }
      if (effMin != null && v < effMin.cents && !ctx.isSuppression) {
        return {
          allowed: false,
          reason: `bid ${v}¢ is below the ${effMin.cents}¢ floor (${effMin.source})`,
          deniedAt: 'entity_bounds',
        }
      }
    }
    /**
     * AUTO.A7 — per-SCOPE spend ceilings, at the one door every write passes.
     *
     * The operator's standing ask, verbatim: a cap "for portfolios or for certain campaigns or
     * for certain markets", and at the cap "refuse further writes and tell me". `AdSpendCeiling`
     * (KT.6's model — four grains, campaign ⊂ line ⊂ portfolio ⊂ market) held the values; nothing
     * enforced them outside KT's own apply path. This binds BUDGET INCREASES: today's authorised
     * increases (our own ledger — Amazon's spend is 2 days old at best, so the only number that
     * is correct at the moment of refusal is the one we keep) plus this delta, against every
     * enabled ceiling whose scope contains the campaign. The TIGHTEST containing scope refuses
     * first and the refusal names it. A budget CUT never trips a spend ceiling — that asymmetry
     * is deliberate here and is exactly why BUD.2's baseline exists for the ratchet.
     * Inert until an operator creates a ceiling row (0 rows exist as this ships).
     */
    /**
     * BUD.2 — entity BUDGET bounds, the bid bounds' twin, and the brake `liveBidWritesEnabled`
     * never was (BUD.1 §1.2: the local cut lands before the gate runs, so the allowlist makes a
     * campaign DIVERGE, not survive). A DENY, never a clamp, for the same reason as the bid
     * bounds: a clamp rewrites an engine's intent without telling anyone. The floor is the
     * direct counter to the ratchet's end state — 58 campaigns pinned at Amazon's €1 floor
     * because nothing above €1 existed to refuse the cut.
     */
    if (ctx.field === 'dailyBudget' && Number.isFinite(ctx.intendedValueCents ?? NaN)) {
      const v = ctx.intendedValueCents as number
      if (campaign.maxBudgetCents != null && v > campaign.maxBudgetCents) {
        return {
          allowed: false,
          reason: `budget €${(v / 100).toFixed(2)} exceeds Campaign.maxBudgetCents=€${(campaign.maxBudgetCents / 100).toFixed(2)} on ${ctx.campaignId}`,
          deniedAt: 'entity_bounds',
        }
      }
      if (campaign.minBudgetCents != null && v < campaign.minBudgetCents) {
        return {
          allowed: false,
          reason: `budget €${(v / 100).toFixed(2)} is below Campaign.minBudgetCents=€${(campaign.minBudgetCents / 100).toFixed(2)} on ${ctx.campaignId} — the floor exists precisely so a cut-only rule cannot walk this to €1`,
          deniedAt: 'entity_bounds',
        }
      }
    }

    if (ctx.field === 'dailyBudget' && Number.isFinite(ctx.intendedValueCents ?? NaN)) {
      const denial = await spendCeilingDenial({
        campaignId: ctx.campaignId,
        currentBudgetCents: Math.round(Number(campaign.dailyBudget ?? 0) * 100),
        intendedCents: ctx.intendedValueCents as number,
        portfolioId: campaign.portfolioId,
        marketplace: campaign.marketplace,
      })
      if (denial) return denial
    }

    /**
     * AUTO.P0 guard ④ — the daily MOVEMENT bound. The last of the four §2.4 guards, and the only
     * one keyed to the ENTITY rather than to a rule.
     *
     * Every other budget brake bounds one actor: `maxExecutionsPerDay` and `maxWritesPerDay` bound
     * a rule's rate, `maxDailyAdSpendCentsEur` bounds a rule's spend, a spend ceiling bounds a
     * scope's INCREASES. None of them bounds what actually happened to `GALE EXACT IT`, which was
     * €4.42 → €1.00 in 2¾ hours with TWO writers taking turns — the pacer raising and a rule
     * cutting it back within the same minute, 41% of the audit chain broken by the collision.
     * A per-rule brake cannot see that; a per-entity one does not need to.
     *
     * CAP §6.5 reached the same conclusion independently: "a cap bounds the RATE of a ratchet, not
     * its DESTINATION… the thing actually missing is a bound on cumulative change." BUD.2 shipped
     * `minBudgetCents`, which bounds the destination — but it is set on **0 of 220** campaigns and
     * is a judgement no default can make. This needs no per-campaign judgement to start working.
     */
    if (ctx.field === 'dailyBudget' && Number.isFinite(ctx.intendedValueCents ?? NaN)) {
      const denial = await budgetDayMoveDenial({
        campaignId: ctx.campaignId,
        currentBudgetCents: Math.round(Number(campaign.dailyBudget ?? 0) * 100),
        intendedCents: ctx.intendedValueCents as number,
      })
      if (denial) return denial
    }

    // WC — the maxWritesPerDay DAILY cap is intentionally DISABLED (operator decision:
    // unlimited bid writes). It counted +1 per ENTITY, so a per-hour rank schedule
    // (~12 entities × ~12–24 flips/day) blew through a small cap by mid-morning and then
    // silently dropped the rest of the day's pushes to Amazon (local ≠ Amazon split-brain).
    // Frequency is no longer capped. Per-WRITE safety still applies (the value + change
    // clamps below, plus cpcCeiling) so no single write can set a wild bid, and the Ads
    // client's 429 backoff (ads-api-client.ts) paces bursts against Amazon's rate limits.
    // liveBidWritesToday is still recorded (see recordWrite) for observability only.
  }

  // ADX A1 — keyword protection. A whitelisted term may not be negated by anything.
  // Checked here rather than in the harvest service because the harvest service is
  // not the only thing that can negate a term, and a protection that only some
  // callers honour is not a protection.
  if (ctx.isNegation && ctx.keywordText) {
    const term = normaliseTerm(ctx.keywordText)
    if (term) {
      const protections = await prisma.adKeywordProtection.findMany({
        where: {
          mode: 'WHITELIST',
          AND: [
            { OR: [{ marketplace: null }, { marketplace: ctx.marketplace }] },
            { OR: [{ campaignId: null }, { campaignId: ctx.campaignId ?? undefined }] },
          ],
        },
        select: { term: true, isPrefix: true, matchType: true, reason: true },
      })
      // ADX G4 — CONTAINS is the mode brand protection actually needs. Amazon returns
      // search terms like "giacca moto xavia", which neither equals "xavia" nor starts
      // with it, so a prefix-only whitelist would have looked like it protected the brand
      // while missing every term where the brand is not the first word.
      // matchType null falls back to isPrefix so pre-existing rows are unchanged.
      const hit = protections.find((p) => {
        const t = normaliseTerm(p.term)
        const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
        if (mode === 'CONTAINS') return term.includes(t)
        if (mode === 'PREFIX') return term.startsWith(t)
        return term === t
      })
      if (hit) {
        return {
          allowed: false,
          reason: `"${term}" is whitelisted against negation${hit.reason ? ` (${hit.reason})` : ''}`,
          deniedAt: 'keyword_protected',
        }
      }
    }
  }

  // Value cap: blast-radius limit per write. Composite actions are
  // chunked into individual OutboundSyncQueue rows so each pass
  // through the gate sees only its slice.
  const cap = maxWriteValueCents()
  if (ctx.payloadValueCents > cap) {
    return {
      allowed: false,
      reason: `payload value ${ctx.payloadValueCents}¢ exceeds cap ${cap}¢ (NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS)`,
      deniedAt: 'value_cap',
    }
  }

  return { allowed: true, mode: 'live', profileId: conn.profileId }
}

/**
 * BID.S5 — resolve the policy half of the bid bounds, most specific first per side:
 * LINE ?? PORTFOLIO ?? MARKET. Cheapest-first like the spend ceilings: one indexed read for the
 * candidate rows; the LINE parents are resolved only if any LINE rows matched at all. Each side
 * resolves independently — a line ceiling and a market floor compose.
 */
async function resolveBidPolicy(
  campaignId: string,
  portfolioId: string | null,
  marketplace: string | null,
): Promise<{ min: { cents: number; label: string } | null; max: { cents: number; label: string } | null }> {
  const rows = await prisma.adBidPolicy.findMany({
    where: {
      enabled: true,
      OR: [
        ...(portfolioId ? [{ grain: 'PORTFOLIO', scopeId: portfolioId }] : []),
        ...(marketplace ? [{ grain: 'MARKET', scopeId: marketplace }] : []),
        { grain: 'LINE' },
      ],
    },
    select: { grain: true, scopeId: true, label: true, minBidCents: true, maxBidCents: true },
  })
  if (rows.length === 0) return { min: null, max: null }
  let candidates = rows
  const lineRows = rows.filter((r) => r.grain === 'LINE')
  if (lineRows.length > 0) {
    const ads = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId } },
      select: { product: { select: { parentId: true } } },
    })
    const parents = new Set(ads.map((a) => a.product?.parentId).filter((x): x is string => !!x))
    candidates = rows.filter((r) => r.grain !== 'LINE' || parents.has(r.scopeId))
  }
  const ORDER: Record<string, number> = { LINE: 0, PORTFOLIO: 1, MARKET: 2 }
  candidates.sort((a, b) => (ORDER[a.grain] ?? 9) - (ORDER[b.grain] ?? 9))
  const min = candidates.find((r) => r.minBidCents != null)
  const max = candidates.find((r) => r.maxBidCents != null)
  return {
    min: min ? { cents: min.minBidCents as number, label: min.label } : null,
    max: max ? { cents: max.maxBidCents as number, label: max.label } : null,
  }
}

/**
 * AUTO.A7 — the spend-ceiling denial, extracted so the check reads as one sentence above.
 *
 * Order of work is cheapest-first: the ceiling rows are fetched before any campaign-set or
 * ledger query, so an account with no ceilings (today's account) pays one indexed read and
 * nothing else. LINE ceilings are resolved only if any exist at all.
 */
async function spendCeilingDenial(args: {
  campaignId: string
  currentBudgetCents: number
  intendedCents: number
  portfolioId: string | null
  marketplace: string | null
}): Promise<GateDecision | null> {
  const deltaCents = args.intendedCents - args.currentBudgetCents
  if (deltaCents <= 0) return null

  const direct = await prisma.adSpendCeiling.findMany({
    where: {
      enabled: true,
      dailyCapCents: { not: null },
      OR: [
        { grain: 'CAMPAIGN', scopeId: args.campaignId },
        ...(args.portfolioId ? [{ grain: 'PORTFOLIO', scopeId: args.portfolioId }] : []),
        ...(args.marketplace ? [{ grain: 'MARKET', scopeId: args.marketplace }] : []),
        { grain: 'LINE' },
      ],
    },
    select: { grain: true, scopeId: true, label: true, dailyCapCents: true },
  })
  if (direct.length === 0) return null

  // LINE rows matched broadly above; keep only the lines this campaign actually advertises.
  let ceilings = direct
  const lineRows = direct.filter((c) => c.grain === 'LINE')
  if (lineRows.length > 0) {
    const ads = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: args.campaignId } },
      select: { product: { select: { parentId: true } } },
    })
    const parents = new Set(ads.map((a) => a.product?.parentId).filter((x): x is string => !!x))
    ceilings = direct.filter((c) => c.grain !== 'LINE' || parents.has(c.scopeId))
    if (ceilings.length === 0) return null
  }

  // Tightest containing scope refuses first — an operator clearing the wrong ceiling would be
  // told the wrong thing about why the account is quiet.
  const GRAIN_ORDER: Record<string, number> = { CAMPAIGN: 0, LINE: 1, PORTFOLIO: 2, MARKET: 3 }
  ceilings.sort((a, b) => (GRAIN_ORDER[a.grain] ?? 9) - (GRAIN_ORDER[b.grain] ?? 9))

  const midnightUtc = new Date(`${utcDayKey()}T00:00:00.000Z`)
  for (const c of ceilings) {
    // The campaigns this ceiling contains.
    let campaignIds: string[]
    if (c.grain === 'CAMPAIGN') campaignIds = [args.campaignId]
    else if (c.grain === 'PORTFOLIO') campaignIds = (await prisma.campaign.findMany({ where: { portfolioId: c.scopeId }, select: { id: true } })).map((x) => x.id)
    else if (c.grain === 'MARKET') campaignIds = (await prisma.campaign.findMany({ where: { marketplace: c.scopeId }, select: { id: true } })).map((x) => x.id)
    else campaignIds = (await prisma.adProductAd.findMany({ where: { product: { parentId: c.scopeId } }, select: { adGroup: { select: { campaignId: true } } } })).map((x) => x.adGroup.campaignId)

    // Today's AUTHORISED budget increases inside the scope — our own ledger, in EUROS in the
    // payloads (the one ads money field that is not cents; assuming cents inflates 100×).
    const rows = await prisma.advertisingActionLog.findMany({
      where: {
        actionType: 'AD_BUDGET_UPDATE',
        entityType: 'CAMPAIGN',
        entityId: { in: campaignIds },
        createdAt: { gte: midnightUtc },
        rolledBackAt: null,
      },
      select: { payloadBefore: true, payloadAfter: true },
    })
    let usedCents = 0
    for (const r of rows) {
      const before = Number((r.payloadBefore as { dailyBudget?: unknown })?.dailyBudget ?? NaN)
      const after = Number((r.payloadAfter as { dailyBudget?: unknown })?.dailyBudget ?? NaN)
      if (Number.isFinite(before) && Number.isFinite(after) && after > before) usedCents += Math.round((after - before) * 100)
    }
    const cap = c.dailyCapCents as number
    if (usedCents + deltaCents > cap) {
      return {
        allowed: false,
        reason: `raising this budget by €${(deltaCents / 100).toFixed(2)} would take ${c.label} past its €${(cap / 100).toFixed(2)}/day ceiling — €${(usedCents / 100).toFixed(2)} of increases already authorised today (our ledger; Amazon's own spend lags ~2 days)`,
        deniedAt: 'spend_ceiling',
      }
    }
  }
  return null
}

/**
 * AUTO.P0 guard ④ — how far one campaign's daily budget may move in one UTC day, across every
 * writer combined. Defaults from the operator's decision, 2026-08-16: −30% down, +50% up.
 *
 * ── Why the down and up bounds are asymmetric ────────────────────────────────────────────────
 * A cut compounds toward zero and a raise does not. Measured: 1,880 of 2,386 budget writes in 60
 * days were decreases, and 58 of 86 live campaigns now sit at Amazon's €1 floor. At −30%/day a
 * €100 budget takes ~13 days to reach €1 instead of the one day it actually took — and each of
 * those days is a chance for a person to notice, which is the entire point.
 *
 * ── 🔴 The absolute rise allowance, and why it is not the operator's number ───────────────────
 * A pure +50% bound would TRAP every campaign the ratchet already damaged. 58 campaigns sit at
 * €1.00; restoring one to €10 is +900%, so a percentage-only ceiling would refuse the repair and
 * make this guard an accomplice to the damage it exists to prevent. Percentages are meaningless
 * at the bottom of their own range. So the rise allowance is the GREATER of the percentage and a
 * flat `NEXUS_ADS_BUDGET_DAY_RISE_ABS_CENTS` (default €10): €1 → up to €11 in a day, €100 → up
 * to €150. The operator's +50% binds everywhere it is the larger number, which is everywhere it
 * was meant to bind. Flagged rather than folded in silently.
 *
 * The DOWN side needs no such escape: −30% of €1.00 is €0.70, already below Amazon's own €1
 * floor, so the guard is simply inert for a campaign that cannot fall further.
 *
 * ── Where the day's opening value comes from ─────────────────────────────────────────────────
 * The earliest `payloadBefore.dailyBudget` logged for this campaign today — A7's ledger, read the
 * same way, with the same unit. ⚠ `payloadBefore/payloadAfter.dailyBudget` is in EUROS, not cents,
 * unlike every neighbouring ads money field; assuming cents inflates this 100× and produced a
 * spectacular false reading once already (BUD §2.5). No rows today ⇒ opening is the current value,
 * so the first write of a day is always allowed and the bound applies from there.
 *
 * Reading the EARLIEST row's `before` is deliberately robust to the 41%-broken audit chain: a
 * mid-sequence break moves intermediate values, not the first row's opening snapshot.
 */
const pctEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 && v < 100 ? v : fallback
}

export async function budgetDayMoveDenial(args: {
  campaignId: string
  currentBudgetCents: number
  intendedCents: number
}): Promise<GateDecision | null> {
  const dropPct = pctEnv('NEXUS_ADS_BUDGET_DAY_DROP_PCT', 30)
  const risePct = pctEnv('NEXUS_ADS_BUDGET_DAY_RISE_PCT', 50)
  const riseAbs = Number(process.env.NEXUS_ADS_BUDGET_DAY_RISE_ABS_CENTS)
  const riseAbsCents = Number.isFinite(riseAbs) && riseAbs >= 0 ? riseAbs : 1_000 // €10

  const midnightUtc = new Date(`${utcDayKey()}T00:00:00.000Z`)
  const first = await prisma.advertisingActionLog.findFirst({
    where: {
      actionType: 'AD_BUDGET_UPDATE',
      entityType: 'CAMPAIGN',
      entityId: args.campaignId,
      createdAt: { gte: midnightUtc },
      rolledBackAt: null,
    },
    orderBy: { createdAt: 'asc' },
    select: { payloadBefore: true },
  })
  const loggedOpening = Number((first?.payloadBefore as { dailyBudget?: unknown })?.dailyBudget ?? NaN)
  const openingCents = Number.isFinite(loggedOpening)
    ? Math.round(loggedOpening * 100) // EUROS in the payload — see the note above
    : args.currentBudgetCents
  if (openingCents <= 0) return null // nothing to measure a move against

  const floorCents = Math.round(openingCents * (1 - dropPct / 100))
  const ceilCents = Math.max(Math.round(openingCents * (1 + risePct / 100)), openingCents + riseAbsCents)
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`

  if (args.intendedCents < floorCents) {
    const movedPct = Math.round((1 - args.intendedCents / openingCents) * 100)
    return {
      allowed: false,
      reason: `this would move today's budget on ${args.campaignId} from ${eur(openingCents)} to ${eur(args.intendedCents)} — a ${movedPct}% drop, past the ${dropPct}%/day limit on total movement. Every writer shares this budget: the day opened at ${eur(openingCents)} and no combination of rules, schedules or the pacer may take it below ${eur(floorCents)} today. It resets at 00:00 UTC.`,
      deniedAt: 'budget_day_move',
    }
  }
  if (args.intendedCents > ceilCents) {
    const movedPct = Math.round((args.intendedCents / openingCents - 1) * 100)
    return {
      allowed: false,
      reason: `this would move today's budget on ${args.campaignId} from ${eur(openingCents)} to ${eur(args.intendedCents)} — a ${movedPct}% rise, past the ${risePct}%/day limit on total movement (or ${eur(riseAbsCents)}, whichever is larger). The day opened at ${eur(openingCents)} and today's ceiling is ${eur(ceilCents)}. It resets at 00:00 UTC.`,
      deniedAt: 'budget_day_move',
    }
  }
  return null
}

/**
 * Convenience: log a deny decision in the structured format that
 * grep `[ADS-WRITE-GATE-DENY]` will pick up.
 *
 * AUTO.A7 / substrate S5 — and, from 2026-08-15, the DURABLE record. Written here so no caller
 * can forget it. The insert is fire-and-forget so a slow row can never delay the deny path, but
 * a failure is error-logged LOUDLY — a refusal record that silently fails to write is worse than
 * none, because every surface reading the table then reports zero. Surfaces must state that the
 * record starts 2026-08-15; earlier refusals exist only in the application log.
 */
export function logGateDeny(
  context: { queueId: string; marketplace: string | null; payloadValueCents: number; campaignId?: string | null; entityType?: string | null; entityId?: string | null },
  reason: string,
  deniedAt: GateDeniedAt,
): void {
  logger.warn('[ADS-WRITE-GATE-DENY]', {
    queueId: context.queueId,
    marketplace: context.marketplace,
    payloadValueCents: context.payloadValueCents,
    reason,
    deniedAt,
  })
  void prisma.adWriteRefusal
    .create({
      data: {
        deniedAt,
        reason,
        marketplace: context.marketplace,
        campaignId: context.campaignId ?? null,
        entityType: context.entityType ?? null,
        entityId: context.entityId ?? null,
        payloadValueCents: context.payloadValueCents,
        queueId: context.queueId,
      },
    })
    .catch((err) => {
      logger.error('[ADS-WRITE-GATE-DENY] refusal record FAILED to persist — refusal surfaces will under-count', {
        queueId: context.queueId,
        deniedAt,
        error: (err as Error).message,
      })
    })
  // BUD.7 / A7 — "at the cap: refuse further writes AND TELL ME." A ceiling or budget-bound
  // refusal reaches the operator through notifyAutomation; the 6h body-keyed dedupe means one
  // notice per distinct refusal, not one per queued write, and a failed notification never
  // breaks the deny path.
  // AUTO.P0 — guard ④ joins the same list. A movement refusal is the one an operator most needs
  // to hear about unprompted: unlike a bound they set themselves, this one has a default, so the
  // first time it fires may well be the first they learn it exists.
  if (deniedAt === 'spend_ceiling' || deniedAt === 'budget_day_move' || (deniedAt === 'entity_bounds' && reason.startsWith('budget'))) {
    void import('./ads-automation-notify.service.js')
      .then(({ notifyAutomation }) => notifyAutomation({
        type: 'ads_write_refusal',
        severity: 'warn',
        title: deniedAt === 'spend_ceiling' ? 'A spend ceiling refused a budget raise'
          : deniedAt === 'budget_day_move' ? "A budget moved as far as it may today"
          : 'A budget bound refused a write',
        body: reason,
        href: '/marketing/ads/rules-automation/automations?view=limits',
      }))
      .catch((err) => logger.warn('[ADS-WRITE-GATE-DENY] notify failed', { error: (err as Error).message }))
  }
}

/**
 * Bump AmazonAdsConnection.lastWriteAt when a write completes
 * successfully. Lets operators see "this connection is actively used"
 * in the AD.4 UI.
 */
export async function recordSuccessfulWrite(marketplace: string | null): Promise<void> {
  if (!marketplace) return
  const at = new Date()
  // Mirror onto the scope as well as the row: the row is still the system of record
  // for `lastWriteAt` until CX.3c, and the two must not drift while both are read.
  const { recordWriteForMarket } = await import('./ads-profile-resolver.js')
  void recordWriteForMarket(marketplace, at)
  await prisma.amazonAdsConnection
    .updateMany({
      where: { marketplace, isActive: true },
      data: { lastWriteAt: at },
    })
    .catch((err) => {
      logger.warn('[ads-write-gate] failed to update lastWriteAt', {
        marketplace,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * Apex A.2a — bump a campaign's rolling daily live-write counter after a
 * successful live bid write. Resets the count when the stored day rolls over.
 * Only called on the live path so sandbox/dry-run never consumes the cap.
 */
export async function recordCampaignLiveWrite(campaignId: string | null): Promise<void> {
  if (!campaignId) return
  const today = utcDayKey()
  try {
    const c = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { liveBidWritesDay: true },
    })
    if (c?.liveBidWritesDay === today) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { liveBidWritesToday: { increment: 1 } },
      })
    } else {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { liveBidWritesToday: 1, liveBidWritesDay: today },
      })
    }
  } catch (err) {
    logger.warn('[ads-write-gate] failed to bump campaign live-write counter', {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
