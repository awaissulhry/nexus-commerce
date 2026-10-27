'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the Owner's page to stop ads waste, all on it (Owner GO 10-10:
 * see, decide, approve or reject what waits, pause, negate, skip, undo — never sent to another page to finish a job).
 *
 * The redesign (2026-10-26, the Owner's yes to the canvas; BRIEF D1–D4, D16, D17) — the platform's list page, as Listings:
 *
 *   header   Advertising › Rules & Automation                                        [Italy ▾]  [Export ▾]
 *            Negative Targeting
 *            Amazon Italy · stops ads that spend with no orders · search terms to 24 Oct · checked 6 min ago
 *   tabs     the Rules & Automation tab bar (unchanged, shared with the other tabs)
 *   tiles    Wasting · Waiting for you · Kept paused · Blocked · Clashes · Protected, each with a hint line — each filters
 *            the view under it; each number comes from the read whose table it opens (Bid audit M1); on a phone Clashes
 *            and Protected stay off the strip (two rows of two) and are a Show pick away
 *   banners  a market Nexus only reads; the filter lists not read
 *   filters  ONE row (the DS FilterBar, inline): Portfolio · Campaign · Ad group · Product · Kind · Show, Clear; the
 *            picks as removable chips under it; a phone: one "Filters (n)" button and its sheet
 *   card     the view: [Wasting | Stopped | Words | Rules] — `?view=`; Wasting and Stopped are `waste/WasteView`, Words
 *            (step 4: a word that wastes across search terms, blocked as a negative phrase) `words/WordsView`, Rules lane
 *            NRVIEW's `rules/WasteRulesView`; one grid card each, a note line under it
 *   theme    this page follows the theme (Owner 10-26 "B"); the rest of the ads console stays light
 *
 * Two jobs on one page: OUR keyword or target that wastes is paused and KEPT paused (no rule, Brain or plan turns it on);
 * a SHOPPER'S search term that wastes gets a negative (exact, phrase or product; in the ad group or the whole campaign).
 * Every write is one review (counted Save, Done with Undo), through the same code as the Nexus MCP tools.
 *
 * Address: `?market=&view=&show=&kind=&q=&sort=&page=&pageSize=&row=&tab=` — one place writes it (`setQuery`):
 * the rest of the query is kept; a record's open is a step in the history (`useDetailParam`), everything else replaces.
 * The filter bar's lists are `?portfolio=&campaign=&adGroup=&product=` (`_shared/scopeFilter`; the old
 * `?scope=pf:|cp:|ag:<id>` is read once and written in those). A filter change goes back to the first page.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Download } from 'lucide-react'
import { SegmentedControl, TokenChip } from '@/design-system/primitives'
import { Banner, Listbox, Menu, MetricStrip, ToastProvider, useNarrow, type MenuItemDef, type Metric } from '@/design-system/components'
import { PageHeader, type FilterBarOption, type FilterDimension } from '@/design-system/patterns'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { useAdsMarketplace, useSharedAdsMarket, type AdsMarket } from '../../_shell/MarketplaceContext'
import { ALL_MARKETS, READING_ONLY, readingOnlyDetail } from '../../_shell/adsMarkets'
import { AdsScopeFilter, scopeChips } from '../_shared/scopeFilter/AdsScopeFilter'
import { scopeDimensions } from '../_shared/scopeFilter/scopeFilterModel'
import { useScopeFilter } from '../_shared/scopeFilter/useScopeFilter'
import { NO_MARKET, rulesMarketOptions } from '../_shared/rulesFrame'
import { RULES_BASE, RulesTabs, rulesTabHeader } from '../_shared/tabs'
import { currencyOf } from '../bid/_shared/format'
import { WasteRulesView } from './rules/WasteRulesView'
import { WasteView } from './waste/WasteView'
import { WordsView } from './words/WordsView'
import { wordShowOf } from './words/wordsModel'
import { readRows, readStopped } from './waste/wasteApi'
import {
  DEFAULT_PAGE_SIZE, headerLine, kindOf, KIND_WORDS, ownFilterCount, PAGE_SIZES, stoppedChips, stoppedShowOf, tileQuery, tilesOf, viewOf, wastingChips, wastingShowOf,
  type KindFilter, type TileId,
} from './waste/wasteModel'
import type { StoppedTotals, WasteCriteria, WasteFreshness, WasteTotals } from './waste/wasteTypes'
import styles from './negatives.module.css'

const VIEWS = [{ value: 'wasting', label: 'Wasting' }, { value: 'stopped', label: 'Stopped' }, { value: 'words', label: 'Words' }, { value: 'rules', label: 'Rules' }]
const PAGE = '/marketing/ads/rules-automation/negative-targeting'
/** D2 — the crumbs above the title (links). */
const CRUMBS = [{ label: 'Advertising', href: '/marketing/ads/dashboard' }, { label: 'Rules & Automation', href: RULES_BASE }]
const TILE_ACCENT: Readonly<Record<TileId, string>> = {
  wasting: 'var(--nds-danger)', waiting: 'var(--nds-warning)', kept: 'var(--nds-primary)', blocked: 'var(--nds-info)', clashes: 'var(--nds-border-strong)',
  // Step 4 — the shield's tone (a protected row's state mark).
  protected: 'var(--nds-success)',
}
/** On a phone the strip keeps four tiles (two rows of two); these are a filter away (Show). */
const PHONE_HIDDEN: ReadonlySet<TileId> = new Set<TileId>(['clashes', 'protected'])
const KIND_ORDER: readonly KindFilter[] = ['all', 'keyword', 'term']

/**
 * A Show field's options for the bar: each pick with its count ("Wasting 9"). The view's default pick is the empty
 * value, so the bar counts a field as filtering only off its default (and the address keeps no `?show=` for it).
 */
const showOptions = (chips: ReadonlyArray<{ id: string; label: string; count?: number | null }>, fallback: string): FilterBarOption[] =>
  chips.map((c) => ({ value: c.id === fallback ? '' : c.id, label: c.label, ...(typeof c.count === 'number' ? { count: c.count } : {}) }))

/** Six tiles on one row down to a ~1,000 px window (the content is then ~930 px wide); a phone keeps two per row (DS). */
const TILE_MIN = 140

export function NegativesClient() {
  return <ToastProvider><NegativesPage /></ToastProvider>
}

function NegativesPage() {
  const router = useRouter()
  const params = useSearchParams()
  const phone = useNarrow()
  const ads = useAdsMarketplace()
  const { readMarkets } = ads
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
  // D2 / D3 — the server's test (its window) and how fresh its numbers are: from whichever Wasting read ran last.
  const [facts, setFacts] = useState<{ criteria: WasteCriteria | null; freshness: WasteFreshness | null }>({ criteria: null, freshness: null })
  const [tilesKey, setTilesKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const filterKey = JSON.stringify([market, filter.key, q])
  useEffect(() => { setWasteTotals(null); setStoppedTotals(null) }, [filterKey])
  // The view on screen reports its own totals; the other view's are read here (one row, the same filters).
  useEffect(() => {
    const ctl = new AbortController()
    const base = { market, lists: filter.api, kind: 'all' as const, q, page: 1, pageSize: 1 }
    if (view !== 'wasting') {
      readRows({ ...base, show: 'wasting' }, ctl.signal)
        .then((a) => { setWasteTotals(a.totals); setFacts({ criteria: a.criteria ?? null, freshness: a.freshness ?? null }) })
        .catch(() => { if (!ctl.signal.aborted) setWasteTotals(null) })
    }
    if (view !== 'stopped') readStopped({ ...base, show: 'all' }, ctl.signal).then((a) => setStoppedTotals(a.totals)).catch(() => { if (!ctl.signal.aborted) setStoppedTotals(null) })
    return () => ctl.abort()
  }, [view, filterKey, tilesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const onTotals = useCallback((t: WasteTotals | StoppedTotals) => {
    if ('wasting' in t) setWasteTotals(t)
    else setStoppedTotals(t)
  }, [])
  const onWrote = useCallback(() => setTilesKey((n) => n + 1), [])

  const tiles = useMemo(() => tilesOf({
    waste: wasteTotals, stopped: stoppedTotals, view, wastingShow, stoppedShow, currency: currencyOf(market), windowDays: facts.criteria?.windowDays ?? null,
  }), [wasteTotals, stoppedTotals, view, wastingShow, stoppedShow, market, facts.criteria?.windowDays])
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

  // ── D2: the header's Export ▾ holds the view's own items (each view hands them up, and takes them back when it goes) ──
  const [exportItems, setExportItems] = useState<MenuItemDef[] | null>(null)

  // ── D4: the view's own fields in the filter bar (Kind, Show), each pick also a chip ──
  const [wordShows, setWordShows] = useState<Array<{ value: string; label: string; count?: number }> | null>(null)
  useEffect(() => { if (view !== 'words') setWordShows(null) }, [view])
  const ownFields = useMemo((): { dims: FilterDimension[]; active: number } => {
    const kindField: FilterDimension = {
      key: 'kind', label: 'Kind', kind: 'listbox', value: kind === 'all' ? '' : kind,
      options: KIND_ORDER.map((k) => ({ value: k === 'all' ? '' : k, label: KIND_WORDS[k] })),
      onChange: (next: string) => setQuery({ kind: next || null, page: null }),
    }
    const showField = (options: FilterBarOption[], value: string): FilterDimension => ({
      key: 'show', label: 'Show', kind: 'listbox', value, options, onChange: (next: string) => setQuery({ show: next || null, page: null }),
    })
    if (view === 'wasting') {
      return { dims: [kindField, showField(showOptions(wastingChips(wasteTotals), 'wasting'), wastingShow === 'wasting' ? '' : wastingShow)], active: ownFilterCount('wasting', kind, wastingShow) }
    }
    if (view === 'stopped') {
      return { dims: [kindField, showField(showOptions(stoppedChips(stoppedTotals), 'all'), stoppedShow === 'all' ? '' : stoppedShow)], active: ownFilterCount('stopped', kind, stoppedShow) }
    }
    if (view === 'words' && wordShows) {
      // Words come from shoppers' search terms: no Kind. Its Show picks are the view's own (WordsView hands them up).
      const w = wordShowOf(rawShow)
      return { dims: [showField(wordShows.map((o) => ({ ...o, value: o.value === 'wasting' ? '' : o.value })), w === 'wasting' ? '' : w)], active: w === 'wasting' ? 0 : 1 }
    }
    return { dims: [], active: 0 }
  }, [view, kind, wastingShow, stoppedShow, rawShow, wasteTotals, stoppedTotals, wordShows, setQuery])
  const clearOwn = useMemo(() => (view === 'rules' ? undefined : { kind: null, show: null }), [view])

  const lists = useMemo(() => scopeDimensions(filter.picks, filter.index, filter.state, filter.error), [filter.picks, filter.index, filter.state, filter.error])
  const chips: ReactNode[] = [
    ...scopeChips(lists).map((c) => (
      <TokenChip key={`${c.key}:${c.id}`} removeLabel={c.removeLabel} onRemove={() => filter.set(c.key, filter.picks[c.key].filter((x) => x !== c.id))}>{c.text}</TokenChip>
    )),
    ...((view === 'wasting' || view === 'stopped') && kind !== 'all' ? [
      <TokenChip key="kind" removeLabel={`Show every kind, not only ${KIND_WORDS[kind]}`} onRemove={() => setQuery({ kind: null, page: null })}>Kind: {KIND_WORDS[kind]}</TokenChip>,
    ] : []),
  ]

  // The rule builder is a full page (Owner 2026-10-11): while it is open nothing of this page is under it (the Rules view
  // stays mounted in place, so its own state — and the step it pushed in the history — is kept).
  const building = view === 'rules' && !!(params.get('builder') || params.get('ruleId'))

  return (
    // D17 — this page follows the theme: its root is the DS's responsive scope (the ads shell around it stays light). The
    // rule builder page opened from the Rules view stays as it is today, light (Owner 2026-10-11: not restyled unasked).
    <div className={building ? 'h10-rules-page' : `h10-rules-page nds-theme-responsive ${styles.root}`}>
      {!building && (
        <NegativesHeader
          market={market}
          markets={readMarkets}
          known={ads.markets}
          onMarket={(m) => {
            if (m === NO_MARKET) return
            // The operator's own move also moves the shared market the next ads page starts from (AM-28), as RulesHeader does.
            if (m === ALL_MARKETS || readMarkets.includes(m)) ads.setScopeMarket(m)
            setQuery({ market: m && m !== 'all' ? m : null, page: null, row: null, word: null, tab: null })
          }}
          writeAccess={ads.writeAccess}
          subtitle={headerLine({ market, freshness: facts.freshness })}
          exportItems={phone ? null : exportItems}
        />
      )}
      {!building && <RulesTabs active="negative-targeting" />}
      <div className={styles.page}>
        {!building && <MetricStrip className={styles.tiles} metrics={metrics} minTileWidth={TILE_MIN} />}
        {!building && (
          <div className={styles.filters}>
            <AdsScopeFilter filter={filter} layout="inline" extraDimensions={ownFields.dims} extraActive={ownFields.active} clearExtra={clearOwn} />
          </div>
        )}
        {!building && chips.length > 0 && <div className={styles.chips} role="group" aria-label="This page shows only">{chips}</div>}
        {view === 'rules' ? (
          <WasteRulesView market={market ?? 'all'} viewSwitch={viewSwitch} scope={filter} onExportItems={setExportItems} />
        ) : view === 'words' ? (
          <WordsView market={market} viewSwitch={viewSwitch} show={rawShow} q={q} scope={filter} sort={sort} page={page} pageSize={pageSize}
            canWrite={canWrite} setQuery={setQuery} onWrote={onWrote} refreshKey={refreshKey}
            showInBar onShowOptions={setWordShows} onExportItems={setExportItems} />
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
            onExportItems={setExportItems}
            onRead={setFacts}
          />
        )}
      </div>
    </div>
  )
}

/**
 * D2 — the DS PageHeader: the crumbs (links), the title, ONE live line; the market picker (the Rules & Automation
 * header's own control: a DS Listbox of the markets Nexus reads, "Amazon market") and Export ▾ (the view's items; none
 * on a phone, as today). A market Nexus only reads says so once, under the header, as RulesHeader does.
 */
function NegativesHeader({ market, markets, known, onMarket, writeAccess, subtitle, exportItems }: {
  market: string
  markets: string[]
  known: readonly AdsMarket[]
  onMarket(m: string): void
  writeAccess(m: string): { canWrite: boolean; reason: string | null }
  subtitle: string
  exportItems: MenuItemDef[] | null
}) {
  const options = useMemo(() => rulesMarketOptions({
    markets: markets.map((code) => {
      const k = known.find((x) => x.code === code)
      const readingOnly = !!k && !k.launchable
      return { code, note: readingOnly ? 'reading only' : null, whyNot: readingOnly ? k?.whyNot ?? null : null }
    }),
    value: market,
    allowAll: true,
  }), [markets, known, market])
  const readOnly = market && market !== ALL_MARKETS && markets.includes(market) ? writeAccess(market) : null
  const title = rulesTabHeader('negative-targeting').title
  return (
    <>
      <PageHeader
        eyebrow={(
          <nav aria-label="Breadcrumb">
            {CRUMBS.map((c, i) => (
              <span key={c.href}>{i > 0 && <span aria-hidden> › </span>}<Link href={c.href}>{c.label}</Link></span>
            ))}
          </nav>
        )}
        title={title}
        subtitle={subtitle}
        actions={(
          <div className={styles.acts}>
            <Listbox size="sm" width={168} ariaLabel="Amazon market" options={options} value={market} onChange={onMarket} />
            {exportItems && (
              <Menu align="right" label={<><Download size={13} aria-hidden /> Export <ChevronDown size={13} aria-hidden /></>} items={exportItems} triggerProps={{ className: 'nds-btn sm' }} />
            )}
          </div>
        )}
      />
      {readOnly && !readOnly.canWrite && (
        <div className={styles.readOnly}>
          <Banner tone="info" title={READING_ONLY}>{readingOnlyDetail(readOnly.reason)}</Banner>
        </div>
      )}
    </>
  )
}
