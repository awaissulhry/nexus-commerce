'use client'

/**
 * RPT.3 — the report runner.
 *
 * One screen that runs any report in the catalogue: date range, market and
 * ad-product filters, free-text search, a grouping picker, a column chooser,
 * server-side sort and pagination, and a totals row.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It defines no columns. Labels, formats and alignment arrive from the server
 *    with the data, so the grid, the totals row and the RPT.4 export are all
 *    reading one definition. A column cannot mean one thing here and another in
 *    the CSV.
 *
 * 2. It does not sort, search or page on the client. Doing any of them here would reorder or
 *    narrow the 50 rows this page happens to hold and present the result as the top 50 — wrong
 *    in a way nobody would notice, because the numbers stay plausible. The search-terms report
 *    is 12,276 rows; every one of those three has to be a query.
 *
 * R3 — the grid is `AdsDataGrid`, the same one the other fifty-four grids in this console use.
 * It was the design-system `DataGrid`, which no other page in the console renders, and the gap
 * showed: no filter presets, no (i) tips on the headers, no "Latest report" footer, a different
 * pager and a different search. Point 2 above is why it could not simply be swapped: that grid
 * assumes it holds the whole result. So `AdsDataGrid` gained a `server` mode — additive, and
 * off for every other consumer — in which it renders the page it is handed and asks the
 * consumer to fetch the next one. The header, the pager and the search behave identically;
 * only who computes the rows changed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Menu } from '@/design-system/components/Menu'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, Settings2, Share2, Sigma, AlertTriangle } from 'lucide-react'
import { AdsFilterBar } from '../campaigns/_grid/AdsFilterBar'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../campaigns/_grid/AdsDataGrid'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { SavedReportBar } from './SavedReportBar'
import { CustomMetricsModal } from './CustomMetricsModal'
import { ShareLinkModal } from './ShareLinkModal'
import { DeliveriesModal, type DeliveriesView } from './DeliveriesModal'
import { ReportSummary } from './ReportSummary'
import { BusinessContextPanel } from './BusinessContextPanel'
import { IncrementalityPanel } from './IncrementalityPanel'
import { BrandMetricsPanel } from './BrandMetricsPanel'
import { fetchSummary, type CompareMode, type SummaryResult } from './summary-api'
import {
  defaultRange,
  exportUrl,
  isoDay,
  formatCell,
  runReport,
  type ColumnMeta,
  type ReportParams,
  type ReportResult,
} from './report-api'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

type Row = Record<string, unknown>

/**
 * Date → `YYYY-MM-DD`, built from local parts.
 *
 * There is one such function and it lives in `report-api` as `isoDay`, beside the default
 * window it also serialises — two of them is how the picker and the default start disagreeing
 * about which day "today" is. See the note there for why local rather than UTC.
 */
function dayToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** Filename the server chose, read back off Content-Disposition. */
function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? ''
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)
  return m ? decodeURIComponent(m[1]) : fallback
}

/**
 * Fetch the export, then hand the browser a Blob.
 *
 * 🔴 R0 — this MUST go through `fetch`, never `a.href = <api url>`. It did the
 * latter until 2026-08-19, and it could not have worked: an anchor click is a
 * TOP-LEVEL CROSS-SITE NAVIGATION, and the session cookie is
 * `SameSite=None; Secure; Partitioned` (CHIPS, because web is on vercel.app and
 * the API on railway.app). A partitioned cookie is keyed to the top-level site,
 * so it is not sent once the top-level site becomes the API. It also bypasses
 * `installAuthFetch`, which is what adds `credentials: 'include'` for us.
 * The request arrived unauthenticated and the browser saved the 72-byte
 * `{"error":"Access denied"}` under a `.csv` name — a download that looked like
 * it worked. Measured on prod; every other export in this console fetches.
 */
async function download(url: string, fallbackName: string) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const why = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(why?.error ?? `Export failed (${res.status})`)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filenameFrom(res, fallbackName)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export function ReportRunner({ reportId }: { reportId: string }) {
  const initial = defaultRange()
  const [params, setParams] = useState<ReportParams>({
    reportId,
    from: initial.from,
    to: initial.to,
    marketplaces: [],
    adProducts: [],
    search: '',
    groupBy: [],
    columns: [],
    sortCol: null,
    sortDir: 'desc',
    page: 1,
    pageSize: 50,
  })
  // The search box is debounced separately so typing doesn't fire a query per key.
  const [searchDraft, setSearchDraft] = useState('')
  /**
   * What the grid's search box is SEEDED with — not what is currently typed.
   *
   * 🔴 These must be different values. `initialSearch` re-seeds the grid whenever it changes, so
   * feeding it the live query would push a 350ms-old string back into the box mid-word and eat
   * the characters typed since. It changes only when something else sets the search for you: a
   * saved report, or a shared link.
   */
  const [searchSeed, setSearchSeed] = useState('')
  const [result, setResult] = useState<ReportResult | null>(null)
  const [summary, setSummary] = useState<SummaryResult | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [compare, setCompare] = useState<CompareMode>('previous')
  // R4 — which metrics are plotted. Several now, not one; the KPI tiles and the chart's own
  // picker both write here, so they cannot disagree. Empty means "whatever the report leads
  // with", resolved in ReportSummary against the metrics that report actually has.
  const [plotted, setPlotted] = useState<string[]>([])
  const [colsOpen, setColsOpen] = useState(false)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  // null = closed; otherwise which view of the one delivery surface to open on.
  const [deliveries, setDeliveries] = useState<DeliveriesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Export is a fetch now, so it takes time and can fail — both have to be visible.
  // Silence is what let a broken export look like a working one for months.
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => {
      setParams((p) => (p.search === searchDraft ? p : { ...p, search: searchDraft, page: 1 }))
    }, 350)
    return () => window.clearTimeout(t)
  }, [searchDraft])

  // Keep the previous result on screen while the next one loads: blanking the
  // grid on every filter change makes the page feel broken and loses your place.
  const acRef = useRef<AbortController | null>(null)
  useEffect(() => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setLoading(true)
    runReport(params, ac.signal)
      .then((r) => {
        setResult(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return
        setError((e as Error).message)
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [params])

  // The summary is its own request so the grid is never held up by it, and a
  // slow chart can never delay the numbers underneath.
  useEffect(() => {
    const ac = new AbortController()
    setSummaryLoading(true)
    fetchSummary(params, compare, ac.signal)
      .then(setSummary)
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setSummary(null) })
      .finally(() => { if (!ac.signal.aborted) setSummaryLoading(false) })
    return () => ac.abort()
  }, [params, compare])

  const patch = useCallback((next: Partial<ReportParams>) => {
    // Any change to filtering or shape invalidates the page number — staying on
    // page 7 of a result that now has 2 pages shows an empty grid.
    setParams((p) => ({ ...p, ...next, page: next.page ?? 1 }))
  }, [])


  const runExport = useCallback(async (format: 'csv' | 'xlsx') => {
    // The DS `Menu` closes itself on select, so there is no popover state to clear here.
    setExportError(null)
    setExporting(format)
    try {
      await download(exportUrl(params, format), `${params.reportId}.${format}`)
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(null)
    }
  }, [params])

  // The header picker is controlled from the report's own window, so the two cannot disagree.
  const headerRange = useMemo(
    () => ({ start: dayToDate(params.from), end: dayToDate(params.to) }),
    [params.from, params.to],
  )

  /**
   * The filter bar's controls, in the shared bar's own vocabulary.
   *
   * Markets and Ad product only appear when the server says this report HAS more than one —
   * an inert control on a Sponsored-Products-only account is a control that teaches you the
   * page is broken. That was already true of the hand-rolled row and is preserved here.
   */
  const barFilters: GridFilter[] = useMemo(() => {
    const out: GridFilter[] = []
    const markets = result?.options.marketplaces ?? []
    if (markets.length > 0) {
      out.push({
        key: 'marketplaces', label: 'Markets', kind: 'multiselect',
        options: markets.map((m) => ({ value: m, label: m })),
        placeholder: 'All markets',
      })
    }
    const products = result?.options.adProducts ?? []
    if (products.length > 1) {
      out.push({
        key: 'adProducts', label: 'Ad product', kind: 'multiselect',
        options: products.map((m) => ({ value: m, label: m.replace('SPONSORED_', 'SP ').toLowerCase() })),
        placeholder: 'All',
      })
    }
    out.push({
      key: 'groupBy', label: 'Group by', kind: 'multiselect',
      options: (result?.options.dimensions ?? []).map((d) => ({ value: d.id, label: d.label })),
      placeholder: 'Default',
      tip: 'What one row of this report is. Clearing it returns the report to its own default grain.',
    })
    return out
  }, [result])

  const barValue: FilterState = useMemo(() => ({
    marketplaces: params.marketplaces,
    adProducts: params.adProducts,
    // The APPLIED grouping, not the requested one: a report falls back to its own default
    // when you clear this, and the bar has to show what the rows are actually grouped by.
    groupBy: result?.applied.groupBy ?? params.groupBy,
  }), [params.marketplaces, params.adProducts, params.groupBy, result])

  const onBarChange = useCallback((next: FilterState) => {
    patch({
      marketplaces: (next.marketplaces as string[] | undefined) ?? [],
      adProducts: (next.adProducts as string[] | undefined) ?? [],
      groupBy: (next.groupBy as string[] | undefined) ?? [],
    })
  }, [patch])

  /**
   * R5 — why this report is empty, when the reason is the calendar rather than the filters.
   *
   * Every v3 feed lands overnight, so a report asked for TODAY is empty by construction — and
   * "try widening the date range" is the one piece of advice that cannot help, because the rows
   * do not exist yet at any width. The hourly stream does have today, in all four markets, so
   * the empty state points there instead of shrugging.
   */
  const emptyBecause = useMemo(() => {
    if (loading) return 'Running\u2026'
    const today = isoDay(new Date())
    const asksForToday = params.to >= today
    if (asksForToday && params.reportId !== 'hourly') {
      return params.from >= today
        ? 'This feed lands overnight, so today has no rows yet. Today\u2019s figures are on the Hourly report, which reads the live stream.'
        : 'No rows yet for today \u2014 this feed lands overnight. Earlier days in this window should appear; if they do not, widen the range.'
    }
    return 'No rows match these filters. Try widening the date range.'
  }, [loading, params.to, params.from, params.reportId])

  const shown: ColumnMeta[] = result?.columns ?? []
  const currency = result?.currency ?? 'EUR'
  const sortCol = result?.applied.sort.col ?? params.sortCol
  const sortDir = result?.applied.sort.dir ?? params.sortDir

  /**
   * R3 — the report's columns, in the shared grid's vocabulary.
   *
   * The client still defines NO columns of its own: labels, formats, alignment and help text
   * arrive from the server with the data, so the grid, the pinned Total row and the export all
   * read one definition and cannot drift. What changed is only which grid renders them.
   *
   * The FIRST column is the shared grid's sticky one and is passed separately, so `columns` is
   * everything after it. `sortValue` is deliberately omitted on every column: in server mode the
   * grid never sorts, and leaving an accessor there would be a second, disagreeing opinion about
   * order that nothing calls today and something might tomorrow.
   */
  const firstCol: ColumnMeta | null = shown[0] ?? null
  const restCols: ColumnMeta[] = useMemo(() => shown.slice(1), [shown])

  const gridColumns: GridColumn<Row>[] = useMemo(
    () => restCols.map((c) => ({
      key: c.id,
      label: c.label,
      tip: c.help,
      metric: c.kind === 'metric',
      render: (row: Row) => formatCell(row[c.id], c.format, currency),
      total: result?.totals && c.kind === 'metric'
        ? formatCell(result.totals[c.id], c.format, currency)
        : undefined,
    })),
    [restCols, currency, result],
  )

  /**
   * The shared grid names its sticky column `__first`; the server names it by id. One
   * translation, in both directions, so neither side has to know about the other.
   */
  const gridSort = useMemo(() => {
    if (!sortCol) return undefined
    return { key: sortCol === firstCol?.id ? '__first' : sortCol, dir: sortDir }
  }, [sortCol, sortDir, firstCol])

  const onGridSort = useCallback((next: { key: string; dir: 'asc' | 'desc' } | null) => {
    setParams((p) => ({
      ...p,
      // Clearing the sort hands ordering back to the report's own default, which is what the
      // server applies when `sortCol` is absent — not "unordered".
      sortCol: next ? (next.key === '__first' ? (firstCol?.id ?? null) : next.key) : null,
      sortDir: next?.dir ?? 'desc',
      page: 1,
    }))
  }, [firstCol])

  const colOptions = result?.options.columns ?? []
  const selectedCols = params.columns.length ? params.columns : shown.map((c) => c.id)

  return (
    <div className="rpt">
      <AdsPageHeader
        title={result?.title ?? 'Report'}
        subtitle={result ? `${result.applied.from} \u2192 ${result.applied.to}` : ''}
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showDataSync
        syncing={loading}
        onDataSync={() => setParams((p) => ({ ...p }))}
        /* R2 — the console's own range control, in the slot every other ads page puts it.
           This page had it switched OFF and hand-rolled two native <input type="date">
           inside the filter row instead: a third date vocabulary in one console, with no
           presets, no two-month calendar, and browser-native chrome nothing else here has.
           `dateRange` + `onDateRange` make the shared picker controlled (PLC.0), so the
           report's window and the header label are one fact rather than two. */
        showDateRange
        dateRange={headerRange}
        onDateRange={(start, end) => patch({ from: isoDay(start), to: isoDay(end) })}
      />

      <SavedReportBar
        params={params}
        onApply={(next) => { setParams(next); setSearchDraft(next.search); setSearchSeed(next.search) }}
      />

      <CustomMetricsModal
        open={metricsOpen}
        onClose={() => setMetricsOpen(false)}
        reportId={params.reportId}
        available={colOptions}
        onChanged={() => setParams((p) => ({ ...p }))}
      />

      <DeliveriesModal
        open={deliveries !== null}
        initialView={deliveries ?? 'list'}
        onClose={() => setDeliveries(null)}
        reportId={params.reportId}
      />

      <ShareLinkModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        reportId={params.reportId}
        reportTitle={result?.title ?? params.reportId}
        query={params as unknown as Record<string, unknown>}
      />

      <Link href="/marketing/ads/reporting" className="rpt-back">
        <ArrowLeft size={14} aria-hidden /> All reports
      </Link>

      {/* R2 — the shared filter bar, not a second implementation of one. This page used to
          render its own `.h10-am-fpanel` markup with `.rpt-field` controls inside; the bar the
          rest of the console renders is `AdsFilterBar`, and it brings the collapsed summary
          (which names what is set rather than counting it) and one Clear button with it. */}
      <AdsFilterBar
        filters={barFilters}
        value={barValue}
        onChange={onBarChange}
        defaultOpen
      />

      {error && (
        <div className="rpt-lede is-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Could not run this report.</b> {error}{' '}
            <Button size="sm" onClick={() => setParams((p) => ({ ...p }))}>
              <RefreshCw size={12} aria-hidden /> Retry
            </Button>
          </span>
        </div>
      )}

      {exportError && (
        <div className="rpt-lede is-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>The export did not download.</b> {exportError}{' '}
            <Button size="sm" onClick={() => setExportError(null)}>
              Dismiss
            </Button>
          </span>
        </div>
      )}

      <ReportSummary
        summary={summary}
        loading={summaryLoading}
        selected={plotted}
        onSelectedChange={setPlotted}
        compare={compare}
        onCompare={setCompare}
      />

      {/* BM.1 — the category benchmarks, in the slot this page already uses for
          report-specific panels (see the campaign report's business context and
          incrementality below the grid). It sits ABOVE the grid rather than below
          because on this report it IS the headline: Amazon has been sending a
          category median and a top-performer figure for thirteen metrics since
          June and nothing has ever rendered one. The grid underneath is unchanged. */}
      {reportId === 'brand-metrics' && (
        <BrandMetricsPanel
          params={params}
          markets={result?.options.marketplaces ?? []}
          onPickMarket={(m) => patch({ marketplaces: [m] })}
        />
      )}

      {/* CBN.3 — toolbar + grid + pager are ONE card, exactly as the Ad Manager
          renders them. The row count lives on the left of the toolbar and the
          view controls sit right-aligned after the spacer; the pager carries
          rows-per-page on its right. Previously these were scattered: the count
          floated above the grid, and Columns/Export sat inside the filter row
          where nothing else in this console puts them. */}
      <AdsDataGrid<Row>
        rows={(result?.rows ?? []) as Row[]}
        loading={loading && !result}
        rowId={(row) =>
          (result?.applied.groupBy ?? []).map((g) => String(row[g] ?? '')).join('\u00a6') || JSON.stringify(row)
        }
        noun="Row"
        firstColLabel={firstCol?.label ?? 'Row'}
        renderFirst={(row) => (firstCol ? formatCell(row[firstCol.id], firstCol.format, currency) : '')}
        firstSortValue={(row) => (firstCol ? String(row[firstCol.id] ?? '') : '')}
        columns={gridColumns}
        /* R3 — the whole point: the rows below are the page the SERVER built. The grid renders
           them verbatim and takes the result size from `total`, so paging a 12,276-row report
           stays a query rather than a slice of whatever happens to be in the browser. */
        server={{
          total: result?.total ?? 0,
          rowsPerPage: params.pageSize,
          onRowsPerPageChange: (n) => setParams((p) => ({ ...p, pageSize: n, page: 1 })),
        }}
        defaultSort={gridSort}
        onSortChange={onGridSort}
        initialPage={params.page}
        onPageChange={(n) => setParams((p) => (p.page === n ? p : { ...p, page: n }))}
        searchable
        searchPlaceholder="Search…"
        initialSearch={searchSeed}
        onSearchChange={setSearchDraft}
        selectable={false}
        /* The report's column chooser is the SERVER's: it changes the query, the pinned totals
           and the export together. The grid's own Customize hides columns in the browser only,
           which would quietly disagree with the file you download. */
        customizable={false}
        toolbarRight={<>
          <div className="h10-custwrap">
            <Button
 active={colsOpen}
 onClick={() => setColsOpen((v) => !v)}
 aria-haspopup="dialog"
 aria-expanded={colsOpen}
 >
              <Settings2 size={13} /> Customize
            </Button>
            {colsOpen && (
              <>
                <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setColsOpen(false)} />
                <div className="h10-menu right rpt-colmenu" role="dialog" aria-label="Customize columns">
                  {colOptions.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={selectedCols.includes(c.id) ? 'on' : ''}
                      onClick={() => {
                        const next = selectedCols.includes(c.id)
                          ? selectedCols.filter((x) => x !== c.id)
                          : [...selectedCols, c.id]
                        patch({ columns: next })
                      }}
                    >
                      <span className="tick">{selectedCols.includes(c.id) ? '✓' : ''}</span>
                      {c.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <Button onClick={() => setMetricsOpen(true)}>
            <Sigma size={13} /> Metrics
          </Button>

          {/* R6 — one control for every way this report leaves the console. Download, share
              and schedule were three affordances in two places, and scheduling was on the
              LIBRARY page: to schedule the report in front of you meant saving it, leaving,
              scrolling and finding it again in a dropdown. They answer one question, so they
              are one menu, on the report. */}
          <Menu
            align="right"
            label={<><Share2 size={13} /> {exporting ? 'Preparing…' : 'Deliver'}</>}
            triggerProps={{ disabled: exporting !== null, 'aria-label': 'Deliver this report' }}
            items={[
              { id: 'csv', label: `Download CSV · ${(result?.total ?? 0).toLocaleString('en-GB')} rows`, onSelect: () => { void runExport('csv') } },
              { id: 'xlsx', label: `Download Excel · ${(result?.total ?? 0).toLocaleString('en-GB')} rows`, onSelect: () => { void runExport('xlsx') } },
              { id: 'share', label: 'Share a link…', onSelect: () => setShareOpen(true) },
              { id: 'schedule', label: 'Schedule by email…', onSelect: () => setDeliveries('new') },
              { id: 'manage', label: 'Manage deliveries…', onSelect: () => setDeliveries('list') },
            ]}
          />
        </>}
        showTotal={!!result?.totals && (result?.rows.length ?? 0) > 0}
        totalFirst={
          <span className="rpt-total-label">
            Total
            <span className="scope">all {(result?.total ?? 0).toLocaleString('en-GB')} rows</span>
          </span>
        }
        emptyLabel={emptyBecause}
      />

      {/* R1 — business context (TACoS, ad vs organic, wasted spend) and incrementality moved
          here from the library. They are analysis, not a report you pick, and on the landing
          page they were the two largest panels on a screen whose job is choosing one. They
          describe campaign performance across the account, so they sit under the campaign
          report and nowhere else. */}
      {reportId === 'campaign' && (
        <>
          <BusinessContextPanel />
          <IncrementalityPanel />
        </>
      )}
    </div>
  )
}
