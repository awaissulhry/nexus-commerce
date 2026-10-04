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
 * The header's market picker writes `?market=`, and since ads fix 7d (review I.1) the rules grid reads it: a rule
 * scoped to another market is left out, and the grid says how many and offers "Show all markets".
 */
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/lib/workspaces/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabHeader } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'FR', 'ES']

export function BidRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        {...rulesTabHeader('bid')}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
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
