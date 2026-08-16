'use client'

/**
 * U1 — the Bid tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.2 and §7.2. In H10 the Bid tab is a single
 * grid — "Showing 0 Bid rules" · 🔍 · [+ Rule], columns ☐ · Bid Rule ⇅ · Automation · Criteria ·
 * Frequency, empty state "Create a Bid Rule to generate suggestions for a campaign!" — and nothing
 * above or below it but the site footer. That is what this renders.
 *
 * What was here before is NOT deleted: `BidClient.tsx` and its eight section files are PARKED in
 * place (unmounted, each with a PARKED header; manifest `docs/2026-08-16-ra-parked-sections.md`),
 * because the operator's read is that the bidder band, census, bounds, activity, staged tray and
 * target drawer are useful — on Analytics, Suggestions and the Ad Manager, not on the rules page.
 * Nothing about them was destroyed and no endpoint was retired: re-mounting one is a single import.
 *
 * ⚠ The market picker is deliberately still here. The grid itself is account-wide (an
 * `AutomationRule` is not per-market), but this header's picker is the section's shared control and
 * every neighbouring tab keeps it; removing it on one tab only would make the section inconsistent
 * for no gain. It writes `?market=` and nothing on this page reads it yet.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'FR', 'ES']

export function BidRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = rulesTabByKey('bid')
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Bid"
        subtitle={tab?.subtitle ?? 'What each target bids, why it is that number, and who decided'}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="bid" />
      <RulesGrid
        tabKey="bid"
        noun="Bid Rule"
        builderHref="/marketing/ads/rules-automation/builder/bid"
        emptyLine="Create a Bid Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
