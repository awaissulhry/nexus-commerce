/**
 * KT.6 §4 — the per-scope spend ceiling, as pure resolution + refusal logic.
 *
 * 🔴 **This is a PROPOSAL with its measurement attached, not a shipped enforcement path.** The
 * resolution and the refusal messages are real and tested; nothing calls them on a write path yet,
 * because the storage decision below needs the operator's answer first.
 *
 * ── What exists today, measured on prod 2026-08-13 ────────────────────────────────────────────
 *
 * The ceiling exists **per RULE and never per SCOPE**. Of 51 `advertising` rules: 50 carry
 * `maxDailyAdSpendCentsEur`, 8 carry `maxValueCentsEur`, 8 carry `scopeMarketplace`, and **0 carry
 * `scopePortfolioId`, `scopeCampaignId` or `scopeProductId`.** So a cap on "IT" or "the GALE
 * portfolio" cannot be expressed at all, which is exactly the gap the operator named:
 * *"I want to be able to set a ceiling for portfolios or for certain campaigns or for certain
 * markets. At the cap: refuse the write and tell me."*
 *
 * `Campaign.maxHourlySpendCentsEur` does **not** exist — a probe for it threw, which is how that was
 * settled rather than assumed. What does exist is `Campaign.dailyBudget` (set on all 220, but that is
 * Amazon's own budget, not a nexus ceiling) and `Campaign.maxBidCents` (a per-write bid bound on
 * exactly the 82 writable campaigns, not a spend cap).
 *
 * ── 🔴 The measurement that shapes the design: "spent today" is not knowable ───────────────────
 *
 * The operator's example message quotes *"€38.90 spent"*. Measured, that number cannot be produced:
 *
 *   · `AmazonAdsDailyPerformance` — newest CAMPAIGN row is **2 days old** (2026-08-10 against a
 *     2026-08-12 clock). Today and yesterday hold **zero rows**.
 *   · There is no hourly ads-performance table at all.
 *   · `Campaign.spend` is an unlabelled 30-day window, already disqualified elsewhere in this
 *     programme.
 *
 * So a ceiling compared against *Amazon's* spend would compare today's request against a figure from
 * the day before yesterday, and would read as authoritative while being two days stale. Three
 * honest options, and the recommendation is the third:
 *
 *   A. **Amazon spend, labelled with its date.** Truthful but two days late; the cap could be blown
 *      through twice before the data showing it arrives.
 *   B. **Yesterday's total as a proxy.** Same lag, plus it implies a precision it does not have.
 *   C. **A nexus-side ledger of what this page has itself authorised today.** Zero lag, and it
 *      answers the question the ceiling is actually asked: *how much have I already committed?*
 *
 * C is recommended, with A shown alongside as context and clearly dated. It is also the only option
 * whose number is correct at the moment of the refusal, which is the only moment that matters.
 *
 * ── The three required properties ─────────────────────────────────────────────────────────────
 *
 * · **Refusal is specific**, naming the grain, the cap, what is committed and what was requested.
 * · **The most specific ceiling wins**, and the refusal says which one bound it.
 * · **A ceiling with no value is not a ceiling** — `dailyCapCents: null` resolves to "no ceiling
 *   set", never to an unlimited one, and `NO_CEILING` is a distinct verdict from `ALLOWED`.
 */

/** Narrowest first. Resolution walks this order and stops at the first ceiling that has a value. */
export const KT6_CEILING_GRAINS = ['CAMPAIGN', 'PORTFOLIO', 'LINE', 'MARKET'] as const
export type Kt6CeilingGrain = (typeof KT6_CEILING_GRAINS)[number]

export interface Kt6Ceiling {
  grain: Kt6CeilingGrain
  /** 'IT' for MARKET · productId for LINE · portfolioId for PORTFOLIO · campaignId for CAMPAIGN */
  scopeId: string
  /**
   * 🔴 null is NOT "unlimited". It is a row that exists without a value — an operator who opened the
   * control and set nothing. It resolves to NO_CEILING and says so.
   */
  dailyCapCents: number | null
  /** what to call it in the refusal: "the IT market", "the GALE portfolio" */
  label: string
  enabled: boolean
}

/** The scope a write belongs to. Any level may be absent. */
export interface Kt6Scope {
  campaignId?: string | null
  portfolioId?: string | null
  /** product line = Product.id, matching AutomationRule.scopeProductId's grain */
  lineId?: string | null
  marketplace?: string | null
}

export interface Kt6CeilingResolution {
  /** the ceiling that binds, or null when none of the four levels has a value */
  bound: Kt6Ceiling | null
  /** every level that had a row, narrowest first — so the UI can show what was considered */
  considered: Kt6Ceiling[]
  /** levels that had a row but no value; named because "no ceiling set" is a real state */
  presentButUnset: Kt6Ceiling[]
}

/**
 * Most specific wins. CAMPAIGN beats PORTFOLIO beats LINE beats MARKET.
 *
 * A row that exists with a null cap does NOT stop the walk — it is recorded in `presentButUnset` and
 * resolution continues outward. The alternative (treating an empty campaign ceiling as "unlimited
 * here") would let an operator disable a market cap by opening a campaign control and saving nothing,
 * which is the opposite of what setting a ceiling is for.
 */
export function resolveCeiling(scope: Kt6Scope, ceilings: Kt6Ceiling[]): Kt6CeilingResolution {
  const idFor = (g: Kt6CeilingGrain): string | null | undefined =>
    g === 'CAMPAIGN' ? scope.campaignId
      : g === 'PORTFOLIO' ? scope.portfolioId
        : g === 'LINE' ? scope.lineId
          : scope.marketplace

  const considered: Kt6Ceiling[] = []
  const presentButUnset: Kt6Ceiling[] = []
  let bound: Kt6Ceiling | null = null

  for (const grain of KT6_CEILING_GRAINS) {
    const id = idFor(grain)
    if (!id) continue
    const hit = ceilings.find((c) => c.grain === grain && c.scopeId === id && c.enabled)
    if (!hit) continue
    considered.push(hit)
    if (hit.dailyCapCents == null) { presentButUnset.push(hit); continue }
    if (!bound) bound = hit
  }
  return { bound, considered, presentButUnset }
}

export type Kt6CeilingVerdict = 'ALLOWED' | 'REFUSED' | 'NO_CEILING'

export interface Kt6CeilingCheck {
  verdict: Kt6CeilingVerdict
  /** the sentence shown to the operator. Never generic. */
  message: string
  bound: Kt6Ceiling | null
  committedCents: number
  requestedCents: number
  remainingCents: number | null
}

export interface Kt6CommittedContext {
  /** what this page has already authorised today, in cents. The zero-lag number. */
  committedCents: number
  /** Amazon's own figure and the day it covers, shown as dated context. Optional. */
  amazonSpendCents?: number | null
  amazonSpendDate?: string | null
}

/**
 * Compare a request against the ceiling that binds it.
 *
 * Refusal, not clamping — following the write gate's own precedent: *"clamping would rewrite an
 * engine's intent without telling anyone, and the whole point of this phase is that the operator can
 * see why something did not happen."*
 */
export function checkCeiling(
  resolution: Kt6CeilingResolution,
  ctx: Kt6CommittedContext,
  requestedCents: number,
): Kt6CeilingCheck {
  const { bound } = resolution
  const committed = ctx.committedCents
  const dated = ctx.amazonSpendCents != null && ctx.amazonSpendDate
    ? ` Amazon reports ${money(ctx.amazonSpendCents)} of spend for ${ctx.amazonSpendDate}, which is the most recent day it has published — it is not today's figure.`
    : ''

  if (!bound) {
    const unset = resolution.presentButUnset
    return {
      verdict: 'NO_CEILING',
      message: unset.length
        ? `No spend ceiling is set for this scope. ${unset.length === 1 ? `A ceiling exists for ${unset[0].label} but has no value, so it does not limit anything.` : `Ceilings exist for ${unset.map((u) => u.label).join(' and ')} but none has a value, so none limits anything.`} This write is not being checked against a cap.`
        : `No spend ceiling is set for this scope, so this write is not being checked against a cap.`,
      bound: null, committedCents: committed, requestedCents, remainingCents: null,
    }
  }

  const cap = bound.dailyCapCents as number
  const remaining = cap - committed

  if (requestedCents > remaining) {
    const why = remaining <= 0
      ? `${money(cap)} is already fully committed`
      : `only ${money(remaining)} of ${money(cap)} is left`
    return {
      verdict: 'REFUSED',
      message: `Refused — the ceiling for ${bound.label} is ${money(cap)} per day and ${why} (${money(committed)} committed today, ${money(requestedCents)} requested).${resolution.considered.length > 1 ? ` That is the ${bound.grain.toLowerCase()} ceiling, the most specific one set for this scope.` : ''}${dated}`,
      bound, committedCents: committed, requestedCents, remainingCents: remaining,
    }
  }

  return {
    verdict: 'ALLOWED',
    message: `Within the ${money(cap)}/day ceiling for ${bound.label} — ${money(committed)} committed today, ${money(requestedCents)} requested, ${money(remaining - requestedCents)} left afterwards.`,
    bound, committedCents: committed, requestedCents, remainingCents: remaining,
  }
}

function money(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`
}

/**
 * The daily commitment a bid change represents.
 *
 * 🔴 Deliberately the SUM OF BIDS, not a forecast. A bid is the most Amazon may charge for one click,
 * so N targets at B is N×B of exposure per click-round — an upper bound the operator can reason
 * about, not a predicted spend. Anything smarter would need a click-rate estimate, and every € figure
 * in this account is already an ACOS estimate without COGS; adding a second layer of estimate under a
 * refusal message would make the refusal unfalsifiable.
 *
 * Stated in the UI as "commits up to", never "will spend".
 */
export function commitmentCents(targetCount: number, bidCents: number): number {
  return targetCount * bidCents
}
