'use client'

/**
 * THE five Helium 10 rule columns — **Bid Rule · Target ACoS · Min/Max Bid · Bid Automation ·
 * Budget Rule** — as one set of cells, used by every grid that shows them.
 *
 * 🔴 **Operator instruction, 2026-08-19:** *"a lot of it is actually missing here, and we must build
 * them as well … we also built them on the Ads Manager page. To make sure it is exactly the same
 * and there are no inconsistencies in the design and the UI, we can simply use shared components."*
 * So: one definition, imported by the Ad Manager grid and by Apply Rules. Change a cell here and
 * both change. Add a prop rather than forking.
 *
 * ── Each cell takes PRIMITIVES, not a row ──────────────────────────────────────────────────────
 * The two grids carry different row shapes (`Camp` on the Ad Manager, `CampaignRow` on Apply
 * Rules), so a cell that took a row would need one of them to adopt the other's type. Passing the
 * values means both feed the same component from whatever they happen to call the field.
 *
 * ── 🔴 What each column may HONESTLY show, measured on prod 2026-08-19 ─────────────────────────
 * · **Bid Rule** — `/advertising/campaigns` returns **no `bidAlgorithm`**, so the Ad Manager's own
 *   Bid Rule cell falls through to its default and reads "Target ACOS" on every row; its editor is
 *   local-only and says so ("Amazon field pending"). The truthful per-campaign source is
 *   `bidder` / `bidderName` from `/advertising/bid-grid?view=campaigns`, which really varies:
 *   **schedule 32 · none 45 · manual 6**, with names like "Rank plan — GALE EXACT DE". That is what
 *   this cell shows, and it is why Apply Rules' Bid Rule column is NOT the Ad Manager's.
 * · **Min/Max Bid** — set on **82 of 220**, from `minBidCents` / `maxBidCents`. (The Ad Manager
 *   derives the same pair client-side since ADX G2; this cell renders the cents directly.)
 * · **Target ACoS** (`targetAcos`, a FRACTION) is a real, writable field currently set on **0 of
 *   220**. Uniform is not the same as fake: Apply Rules' bulk verb writes it, so "—" is the honest
 *   reading of "nobody has set one", not a placeholder.
 * · **Bid Automation** (`bidAutomation`) is real and **false on all 220**. Same reasoning.
 * · **Budget Rule** — `reachedByRuleIds` is **6 on every campaign**, because all six budget rules
 *   are account-wide (0 of 51 rules carry a campaign scope). A column printing "6" everywhere would
 *   be decorative, so the cell leads with what DOES vary: whether a rule has actually moved this
 *   campaign's budget (`lastMovedByKind === 'rule'` — true on 1 of 86), with the reach as context.
 */
import { Shuffle, Sparkles, User, Minus } from 'lucide-react'

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

/** Bid Rule — who owns this campaign's bids. */
export function BidRuleCell({ bidder, bidderName }: { bidder?: string | null; bidderName?: string | null }) {
  if (!bidder || bidder === 'none') {
    return <span className="h10-rc-none" title="No bid rule, rank plan or schedule owns this campaign's bids — they move only when someone changes them by hand.">None</span>
  }
  const isSchedule = bidder === 'schedule'
  const Icon = isSchedule ? Sparkles : bidder === 'manual' ? User : Shuffle
  return (
    <span
      className={`h10-rc-bidrule ${isSchedule ? 'auto' : ''}`}
      title={isSchedule
        ? `Bids here are held by a plan: ${bidderName ?? 'a rank schedule'}. It writes on its own cadence.`
        : bidder === 'manual'
          ? 'Bids here were last set by hand — no rule or plan owns them.'
          : `Owned by ${bidderName ?? bidder}.`}
    >
      <Icon size={13} aria-hidden />
      <span className="t">{bidderName ?? bidder}</span>
    </span>
  )
}

/**
 * Target ACoS — stored as a FRACTION (0.3 = 30%).
 * 🔴 The 30-vs-0.3 trap: `PUT /campaigns/:id/goal` refuses the whole-number form, and one rule on
 * prod stores 30 where the rest store 0.3. A value above 1 is therefore already a percentage.
 */
export function TargetAcosCell({ fraction }: { fraction?: number | null }) {
  if (fraction == null) return <span className="h10-rc-none" title="No target ACoS is set on this campaign. Rules that bid to a target read the account default instead.">—</span>
  const pct = fraction > 1 ? fraction : fraction * 100
  return <span className="h10-rc-num">{pct.toFixed(2)}%</span>
}

/** Min/Max Bid — the two enforced guardrails, in cents. */
export function MinMaxBidCell({ minCents, maxCents }: { minCents?: number | null; maxCents?: number | null }) {
  if (minCents == null && maxCents == null) {
    return <span className="h10-rc-none" title="No bid band is set, so a rule may bid this campaign anywhere the write gate allows.">None</span>
  }
  return (
    <span className="h10-rc-num" title={`The write gate refuses any bid outside ${minCents != null ? eur(minCents) : 'no floor'} – ${maxCents != null ? eur(maxCents) : 'no ceiling'}.`}>
      {minCents != null ? eur(minCents) : '—'} – {maxCents != null ? eur(maxCents) : '—'}
    </span>
  )
}

/**
 * Bid Automation — H10's own switch for "let the bid algorithm act".
 * ⚠ NOT the write gate. Apply Rules' "Automations" column shows `liveBidWritesEnabled` (whether any
 * armed rule may write at all); this is `bidAutomation`, a different field on a different endpoint.
 * Showing one under the other's name is the confusion this comment exists to prevent.
 */
export function BidAutomationCell({ on }: { on?: boolean | null }) {
  return (
    <span
      className={`h10-rc-toggle ${on ? 'on' : 'off'}`}
      role="img"
      aria-label={on ? 'Bid automation on' : 'Bid automation off'}
      title={on
        ? 'Bid automation is ON: the bid algorithm applies its own suggestions to this campaign.'
        : 'Bid automation is OFF: suggestions are proposed, not applied. This is not the write gate — see the Automations column for that.'}
    ><span /></span>
  )
}

/**
 * Budget Rule — leads with what varies (has a rule actually moved this budget?) and carries the
 * reach as context, because reach alone is the same number on every campaign today.
 */
export function BudgetRuleCell({ reachedBy, lastMovedByKind, lastMovedBy }: {
  reachedBy?: number | null
  lastMovedByKind?: string | null
  lastMovedBy?: string | null
}) {
  const n = reachedBy ?? 0
  const moved = lastMovedByKind === 'rule'
  if (moved) {
    return (
      <span className="h10-rc-bidrule auto" title={`This campaign's budget was last moved by a rule${lastMovedBy ? `: ${lastMovedBy}` : ''}. ${n} budget rule${n === 1 ? '' : 's'} can reach it.`}>
        <Shuffle size={13} aria-hidden /><span className="t">{lastMovedBy ?? 'A rule'}</span>
      </span>
    )
  }
  if (n > 0) {
    return (
      <span className="h10-rc-reach" title={`${n} budget rule${n === 1 ? '' : 's'} can write to this campaign — all of them account-wide — but none has moved its budget yet.`}>
        <Minus size={12} aria-hidden /> {n} can
      </span>
    )
  }
  return <span className="h10-rc-none" title="No budget rule reaches this campaign.">None</span>
}
