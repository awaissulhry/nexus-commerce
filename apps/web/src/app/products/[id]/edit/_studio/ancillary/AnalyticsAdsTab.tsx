'use client'

/**
 * PES.7 — Analytics · Ads.
 *
 * Written fresh on the DS against the old tabs' capability list, not ported from their markup
 * (`AnalyticsTab` 369 L / `AdsTab` 523 L, 910 Tailwind tokens between them, zero DS).
 *
 * 🔴 Two measurements decide how this tab behaves, and both are in `readAnalytics`/`readAds`:
 *   • A **parent** product's analytics row is empty at every window while its variants sell — 427
 *     units across 17 of 20 children on GALE-JACKET. So a zero is never printed where there are no
 *     channel rows; the surface says where the figures live instead.
 *   • Ad rows are keyed by **ASIN**: `?productId=` returns 0 for the same product that
 *     `?asin=` returns 103 ads and 74 campaigns for. The query carries every identifier.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { NexusGrid } from '@/design-system/grid'
import { Pill, SegmentedControl } from '@/design-system/primitives'
import type { ColDef } from '@/design-system/grid'

// One error client for the whole lane. Deliberately not a second copy: `apiGet` already turns a
// non-JSON body, a network failure and a server message into one discriminated result, and two
// copies of that logic drift.
import { apiGet } from '../images/api'
import { useStudioProduct, useStudioScope } from '../contracts'
import { adsHeadline, adsQuery, money, readAds, readEfficiency } from './analytics/readAds'
import {
  joinPriceRows, readAvailable, readDaysOfInventory, readSales, readStockoutRisk, readTrend,
  sparklinePath,
} from './analytics/readAnalytics'
import type { AdCampaign, AdSearchTerm, AnalyticsPayload, ProductAdsPayload, TrendPoint } from './analytics/types'
import styles from './analytics.module.css'
import { ScopedPerformance } from './ScopedPerformance'

const WINDOWS = [
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
]

/** Tall enough to read a dozen rows at a glance, short enough that the page stays navigable. */
const GRID_HEIGHT = 460

/**
 * 🔴 Hoisted, not inline.
 *
 * An object literal in JSX is a new identity every render, and AG re-runs its whole column model
 * for each one — the guard `check-grid-option-identity` caught this as two inline literals here.
 * Module scope is the strongest form of the fix: there is nothing to forget to memoise.
 */
const DEFAULT_COL_DEF = { sortable: true, resizable: true } as const

/**
 * 🔴 The small tables are `NexusGrid`, not a hand-rolled `<table>` — and not the DS `DataGrid`.
 *
 * Grid chrome lives in the engine, and `check-grid-kit-ratchet` counts BOTH: a raw JSX table (mine
 * took it 193 → 195) and an importer of a **retiring** kit. `DataGrid` is retiring — the guard's own
 * words are "a retiring grid kit gained an importer. New grids are built on design-system/grid
 * (NexusGrid)". So the first migration, to `DataGrid`, traded one ratchet failure for another. This
 * is also what §5 specified for the per-channel breakdown in the first place, and it closes the
 * "wants sort and has none" gap §30.2 recorded against these tables.
 */
type ChannelRow = { channel: string; marketplace: string | null; units: number; revenue: number; orders: number }
type PriceRow = { key: string; channel: string; marketplace: string | null; price: string; priceKnown: boolean; buyBox: string; buyBoxKnown: boolean }

const CHANNEL_COLUMNS: ColDef<ChannelRow>[] = [
  { field: 'channel', headerName: 'Channel', flex: 1, minWidth: 120 },
  { headerName: 'Market', width: 105, valueGetter: (p) => p.data?.marketplace ?? '—' },
  { field: 'units', headerName: 'Units', width: 105, type: 'numericColumn' },
  {
    field: 'revenue', headerName: 'Revenue', width: 125, type: 'numericColumn',
    valueFormatter: (p) => (typeof p.value === 'number' ? p.value.toFixed(2) : ''),
  },
  { field: 'orders', headerName: 'Orders', width: 105, type: 'numericColumn' },
]

const PRICE_COLUMNS: ColDef<PriceRow>[] = [
  { field: 'channel', headerName: 'Channel', flex: 1, minWidth: 120 },
  { headerName: 'Market', width: 105, valueGetter: (p) => p.data?.marketplace ?? '—' },
  {
    headerName: 'Price', width: 125, type: 'numericColumn',
    // "Not set" sorts below every real price rather than alphabetically among them.
    valueGetter: (p) => (p.data?.priceKnown ? Number(p.data.price) : -1),
    valueFormatter: (p) => (p.data?.priceKnown ? p.data.price : 'Not set'),
    cellClass: (p) => (p.data?.priceKnown ? '' : 'nds-muted'),
  },
  {
    headerName: 'Buy box', width: 125, type: 'numericColumn',
    valueGetter: (p) => (p.data?.buyBoxKnown ? Number(p.data.buyBox) : -1),
    valueFormatter: (p) => (p.data?.buyBoxKnown ? p.data.buyBox : 'No observation'),
    cellClass: (p) => (p.data?.buyBoxKnown ? '' : 'nds-muted'),
  },
]

/**
 * A small table is exactly as wide as its columns. `.tableWrap` is `width: auto` on a flex column,
 * which shrank it to the stylesheet's 380px floor, and the four-column pricing table at 475px then
 * clipped its last column to "No…" (measured 2026-09-04, CT.1). The flex column counts at its
 * `minWidth`; +2 is the grid's own border pair.
 */
function tableWidth<T>(cols: ReadonlyArray<ColDef<T>>): number {
  return cols.reduce((w, c) => w + (c.width ?? c.minWidth ?? 100), 0) + 2
}

const SPARK_WIDTH = 320
const SPARK_HEIGHT = 48

function Efficiency({ row }: { row: { spendCents: number; adSalesCents: number; acos: number | null } }) {
  const e = readEfficiency(row)
  // "No sales" is the worst outcome on the table and must not look like the best — so it is a
  // warning, never a dash and never "0%".
  if (e.kind === 'spentNoSales') return <Pill tone="warning">{e.label}</Pill>
  if (e.kind === 'noSpend') return <span className={styles.unknown}>{e.label}</span>
  return <span>{e.label}</span>
}

export function AnalyticsAdsTab() {
  const { scope } = useStudioScope()
  return scope === 'master' ? <ProductPerformance /> : <ScopedPerformance />
}

function ProductPerformance() {
  const product = useStudioProduct()
  const [days, setDays] = useState('30')
  const [analytics, setAnalytics] = useState<AnalyticsPayload | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [ads, setAds] = useState<ProductAdsPayload | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    setState('loading')
    const window = Number(days)
    const [a, t, ad] = await Promise.all([
      apiGet<{ analytics: AnalyticsPayload }>(`/api/products/${product.id}/analytics?days=${window}`, signal),
      apiGet<{ trend: TrendPoint[] }>(`/api/products/${product.id}/analytics/trend?days=${window}`, signal),
      apiGet<ProductAdsPayload>(`/api/advertising/product-ads?${adsQuery({
        productId: product.id, sku: product.sku, asin: product.asin, windowDays: window,
      })}`, signal),
    ])
    if (signal.aborted) return
    if (!a.ok) { setError(a.message); setState('error'); return }
    setAnalytics(a.data?.analytics ?? null)
    setTrend(t.ok ? (t.data?.trend ?? []) : [])
    // Ads failing must not blank the analytics half — they are separate questions.
    setAds(ad.ok ? (ad.data ?? null) : null)
    setError(null)
    setState('ready')
  }, [product.id, product.sku, product.asin, days])

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])

  const sales = useMemo(
    () => (analytics ? readSales(analytics, { isParent: product.isParent }) : null),
    [analytics, product.isParent],
  )
  const trendReading = useMemo(() => readTrend(trend), [trend])
  const priceRows = useMemo<PriceRow[]>(
    // Joined on the coordinate, in a tested pure function — see `joinPriceRows`.
    () => (analytics ? joinPriceRows(analytics.pricing.currentPrices, analytics.pricing.latestBuyBoxPrices) : []),
    [analytics],
  )
  const adsReading = useMemo(() => readAds(ads), [ads])

  const campaignColumns = useMemo<ColDef<AdCampaign>[]>(() => [
    { field: 'name', headerName: 'Campaign', flex: 1, minWidth: 220 },
    { field: 'marketplace', headerName: 'Market', width: 105 },
    { field: 'status', headerName: 'Status', width: 115 },
    { field: 'impressions', headerName: 'Impressions', width: 140, type: 'numericColumn' },
    { field: 'clicks', headerName: 'Clicks', width: 105, type: 'numericColumn' },
    { field: 'orders', headerName: 'Orders', width: 105, type: 'numericColumn' },
    {
      headerName: 'Spend', width: 110, type: 'numericColumn',
      valueGetter: (p) => (p.data ? p.data.spendCents / 100 : 0),
      valueFormatter: (p) => money(Math.round((p.value as number) * 100), p.data?.currencyCode ?? null),
    },
    {
      headerName: 'Ad sales', width: 120, type: 'numericColumn',
      valueGetter: (p) => (p.data ? p.data.adSalesCents / 100 : 0),
      valueFormatter: (p) => money(Math.round((p.value as number) * 100), p.data?.currencyCode ?? null),
    },
    {
      headerName: 'ACOS', width: 110,
      // 🔴 Sorts on a number but renders the reading: a null ACOS with real spend is "No sales",
      // which is not 0% and must not sort as though it were the best row in the table.
      valueGetter: (p) => (p.data && p.data.spendCents > 0 && p.data.adSalesCents <= 0
        ? Number.POSITIVE_INFINITY
        : p.data?.acos ?? null),
      cellRenderer: (p: { data?: AdCampaign }) => (p.data ? <Efficiency row={p.data} /> : null),
    },
  ], [])

  const termColumns = useMemo<ColDef<AdSearchTerm>[]>(() => [
    { field: 'query', headerName: 'Search term', flex: 1, minWidth: 240 },
    { field: 'matchType', headerName: 'Match', width: 105 },
    { field: 'marketplace', headerName: 'Market', width: 105 },
    { field: 'impressions', headerName: 'Impressions', width: 140, type: 'numericColumn' },
    { field: 'clicks', headerName: 'Clicks', width: 105, type: 'numericColumn' },
    { field: 'orders', headerName: 'Orders', width: 105, type: 'numericColumn' },
    {
      headerName: 'Spend', width: 110, type: 'numericColumn',
      valueGetter: (p) => (p.data ? p.data.spendCents / 100 : 0),
      valueFormatter: (p) => (p.value as number).toFixed(2),
    },
    {
      headerName: 'ACOS', width: 110,
      valueGetter: (p) => (p.data && p.data.spendCents > 0 && p.data.adSalesCents <= 0
        ? Number.POSITIVE_INFINITY
        : p.data?.acos ?? null),
      cellRenderer: (p: { data?: AdSearchTerm }) => (p.data ? <Efficiency row={p.data} /> : null),
    },
  ], [])

  if (state === 'loading') return <p className={styles.state}>Reading this product’s figures…</p>
  if (state === 'error') {
    return (
      <div className={styles.page}>
        <p className={styles.error} role="alert">{error}</p>
      </div>
    )
  }

  const inventory = analytics?.inventory
  const available = readAvailable(inventory?.totalAvailable)
  const cover = inventory ? readDaysOfInventory(inventory.daysOfInventory) : null
  const risk = inventory ? readStockoutRisk(inventory.stockoutRisk) : null

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>Product performance · all destinations</h2>
        <span className={styles.spacer} />
        <SegmentedControl
          options={WINDOWS}
          value={days}
          onChange={setDays}
          aria-label="Reporting window"
        />
      </header>

      {/* ── sales ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>Sales</h3>
        {sales?.kind === 'measured' ? (
          <>
            <dl className={styles.stats}>
              <div><dt>Units</dt><dd>{sales.units}</dd></div>
              <div><dt>Revenue</dt><dd>{sales.revenue.toFixed(2)}</dd></div>
              <div><dt>Orders</dt><dd>{sales.orders}</dd></div>
              <div><dt>Units / day</dt><dd>{sales.avgDailyUnits.toFixed(1)}</dd></div>
              <div>
                <dt>Stockout days</dt>
                {/* Through the reading, like its four siblings — a `?? 0` here printed a clean
                    bill of health for a field the server never sent. */}
                <dd className={sales.stockoutDays === null ? styles.unknown : undefined}>
                  {sales.stockoutDays === null ? 'Not known' : sales.stockoutDays}
                </dd>
              </div>
            </dl>
            {trendReading.empty ? (
              <p className={styles.unknown}>Not enough daily readings to draw a trend.</p>
            ) : (
              <svg
                className={styles.spark}
                viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Daily units over ${days} days, peaking at ${trendReading.max}`}
              >
                <path className={styles.sparkLine} d={sparklinePath(trendReading.points, SPARK_WIDTH, SPARK_HEIGHT)} />
              </svg>
            )}
            {analytics && analytics.sales.byChannel.length > 0 && (
              <div className={styles.tableWrap} style={{ width: tableWidth(CHANNEL_COLUMNS) }}>
                <NexusGrid<ChannelRow>
                  rowData={analytics.sales.byChannel as ChannelRow[]}
                  columnDefs={CHANNEL_COLUMNS}
                  domLayout="autoHeight"
                  defaultColDef={DEFAULT_COL_DEF}
                />
              </div>
            )}
          </>
        ) : (
          // The number is refused, and the reason takes its place.
          <p className={styles.absence}>{sales?.note}</p>
        )}
      </section>

      {/*
        🔴 The whole row is gated on `analytics`, not each figure inside it.
        With the state `ready` but no payload — a request that succeeded and returned nothing —
        every card below fell through to its non-null branch: `Available` rendered `?? 0`
        ("out of stock", the most actionable number on the page, printed exactly when the read
        failed), and Cover, Stockout risk, Quality and Reviews rendered EMPTY `<dd>`s. Optional
        chaining made each of them typecheck while producing a blank or a lie.
      */}
      {analytics ? (
        <div className={styles.row}>
          <section className={styles.card}>
            <h3 className={styles.cardTitle}>Inventory</h3>
            <dl className={styles.stats}>
              <div>
                <dt>Available</dt>
                {/* A real 0 shows as 0 — out of stock is a fact. An absent value never does. */}
                <dd className={available.known ? undefined : styles.unknown}>{available.text}</dd>
              </div>
              <div>
                <dt>Cover</dt>
                <dd className={cover?.known ? undefined : styles.unknown}>{cover?.text ?? 'Not known'}</dd>
              </div>
              <div>
                <dt>Stockout risk</dt>
                <dd>
                  {risk
                    ? <Pill tone={risk.tone}>{risk.label}</Pill>
                    : <span className={styles.unknown}>Not known</span>}
                </dd>
              </div>
            </dl>
          </section>

          <section className={styles.card}>
            <h3 className={styles.cardTitle}>Quality</h3>
            {analytics.quality.latestScore === null ? (
              <p className={styles.unknown}>No quality score has been recorded for this product.</p>
            ) : (
              <dl className={styles.stats}>
                <div><dt>Latest score</dt><dd>{analytics.quality.latestScore}</dd></div>
              </dl>
            )}
          </section>

          <section className={styles.card}>
            <h3 className={styles.cardTitle}>Reviews</h3>
            {analytics.reviews.reviewCount === 0 ? (
              <p className={styles.unknown}>No reviews have been recorded for this product.</p>
            ) : (
              <dl className={styles.stats}>
                <div><dt>Rating</dt><dd>{analytics.reviews.avgRating?.toFixed(1) ?? '—'}</dd></div>
                <div><dt>Reviews</dt><dd>{analytics.reviews.reviewCount}</dd></div>
                <div><dt>Recent spike</dt><dd>{analytics.reviews.recentSpikeCount}</dd></div>
              </dl>
            )}
          </section>
        </div>
      ) : (
        <section className={styles.card}>
          <p className={styles.absence}>
            The server returned no figures for this product, so nothing here is known — including
            stock. That is an absence of data, not a reading of zero.
          </p>
        </section>
      )}

      {analytics && analytics.pricing.currentPrices.length > 0 && (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>Pricing</h3>
          <div className={styles.tableWrap} style={{ width: tableWidth(PRICE_COLUMNS) }}>
            <NexusGrid<PriceRow>
              rowData={priceRows}
              columnDefs={PRICE_COLUMNS}
              domLayout="autoHeight"
              defaultColDef={DEFAULT_COL_DEF}
            />
          </div>
        </section>
      )}

      {/* ── ads ──────────────────────────────────────────────────── */}
      <header className={styles.head}>
        <h2 className={styles.title}>Ads</h2>
        {adsReading.hasAds && <Pill tone="neutral">{adsReading.campaigns.length} campaigns</Pill>}
        {adsReading.spendingNothingBack > 0 && (
          <Pill tone="warning">{adsReading.spendingNothingBack} returned nothing</Pill>
        )}
      </header>

      <section className={styles.card}>
        <p className={styles.absence}>{adsHeadline(adsReading, { isParent: product.isParent })}</p>
        {adsReading.hasAds && adsReading.summary && (
          <dl className={styles.stats}>
            <div><dt>Spend</dt><dd>{money(adsReading.summary.totalSpendCents, adsReading.campaigns[0]?.currencyCode ?? null)}</dd></div>
            <div><dt>Ad sales</dt><dd>{money(adsReading.summary.totalAdSalesCents, adsReading.campaigns[0]?.currencyCode ?? null)}</dd></div>
            <div><dt>ACOS</dt><dd>{adsReading.summary.acos === null ? <span className={styles.unknown}>No sales</span> : `${adsReading.summary.acos.toFixed(1)}%`}</dd></div>
            <div><dt>Ads</dt><dd>{adsReading.summary.productAdCount}</dd></div>
          </dl>
        )}
      </section>

      {adsReading.campaigns.length > 0 && (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>Campaigns</h3>
          {/*
            🔴 A height, not `autoHeight`.
            74 campaigns under `autoHeight` measured 3675px — the grid became the page, and every
            section below it was pushed out of reach. The grid scrolls inside its own box instead,
            which is also what makes its header sticky and its sort usable.
          */}
          <NexusGrid<AdCampaign>
            rowData={adsReading.campaigns}
            columnDefs={campaignColumns}
            height={GRID_HEIGHT}
            defaultColDef={DEFAULT_COL_DEF}
          />
        </section>
      )}

      {adsReading.searchTerms.length > 0 && (
        <section className={styles.card}>
          <h3 className={styles.cardTitle}>Top search terms</h3>
          {/* Ten rows at most — it can grow with its content without taking the page over. */}
          <NexusGrid<AdSearchTerm>
            rowData={adsReading.searchTerms}
            columnDefs={termColumns}
            domLayout="autoHeight"
            defaultColDef={DEFAULT_COL_DEF}
          />
        </section>
      )}
    </div>
  )
}
