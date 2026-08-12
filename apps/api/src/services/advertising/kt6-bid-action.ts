/**
 * KT.6 — the arithmetic behind acting on a Keyword Tracker row, as pure functions.
 *
 * Pure and separate because every number here goes into a sentence an operator reads before
 * spending money, and D4 says that sentence must be exact. "42 of 100" is not a rounding; it is the
 * difference between what a rule matched and what it is permitted to touch, and D3 requires both to
 * be on screen: *a rule that looks broken is often simply not permitted.*
 *
 * ── What one row can reach, measured on prod 2026-08-13 ───────────────────────────────────────
 *
 * `giacca moto` (IT) is 100 keyword targets across 53 campaigns. **42 targets in 17 campaigns are
 * writable**; the other 58 sit in campaigns that `Campaign.liveBidWritesEnabled=false` puts out of
 * reach of every rule in the account. Outside Italy the picture is worse and the page must say so
 * rather than looking broken: writable campaigns are IT 70/150, DE 8/38, ES 2/10, **FR 2/22**.
 *
 * ── Four exclusions, and why each is a refusal rather than a clamp ────────────────────────────
 *
 * 1. **Not write-enabled.** The account's strongest safety property. Named, never hidden.
 * 2. **Deliberately suppressed.** The house rule is "no pause — suppress with a ~2¢ bid", so a
 *    control that sets one bid across a row would silently switch delivery back ON for traffic
 *    somebody switched off. Measured: of `giacca moto`'s 42 writable targets, **9 carry
 *    `suppressedFromBidCents`** and **12 bid ≤3¢** — so three low bids carry no flag at all, and
 *    account-wide 141 of 561 low bids are unflagged. Both categories are therefore excluded by
 *    default and counted SEPARATELY: the flag is evidence, ≤3¢ is a convention, and conflating them
 *    would hide the 141 the flag does not know about.
 * 3. **Above the campaign's own ceiling.** `Campaign.maxBidCents` is set on exactly the 82 writable
 *    campaigns (IT €0.80 · DE €1.90 · ES €0.90 · FR €0.80). The write gate DENIES rather than
 *    clamps, deliberately — "clamping would rewrite an engine's intent without telling anyone" —
 *    so this predicts the gate's own answer instead of pretending the write will land.
 * 4. **Below the floor.** `Campaign.minBidCents` is set on **0 of 220**, so the only floor in the
 *    system is the handler's 5¢. A "lower the bid" control with no floor of its own would be a
 *    silent path to 1¢. KT.6 carries its own, above the suppression band, so lowering a bid can
 *    never be mistaken for suppressing a target.
 *
 * Nothing here writes, queues, or decides autonomy. `graduationCeiling` already owns the ceiling
 * (bid changes → AUTO, keyword creation → PROPOSE) and `checkAdsWriteGate` owns the write.
 */

/** The handler's own floor. Below this a bid is a suppression, not an optimisation. */
export const KT6_BID_FLOOR_CENTS = 5

/**
 * At or below this, a bid is treated as a deliberate suppression whatever the flag says.
 * A guess, in the safe direction, stated rather than hidden — see exclusion 2.
 */
export const KT6_SUPPRESSION_CENTS = 3

export interface Kt6Target {
  id: string
  expressionValue: string
  matchType: string
  bidCents: number | null
  /** non-null ⇒ recorded suppression, holding the bid it was suppressed FROM */
  suppressedFromBidCents: number | null
  campaignId: string
  campaignName: string
  /** Campaign.liveBidWritesEnabled */
  writable: boolean
  /** Campaign.maxBidCents — the gate's ceiling for this campaign */
  maxBidCents: number | null
  /** Campaign.minBidCents — measured null on all 220, kept because the gate reads it */
  minBidCents: number | null
}

export type Kt6Exclusion =
  | 'not_write_enabled'
  | 'suppressed_flag'
  | 'suppressed_by_bid'
  | 'over_campaign_ceiling'
  | 'below_floor'
  | 'no_change'

export interface Kt6Excluded {
  target: Kt6Target
  why: Kt6Exclusion
  detail: string
}

export interface Kt6BlastRadius {
  requestedBidCents: number
  /** everything the row resolves to, before any permission is considered */
  matchedTargets: number
  matchedCampaigns: number
  /** what would actually change */
  actionable: Kt6Target[]
  actionableCampaigns: number
  excluded: Kt6Excluded[]
  /** counts by reason, so a sentence can name each one */
  byReason: Record<Kt6Exclusion, number>
  /** campaigns that hold at least one excluded target, per reason */
  blockedCampaignNames: string[]
  /** the highest bid that WOULD be allowed everywhere actionable, for a "try this instead" hint */
  highestUniformAllowed: number | null
}

export interface Kt6RadiusOptions {
  /** include targets whose bid already equals the requested value (default false — nothing to do) */
  includeNoChange?: boolean
  /** raise deliberately-suppressed targets too. Default false, and the UI must ask explicitly. */
  includeSuppressed?: boolean
  floorCents?: number
}

/**
 * Resolve what a single bid value would actually do to a row.
 *
 * Order matters and is not arbitrary: permission first (it is the broadest refusal and the one D3
 * insists is visible), then intent (suppression is a decision someone made), then bounds. Reporting
 * a ceiling breach on a campaign that was never writable would tell the operator to fix the wrong
 * thing — the same reasoning the write gate uses to check pins before bounds.
 */
export function computeBlastRadius(
  targets: Kt6Target[],
  requestedBidCents: number,
  opts: Kt6RadiusOptions = {},
): Kt6BlastRadius {
  const floor = opts.floorCents ?? KT6_BID_FLOOR_CENTS
  const actionable: Kt6Target[] = []
  const excluded: Kt6Excluded[] = []
  const byReason: Record<Kt6Exclusion, number> = {
    not_write_enabled: 0, suppressed_flag: 0, suppressed_by_bid: 0,
    over_campaign_ceiling: 0, below_floor: 0, no_change: 0,
  }
  const blocked = new Set<string>()

  for (const t of targets) {
    const drop = (why: Kt6Exclusion, detail: string) => {
      excluded.push({ target: t, why, detail })
      byReason[why] += 1
      blocked.add(t.campaignName)
    }

    if (!t.writable) {
      drop('not_write_enabled', `${t.campaignName} is not on the live-write allowlist`)
      continue
    }
    if (!opts.includeSuppressed && t.suppressedFromBidCents != null) {
      drop('suppressed_flag', `deliberately suppressed from ${fmt(t.suppressedFromBidCents)} — raising it would switch delivery back on`)
      continue
    }
    if (!opts.includeSuppressed && t.bidCents != null && t.bidCents <= KT6_SUPPRESSION_CENTS) {
      drop('suppressed_by_bid', `bids ${fmt(t.bidCents)}, at or under the ${fmt(KT6_SUPPRESSION_CENTS)} suppression convention, with no suppression flag to confirm it`)
      continue
    }
    if (requestedBidCents < floor) {
      drop('below_floor', `${fmt(requestedBidCents)} is below KT.6's ${fmt(floor)} floor — use the suppression control, not a bid change`)
      continue
    }
    if (t.maxBidCents != null && requestedBidCents > t.maxBidCents) {
      drop('over_campaign_ceiling', `${t.campaignName} caps bids at ${fmt(t.maxBidCents)}; the write gate would refuse ${fmt(requestedBidCents)}`)
      continue
    }
    if (!opts.includeNoChange && t.bidCents === requestedBidCents) {
      drop('no_change', `already bids ${fmt(requestedBidCents)}`)
      continue
    }
    actionable.push(t)
  }

  // The best uniform value that clears every ceiling among the targets that are otherwise eligible.
  // Only the ceiling is considered — a floor breach is the operator's number, not the account's.
  const eligible = targets.filter((t) =>
    t.writable &&
    (opts.includeSuppressed || (t.suppressedFromBidCents == null && !(t.bidCents != null && t.bidCents <= KT6_SUPPRESSION_CENTS))),
  )
  const caps = eligible.map((t) => t.maxBidCents).filter((c): c is number => c != null)
  const highestUniformAllowed = caps.length ? Math.min(...caps) : null

  return {
    requestedBidCents,
    matchedTargets: targets.length,
    matchedCampaigns: new Set(targets.map((t) => t.campaignId)).size,
    actionable,
    actionableCampaigns: new Set(actionable.map((t) => t.campaignId)).size,
    excluded,
    byReason,
    blockedCampaignNames: [...blocked].sort(),
    highestUniformAllowed,
  }
}

/** cents → €x.yz, the one spelling used in every sentence below. */
export function fmt(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`
}

export interface Kt6SentenceContext {
  term: string
  marketplace: string
  /** how old the SQP week backing this decision is, in days. Measured 24 today. */
  shareAgeDays: number | null
  /** hours the undo window stays open. 24, from rollbackByExecutionId. */
  undoWindowHours: number
  /** true when the action is queued as a proposal rather than executed */
  proposeOnly: boolean
}

/**
 * The sentence shown BEFORE the write. D4 at full strength: what it will do, to how many targets and
 * campaigns, what it will NOT do and why, how old the evidence is, and whether it can be undone.
 *
 * Written as whole sentences per branch rather than assembled from fragments — KT.4 shipped "the
 * point stand alone" by pluralising a noun and leaving the verb, and that was caught by reading the
 * rendered string, not the template.
 */
export function blastRadiusSentence(r: Kt6BlastRadius, ctx: Kt6SentenceContext): string {
  const parts: string[] = []

  if (r.actionable.length === 0) {
    parts.push(nothingToDoSentence(r, ctx))
  } else {
    const t = r.actionable.length === 1 ? '1 target' : `${r.actionable.length} targets`
    const c = r.actionableCampaigns === 1 ? '1 campaign' : `${r.actionableCampaigns} campaigns`
    parts.push(
      ctx.proposeOnly
        ? `Propose setting the bid to ${fmt(r.requestedBidCents)} on ${t} across ${c} for “${ctx.term}” in ${ctx.marketplace}. Nothing changes until the proposal is approved.`
        : `Set the bid to ${fmt(r.requestedBidCents)} on ${t} across ${c} for “${ctx.term}” in ${ctx.marketplace}.`,
    )
  }

  // What it will NOT do — each reason its own sentence, because they are different problems with
  // different fixes, and a single "58 excluded" would tell the operator nothing they can act on.
  const nw = r.byReason.not_write_enabled
  if (nw > 0) {
    const camps = new Set(r.excluded.filter((e) => e.why === 'not_write_enabled').map((e) => e.target.campaignName))
    parts.push(
      `${nw === 1 ? '1 further target' : `${nw} further targets`} in ${camps.size === 1 ? '1 campaign' : `${camps.size} campaigns`} ${nw === 1 ? 'is' : 'are'} not write-enabled and will not change — that is the account's default-deny allowlist, not a failure here.`,
    )
  }
  const sf = r.byReason.suppressed_flag
  const sb = r.byReason.suppressed_by_bid
  if (sf > 0 || sb > 0) {
    const bits: string[] = []
    if (sf > 0) bits.push(`${sf} ${sf === 1 ? 'is' : 'are'} recorded as deliberately suppressed`)
    if (sb > 0) bits.push(`${sb} ${sb === 1 ? 'bids' : 'bid'} at or under ${fmt(KT6_SUPPRESSION_CENTS)} with no suppression flag`)
    parts.push(`${bits.join(' and ')}, so ${sf + sb === 1 ? 'it is' : 'they are'} left alone — raising a suppressed bid would switch delivery back on for traffic that was switched off on purpose.`)
  }
  const oc = r.byReason.over_campaign_ceiling
  if (oc > 0) {
    const caps = [...new Set(r.excluded.filter((e) => e.why === 'over_campaign_ceiling').map((e) => e.target.maxBidCents!))].sort((a, b) => a - b)
    parts.push(
      `${oc === 1 ? '1 target' : `${oc} targets`} sit${oc === 1 ? 's' : ''} in campaigns that cap bids at ${caps.map(fmt).join(' / ')}, so the write gate would refuse ${fmt(r.requestedBidCents)} there.${r.highestUniformAllowed != null ? ` ${fmt(r.highestUniformAllowed)} would be accepted everywhere.` : ''}`,
    )
  }
  const bf = r.byReason.below_floor
  if (bf > 0) {
    parts.push(`${fmt(r.requestedBidCents)} is below KT.6's ${fmt(KT6_BID_FLOOR_CENTS)} floor, so nothing will be lowered to it. To stop delivery, suppress the target instead of bidding near zero.`)
  }
  const ncc = r.byReason.no_change
  if (ncc > 0) {
    parts.push(`${ncc === 1 ? '1 target already bids' : `${ncc} targets already bid`} ${fmt(r.requestedBidCents)} and ${ncc === 1 ? 'is' : 'are'} left untouched.`)
  }

  // Evidence age — §2.5. Any action justified by share must say how old that share is.
  if (ctx.shareAgeDays != null) {
    parts.push(
      ctx.shareAgeDays >= 14
        ? `The impression share on this row is from a Brand Analytics week that ended ${ctx.shareAgeDays} days ago, and the feed cannot currently produce a fresher one — judge this on the bid and the spend, not on the share.`
        : `The impression share on this row is ${ctx.shareAgeDays} days old.`,
    )
  }

  if (r.actionable.length > 0) {
    parts.push(
      ctx.proposeOnly
        ? `If approved, the change is undoable in one action for ${ctx.undoWindowHours} hours afterwards.`
        : `Undoable in one action for ${ctx.undoWindowHours} hours.`,
    )
  }

  return parts.join(' ')
}

/**
 * "Never ran" and "nothing to do" must never render the same (D4). Five different zeros, five
 * different sentences — a single "0 targets" would collapse a permissions problem, a deliberate
 * suppression and an unwatched term into one shrug.
 */
function nothingToDoSentence(r: Kt6BlastRadius, ctx: Kt6SentenceContext): string {
  if (r.matchedTargets === 0) {
    return `No campaign bids “${ctx.term}” in ${ctx.marketplace}, so there is no bid to change. This term is on the watchlist and is not being bought — the action here is to start bidding it, not to reprice it.`
  }
  if (r.byReason.not_write_enabled === r.matchedTargets) {
    return `“${ctx.term}” is bid in ${r.matchedCampaigns === 1 ? '1 campaign' : `${r.matchedCampaigns} campaigns`} in ${ctx.marketplace}, and not one of them is write-enabled, so nothing can be changed from here. This is the account's default-deny allowlist doing its job, not a fault on this page.`
  }
  if (r.byReason.below_floor > 0) {
    return `Nothing will change: ${fmt(r.requestedBidCents)} is below KT.6's ${fmt(KT6_BID_FLOOR_CENTS)} floor. To stop delivery on this term, suppress it rather than bidding near zero.`
  }
  if (r.byReason.over_campaign_ceiling > 0) {
    return `Nothing will change: every writable target for “${ctx.term}” sits in a campaign whose bid ceiling is below ${fmt(r.requestedBidCents)}.${r.highestUniformAllowed != null ? ` ${fmt(r.highestUniformAllowed)} would be accepted.` : ''}`
  }
  // A sixth zero, added after the gate run rendered this case through the generic fallback: every
  // target this page MAY change is suppressed. That is not "a mix of reasons" — it is one specific
  // and recoverable state, and it has its own fix (un-suppress deliberately, or leave it alone).
  const suppressedTotal = r.byReason.suppressed_flag + r.byReason.suppressed_by_bid
  if (suppressedTotal > 0 && suppressedTotal === r.matchedTargets - r.byReason.not_write_enabled) {
    return `Nothing will change: every writable target for “${ctx.term}” is suppressed — ${r.byReason.suppressed_flag} recorded as suppressed and ${r.byReason.suppressed_by_bid} bidding at or under ${fmt(KT6_SUPPRESSION_CENTS)}. Delivery on this term was switched off on purpose, so repricing it is not the action; un-suppressing it is, and that is a separate decision.`
  }
  // The floor and ceiling branches above have already returned, so reaching here with any
  // no_change at all means the remaining eligible targets are simply already at this bid.
  // (The first version subtracted only the unwritable count, which ignored the suppressed ones and
  // made this sentence unreachable on the widest real row — caught by the test, not by reading it.)
  if (r.byReason.no_change > 0) {
    const others = r.byReason.suppressed_flag + r.byReason.suppressed_by_bid
    return `Nothing to do — every target for “${ctx.term}” that this page may change already bids ${fmt(r.requestedBidCents)}.${others > 0 ? ` A further ${others} ${others === 1 ? 'is' : 'are'} suppressed and deliberately left alone.` : ''}`
  }
  return `Nothing will change for “${ctx.term}” in ${ctx.marketplace}. ${r.excluded.length} target${r.excluded.length === 1 ? '' : 's'} ${r.excluded.length === 1 ? 'was' : 'were'} excluded; the reasons are listed below.`
}
