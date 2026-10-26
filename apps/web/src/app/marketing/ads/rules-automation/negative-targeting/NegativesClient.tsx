'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the Owner's page to stop ads waste, all on it (Owner GO 10-10:
 * see, decide, approve or reject what waits, pause, negate, skip, undo — never sent to another page to finish a job).
 *
 *   header   Negative Targeting                                                       [Amazon IT ▾]
 *   tabs     the Rules & Automation tab bar
 *   tiles    Wasting · Waiting for you · Kept paused · Blocked · Clashes · Protected — each filters the view under it; each
 *            number comes from the read whose table it opens (Bid audit M1); on a phone Clashes and Protected stay off
 *            the strip (two rows of two) and are a filter away (Show ▾)
 *   view     [Wasting | Stopped | Words | Rules] — `?view=`; Wasting and Stopped are `waste/WasteView`, Words (step 4,
 *            2026-10-25: a word that wastes across search terms, blocked as a negative phrase) is `words/WordsView`, Rules
 *            is lane NRVIEW's `rules/WasteRulesView`
 *
 * Two jobs on one page: OUR keyword or target that wastes is paused and KEPT paused (no rule, Brain or plan turns it on);
 * a SHOPPER'S search term that wastes gets a negative (exact, phrase or product; in the ad group or the whole campaign).
 * Every write is one review (counted Save, Done with Undo), through the same code as the Nexus MCP tools.
 *
 * Address: `?market=&view=&show=&kind=&q=&sort=&page=&pageSize=&row=&tab=` — one place writes it (`setQuery`):
 * the rest of the query is kept; a record's open is a step in the history (`useDetailParam`), everything else replaces.
 *
 * The filter bar (2026-10-12, `_shared/scopeFilter`) sits under the tab bar: Portfolio · Campaign · Ad group · Product
 * (`?portfolio=&campaign=&adGroup=&product=`; the old `?scope=pf:|cp:|ag:<id>` is read once and written in those).
 * Wasting and Stopped — rows, tiles, select all, Export — are read with it; the Rules view keeps the rules that can act on
 * a pick (the Brain and Harvest rows always show). A filter change goes back to the first page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SegmentedControl } from '@/design-system/primitives'
import { MetricStrip, ToastProvider, useNarrow, type Metric } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { useAdsMarketplace, useSharedAdsMarket } from '../../_shell/MarketplaceContext'
import { AdsScopeFilter } from '../_shared/scopeFilter/AdsScopeFilter'
import { useScopeFilter } from '../_shared/scopeFilter/useScopeFilter'
import { RulesTabs, rulesTabHeader } from '../_shared/tabs'
import { currencyOf } from '../bid/_shared/format'
import { WasteRulesView } from './rules/WasteRulesView'
import { WasteView } from './waste/WasteView'
import { WordsView } from './words/WordsView'
import { readRows, readStopped } from './waste/wasteApi'
import {
  DEFAULT_PAGE_SIZE, kindOf, PAGE_SIZES, stoppedShowOf, tileQuery, tilesOf, viewOf, wastingShowOf, type TileId,
} from './waste/wasteModel'
import type { StoppedTotals, WasteTotals } from './waste/wasteTypes'
import styles from './negatives.module.css'

const VIEWS = [{ value: 'wasting', label: 'Wasting' }, { value: 'stopped', label: 'Stopped' }, { value: 'words', label: 'Words' }, { value: 'rules', label: 'Rules' }]
const PAGE = '/marketing/ads/rules-automation/negative-targeting'
const TILE_ACCENT: Readonly<Record<TileId, string>> = {
  wasting: 'var(--nds-danger)', waiting: 'var(--nds-warning)', kept: 'var(--nds-primary)', blocked: 'var(--nds-info)', clashes: 'var(--nds-border-strong)',
  // Step 4 — the shield's tone (a protected row's state mark).
  protected: 'var(--nds-success)',
}
/** On a phone the strip keeps four tiles (two rows of two); these are a filter away (Show ▾). */
const PHONE_HIDDEN: ReadonlySet<TileId> = new Set<TileId>(['clashes', 'protected'])

export function NegativesClient() {
  return <ToastProvider><NegativesPage /></ToastProvider>
}

function NegativesPage() {
  const router = useRouter()
  const params = useSearchParams()
  const phone = useNarrow()
  const { readMarkets } = useAdsMarketplace()
  const [market] = useSharedAdsMarket({ raw: params.get('market') })
  // The server's own gate for every write here (permissions-manifest: /api/advertising writes).
  const canWrite = usePermission('ads.campaigns.manage')

  const view = viewOf(params.get('view'))
  const rawShow = params.get('show')
  const wastingShow = wastingShowOf(rawShow)
  const stoppedShow = stoppedShowOf(rawShow)
  const kind = kindOf(params.get('kind'))
  const q = params.get('q') ?? ''
  const filter = useScopeFilter(market, { clear: ['page'] })
  const sort = params.get('sort')
  const page = Math.max(1, Number(params.get('page')) || 1)
  const sizeParam = Number(params.get('pageSize'))
  const pageSize = (PAGE_SIZES as readonly number[]).includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE

  /** One place writes the address: the rest of the query is kept. */
  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const s = next.toString()
    router.replace(s ? `?${s}` : '?', { scroll: false })
  }, [router])

  // ── the tiles: each number from the read whose table it opens ──
  const [wasteTotals, setWasteTotals] = useState<WasteTotals | null>(null)
  const [stoppedTotals, setStoppedTotals] = useState<StoppedTotals | null>(null)
  const [tilesKey, setTilesKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const filterKey = JSON.stringify([market, filter.key, q])
  useEffect(() => { setWasteTotals(null); setStoppedTotals(null) }, [filterKey])
  // The view on screen reports its own totals; the other view's are read here (one row, the same filters).
  useEffect(() => {
    const ctl = new AbortController()
    const base = { market, lists: filter.api, kind: 'all' as const, q, page: 1, pageSize: 1 }
    if (view !== 'wasting') readRows({ ...base, show: 'wasting' }, ctl.signal).then((a) => setWasteTotals(a.totals)).catch(() => { if (!ctl.signal.aborted) setWasteTotals(null) })
    if (view !== 'stopped') readStopped({ ...base, show: 'all' }, ctl.signal).then((a) => setStoppedTotals(a.totals)).catch(() => { if (!ctl.signal.aborted) setStoppedTotals(null) })
    return () => ctl.abort()
  }, [view, filterKey, tilesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const onTotals = useCallback((t: WasteTotals | StoppedTotals) => {
    if ('wasting' in t) setWasteTotals(t)
    else setStoppedTotals(t)
  }, [])
  const onWrote = useCallback(() => setTilesKey((n) => n + 1), [])

  const tiles = useMemo(() => tilesOf({ waste: wasteTotals, stopped: stoppedTotals, view, wastingShow, stoppedShow, currency: currencyOf(market) }), [wasteTotals, stoppedTotals, view, wastingShow, stoppedShow, market])
  const metrics: Metric[] = tiles
    .filter((t) => !(phone && PHONE_HIDDEN.has(t.id)))
    .map((t) => ({
      label: <span title={t.title}>{phone ? t.short : t.label}</span>,
      value: t.value ?? '—',
      hint: t.hint,
      accent: t.value ? TILE_ACCENT[t.id] : 'var(--nds-border-strong)',
      ...(t.clickable || t.active ? { onClick: () => { setQuery(tileQuery(t.id, t.active)); setRefreshKey((n) => n + 1) }, active: t.active } : {}),
    }))

  const ruleHref = useCallback((ruleId: string) => {
    const s = new URLSearchParams({ view: 'rules', rule: ruleId })
    if (market && market !== 'all') s.set('market', market)
    return `${PAGE}?${s}`
  }, [market])

  const viewSwitch = (
    <SegmentedControl size="sm" ariaLabel="View" options={VIEWS} value={view}
      onChange={(v) => setQuery({ view: v === 'wasting' ? null : v, show: null, sort: null, page: null, row: null, word: null, tab: null, rule: null })} />
  )

  // The rule builder is a full page (Owner 2026-10-11): while it is open nothing of this page is under it (the Rules view
  // stays mounted in place, so its own state — and the step it pushed in the history — is kept).
  const building = view === 'rules' && !!(params.get('builder') || params.get('ruleId'))

  return (
    <div className="h10-rules-page">
      {!building && (
        <AdsPageHeader
          {...rulesTabHeader('negative-targeting')}
          markets={readMarkets}
          market={market}
          onMarketChange={(m) => setQuery({ market: m && m !== 'all' ? m : null, page: null, row: null, word: null, tab: null })}
          showDataSync={false}
          showDateRange={false}
          showChangeLog={false}
        />
      )}
      {!building && <RulesTabs active="negative-targeting" />}
      <div className={styles.page}>
        {!building && <AdsScopeFilter filter={filter} />}
        {!building && <MetricStrip className={styles.tiles} metrics={metrics} />}
        {view === 'rules' ? (
          <WasteRulesView market={market ?? 'all'} viewSwitch={viewSwitch} scope={filter} />
        ) : view === 'words' ? (
          <WordsView market={market} viewSwitch={viewSwitch} show={rawShow} q={q} scope={filter} sort={sort} page={page} pageSize={pageSize}
            canWrite={canWrite} setQuery={setQuery} onWrote={onWrote} refreshKey={refreshKey} />
        ) : (
          // Keyed by the tab: each list keeps its own saved layout (widths, order). Unkeyed, the grid read the first
          // tab's layout once and the second tab opened with it, then saved it over its own (grid audit B7).
          <WasteView
            key={view}
            view={view}
            market={market}
            viewSwitch={viewSwitch}
            show={view === 'wasting' ? wastingShow : stoppedShow}
            kind={kind}
            q={q}
            scope={filter}
            sort={sort}
            page={page}
            pageSize={pageSize}
            canWrite={canWrite}
            setQuery={setQuery}
            onTotals={onTotals}
            onWrote={onWrote}
            refreshKey={refreshKey}
            ruleHref={ruleHref}
          />
        )}
      </div>
    </div>
  )
}
