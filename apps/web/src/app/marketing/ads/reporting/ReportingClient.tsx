'use client'

/**
 * RPX.5 — Reporting is four tabs on one route.
 *
 * ── What changed, and why it is a move rather than a rebuild ───────────────────
 *
 * This page was a report library: fourteen reports, per-market freshness, export, saved views,
 * scheduled deliveries, share links, console import. That is a genuinely good surface and no
 * competitor ships it — but it answers "which report do I open?", and the question an operator
 * arrives with is "how is the brand doing?". Helium 10 splits those into two pages; we keep one
 * route and put the strategy view in front, because a second rail entry is a second place to
 * look and the library is still what you want twice a week.
 *
 * So: Brand · Market share · Business · Library. The library is the fourth tab, unchanged —
 * same catalogue, same coverage endpoint, same grid, same idle-vs-broken derivation, same
 * routes underneath. Zero deletions in the whole change.
 *
 * ── The market selector is the page's, not each tab's ─────────────────────────
 *
 * Every strategy tab reads one market at a time, and for a reason that is different on each:
 * Brand because Amazon computes each benchmark against ONE market's category tree, Market share
 * because a share pooled across four markets invents a market nobody sells in, Business because
 * a blended TACoS hides exactly the market that moved. One control at the top, one answer.
 *
 * The tab and the market live in the URL, so a link to what you are looking at is the address bar
 * rather than a description of where to click.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Tabs } from '@/design-system/components/Tabs'
import { BrandTab } from './BrandTab'
import { MarketShareTab } from './MarketShareTab'
import { BusinessTab } from './BusinessTab'
import { ExplorerTab } from './ExplorerTab'
import { HourlyTab } from './HourlyTab'
import { LibraryTab } from './LibraryTab'
import { TodayBand } from './TodayBand'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

const TABS = [
  { id: 'brand', label: 'Brand' },
  { id: 'market-share', label: 'Market share' },
  { id: 'business', label: 'Business' },
  // GX.3 — the drill-down. It sits with the analysis tabs rather than in the Ad Manager, which is
  // the EXECUTION grid: its rows are things you change in bulk, these are things you read and
  // click through. (The Ad Manager also still renders its own <table>; adopting the shared grid
  // there is a data migration over two bespoke localStorage shapes, not a table swap.)
  { id: 'explorer', label: 'Explorer' },
  // GX.5 — the only feed on this page that is current to this hour. It sits after the analysis
  // tabs because "what is happening right now" is a different question from "how are we doing".
  { id: 'hourly', label: 'Hourly' },
  { id: 'library', label: 'Library' },
] as const

type TabId = (typeof TABS)[number]['id']

const SUBTITLES: Record<TabId, string> = {
  brand: 'Brand penetration against the category. Weekly — Amazon publishes this feed about eleven days in arrears.',
  'market-share': 'Our slice of the whole market, query by query. Weekly, roughly ten days in arrears.',
  business: 'What advertising costs the whole business, not just the ad account.',
  hourly: 'What is happening right now, and whether it is normal for this hour. UTC, because Amazon’s budget day is.',
  explorer: 'Where the money went — market to portfolio to campaign to product or target, every level adding up to the one above it.',
  library: 'Every ads number this console can produce.',
}

/**
 * The markets the console sells in. Hard-coded here exactly as the rest of the ads console does
 * it — the alternative is a fifth request on first paint to learn four strings that have not
 * changed in the life of the account.
 */
const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function ReportingClient() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const urlTab = params.get('tab')
  const tab: TabId = (TABS.some((t) => t.id === urlTab) ? urlTab : 'brand') as TabId
  const urlMarket = params.get('market')
  const market = urlMarket && (urlMarket === 'all' || MARKETS.includes(urlMarket)) ? urlMarket : 'IT'

  const [reloadKey, setReloadKey] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const push = useCallback((next: { tab?: string; market?: string }) => {
    const qs = new URLSearchParams(params.toString())
    if (next.tab) qs.set('tab', next.tab)
    if (next.market) qs.set('market', next.market)
    router.replace(`${pathname}?${qs}`, { scroll: false })
  }, [params, pathname, router])

  /**
   * Refresh re-mounts the tab's data, it does not reload the page.
   *
   * The button spins for a beat so the click is acknowledged even when the answer comes back
   * from cache in 40 ms — a control that looks inert is a control people press twice.
   */
  const onSync = useCallback(() => {
    setReloadKey((n) => n + 1)
    setSyncing(true)
    const t = window.setTimeout(() => setSyncing(false), 600)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => () => setSyncing(false), [])

  const body = useMemo(() => {
    switch (tab) {
      case 'market-share': return <MarketShareTab key={`ms-${market}-${reloadKey}`} market={market} />
      case 'business': return <BusinessTab key={`bz-${market}-${reloadKey}`} market={market} />
      case 'explorer': return <ExplorerTab key={`ex-${market}-${reloadKey}`} market={market} />
      case 'hourly': return <HourlyTab key={`hr-${market}-${reloadKey}`} market={market} />
      case 'library': return <LibraryTab reloadKey={reloadKey} />
      default: return <BrandTab key={`br-${market}-${reloadKey}`} market={market} />
    }
  }, [tab, market, reloadKey])

  return (
    <div className="rpt rpx-shell">
      <AdsPageHeader
        title="Reporting"
        subtitle={SUBTITLES[tab]}
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => push({ market: m })}
        // The library is market-agnostic — it lists reports, and every one of them carries its
        // own per-market freshness. Showing a market picker there would suggest it filters.
        showMarket={tab !== 'library'}
        showDataSync
        syncing={syncing}
        onDataSync={onSync}
        showDateRange={false}
      />

      <Tabs
        size="lg"
        ariaLabel="Reporting sections"
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={tab}
        onChange={(id) => push({ tab: id })}
      />

      {/* R5 — every feed on the first three tabs lands days behind; this one band does not. It
          reads the hourly stream, which is current to today in all four markets. It sits above
          the tab body rather than inside the library, because "what is happening right now" is
          the question a strategy page gets asked first. */}
      <TodayBand />

      {body}
    </div>
  )
}
