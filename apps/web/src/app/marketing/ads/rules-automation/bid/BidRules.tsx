'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the interim governance table (Rule · May it act? · Where · Caps · Executions) via _shared/TabRules.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: nowhere — SUPERSEDED by _shared/RulesGrid.tsx, which is H10's actual rules grid. Kept only so the governance columns are not lost if Automations ever wants them.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S7 — rules as declared exceptions to a campaign's bidder.
 *
 * The section's body is the shared `TabRules` (this page built the original; HV's close-out
 * generalised it so other tabs retire their interim RuleListTab mounts onto ONE implementation).
 * Membership is `ruleBelongsToTab(actions, 'bid')` — the same predicate the tab badge counts with.
 */
import { TabRules } from '../_shared/TabRules'

export function BidRules() {
  return (
    <TabRules
      tabKey="bid"
      sectionId="bid-rules"
      heading="declared exceptions to a campaign's bidder"
      subject="bids besides the bidder"
      builderHref="/marketing/ads/rules-automation/builder/bid"
      builderLabel="Bid Rule"
      emptyLine="No rule is allowed to move bids. The bidders above are the whole story until one is created."
    />
  )
}
