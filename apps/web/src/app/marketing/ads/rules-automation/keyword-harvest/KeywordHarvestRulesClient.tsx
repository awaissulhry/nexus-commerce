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
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
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

  /**
   * HP4 — the loop, closed: what harvesting has actually produced, on the page that manages it.
   * `census` comes from the cohort service (the post-graduation read no competitor ships). On a
   * failed read the strip is absent — supplementary context may be missing, never fabricated.
   */
  const [census, setCensus] = useState<{ cohort: number; served: number; pushable: number } | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/harvest-cohort?market=all`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j?.census) return
        setCensus({
          cohort: Number(j.census.cohort ?? 0),
          served: Number(j.census.byOutcome?.served ?? 0),
          pushable: Number(j.census.backlog?.pushable ?? 0),
        })
      })
      .catch(() => { /* absent, never invented */ })
    return () => { alive = false }
  }, [])

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Harvest"
        subtitle="Rules that create targets from converting search terms — and the ad groups they map"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m === 'all' ? '' : m })}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="keyword-harvest" />

      {/* HP3 — the DS SegmentedControl (the same primitive the dayparting GrainSwitch uses),
          replacing a hand-rolled div[role=tablist] with no arrow-key navigation. The wrapper
          class keeps the pill's placement styles. */}
      <div className="h10-hv-viewseg">
        <SegmentedControl
          value={view === 'ad-groups' ? 'ad-groups' : 'rules'}
          onChange={(v) => push({ view: v === 'ad-groups' ? 'ad-groups' : '' })}
          options={[{ value: 'rules', label: 'Rules View' }, { value: 'ad-groups', label: 'Ad Group View' }]}
        />
      </div>

      {view !== 'ad-groups' && census && (
        <p className="h10-hv-cohortline">
          <b>{census.cohort.toLocaleString('en-IE')}</b> keywords harvested by the engine to date · <b>{census.served.toLocaleString('en-IE')}</b> went on to serve
          {census.pushable > 0 && <> · <b>{census.pushable.toLocaleString('en-IE')}</b> exist locally and never reached Amazon</>}
          {' '}· rule output queues on <a className="h10-nt-open" href="/marketing/ads/suggestions">Suggestions</a>
        </p>
      )}
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
