'use client'

/**
 * U7 — the Keyword Harvest tab, reduced to Helium 10's shape.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.3 and §7.8. This is the ONE rule-type tab
 * H10 gives a second view: a pill directly under the tab bar —
 *
 *   [ Rules View | Ad Group View ]
 *
 * Rules View is the standard rules card. Ad Group View is the mapping table (`HvAdGroupView.tsx`).
 * The operator named exactly these three things for this page: "Rules, Add Group View, Rule
 * Builder" — the builder being the existing one behind "+ Rule".
 *
 * ⚠ In H10 the pill does not change the URL. Ours does (`?view=ad-groups`), deliberately: every
 * other view state in this section is linkable, and a view you cannot send to someone is a view
 * you have to describe over the phone. `rules` is the default and writes no param.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'
import { HvAdGroupView } from './HvAdGroupView'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function KeywordHarvestRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'
  const view = params.get('view') === 'ad-groups' ? 'ad-groups' : 'rules'

  const push = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k) }
    const q = next.toString()
    router.replace(q ? `?${q}` : '?', { scroll: false })
  }

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Harvest"
        subtitle="Rules that create targets from converting search terms — and the ad groups they map"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m === 'all' ? '' : m })}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="keyword-harvest" />

      <div className="h10-hv-viewseg" role="tablist" aria-label="Keyword Harvest view">
        <button
          type="button" role="tab" aria-selected={view === 'rules'}
          className={`seg ${view === 'rules' ? 'on' : ''}`}
          onClick={() => push({ view: '' })}
        >Rules View</button>
        <button
          type="button" role="tab" aria-selected={view === 'ad-groups'}
          className={`seg ${view === 'ad-groups' ? 'on' : ''}`}
          onClick={() => push({ view: 'ad-groups' })}
        >Ad Group View</button>
      </div>

      {view === 'ad-groups' ? (
        <HvAdGroupView />
      ) : (
        <RulesGrid
          tabKey="keyword-harvest"
          noun="Keyword Harvest Rule"
          builderHref="/marketing/ads/rules-automation/builder/keyword-harvesting"
          emptyLine="Create a Keyword Harvest Rule to generate suggestions for a campaign!"
        />
      )}
    </div>
  )
}
