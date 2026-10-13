'use client'

/**
 * Google Ads — /marketing/ads/google, the third value of the Ads console's channel switch (step 1a PLAN.md L8; step 1b
 * PLAN-1B.md M3).
 *
 * READ ONLY: Google's campaigns and numbers as Google reports them, in the account's own currency and time zone.
 * Nexus changes nothing in Google Ads here — there is no write control on this page, and "Read now" only asks Nexus
 * to read Google again (S, at most once an hour).
 *
 *   header      date range · Read now
 *   cards       "Needs a look" (R14 alerts) · "Google acts on its own" (R12 summary)
 *   numbers     the step-1a tiles and the daily chart, unchanged
 *   tabs        Campaigns | Search terms | Products | Disapprovals | Google acts on its own | Google's recommendations
 *               (`?view=`; Campaigns writes none). A campaign opens in its window (`?campaign=&tab=`, WB's
 *               `GoogleCampaignModal`): Back closes it, an alert's Open lands on it.
 *
 * `googlePageState` (./googleAds.ts) decides what may render: outside `ok` (and a failed read that still has an
 * earlier good one) the page shows words and one way forward, never a number, a chart or a grid.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { AsOf, Banner, Card, EmptyState, Listbox, MetricStrip, PerformanceGraph, Tabs, tabPanelProps, type Metric } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import {
  fetchAllGoogleCampaigns,
  fetchGoogleOverview,
  requestGoogleRead,
  type GoogleCampaign,
  type GoogleOverview,
} from '@/lib/google-ads/contract'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { lastCompleteDays } from '../_shell/DateRangePicker'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleActsCard, GoogleActsPanel } from './GoogleActsPanel'
import { GoogleAlertsCard } from './GoogleAlertsCard'
import { GoogleCampaignModal, useGoogleCampaignParam } from './GoogleCampaignModal'
import { GoogleDisapprovalsTab } from './GoogleDisapprovalsTab'
import { GoogleProductsGrid } from './GoogleProductsGrid'
import { GoogleRecommendationsTab } from './GoogleRecommendationsTab'
import { GoogleSearchTermsGrid } from './GoogleSearchTermsGrid'
import {
  CAMPAIGN_COLUMN_ORDER,
  STATUS_FILTER_OPTIONS,
  type CampaignColumnKey,
  type MetricColumnKey,
  TYPE_FILTER_OPTIONS,
  biddingLabel,
  budgetText,
  campaignStatusLabel,
  campaignTypeLabel,
  chartHasMoney,
  chartPoints,
  comparedWindow,
  coverageNote,
  dataLine,
  formatMoney,
  googlePageState,
  metricColumns,
  metricTiles,
  provisionalDays,
  provisionalNote,
  readNowNote,
  servingText,
  sortable,
  toMinor,
  formatWindow,
  ymd,
} from './googleAds'
import { viewOf, viewSearch, viewTabs, type AlertTarget, type GoogleView } from './googleAttention'
import { forgetGoogleReads, googleReadKey, useGoogleRead } from './useGoogleRead'
import './google.css'

/** The id the tab bar and its panel share (`aria-controls` and `aria-labelledby`). */
const VIEW_TABS_ID = 'gads-view'

export function GoogleAdsClient() {
  const router = useRouter()
  const params = useSearchParams()
  const view = viewOf(params.get('view'))
  const detail = useGoogleCampaignParam()
  const [range, setRange] = useState(() => lastCompleteDays(30))
  const [account, setAccount] = useState<string | null>(null)
  const from = ymd(range.start)
  const to = ymd(range.end)

  // ── R1: the account and its numbers. While a new window loads, the last answer stays on screen. ──
  const overview = useGoogleRead<GoogleOverview>(
    googleReadKey('overview', account, from, to),
    () => fetchGoogleOverview({ account, from, to }),
    { keepPrevious: true, cache: false, fallbackError: 'Nexus could not load the Google Ads numbers.' },
  )
  const shown = overview.data
  const compared = shown ? comparedWindow(shown) : null
  const page = googlePageState({ loading: overview.loading, error: overview.error, overview: shown })

  // ── R2: the campaigns, only when the page may show numbers ────────────
  const campaigns = useGoogleRead(
    page.showData ? googleReadKey('campaigns', account, from, to) : null,
    () => fetchAllGoogleCampaigns({ account, from, to }),
    { cache: false, fallbackError: 'Nexus could not load the campaigns.' },
  )

  // ── Read now (S) ──────────────────────────────────────────────────────
  const [reading, setReading] = useState(false)
  const [readNote, setReadNote] = useState<ReturnType<typeof readNowNote> | null>(null)
  const readNow = useCallback(async () => {
    if (reading) return
    setReading(true)
    setReadNote(null)
    try {
      const answer = await requestGoogleRead(account)
      // A new read is coming: what the page keeps is read again when it is shown next.
      if (answer.queued) forgetGoogleReads()
      setReadNote(readNowNote(answer))
    } catch (err) {
      setReadNote(readNowNote({ error: err instanceof Error ? err.message : 'the server did not answer.' }))
    } finally {
      setReading(false)
    }
  }, [account, reading])

  // ── The tabs (?view=), and where an alert's Open goes ─────────────────
  const tabsRef = useRef<HTMLDivElement>(null)
  const setView = useCallback((next: GoogleView, reveal = false) => {
    const q = viewSearch(window.location.search, next)
    router.replace(q ? `?${q}` : '?', { scroll: false })
    if (reveal) tabsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [router])
  const openTarget = useCallback((t: AlertTarget) => {
    if (t.kind === 'campaign') detail.open(t.campaignId, t.tab)
    else setView(t.view, true)
  }, [detail, setView])
  const openCampaign = useCallback((campaignId: string, tab?: string) => detail.open(campaignId, tab ?? null), [detail])

  const currency = shown?.currency ?? null
  const nextReadAt = page.account?.read.nextReadAt ?? null
  // The window as the server answered it (the grids and the campaign window read the same days as the tiles).
  const winFrom = shown?.window.from ?? from
  const winTo = shown?.window.to ?? to
  const win = useMemo(() => ({ from: winFrom, to: winTo }), [winFrom, winTo])
  const columns = useMemo(() => campaignColumns(currency), [currency])
  const filters: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleCampaign).status ?? '' },
    { key: 'type', label: 'Type', kind: 'select', options: TYPE_FILTER_OPTIONS, placeholder: 'All', value: (r) => campaignTypeLabel((r as GoogleCampaign).type) },
  ], [])
  const campaignRows = campaigns.data?.items ?? null
  const tabs = useMemo(() => viewTabs({
    // A count only when the whole list is loaded; never a 0 for a list not read.
    campaigns: campaignRows && !campaigns.data?.truncated ? campaignRows.length : null,
  }), [campaignRows, campaigns.data?.truncated])

  const accounts = shown?.accounts ?? []
  const accountOptions = accounts.filter((a) => a.ads).map((a) => ({ value: a.connectionId, label: a.ads?.name?.trim() || a.label || 'Google Ads account' }))

  return (
    <div className="h10-am gads-root">
      <AdsPageHeader
        channel="google"
        title="Google Ads"
        subtitle="Campaigns and daily numbers as Google reports them. Nexus reads them and changes nothing in Google Ads."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showMarket={false}
        dateRange={range}
        onDateRange={(start, end) => setRange({ start, end })}
        showDataSync={page.canReadNow}
        onDataSync={() => { void readNow() }}
        syncing={reading}
        dataSyncLabel={reading ? 'Asking Google…' : 'Read now'}
        dataSyncTip="Ask Nexus to read this Google Ads account again now (at most once an hour). It changes nothing in Google Ads."
      />

      {readNote && <Banner tone={readNote.tone} onDismiss={() => setReadNote(null)}>{readNote.text}</Banner>}

      {accountOptions.length > 1 && (
        <div className="gads-toolbar">
          <span className="gads-meta">Google Ads account</span>
          <Listbox ariaLabel="Google Ads account" options={accountOptions} width={280}
            value={account ?? page.account?.connectionId ?? accountOptions[0]!.value}
            onChange={(value) => { setAccount(value); detail.close() }} />
        </div>
      )}

      {page.kind === 'loading' && (
        <div className="gads-root" aria-busy="true" aria-label="Loading Google Ads">
          <Skeleton height={72} radius="var(--nds-radius-lg)" />
          <Skeleton height={260} radius="var(--nds-radius-lg)" />
        </div>
      )}

      {page.kind === 'load_error' && (
        <Banner tone="danger" title={page.title ?? undefined} action={<Button onClick={overview.reload}>Try again</Button>}>
          {page.text}
        </Banner>
      )}

      {!page.showData && page.kind !== 'loading' && page.kind !== 'load_error' && (
        <Card padded>
          <EmptyState
            title={page.title}
            description={page.text}
            action={page.action ? <Button asChild variant="primary"><Link href={page.action.href}>{page.action.label}</Link></Button> : undefined}
          />
        </Card>
      )}

      {page.showData && shown && (
        <>
          {page.banner && <Banner tone={page.banner.tone} title={page.banner.title}>{page.banner.text}</Banner>}
          <p className="gads-meta">
            <span>Read from Google <AsOf at={shown.dataAsOf ?? page.account?.read.lastReadAt ?? null} kind="event" /></span>
            {dataLine(shown, page.account).map((part) => <span key={part}>· {part}</span>)}
          </p>

          <div className="gads-cards">
            <GoogleAlertsCard account={account} currency={currency} onOpen={openTarget} />
            <GoogleActsCard account={account} onSeeAll={() => setView('on-its-own', true)} />
          </div>

          {coverageNote(shown) && <Banner tone="warning">{coverageNote(shown)}</Banner>}

          <MetricStrip metrics={metricTiles(shown).map((t): Metric => ({
            label: t.label,
            value: t.value,
            hint: t.hint,
            delta: t.delta ? { value: t.delta.text, positive: t.delta.good } : undefined,
          }))} />
          {compared && (
            <p className="gads-meta">Changes compare with {formatWindow(compared.from, compared.to)}, which Nexus read in full.</p>
          )}

          <Card header="Cost and conversion value per day" description="A day Nexus has not read is a gap in the lines, not a zero.">
            {chartHasMoney(shown.days) && currency ? (
              <PerformanceGraph
                data={chartPoints(shown.days, currency)}
                xKey="day"
                left={{ key: 'cost', label: 'Cost', axisLabel: `Cost (${currency})`, color: chart.cap, axis: 'left', format: (v) => formatMoney(toMinor(v, currency), currency) }}
                right={{ key: 'value', label: 'Conversion value', axisLabel: `Conversion value (${currency})`, color: chart.actual, axis: 'right', format: (v) => formatMoney(toMinor(v, currency), currency) }}
                height={240}
              />
            ) : (
              <p className="gads-meta">No cost or conversion value to draw for these days.</p>
            )}
            {provisionalNote(provisionalDays(shown.days, shown.window.provisionalFrom)) && (
              <p className="gads-note">{provisionalNote(provisionalDays(shown.days, shown.window.provisionalFrom))}</p>
            )}
          </Card>

          <div className="gads-tabs" ref={tabsRef}>
            <Tabs size="lg" dense overflow="scroll" ariaLabel="Google Ads views" idBase={VIEW_TABS_ID}
              tabs={tabs} active={view} onChange={(id) => setView(viewOf(id))} />
          </div>

          <div className="gads-view" {...tabPanelProps(VIEW_TABS_ID, view)}>
            {view === 'campaigns' && (
              <>
                {campaigns.error && (
                  <Banner tone="danger" title="The campaigns could not be loaded" action={<Button onClick={campaigns.reload}>Try again</Button>}>
                    {campaigns.error}
                  </Banner>
                )}
                {campaigns.data?.truncated && (
                  <Banner tone="warning">This account has more campaigns than this page loads at once; the list and its totals show the first ones only.</Banner>
                )}
                <AdsDataGrid<GoogleCampaign>
                  rows={campaignRows ?? []}
                  loading={campaigns.loading}
                  rowId={(r) => r.campaignId}
                  noun="Campaign"
                  firstColLabel="Campaign"
                  renderFirst={(r) => <span className="gads-camp" title={r.name}>{r.name}</span>}
                  firstSortValue={(r) => r.name.toLowerCase()}
                  columns={columns}
                  filters={filters}
                  filtersDefaultOpen={false}
                  searchable
                  searchPlaceholder="Search campaigns…"
                  searchValue={(r) => r.name}
                  showTotal
                  totalFirst="Total of the campaigns shown"
                  defaultSort={{ key: 'cost', dir: 'desc' }}
                  enabledFirst={(r) => r.status}
                  storageKey="h10-google-campaigns-cols"
                  onRowClick={(r) => openCampaign(r.campaignId)}
                  // No row checkboxes: this page changes nothing in Google Ads, so there is no action for a selection.
                  selectable={false}
                  keyboardNav
                  emptyLabel="Google reported no campaigns for this account."
                />
              </>
            )}
            {view === 'search-terms' && (
              <GoogleSearchTermsGrid campaignId={null} account={account} window={win} currency={currency} nextReadAt={nextReadAt} />
            )}
            {view === 'products' && (
              <GoogleProductsGrid campaignId={null} account={account} window={win} currency={currency} nextReadAt={nextReadAt} />
            )}
            {view === 'disapprovals' && <GoogleDisapprovalsTab account={account} nextReadAt={nextReadAt} />}
            {view === 'on-its-own' && <GoogleActsPanel account={account} nextReadAt={nextReadAt} onOpenCampaign={openCampaign} />}
            {view === 'recommendations' && <GoogleRecommendationsTab account={account} currency={currency} nextReadAt={nextReadAt} />}
          </div>
        </>
      )}

      {page.showData && shown && (
        <GoogleCampaignModal
          detail={detail}
          campaign={detail.id ? campaignRows?.find((c) => c.campaignId === detail.id) ?? null : null}
          account={account}
          window={win}
          currency={currency}
          nextReadAt={nextReadAt}
        />
      )}
    </div>
  )
}

/**
 * The fourteen columns (with the campaign name first), money first as Google Ads shows them: what a campaign cost and
 * what it brought in are on screen without a sideways scroll. The nine metric columns are `metricColumns`, the same on
 * every Google grid; ratios are worked out from the sums, here and in the totals.
 */
function campaignColumns(currency: string | null): GridColumn<GoogleCampaign>[] {
  const metrics = Object.fromEntries(metricColumns<GoogleCampaign>((r) => r.metrics, currency).map((c) => [c.key, c])) as Record<MetricColumnKey, GridColumn<GoogleCampaign>>
  const byKey: Record<CampaignColumnKey, GridColumn<GoogleCampaign>> = {
    status: {
      key: 'status', label: 'Status', metric: false, sortValue: (r) => r.status,
      render: (r) => {
        const serving = servingText(r)
        return (
          <span className="gads-status">
            <Pill tone={r.status === 'ENABLED' ? 'success' : 'neutral'} size="sm">{campaignStatusLabel(r.status)}</Pill>
            {serving && <span className="gads-dim">{serving}</span>}
          </span>
        )
      },
    },
    type: { key: 'type', label: 'Type', metric: false, sortValue: (r) => campaignTypeLabel(r.type), render: (r) => campaignTypeLabel(r.type) },
    ...metrics,
    budget: { key: 'budget', label: 'Daily budget', sortValue: (r) => sortable(r.dailyBudgetCents), render: (r) => budgetText(r, currency), tip: 'The daily budget Google holds for this campaign. "Shared" means several campaigns spend from it.' },
    bidding: { key: 'bidding', label: 'Bidding', metric: false, sortValue: (r) => biddingLabel(r.biddingStrategy), render: (r) => biddingLabel(r.biddingStrategy) },
  }
  return CAMPAIGN_COLUMN_ORDER.map((key) => byKey[key])
}
