'use client'

/**
 * U5 — the Negative Targeting tab, reduced to Helium 10's shape: page header · tab bar · ONE rules
 * card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.4 and §7.6. In H10 the Negative Targeting
 * tab is a single grid — "Viewing 1-2 of 2 Negative Targeting Rules" · 🔍 · [+ Rule], columns
 * ☐ · Negative Targeting Rule ⇅ · Automation · Criteria · Frequency, empty state "Create a Negative
 * Targeting Rule to generate suggestions for a campaign!" — with no segment control, no filter card
 * and nothing below it. That is what this renders.
 *
 * Unlike U3/U4 this tab needed no `RULE_TAB_ACTION_TYPES` change: `negative-targeting` already maps
 * real engine action types (`add_negative_exact`, `add_negative_phrase`, `harvest_and_negate`,
 * `sync_negatives_across_campaigns`) and the derivation adds the builder slug.
 *
 * 🔴 What leaves this page is the biggest parking in the programme, and none of it is protection.
 * The protected-terms whitelist, the converting-term guard and the write gate are **server-side**
 * and still armed; `NegProtectedTerms.tsx` was the EDITOR for that list, not the enforcement, and
 * the same panel already lives on Control Room › Guardrails (`ProtectedTermsPanel.tsx`). Parking a
 * UI removes no protection — but it does remove the place the operator edits the whitelist from
 * this page, which is why the register names Control Room as its home rather than "later".
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function NegativeRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Negative Targeting"
        subtitle="Rules that create negatives — what each one blocks, and whether it acts on its own"
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
      <RulesTabs active="negative-targeting" />
      <RulesGrid
        tabKey="negative-targeting"
        noun="Negative Targeting Rule"
        builderHref="/marketing/ads/rules-automation/builder/negative-targeting"
        emptyLine="Create a Negative Targeting Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
