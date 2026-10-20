'use client'

/**
 * Meta ads step 2 — /marketing/ads/meta, the fourth value of the Ads console's channel switch.
 *
 * READ ONLY: the ad account's campaigns, ad sets, ads and daily numbers as Meta reports them, in the account's own
 * currency and time zone. Nexus changes nothing in Meta here — there is no write control on this page, and "Read now"
 * only asks Nexus to read Meta again (at most once an hour).
 *
 * `metaPageState` (./metaAds.ts) decides what may render: outside `ok` (and a failed read that still has an earlier good
 * one) the page shows words and one way forward (Settings › Channels › Meta), never a number, a chart or a grid.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from '@/lib/workspaces/Link'
import { AsOf, Banner, Card, EmptyState, Listbox, MetricStrip, PerformanceGraph, Tabs, tabPanelProps, type Metric } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import {
  fetchAllMetaAds,
  fetchAllMetaAdSets,
  fetchAllMetaCampaigns,
  fetchMetaOverview,
  requestMetaRead,
  type MetaAdsAdRow,
  type MetaAdsAdSetRow,
  type MetaAdsCampaignRow,
  type MetaAdsOverview,
} from '@/lib/meta-ads/contract'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { lastCompleteDays } from '../_shell/DateRangePicker'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { MetaCampaignModal } from './MetaCampaignModal'
import {
  STATUS_FILTER_OPTIONS, accountLine, bidStrategyLabel, budgetText, chartHasMoney, chartPoints, comparedWindow, coverageNote, creativeText,
  dataLine, effectiveText, formatInt, formatMoney, formatPurchases, formatRate, formatRoas, formatWindow, goalLabel, metaPageState,
  metricTiles, metricsView, objectiveLabel, provisionalDays, provisionalNote, ratiosOf, readNowNote, statusLabel, sumMetrics, toMinor, ymd,
  type Ratios, type Sums,
} from './metaAds'
import './meta.css'

type Loaded<T> = { key: string; data: T | null; error: string | null; truncated?: boolean }
type View = 'campaigns' | 'adsets' | 'ads'
const VIEW_TABS_ID = 'mads-views'

const sortable = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v)

/** Loads a list for the current window when `enabled`; keeps the answer per key. */
function useList<T>(enabled: boolean, key: string, load: () => Promise<{ items: T[]; truncated: boolean }>) {
  const [state, setState] = useState<Loaded<T[]> | null>(null)
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const mine = ++seq.current
    loadRef.current()
      .then((page) => { if (seq.current === mine) setState({ key, data: page.items, error: null, truncated: page.truncated }) })
      .catch((err: unknown) => { if (seq.current === mine) setState({ key, data: null, error: err instanceof Error ? err.message : 'Nexus could not load this list.' }) })
  }, [enabled, key, attempt])
  const now = state?.key === key ? state : null
  return { now, reload: () => setAttempt((n) => n + 1) }
}

export function MetaAdsClient() {
  const [range, setRange] = useState(() => lastCompleteDays(30))
  const [account, setAccount] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [view, setView] = useState<View>('campaigns')
  const from = ymd(range.start)
  const to = ymd(range.end)
  const key = JSON.stringify([account, from, to, reload])

  // ── the account and its numbers ───────────────────────────────────────
  const [overview, setOverview] = useState<Loaded<MetaAdsOverview> | null>(null)
  const overviewSeq = useRef(0)
  useEffect(() => {
    const seq = ++overviewSeq.current
    fetchMetaOverview({ account, from, to })
      .then((data) => { if (overviewSeq.current === seq) setOverview({ key, data, error: null }) })
      .catch((err: unknown) => { if (overviewSeq.current === seq) setOverview({ key, data: null, error: err instanceof Error ? err.message : 'Nexus could not load the Meta numbers.' }) })
  }, [account, from, to, key])
  const current = overview?.key === key ? overview : null
  const shown = current?.data ?? (overview?.data && !current ? overview.data : null)
  const compared = shown ? comparedWindow(shown) : null
  const page = metaPageState({ loading: !current, error: current?.error ?? null, overview: shown })

  // ── the lists, only when the page may show numbers and their tab is open ──
  const campaigns = useList<MetaAdsCampaignRow>(page.showData && view === 'campaigns', key, () => fetchAllMetaCampaigns({ account, from, to }))
  const adSets = useList<MetaAdsAdSetRow>(page.showData && view === 'adsets', key, () => fetchAllMetaAdSets({ account, from, to }))
  const ads = useList<MetaAdsAdRow>(page.showData && view === 'ads', key, () => fetchAllMetaAds({ account, from, to }))

  // ── Read now ──────────────────────────────────────────────────────────
  const [reading, setReading] = useState(false)
  const [readNote, setReadNote] = useState<ReturnType<typeof readNowNote> | null>(null)
  const readNow = useCallback(async () => {
    if (reading) return
    setReading(true)
    setReadNote(null)
    try {
      setReadNote(readNowNote(await requestMetaRead(account)))
    } catch (err) {
      setReadNote(readNowNote({ error: err instanceof Error ? err.message : 'the server did not answer.' }))
    } finally {
      setReading(false)
    }
  }, [account, reading])

  const [open, setOpen] = useState<MetaAdsCampaignRow | null>(null)
  const currency = shown?.currency ?? null
  const campaignCols = useMemo(() => campaignColumns(currency), [currency])
  const adSetCols = useMemo(() => adSetColumns(currency), [currency])
  const adCols = useMemo(() => adColumns(currency), [currency])
  const statusFilter: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as { status: string | null }).status ?? '' },
  ], [])

  const connections = shown?.connections ?? []
  const accountOptions = connections.filter((c) => c.adAccount).map((c) => ({ value: c.connectionId, label: c.adAccount?.name?.trim() || c.label || 'Meta ad account' }))
  const tabs = [
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'adsets', label: 'Ad sets' },
    { id: 'ads', label: 'Ads' },
  ]

  return (
    <div className="h10-am mads-root">
      <AdsPageHeader
        channel="meta"
        title="Meta ads"
        subtitle="Facebook and Instagram campaigns, ad sets, ads and daily numbers as Meta reports them. Nexus reads them and changes nothing in Meta."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showMarket={false}
        dateRange={range}
        onDateRange={(start, end) => setRange({ start, end })}
        showDataSync={page.canReadNow}
        onDataSync={() => { void readNow() }}
        syncing={reading}
        dataSyncLabel={reading ? 'Asking Meta…' : 'Read now'}
        dataSyncTip="Ask Nexus to read this Meta ad account again now (at most once an hour). It changes nothing in Meta."
      />

      {readNote && <Banner tone={readNote.tone} onDismiss={() => setReadNote(null)}>{readNote.text}</Banner>}

      {accountOptions.length > 1 && (
        <div className="mads-toolbar">
          <span className="mads-meta">Meta ad account</span>
          <Listbox ariaLabel="Meta ad account" options={accountOptions} width={280}
            value={account ?? page.connection?.connectionId ?? accountOptions[0]!.value}
            onChange={(value) => { setAccount(value); setOpen(null) }} />
        </div>
      )}

      {page.kind === 'loading' && (
        <div className="mads-root" aria-busy="true" aria-label="Loading Meta ads">
          <Skeleton height={72} radius="var(--nds-radius-lg)" />
          <Skeleton height={260} radius="var(--nds-radius-lg)" />
        </div>
      )}

      {page.kind === 'load_error' && (
        <Banner tone="danger" title={page.title ?? undefined} action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}>
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
          <p className="mads-meta">
            <span>Read from Meta <AsOf at={shown.dataAsOf ?? page.connection?.read.lastReadAt ?? null} kind="event" /></span>
            {dataLine(shown, page.connection).map((part) => <span key={part}>· {part}</span>)}
          </p>
          {accountLine(shown).length > 0 && (
            <p className="mads-meta">{accountLine(shown).map((part, i) => <span key={part}>{i ? '· ' : ''}{part}</span>)}</p>
          )}
          {coverageNote(shown) && <Banner tone="warning">{coverageNote(shown)}</Banner>}

          <MetricStrip metrics={metricTiles(shown).map((t): Metric => ({
            label: t.label,
            value: t.value,
            hint: t.hint,
            delta: t.delta ? { value: t.delta.text, positive: t.delta.good } : undefined,
          }))} />
          {compared && <p className="mads-meta">Changes compare with {formatWindow(compared.from, compared.to)}, which Nexus read in full.</p>}

          <Card header="Amount spent and purchase value per day" description="A day Nexus has not read is a gap in the lines, not a zero.">
            {chartHasMoney(shown.days) && currency ? (
              <PerformanceGraph
                data={chartPoints(shown.days, currency)}
                xKey="day"
                left={{ key: 'spend', label: 'Amount spent', axisLabel: `Amount spent (${currency})`, color: chart.cap, axis: 'left', format: (v) => formatMoney(toMinor(v, currency), currency) }}
                right={{ key: 'value', label: 'Purchase value', axisLabel: `Purchase value (${currency})`, color: chart.actual, axis: 'right', format: (v) => formatMoney(toMinor(v, currency), currency) }}
                height={240}
              />
            ) : (
              <p className="mads-meta">No amount spent or purchase value to draw for these days.</p>
            )}
            {provisionalNote(provisionalDays(shown.days, shown.window.provisionalFrom)) && (
              <p className="mads-note">{provisionalNote(provisionalDays(shown.days, shown.window.provisionalFrom))}</p>
            )}
          </Card>

          <div className="mads-tabs">
            <Tabs size="lg" dense overflow="scroll" ariaLabel="Meta ads views" idBase={VIEW_TABS_ID} tabs={tabs} active={view} onChange={(id) => setView(id as View)} />
          </div>

          <div className="mads-view" {...tabPanelProps(VIEW_TABS_ID, view)}>
            {view === 'campaigns' && (
              <ListView state={campaigns.now} reload={campaigns.reload} what="campaigns">
                <AdsDataGrid<MetaAdsCampaignRow>
                  rows={campaigns.now?.data ?? []}
                  loading={!campaigns.now}
                  rowId={(r) => r.campaignId}
                  noun="Campaign"
                  firstColLabel="Campaign"
                  renderFirst={(r) => <span className="mads-name" title={r.name}>{r.name}</span>}
                  firstSortValue={(r) => r.name.toLowerCase()}
                  columns={campaignCols}
                  filters={statusFilter}
                  filtersDefaultOpen={false}
                  searchable
                  searchPlaceholder="Search campaigns…"
                  searchValue={(r) => r.name}
                  showTotal
                  totalFirst="Total of the campaigns shown"
                  defaultSort={{ key: 'spend', dir: 'desc' }}
                  enabledFirst={(r) => (r.status === 'ACTIVE' ? 'ENABLED' : r.status)}
                  storageKey="h10-meta-campaigns-cols"
                  onRowClick={(r) => setOpen(r)}
                  // No row checkboxes: this page changes nothing in Meta, so there is no action for a selection.
                  selectable={false}
                  keyboardNav
                  emptyLabel="Meta reported no campaigns for this ad account."
                />
              </ListView>
            )}
            {view === 'adsets' && (
              <ListView state={adSets.now} reload={adSets.reload} what="ad sets">
                <AdsDataGrid<MetaAdsAdSetRow>
                  rows={adSets.now?.data ?? []}
                  loading={!adSets.now}
                  rowId={(r) => r.adSetId}
                  noun="Ad set"
                  firstColLabel="Ad set"
                  renderFirst={(r) => <span className="mads-name" title={r.name}>{r.name}</span>}
                  firstSortValue={(r) => r.name.toLowerCase()}
                  columns={adSetCols}
                  filters={statusFilter}
                  filtersDefaultOpen={false}
                  searchable
                  searchPlaceholder="Search ad sets…"
                  searchValue={(r) => r.name}
                  showTotal
                  totalFirst="Total of the ad sets shown"
                  defaultSort={{ key: 'spend', dir: 'desc' }}
                  enabledFirst={(r) => (r.status === 'ACTIVE' ? 'ENABLED' : r.status)}
                  storageKey="h10-meta-adsets-cols"
                  selectable={false}
                  keyboardNav
                  emptyLabel="Meta reported no ad sets for this ad account."
                />
              </ListView>
            )}
            {view === 'ads' && (
              <ListView state={ads.now} reload={ads.reload} what="ads">
                <AdsDataGrid<MetaAdsAdRow>
                  rows={ads.now?.data ?? []}
                  loading={!ads.now}
                  rowId={(r) => r.adId}
                  noun="Ad"
                  firstColLabel="Ad"
                  renderFirst={(r) => <span className="mads-name" title={r.name}>{r.name}</span>}
                  firstSortValue={(r) => r.name.toLowerCase()}
                  columns={adCols}
                  filters={statusFilter}
                  filtersDefaultOpen={false}
                  searchable
                  searchPlaceholder="Search ads…"
                  searchValue={(r) => r.name}
                  showTotal
                  totalFirst="Total of the ads shown"
                  defaultSort={{ key: 'spend', dir: 'desc' }}
                  enabledFirst={(r) => (r.status === 'ACTIVE' ? 'ENABLED' : r.status)}
                  storageKey="h10-meta-ads-cols"
                  selectable={false}
                  keyboardNav
                  emptyLabel="Meta reported no ads for this ad account."
                />
              </ListView>
            )}
          </div>
        </>
      )}

      {open && shown && (
        <MetaCampaignModal campaign={open} currency={currency} range={{ from: shown.window.from, to: shown.window.to }} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}

/** A list's failure banner, its "first rows only" note, and the grid — never an empty grid after a failed load. */
function ListView({ state, reload, what, children }: { state: Loaded<unknown[]> | null; reload: () => void; what: string; children: ReactNode }) {
  if (state?.error) {
    return (
      <Banner tone="danger" title={`The ${what} could not be loaded`} action={<Button onClick={reload}>Try again</Button>}>
        {state.error}
      </Banner>
    )
  }
  return (
    <>
      {state?.truncated && <Banner tone="warning">{`This ad account has more ${what} than this page loads at once; the list and its totals show the first ones only.`}</Banner>}
      {children}
    </>
  )
}

type WithMetrics = { metrics: Parameters<typeof metricsView>[0] }

/** The money and traffic columns every Meta list shares, money first as Ads Manager shows them. */
function numberColumns<T extends WithMetrics>(currency: string | null): GridColumn<T>[] {
  const m = (r: T) => metricsView(r.metrics)
  const total = (vr: T[]): (Sums & Ratios) | null => {
    const s = sumMetrics(vr.map((r) => r.metrics))
    return s ? { ...s, ...ratiosOf(s) } : null
  }
  return [
    { key: 'spend', label: 'Amount spent', sortValue: (r) => sortable(m(r)?.spendCents), render: (r) => formatMoney(m(r)?.spendCents, currency), total: (vr) => formatMoney(total(vr)?.spendCents, currency) },
    { key: 'value', label: 'Purchase value', sortValue: (r) => sortable(m(r)?.purchaseValueCents), render: (r) => formatMoney(m(r)?.purchaseValueCents, currency), total: (vr) => formatMoney(total(vr)?.purchaseValueCents, currency) },
    { key: 'roas', label: 'Return on ad spend', tip: 'Purchase value ÷ amount spent.', sortValue: (r) => sortable(m(r)?.roas), render: (r) => formatRoas(m(r)?.roas), total: (vr) => formatRoas(total(vr)?.roas) },
    { key: 'purchases', label: 'Purchases', tip: "Meta's count, with each ad set's attribution setting.", sortValue: (r) => sortable(m(r)?.purchases), render: (r) => formatPurchases(m(r)?.purchases), total: (vr) => formatPurchases(total(vr)?.purchases) },
    { key: 'cpp', label: 'Cost per purchase', tip: 'Amount spent ÷ purchases.', sortValue: (r) => sortable(m(r)?.costPerPurchaseCents), render: (r) => formatMoney(m(r)?.costPerPurchaseCents, currency), total: (vr) => formatMoney(total(vr)?.costPerPurchaseCents, currency) },
    { key: 'clicks', label: 'Clicks', sortValue: (r) => sortable(m(r)?.clicks), render: (r) => formatInt(m(r)?.clicks), total: (vr) => formatInt(total(vr)?.clicks) },
    { key: 'impressions', label: 'Impressions', sortValue: (r) => sortable(m(r)?.impressions), render: (r) => formatInt(m(r)?.impressions), total: (vr) => formatInt(total(vr)?.impressions) },
    { key: 'ctr', label: 'Click rate', tip: 'Clicks ÷ impressions.', sortValue: (r) => sortable(m(r)?.ctr), render: (r) => formatRate(m(r)?.ctr), total: (vr) => formatRate(total(vr)?.ctr) },
    { key: 'cpc', label: 'Cost per click', tip: 'Amount spent ÷ clicks.', sortValue: (r) => sortable(m(r)?.cpcCents), render: (r) => formatMoney(m(r)?.cpcCents, currency), total: (vr) => formatMoney(total(vr)?.cpcCents, currency) },
    { key: 'cpm', label: 'Cost per 1,000 impressions', sortValue: (r) => sortable(m(r)?.cpmCents), render: (r) => formatMoney(m(r)?.cpmCents, currency), total: (vr) => formatMoney(total(vr)?.cpmCents, currency) },
  ]
}

function statusColumn<T extends { status: string | null; effectiveStatus: string | null }>(): GridColumn<T> {
  return {
    key: 'status', label: 'Status', metric: false, sortValue: (r) => r.status,
    render: (r) => {
      const more = effectiveText(r.status, r.effectiveStatus)
      return (
        <span className="mads-status">
          <Pill tone={r.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">{statusLabel(r.status)}</Pill>
          {more && <span className="mads-dim">{more}</span>}
        </span>
      )
    },
  }
}

function campaignColumns(currency: string | null): GridColumn<MetaAdsCampaignRow>[] {
  return [
    statusColumn<MetaAdsCampaignRow>(),
    { key: 'objective', label: 'Objective', metric: false, sortValue: (r) => objectiveLabel(r.objective), render: (r) => objectiveLabel(r.objective) },
    ...numberColumns<MetaAdsCampaignRow>(currency),
    { key: 'budget', label: 'Budget', metric: false, sortValue: (r) => sortable(r.dailyBudgetCents ?? r.lifetimeBudgetCents ?? null), render: (r) => budgetText(r, currency), tip: 'The campaign budget (Advantage+ campaign budget), or "On the ad sets".' },
    { key: 'bidding', label: 'Bid strategy', metric: false, sortValue: (r) => bidStrategyLabel(r.bidStrategy), render: (r) => bidStrategyLabel(r.bidStrategy) },
  ]
}

function adSetColumns(currency: string | null): GridColumn<MetaAdsAdSetRow>[] {
  return [
    statusColumn<MetaAdsAdSetRow>(),
    { key: 'goal', label: 'Optimisation goal', metric: false, sortValue: (r) => goalLabel(r), render: (r) => goalLabel(r) },
    ...numberColumns<MetaAdsAdSetRow>(currency),
    { key: 'budget', label: 'Budget', metric: false, sortValue: (r) => sortable(r.dailyBudgetCents ?? r.lifetimeBudgetCents ?? null), render: (r) => budgetText(r, currency, 'On the campaign') },
    { key: 'bidding', label: 'Bid strategy', metric: false, sortValue: (r) => bidStrategyLabel(r.bidStrategy), render: (r) => bidStrategyLabel(r.bidStrategy) },
  ]
}

function adColumns(currency: string | null): GridColumn<MetaAdsAdRow>[] {
  return [
    statusColumn<MetaAdsAdRow>(),
    { key: 'creative', label: 'Creative', metric: false, sortValue: (r) => creativeText(r), render: (r) => <span className="mads-dim" title={creativeText(r)}>{creativeText(r)}</span> },
    ...numberColumns<MetaAdsAdRow>(currency),
  ]
}
