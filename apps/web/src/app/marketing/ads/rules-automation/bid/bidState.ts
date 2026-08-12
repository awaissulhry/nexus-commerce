/**
 * BID.S2 — the Bid page's state vocabulary. **This is the canonical definition for S3–S9.**
 *
 * Nine chips, one pure resolver, no I/O. A later section imports `resolveBidStates` and renders the
 * result; it does not re-derive "is this at the floor", because the moment two sections answer that
 * differently the page starts contradicting itself in front of the operator.
 *
 * ── Why at most two chips per row ───────────────────────────────────────────────────────────────
 *
 * Most rows qualify for several. A target can simultaneously be unnamed, unmeasured, not in
 * auction, and owned by nobody — four true statements, none of which is the reason you opened the
 * page. Rendering all four turns the column into noise and pushes the grid past its width. So the
 * list is ordered by *what would change a decision* and truncated at two.
 *
 * ── The precedence, and why it is this order ────────────────────────────────────────────────────
 *
 *   1. `out-of-band`     — the bid is outside a ceiling somebody set. Actionable, and rare (56).
 *   2. `unrecorded`      — we cannot account for the current value. Everything below is a fact we
 *                          are confident about; this one says the row itself is untrustworthy.
 *   3. `suppressed`      — deliberately floored, with a remembered value to restore.
 *   4. `min-bid-window`  — floored by a schedule, restoring on the clock.
 *   5. `at-floor`        — at the floor with NO memory of what it was. 🔴 The honest third bucket.
 *   6. `no-bidder`       — nothing automated will ever move this bid.
 *   7. `not-in-auction`  — switched on inside something switched off.
 *   8. `unnamed`         — no expression of its own; identified by its targeting group.
 *   9. `no-data`         — never served in the window. Last because it is the most common (79%)
 *                          and the least actionable; it belongs in the metric cells, which already
 *                          say "not served", and here only when nothing else is worth saying.
 *
 * 🔴 **3, 4 and 5 are mutually exclusive by construction.** `at-floor` is *defined* as the absence
 * of the other two — a 2¢ bid with no restore value and no window. The tab study called the whole
 * 2¢ population "suppressed"; measured 2026-08-12, **none of it carries a restore value**. Getting
 * this wrong means telling an operator a bid will come back on its own when nothing will bring it
 * back.
 *
 * ── 🔴 These chips are a CLOCK READING, not a state ─────────────────────────────────────────────
 *
 * The rank engine floors ~900 bids at 00:00 Rome and restores them at 08:00. Measured at 11:58
 * Rome: `suppressed` 0, `min-bid-window` 0, `at-floor` 151. Measured at 23:00 the first two would
 * be full and `unrecorded` near zero — because the floor IS audited and the restore is what goes
 * unrecorded. **A verification pass that runs at the wrong hour will conclude a chip is broken.**
 * Anything that renders a COUNT of these must stamp the time it was read.
 */

export type BidStateKey =
  | 'out-of-band'
  | 'unrecorded'
  | 'suppressed'
  | 'min-bid-window'
  | 'at-floor'
  | 'no-bidder'
  | 'not-in-auction'
  | 'unnamed'
  | 'no-data'

/** Visual weight. `bad` = costs money or cannot be trusted · `warn` = needs a decision · `mute` = context. */
export type BidStateTone = 'bad' | 'warn' | 'mute'

export interface BidStateChip {
  key: BidStateKey
  label: string
  tone: BidStateTone
  /** The full sentence, for the cell's title. Always names the number or the value behind the chip. */
  title: string
}

/** Everything the resolver reads. A subset of `BidTargetRow`, so a caller passes the row itself. */
export interface BidStateInput {
  bidCents: number
  status: string
  campaignStatus: string
  minBidCents: number | null
  maxBidCents: number | null
  suppressedFromBidCents: number | null
  inMinBidWindow: boolean
  lastAuditedCents: number | null
  unrecorded: boolean
  bidder: 'schedule' | 'goal' | 'manual' | 'none'
  derived: boolean
  measured: boolean
}

/** 5¢ is `BID_FLOOR_CENTS` in the rule handlers and `FLOOR_CENTS` in the optimiser; 2¢ is
 *  `SUPPRESSION_FLOOR_CENTS`. The chip uses the SUPPRESSION floor, because that is the value the
 *  no-pause policy writes and the one an operator recognises as "switched off without pausing". */
export const SUPPRESSION_FLOOR_CENTS = 2

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

/**
 * The chips this row earns, most decision-changing first, capped at `max`.
 *
 * Pure: same input, same output, no clock read inside. (The *populations* move with the clock; the
 * function does not.)
 */
export function resolveBidStates(t: BidStateInput, max = 2): BidStateChip[] {
  const out: BidStateChip[] = []

  // 1 — outside a ceiling somebody set. The gate DENIES writes outside the band but never pulls an
  // existing bid in, so these are frozen upward: nothing may raise them and nothing is lowering them.
  if (t.maxBidCents != null && t.bidCents > t.maxBidCents) {
    out.push({
      key: 'out-of-band', label: 'Out of band', tone: 'bad',
      title: `${eur(t.bidCents)} is above this campaign's ceiling of ${eur(t.maxBidCents)}. The write gate refuses anything outside the band but never pulls an existing bid in, so this one is frozen: nothing may raise it and nothing is lowering it.`,
    })
  } else if (t.minBidCents != null && t.bidCents < t.minBidCents) {
    // The same chip from the other side. No campaign declares a floor today (0 of 220), so this
    // branch is currently unreachable on production — kept because S5 is about to make it reachable.
    out.push({
      key: 'out-of-band', label: 'Below floor', tone: 'bad',
      title: `${eur(t.bidCents)} is below this campaign's declared floor of ${eur(t.minBidCents)}.`,
    })
  }

  // 2 — the audit trail cannot account for the current value.
  if (t.unrecorded && t.lastAuditedCents != null) {
    out.push({
      key: 'unrecorded', label: 'Unrecorded change', tone: 'bad',
      title: `The last recorded change set this to ${eur(t.lastAuditedCents)}; it is now ${eur(t.bidCents)} and nothing recorded the difference. Usually the nightly restore, which is audited on most campaigns and not on this one — but a Seller Central edit looks identical, and the hourly inbound sync overwrites the local value either way without leaving a row.`,
    })
  }

  // 3/4/5 — the floor, in its three genuinely different forms. Mutually exclusive by construction.
  if (t.suppressedFromBidCents != null) {
    out.push({
      key: 'suppressed', label: 'Suppressed', tone: 'warn',
      title: `Deliberately floored to ${eur(t.bidCents)}; restores to ${eur(t.suppressedFromBidCents)}. A floor is what optimisation may not go below — suppression is not optimisation and passes through it.`,
    })
  } else if (t.inMinBidWindow) {
    out.push({
      key: 'min-bid-window', label: 'Min-bid window', tone: 'warn',
      title: `This campaign is inside a Min-bid window, so its bids are held at the floor until the window ends. The schedule restores them; no operator action is needed.`,
    })
  } else if (t.bidCents <= SUPPRESSION_FLOOR_CENTS) {
    out.push({
      key: 'at-floor', label: 'At floor · no restore', tone: 'warn',
      title: `At ${eur(t.bidCents)} with no remembered value and no active window — nothing on record says what this bid was, so nothing will bring it back on its own. This is the whole of the 2¢ population today; the tab study called it "suppressed" and none of it carries a restore value.`,
    })
  }

  // 6 — nobody automated owns this bid.
  if (t.bidder === 'none') {
    out.push({
      key: 'no-bidder', label: 'No bidder', tone: 'warn',
      title: `No schedule, no goal and no operator has moved a bid in this campaign in 60 days. 41 of the 86 enabled campaigns are in this position and 26 of them spent money last month; their write gates are open, so nothing is stopping a bidder reaching them. Nothing is trying.`,
    })
  }

  // 7 — switched on inside something switched off.
  if (t.status === 'ENABLED' && t.campaignStatus !== 'ENABLED') {
    out.push({
      key: 'not-in-auction', label: 'Not in auction', tone: 'mute',
      title: `This target is enabled but its campaign is ${t.campaignStatus.toLowerCase()}, so the bid enters no auction and no bidder will move it. 1,853 of the 2,944 enabled targets are in this position.`,
    })
  }

  // 8 — no expression of its own.
  if (t.derived) {
    out.push({
      key: 'unnamed', label: 'Unnamed', tone: 'mute',
      title: `Amazon stores no text for this target — it is identified by its targeting group, and the name in the first column is derived from the match type.`,
    })
  }

  // 9 — never served. Last: true of 79% of rows and the metric cells already say it.
  if (!t.measured) {
    out.push({
      key: 'no-data', label: 'No data', tone: 'mute',
      title: `No impressions in the selected window, so there is nothing to report — which is a different fact from being served and earning nothing.`,
    })
  }

  return out.slice(0, max)
}

/** Every chip, in precedence order — for a filter control that must offer all of them. */
export const BID_STATE_KEYS: readonly BidStateKey[] = [
  'out-of-band', 'unrecorded', 'suppressed', 'min-bid-window',
  'at-floor', 'no-bidder', 'not-in-auction', 'unnamed', 'no-data',
] as const

export const BID_STATE_LABEL: Record<BidStateKey, string> = {
  'out-of-band': 'Out of band',
  unrecorded: 'Unrecorded change',
  suppressed: 'Suppressed',
  'min-bid-window': 'Min-bid window',
  'at-floor': 'At floor · no restore',
  'no-bidder': 'No bidder',
  'not-in-auction': 'Not in auction',
  unnamed: 'Unnamed',
  'no-data': 'No data',
}

/**
 * Does this row carry `key` **at all** — before the two-chip cap?
 *
 * 🔴 The filter must use this, never `resolveBidStates(...).some(...)`. A row that is both
 * `out-of-band` and `no-data` renders two chips and drops the rest; filtering on the rendered list
 * would hide it from `state=no-data`, so a chip's filter would return fewer rows than the chip's
 * own count. That exact disagreement — a count and its filter not matching — is what NEG.1 shipped
 * and found by clicking.
 */
export function hasBidState(t: BidStateInput, key: BidStateKey): boolean {
  return resolveBidStates(t, Number.MAX_SAFE_INTEGER).some((c) => c.key === key)
}
