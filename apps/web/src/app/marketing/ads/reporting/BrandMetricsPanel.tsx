'use client'

/**
 * BM.1 + BM.2 + BM.4 — the Brand Metrics dashboard head.
 *
 * Amazon sends 48 metric keys per brand-week and the ingest stores every one of
 * them whole. Eleven were promoted to typed columns and the report rendered six.
 * The half nobody had ever seen — a category median AND a top-performer figure for
 * thirteen metrics — is Helium 10's headline comparison feature, sitting in a jsonb
 * column since June. This renders it.
 *
 * ── No new endpoint, no second definition ───────────────────────────────────────
 *
 * This calls the SAME `/reporting/run` the grid below it calls, with the same
 * filters, asking for different columns and a different grouping. Every figure here
 * is therefore the registry's own SQL — a card and a grid cell for the same metric
 * cannot disagree, and both agree with the CSV. A dedicated benchmark endpoint would
 * have been the second execution path the engine invariants exist to prevent.
 *
 * ── Why it asks for one market ──────────────────────────────────────────────────
 *
 * 🔴 The category node and its benchmarks are market-specific by construction —
 * Italy's root node is `/Categorie/Moto, accessori e componenti`, Germany's is a
 * different tree with different medians. Blending them would invent a "category"
 * that does not exist anywhere. So with several markets in scope the panel does not
 * guess: it says why and offers the markets as buttons which set the SAME filter the
 * bar owns, rather than introducing a second place to choose a market.
 *
 * ── Why it pins to the root node ────────────────────────────────────────────────
 *
 * 🔴 Amazon returns the same brand-week at several category depths — seven in Italy,
 * three elsewhere — each with its own benchmark. Aggregating across them counts the
 * same week up to seven times. The panel takes the shallowest path (the fewest
 * segments) and names it above the cards, so the numbers always say which category
 * they belong to. Choosing among the deeper nodes is BM.3's filter, not this.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, Info } from 'lucide-react'
import { HoverCard } from '../campaigns/FilterDropdown'
import { BenchmarkCard } from './BenchmarkCard'
import { BrandFunnel, type FunnelStage } from './BrandFunnel'
import { MetricChart, type ChartMetric } from '../_shared/MetricChart'
import { formatCell, runReport, type ColumnMeta, type ReportParams, type ReportResult } from './report-api'

/** A card is a metric id plus the two the registry generated beside it. */
interface CardSpec { id: string; label: string; tip?: string }

/**
 * The order the cards read in — engagement first, then what that engagement
 * returned. Labels are shortened from the registry's, which have to carry
 * "— category median" for the grid and the CSV where there is no card around them.
 */
const ROE_TIP = 'Return on engagement — what this kind of engagement returned. Amazon sends our figure, the category median and the top performers for all five.'

const ENGAGEMENT: CardSpec[] = [
  { id: 'brandCustomers', label: 'Brand customers' },
  { id: 'customerConversionRate', label: 'Customer conversion rate' },
  {
    id: 'newToBrandCustomerRate', label: 'New-to-brand customers',
    tip: 'Share of brand customers who had not bought from the brand before. This is brand-level and is NOT the ad-level new-to-brand figure, which Amazon reports only for Sponsored Brands and Display.',
  },
  { id: 'addToCarts', label: 'Add to carts' },
  { id: 'highValueCustomers', label: 'High-value customers' },
  {
    id: 'viewedDetailPageOnly', label: 'Viewed detail page only',
    tip: 'Shoppers who reached the detail page and went no further. More of them is not automatically better — it is reach without conversion, which is why this metric carries no good/bad direction.',
  },
  { id: 'brandedSearchesAndDetailPageViews', label: 'Branded search + detail page' },
  {
    id: 'brandedSearchesOnly', label: 'Branded searches only',
    tip: 'Searched the brand and viewed nothing further. Amazon reports this on a minority of weeks — an em-dash means no figure was sent, not zero.',
  },
]

/**
 * Return on engagement — five more instances of the same card.
 *
 * These were a separate labelled group under a subheading, which cost more than it
 * bought: nine cards then five, in an eight-column grid, left one card alone on a
 * row with ~1,200px of white beside it. Fourteen in one flow wraps to 8 + 6 and
 * leaves two empty cells instead of ten. The grouping the subheading carried moved
 * into the labels, which now say "Return per …" and stand on their own.
 */
const RETURN_ON_ENGAGEMENT: CardSpec[] = [
  { id: 'roeBrandCustomers', label: 'Return per brand customer', tip: ROE_TIP },
  { id: 'roeAddToCarts', label: 'Return per add to cart', tip: ROE_TIP },
  { id: 'roeHighValueCustomers', label: 'Return per high-value customer', tip: ROE_TIP },
  { id: 'roeViewedDetailPage', label: 'Return per detail page view', tip: ROE_TIP },
  { id: 'roeBrandedSearchesAndDetailPageViews', label: 'Return per branded search + view', tip: ROE_TIP },
]

/**
 * BM.2 — the three stages, and the counts Amazon reports in each.
 *
 * The counts are NOT divided into one another anywhere; see BrandFunnel for why.
 * `brandedSearchesOnly` is listed even though Amazon sends it on a minority of
 * weeks: the stage shows an em-dash rather than dropping a row, so the shape of
 * the journey does not change with the data.
 */
const FUNNEL: Array<{ key: string; label: string; index: string; tip: string; counts: Array<[string, string]> }> = [
  {
    key: 'awareness', label: 'Awareness', index: 'awarenessIndex',
    tip: 'Amazon’s own 0–1 composite for this stage. Tested against production data on 20 Aug 2026 and it is NOT a percentile rank — a brand sitting exactly on the category median scores about 0.72 here, not 0.50.',
    counts: [['Detail page views', 'viewedDetailPageOnly'], ['Branded searches', 'brandedSearchesOnly'], ['Both', 'brandedSearchesAndDetailPageViews']],
  },
  {
    key: 'consideration', label: 'Consideration', index: 'considerationIndex',
    tip: 'Amazon’s own 0–1 composite. It tracks the awareness score to within 0.022 on every production row but is never quite equal to it — two computations over nearly the same input.',
    counts: [['Add to carts', 'addToCarts']],
  },
  {
    key: 'sales', label: 'Sales', index: 'salesIndex',
    tip: 'Amazon’s own 0–1 composite. High-value customers are a subset of brand customers, not a further stage.',
    counts: [['Brand customers', 'brandCustomers'], ['High-value', 'highValueCustomers']],
  },
]

/** Every column the aggregate fetch needs — benchmarks, the band, and the indices. */
const COLUMN_IDS = [
  ...[...ENGAGEMENT, ...RETURN_ON_ENGAGEMENT].flatMap((c) => [c.id, `${c.id}Median`, `${c.id}Top`]),
  'engagedShopperRateLow', 'engagedShopperRateHigh',
  'engagedShopperRateMedianLow', 'engagedShopperRateMedianHigh',
  'engagedShopperRateTopLow', 'engagedShopperRateTopHigh',
  ...FUNNEL.map((f) => f.index),
]

/**
 * BM.4 — the over-time series. Its own fetch, because the cards above are a window
 * AGGREGATE and this is a series: asking for both in one query would mean folding
 * the series client-side to get the totals, and a rate averaged in the browser is
 * exactly the second definition the one-registry rule exists to prevent.
 */
const SERIES_COLUMN_IDS = ['brandCustomers', 'newToBrandCustomerRate', 'customerConversionRate']

const SERIES_METRICS: ChartMetric[] = [
  { key: 'ntb', label: 'New-to-brand customers', unit: 'count' },
  { key: 'existing', label: 'Existing customers', unit: 'count' },
  { key: 'brandCustomers', label: 'Brand customers (total)', unit: 'count' },
]

type Row = Record<string, unknown>

/** `/Categorie/Moto/Abbigliamento` → `Categorie › Moto › Abbigliamento`. */
function breadcrumb(path: string): string {
  return path.split('/').filter(Boolean).join(' › ')
}

/** The shallowest node in the set — Amazon's root for this market. */
function rootRow(rows: Row[]): Row | null {
  let best: Row | null = null
  let bestDepth = Infinity
  for (const r of rows) {
    const depth = String(r.categoryNodeName ?? '').split('/').filter(Boolean).length
    if (depth < bestDepth) { bestDepth = depth; best = r }
  }
  return best
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function BrandMetricsPanel({ params, markets, onPickMarket }: {
  params: ReportParams
  /** Markets this report actually has, from the grid's own response. */
  markets: string[]
  /** Sets the ONE market filter the bar already owns — never a second copy of it. */
  onPickMarket: (market: string) => void
}) {
  const market = params.marketplaces.length === 1 ? params.marketplaces[0] : null
  const [result, setResult] = useState<ReportResult | null>(null)
  const [series, setSeries] = useState<ReportResult | null>(null)
  const [seriesLoading, setSeriesLoading] = useState(false)
  const [plotted, setPlotted] = useState<string[]>(['ntb', 'existing'])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!market) { setResult(null); return }
    const ac = new AbortController()
    setLoading(true)
    runReport({
      ...params,
      groupBy: ['categoryNodeName'],
      columns: COLUMN_IDS,
      sortCol: null,
      page: 1,
      // Seven nodes in the busiest market; 100 is far above any real answer and
      // still one page, so the panel never silently renders a truncated set.
      pageSize: 100,
    }, ac.signal)
      .then((r) => { setResult(r); setError(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [params, market])

  // BM.4 — the weekly series, grouped by date AND node so the root can be picked the
  // same way the aggregate picks it. Separate request so a slow chart never holds up
  // the numbers above it, exactly as the report's own summary already behaves.
  useEffect(() => {
    if (!market) { setSeries(null); return }
    const ac = new AbortController()
    setSeriesLoading(true)
    runReport({
      ...params,
      groupBy: ['computationDate', 'categoryNodeName'],
      columns: SERIES_COLUMN_IDS,
      sortCol: null,
      page: 1,
      pageSize: 500,
    }, ac.signal)
      .then(setSeries)
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setSeries(null) })
      .finally(() => { if (!ac.signal.aborted) setSeriesLoading(false) })
    return () => ac.abort()
  }, [params, market])

  const root = useMemo(() => (result ? rootRow(result.rows as Row[]) : null), [result])
  const meta = useMemo(() => {
    const m = new Map<string, ColumnMeta>()
    for (const c of result?.columns ?? []) m.set(c.id, c)
    return m
  }, [result])

  /** A value formatted by the format the SERVER declared for it — never a local guess. */
  const fmt = (id: string): string => {
    const c = meta.get(id)
    if (!root || !c) return '—'
    return formatCell(root[id], c.format, result?.currency ?? 'EUR')
  }
  /**
   * BM.2 — the three stages, read off the same root row as the cards.
   * A stage whose index Amazon did not send shows an em-dash and no bar; the stage
   * itself stays, because the journey has three parts whatever this week holds.
   */
  const stages: FunnelStage[] = useMemo(() => FUNNEL.map((f) => ({
    key: f.key,
    label: f.label,
    tip: f.tip,
    index: num(root?.[f.index]),
    indexLabel: fmt(f.index),
    counts: f.counts.map(([label, id]) => ({ label, value: fmt(id) })),
  })), [root, meta, result]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * BM.4 — new-to-brand against existing, per week, on the root node.
   *
   * 🔴 `existing` is DERIVED — `brandCustomers × (1 − newToBrandCustomerRate)` — and
   * is labelled as such in the chart. Amazon sends the total and the rate, never the
   * split. A week missing either input contributes NOTHING rather than a zero: a
   * fabricated 0 in a time series reads as a collapse.
   */
  const chartData = useMemo(() => {
    const rows = (series?.rows ?? []) as Row[]
    if (!rows.length) return []
    const depth = (r: Row) => String(r.categoryNodeName ?? '').split('/').filter(Boolean).length
    const rootDepth = Math.min(...rows.map(depth))
    return rows
      .filter((r) => depth(r) === rootDepth)
      .map((r) => {
        const total = num(r.brandCustomers)
        const rate = num(r.newToBrandCustomerRate)
        const ntb = total != null && rate != null ? Math.round(total * rate) : null
        return {
          date: String(r.computationDate ?? '').slice(0, 10),
          brandCustomers: total,
          ntb,
          existing: total != null && ntb != null ? total - ntb : null,
        }
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [series])

  const card = (c: CardSpec) => (
    <BenchmarkCard
      key={c.id}
      label={c.label}
      tip={c.tip ?? meta.get(c.id)?.help}
      value={fmt(c.id)}
      median={fmt(`${c.id}Median`)}
      top={fmt(`${c.id}Top`)}
      raw={{
        value: num(root?.[c.id]),
        median: num(root?.[`${c.id}Median`]),
        top: num(root?.[`${c.id}Top`]),
      }}
    />
  )

  // ── several markets in scope: say why, and offer the shortcut ────────────────
  if (!market) {
    return (
      <section className="rpt-bm" aria-labelledby="rpt-bm-h">
        <div className="rpt-bm-head">
          <h2 id="rpt-bm-h">Category benchmarks</h2>
        </div>
        <p className="rpt-bm-why">
          Amazon computes the median and top-performer figures <b>against one market&rsquo;s category tree</b>,
          and the trees differ — Italy&rsquo;s root node is not Germany&rsquo;s. Comparing against a blend of
          four would describe a category that does not exist. Choose a market:
        </p>
        <div className="rpt-bm-markets">
          {markets.map((m) => (
            <Button key={m} onClick={() => onPickMarket(m)}>
              {m}
            </Button>
          ))}
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <div className="rpt-lede is-error" role="alert">
        <AlertTriangle size={16} aria-hidden />
        <span><b>Category benchmarks could not load.</b> {error}</span>
      </div>
    )
  }

  const nodeName = root ? String(root.categoryNodeName ?? '') : ''

  return (
    <section className="rpt-bm" aria-labelledby="rpt-bm-h" aria-busy={loading}>
      <div className="rpt-bm-head">
        <h2 id="rpt-bm-h">Category benchmarks</h2>
        {nodeName && <span className="rpt-bm-node">{breadcrumb(nodeName)}</span>}
        <HoverCard text="Amazon returns the same brand-week at several category depths, each with its own benchmark. These figures are pinned to the shallowest node in this market so the same week is never counted twice.">
          <Info size={13} aria-hidden />
        </HoverCard>
        <span className="rpt-bm-scope">
          {market} · {result?.applied.from} → {result?.applied.to}
        </span>
      </div>

      {!loading && !root && (
        <p className="rpt-bm-why">No Brand Metrics week falls inside this range for {market}.</p>
      )}

      {root && (
        <>
          {/* BM.2 — the journey first: it is the question the page is named after, and
              the benchmark cards below answer "compared to whom" for its parts. */}
          <BrandFunnel stages={stages} />
          <p className="rpt-bm-foot">
            Amazon&rsquo;s own 0&ndash;1 composite score per stage. <b>Not percentiles</b>{' '}&mdash; tested
            against this account&rsquo;s data on 20 Aug 2026: a brand sitting exactly on the category
            median scores about 0.72 on awareness, not 0.50. The counts beneath each stage are what
            Amazon reports in that region of the journey and are <b>not one cohort flowing downward</b>,
            so no conversion rate is computed between them.
          </p>

          <div className="rpt-bm-sub">
            Against the category
            <HoverCard text="Amazon sends a category median and a top-performer figure alongside thirteen of these metrics. The bar runs from zero to the top performer, and the tick is the median.">
              <Info size={12} aria-hidden />
            </HoverCard>
          </div>

          {/* Engagement rate leads, because it is the one figure Amazon refuses to
              give as a point value and therefore the one most likely to be
              misrepresented elsewhere. */}
          <div className="rpt-bm-grid">
            <BenchmarkCard
              label="Shopper engagement rate"
              tip="Amazon reports engagement as a bounded RANGE, never a single figure, and these bounds are already percentages. Rendering a midpoint would invent a precision Amazon deliberately withheld."
              value={`${fmt('engagedShopperRateLow')}–${fmt('engagedShopperRateHigh')}%`}
              median={`${fmt('engagedShopperRateMedianLow')}–${fmt('engagedShopperRateMedianHigh')}%`}
              top={`${fmt('engagedShopperRateTopLow')}–${fmt('engagedShopperRateTopHigh')}%`}
              /* The bar reads the UPPER bounds: a range has no single point to plot,
                 and the upper bound is the one both sides share a ceiling on. */
              raw={{
                value: num(root.engagedShopperRateHigh),
                median: num(root.engagedShopperRateMedianHigh),
                top: num(root.engagedShopperRateTopHigh),
              }}
            />
            {ENGAGEMENT.map(card)}
            {RETURN_ON_ENGAGEMENT.map(card)}
          </div>

          {/* BM.4 — the chart Helium 10's own screenshot renders as "No data". Same
              shared chart the campaign report and the Ad Manager use; this page supplies
              only the series and the metric list, which is the whole contract. */}
          <MetricChart
            title="Brand customers over time"
            subtitle={`New-to-brand against existing · ${market} · ${breadcrumb(nodeName)}`}
            data={chartData}
            metrics={SERIES_METRICS}
            selected={plotted}
            onSelectedChange={setPlotted}
            loading={seriesLoading}
            storageKey="rpt-brand-customers"
            emptyLabel="No week in this range reports both a customer count and a new-to-brand rate."
          />
          <p className="rpt-bm-foot">
            <b>Existing customers is derived</b>{' '}&mdash; brand customers &times; (1 &minus; new-to-brand
            rate). Amazon sends the total and the rate, never the split. A week missing either is
            omitted rather than drawn as zero.
          </p>
        </>
      )}
    </section>
  )
}
