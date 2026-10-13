'use client'

/**
 * Google Ads step 1a, W2 — /marketing/ads/google, the third value of the Ads console's channel switch (PLAN.md L8).
 *
 * READ ONLY: Google's campaigns and daily numbers as Google reports them, in the account's own currency and time zone.
 * Nexus changes nothing in Google Ads here — there is no write control on this page, and "Read now" only asks Nexus
 * to read Google again (S, at most once an hour).
 *
 * `googlePageState` (./googleAds.ts) decides what may render: outside `ok` (and a failed read that still has an
 * earlier good one) the page shows words and one way forward, never a number, a chart or a grid.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { AsOf, Banner, Card, EmptyState, Listbox, MetricStrip, PerformanceGraph, type Metric } from '@/design-system/components'
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
import { GoogleCampaignModal } from './GoogleCampaignModal'
import {
  CAMPAIGN_COLUMN_ORDER,
  STATUS_FILTER_OPTIONS,
  type CampaignColumnKey,
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
  formatConversions,
  formatInt,
  formatMoney,
  formatRate,
  formatRoas,
  googlePageState,
  metricTiles,
  metricsView,
  provisionalDays,
  provisionalNote,
  ratiosOf,
  readNowNote,
  servingText,
  sumMetrics,
  toMinor,
  formatWindow,
  ymd,
} from './googleAds'
import './google.css'

type Loaded<T> = { key: string; data: T | null; error: string | null }

const sortable = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v)

export function GoogleAdsClient() {
  const [range, setRange] = useState(() => lastCompleteDays(30))
  const [account, setAccount] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const from = ymd(range.start)
  const to = ymd(range.end)
  const key = JSON.stringify([account, from, to, reload])

  // ── R1: the account and its numbers ───────────────────────────────────
  const [overview, setOverview] = useState<Loaded<GoogleOverview> | null>(null)
  const overviewSeq = useRef(0)
  useEffect(() => {
    const seq = ++overviewSeq.current
    fetchGoogleOverview({ account, from, to })
      .then((data) => { if (overviewSeq.current === seq) setOverview({ key, data, error: null }) })
      .catch((err: unknown) => { if (overviewSeq.current === seq) setOverview({ key, data: null, error: err instanceof Error ? err.message : 'Nexus could not load the Google Ads numbers.' }) })
  }, [account, from, to, key])
  const current = overview?.key === key ? overview : null
  // While a new window loads, keep the last answer on screen (the grid's reload veil covers the change).
  const shown = current?.data ?? (overview?.data && !current ? overview.data : null)
  const compared = shown ? comparedWindow(shown) : null
  const view = googlePageState({ loading: !current, error: current?.error ?? null, overview: shown })

  // ── R2: the campaigns, only when the page may show numbers ────────────
  const [campaigns, setCampaigns] = useState<Loaded<GoogleCampaign[]> & { truncated?: boolean } | null>(null)
  const campaignSeq = useRef(0)
  useEffect(() => {
    if (!view.showData) return
    const seq = ++campaignSeq.current
    fetchAllGoogleCampaigns({ account, from, to })
      .then((page) => { if (campaignSeq.current === seq) setCampaigns({ key, data: page.items, error: null, truncated: page.truncated }) })
      .catch((err: unknown) => { if (campaignSeq.current === seq) setCampaigns({ key, data: null, error: err instanceof Error ? err.message : 'Nexus could not load the campaigns.' }) })
  }, [view.showData, account, from, to, key])
  const campaignsNow = campaigns?.key === key ? campaigns : null

  // ── Read now (S) ──────────────────────────────────────────────────────
  const [reading, setReading] = useState(false)
  const [readNote, setReadNote] = useState<ReturnType<typeof readNowNote> | null>(null)
  const readNow = useCallback(async () => {
    if (reading) return
    setReading(true)
    setReadNote(null)
    try {
      setReadNote(readNowNote(await requestGoogleRead(account)))
    } catch (err) {
      setReadNote(readNowNote({ error: err instanceof Error ? err.message : 'the server did not answer.' }))
    } finally {
      setReading(false)
    }
  }, [account, reading])

  const [open, setOpen] = useState<GoogleCampaign | null>(null)

  const currency = shown?.currency ?? null
  const columns = useMemo(() => campaignColumns(currency), [currency])
  const filters: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleCampaign).status ?? '' },
    { key: 'type', label: 'Type', kind: 'select', options: TYPE_FILTER_OPTIONS, placeholder: 'All', value: (r) => campaignTypeLabel((r as GoogleCampaign).type) },
  ], [])

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
        showDataSync={view.canReadNow}
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
            value={account ?? view.account?.connectionId ?? accountOptions[0]!.value}
            onChange={(value) => { setAccount(value); setOpen(null) }} />
        </div>
      )}

      {view.kind === 'loading' && (
        <div className="gads-root" aria-busy="true" aria-label="Loading Google Ads">
          <Skeleton height={72} radius="var(--nds-radius-lg)" />
          <Skeleton height={260} radius="var(--nds-radius-lg)" />
        </div>
      )}

      {view.kind === 'load_error' && (
        <Banner tone="danger" title={view.title ?? undefined} action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}>
          {view.text}
        </Banner>
      )}

      {!view.showData && view.kind !== 'loading' && view.kind !== 'load_error' && (
        <Card padded>
          <EmptyState
            title={view.title}
            description={view.text}
            action={view.action ? <Button asChild variant="primary"><Link href={view.action.href}>{view.action.label}</Link></Button> : undefined}
          />
        </Card>
      )}

      {view.showData && shown && (
        <>
          {view.banner && <Banner tone={view.banner.tone} title={view.banner.title}>{view.banner.text}</Banner>}
          <p className="gads-meta">
            <span>Read from Google <AsOf at={shown.dataAsOf ?? view.account?.read.lastReadAt ?? null} kind="event" /></span>
            {dataLine(shown, view.account).map((part) => <span key={part}>· {part}</span>)}
          </p>
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

          {campaignsNow?.error && (
            <Banner tone="danger" title="The campaigns could not be loaded" action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}>
              {campaignsNow.error}
            </Banner>
          )}
          {campaignsNow?.truncated && (
            <Banner tone="warning">This account has more campaigns than this page loads at once; the list and its totals show the first ones only.</Banner>
          )}

          <AdsDataGrid<GoogleCampaign>
            rows={campaignsNow?.data ?? []}
            loading={!campaignsNow}
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
            onRowClick={(r) => setOpen(r)}
            // No row checkboxes: this page changes nothing in Google Ads, so there is no action for a selection.
            selectable={false}
            keyboardNav
            emptyLabel="Google reported no campaigns for this account."
          />
        </>
      )}

      {open && shown && (
        <GoogleCampaignModal
          campaign={open}
          currency={currency}
          range={{ from: shown.window.from, to: shown.window.to }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

/**
 * The fourteen columns (with the campaign name first), money first as Google Ads shows them: what a campaign cost and
 * what it brought in are on screen without a sideways scroll. Ratios are worked out from the sums, here and in the totals.
 */
function campaignColumns(currency: string | null): GridColumn<GoogleCampaign>[] {
  const m = (r: GoogleCampaign) => metricsView(r.metrics)
  const total = (vr: GoogleCampaign[]) => {
    const s = sumMetrics(vr.map((r) => r.metrics))
    return s ? { ...s, ...ratiosOf(s) } : null
  }
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
    cost: { key: 'cost', label: 'Cost', sortValue: (r) => sortable(m(r)?.spendCents), render: (r) => formatMoney(m(r)?.spendCents, currency), total: (vr) => formatMoney(total(vr)?.spendCents, currency) },
    value: { key: 'value', label: 'Conversion value', sortValue: (r) => sortable(m(r)?.conversionValueCents), render: (r) => formatMoney(m(r)?.conversionValueCents, currency), total: (vr) => formatMoney(total(vr)?.conversionValueCents, currency) },
    roas: { key: 'roas', label: 'Return on ad spend', tip: 'Conversion value ÷ cost.', sortValue: (r) => sortable(m(r)?.roas), render: (r) => formatRoas(m(r)?.roas), total: (vr) => formatRoas(total(vr)?.roas) },
    conversions: { key: 'conversions', label: 'Conversions', tip: 'As Google counts them; Google counts part-conversions.', sortValue: (r) => sortable(m(r)?.conversions), render: (r) => formatConversions(m(r)?.conversions), total: (vr) => formatConversions(total(vr)?.conversions) },
    cpa: { key: 'cpa', label: 'Cost per conversion', tip: 'Cost ÷ conversions.', sortValue: (r) => sortable(m(r)?.costPerConversionCents), render: (r) => formatMoney(m(r)?.costPerConversionCents, currency), total: (vr) => formatMoney(total(vr)?.costPerConversionCents, currency) },
    clicks: { key: 'clicks', label: 'Clicks', sortValue: (r) => sortable(m(r)?.clicks), render: (r) => formatInt(m(r)?.clicks), total: (vr) => formatInt(total(vr)?.clicks) },
    impressions: { key: 'impressions', label: 'Impressions', sortValue: (r) => sortable(m(r)?.impressions), render: (r) => formatInt(m(r)?.impressions), total: (vr) => formatInt(total(vr)?.impressions) },
    ctr: { key: 'ctr', label: 'Click rate', tip: 'Clicks ÷ impressions.', sortValue: (r) => sortable(m(r)?.ctr), render: (r) => formatRate(m(r)?.ctr), total: (vr) => formatRate(total(vr)?.ctr) },
    cpc: { key: 'cpc', label: 'Avg. cost per click', tip: 'Cost ÷ clicks.', sortValue: (r) => sortable(m(r)?.avgCpcCents), render: (r) => formatMoney(m(r)?.avgCpcCents, currency), total: (vr) => formatMoney(total(vr)?.avgCpcCents, currency) },
    budget: { key: 'budget', label: 'Daily budget', sortValue: (r) => sortable(r.dailyBudgetCents), render: (r) => budgetText(r, currency), tip: 'The daily budget Google holds for this campaign. "Shared" means several campaigns spend from it.' },
    bidding: { key: 'bidding', label: 'Bidding', metric: false, sortValue: (r) => biddingLabel(r.biddingStrategy), render: (r) => biddingLabel(r.biddingStrategy) },
  }
  return CAMPAIGN_COLUMN_ORDER.map((key) => byKey[key])
}
