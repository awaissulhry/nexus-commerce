'use client'

/**
 * The Keyword Harvest page (2026-10-11, wave 2; Owner GO 10-10: layout A+, a table like /products with every bulk
 * action, SELF-CONTAINED — every harvest action happens here, nothing hands off to Suggestions).
 *
 *   header      the section's (`AdsPageHeader` → the DS RulesHeader): title and market — no Change log, like the Bid page
 *               (everything is done here; nothing hands off to another page)
 *   tab bar     the Rules & Automation tabs
 *   tiles       four per view, from the view's own report (`onTotals`, after each read); each filters its view (`?show=`)
 *   switch      Terms · Rules · Sources (`?view=`; Terms writes no param), at the start of each view's toolbar
 *   the view    Terms (`terms/`, lane TERMS; its "Harvest to…" window `harvest-to/`, lane HTO) · Rules and Sources
 *               (`rules/`, `sources/`, lane HRULES)
 *
 * No Amazon Ads account in this business: one empty state, no table.
 */
import { useCallback, useEffect, useState } from 'react'
import { Megaphone } from 'lucide-react'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { EmptyState, MetricStrip, ToastProvider, type Metric } from '@/design-system/components'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import Link from '@/lib/workspaces/Link'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { useAdsMarketplace, useSharedAdsMarket } from '../../_shell/MarketplaceContext'
import { RulesTabs, rulesTabHeader } from '../_shared/tabs'
import type { CandidateTotals, ViewReport } from './_shared/types'
import { HARVEST_VIEWS, isHarvestView, nextShow, placeholderTiles, termsTiles, tileAccent, VIEW_LABEL, type HarvestView, type TileSpec } from './_shared/tiles'
import { isTermsShow, TermsView } from './terms'
import { HarvestRulesView, RULES_TILE_LABEL } from './rules'
import { HarvestSourcesView, SOURCES_TILE_LABEL } from './sources'
import styles from './_shared/harvest.module.css'

/** What the tiles draw from: each view's last report (null until it has read the market on show). */
interface Reports { terms: CandidateTotals | null; rules: ViewReport | null; sources: ViewReport | null }
const NO_REPORTS: Reports = { terms: null, rules: null, sources: null }

export function HarvestClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { readMarkets, ready } = useAdsMarketplace()
  const [market] = useSharedAdsMarket({ raw: params.get('market') })
  const raw = params.get('view')
  const view: HarvestView = isHarvestView(raw) ? raw : 'terms'
  const show = params.get('show')
  const [reports, setReports] = useState<Reports>(NO_REPORTS)
  // Every number belongs to one read of one market: a new market waits for its own.
  useEffect(() => { setReports(NO_REPORTS) }, [market])

  /** One place writes the address; the rest of the query is kept. */
  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const q = next.toString()
    router.replace(q ? `?${q}` : '?', { scroll: false })
  }, [router])

  const onTermsTotals = useCallback((t: CandidateTotals) => setReports((c) => ({ ...c, terms: t })), [])
  const onRulesTotals = useCallback((t: ViewReport) => setReports((c) => ({ ...c, rules: t })), [])
  const onSourcesTotals = useCallback((t: ViewReport) => setReports((c) => ({ ...c, sources: t })), [])

  const reported = view === 'terms' ? null : reports[view]
  // Every view shows its four tiles from the first frame: "—" until its report comes (audit S13), so nothing jumps.
  const tiles: TileSpec[] = view === 'terms' ? termsTiles(reports.terms)
    : reported ? reported.tiles.map((t) => ({ ...t }))
      : placeholderTiles(view === 'rules' ? RULES_TILE_LABEL : SOURCES_TILE_LABEL)
  const metrics: Metric[] = tiles.map((t) => {
    const next = nextShow(show, t)
    return {
      label: t.label,
      value: t.value ?? '—',
      ...(t.hint ? { hint: t.hint } : {}),
      accent: tileAccent(t),
      ...(next !== undefined ? { onClick: () => setQuery({ show: next, list: null, term: null, tab: null }), active: show === t.id } : {}),
    }
  })

  const noAds = ready && readMarkets.length === 0
  // The [Terms | Rules | Sources] switch, drawn at the start of each view's toolbar (the Bid page's place for it).
  const viewSwitch = (
    <SegmentedControl
      size="sm"
      ariaLabel="View"
      options={HARVEST_VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
      value={view}
      onChange={(v) => setQuery({ view: v === 'terms' ? null : v, show: null, list: null, term: null, tab: null })}
    />
  )

  return (
    <ToastProvider>
      <div className="h10-rules-page">
        <AdsPageHeader
          {...rulesTabHeader('keyword-harvest')}
          markets={readMarkets}
          market={market}
          onMarketChange={(m) => setQuery({ market: m && m !== 'all' ? m : null, term: null, tab: null })}
          showDataSync={false}
          showDateRange={false}
          showChangeLog={false}
        />
        <RulesTabs active="keyword-harvest" />
        {noAds ? (
          <div className={styles.page}>
            <EmptyState
              icon={<Megaphone size={20} aria-hidden />}
              title="No Amazon Ads account"
              action={<Button asChild size="sm" variant="secondary"><Link href="/settings/advertising">Connect Amazon Ads</Link></Button>}
            />
          </div>
        ) : (
          <div className={styles.page}>
            {metrics.length > 0 && <MetricStrip className={styles.tiles} metrics={metrics} />}
            {view === 'rules' ? <HarvestRulesView market={market} show={show} onTotals={onRulesTotals} viewSwitch={viewSwitch} />
              : view === 'sources' ? <HarvestSourcesView market={market} show={show} onTotals={onSourcesTotals} viewSwitch={viewSwitch} />
                : <TermsView market={market} show={isTermsShow(show) ? show : null} onTotals={onTermsTotals} viewSwitch={viewSwitch} />}
          </div>
        )}
      </div>
    </ToastProvider>
  )
}
