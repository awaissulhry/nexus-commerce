'use client'

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
