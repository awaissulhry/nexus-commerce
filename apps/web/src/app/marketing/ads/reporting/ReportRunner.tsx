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
 * 2. It does not sort on the client. DataGrid can sort what it holds, but it only
 *    holds the current page — sorting there would reorder 50 rows and present it
 *    as the top 50, which is wrong in a way nobody would notice. So the headers
 *    are our own buttons that re-query the server, and DataGrid is used for what
 *    it is genuinely good at: sticky headers, the totals row, and the empty state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowDown, ArrowUp, ChevronDown, Download, RefreshCw, Search, Settings2, Sigma, AlertTriangle } from 'lucide-react'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { H10Select } from '../campaigns/FilterDropdown'
import { MultiSelect } from '@/design-system/components/MultiSelect'
import { Pagination } from '@/design-system/components/Pagination'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { SavedReportBar } from './SavedReportBar'
import { CustomMetricsModal } from './CustomMetricsModal'
import { ReportSummary } from './ReportSummary'
import { fetchSummary, type CompareMode, type SummaryResult } from './summary-api'
import {
  defaultRange,
  exportUrl,
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
 * Trigger a file download without navigating. Content-Disposition makes the
 * browser save rather than render, and an anchor keeps the SPA on the page —
 * `location.href` would tear down the grid while the file is being generated.
 */
function download(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
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
  const [result, setResult] = useState<ReportResult | null>(null)
  const [summary, setSummary] = useState<SummaryResult | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [compare, setCompare] = useState<CompareMode>('previous')
  const [focusMetric, setFocusMetric] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [colsOpen, setColsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  const toggleSort = useCallback((col: string) => {
    setParams((p) => ({
      ...p,
      sortCol: col,
      sortDir: p.sortCol === col && p.sortDir === 'desc' ? 'asc' : 'desc',
      page: 1,
    }))
  }, [])

  const shown: ColumnMeta[] = result?.columns ?? []
  const currency = result?.currency ?? 'EUR'
  const sortCol = result?.applied.sort.col ?? params.sortCol
  const sortDir = result?.applied.sort.dir ?? params.sortDir

  const gridColumns: Array<Column<Row>> = useMemo(
    () =>
      shown.map((c, i) => ({
        key: c.id,
        // Sorting is server-side, so the header is our own button and DataGrid's
        // own sorting stays off (`sortable` unset).
        label: (
          <button
            type="button"
            className={`rpt-th${sortCol === c.id ? ' on' : ''}`}
            onClick={() => toggleSort(c.id)}
            title={c.help ? `${c.label} — ${c.help}` : `Sort by ${c.label}`}
          >
            <span>{c.label}</span>
            {sortCol === c.id
              ? (sortDir === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)
              : null}
          </button>
        ),
        align: c.align,
        sticky: i === 0,
        width: i === 0 ? 260 : undefined,
        render: (row: Row) => (
          <span className={c.kind === 'metric' ? 'rpt-num' : undefined}>
            {formatCell(row[c.id], c.format, currency)}
          </span>
        ),
        total:
          result?.totals && c.kind === 'metric'
            ? <span className="rpt-num">{formatCell(result.totals[c.id], c.format, currency)}</span>
            : i === 0
              ? (
                <span className="rpt-total-label">
                  Total
                  <span className="scope">
                    all {(result?.total ?? 0).toLocaleString('en-GB')} rows
                  </span>
                </span>
              )
              : null,
      })),
    [shown, sortCol, sortDir, currency, result, toggleSort],
  )

  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1
  const page = result?.page ?? params.page
  const viewStart = result && result.total > 0 ? (page - 1) * result.pageSize + 1 : 0
  const viewEnd = result ? Math.min(result.total, page * result.pageSize) : 0
  const colOptions = result?.options.columns ?? []
  const selectedCols = params.columns.length ? params.columns : shown.map((c) => c.id)

  return (
    <div className="rpt">
      <AdsPageHeader
        title={result?.title ?? 'Report'}
        subtitle="Filter, group, sort and page through the data. Every figure is computed server-side, so the totals row reflects the whole result, not this page."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showLearn={false}
        showDateRange={false}
        showDataSync
        syncing={loading}
        onDataSync={() => setParams((p) => ({ ...p }))}
      />

      <SavedReportBar params={params} onApply={setParams} />

      <CustomMetricsModal
        open={metricsOpen}
        onClose={() => setMetricsOpen(false)}
        reportId={params.reportId}
        available={colOptions}
        onChanged={() => setParams((p) => ({ ...p }))}
      />

      <Link href="/marketing/ads/reporting" className="rpt-back">
        <ArrowLeft size={14} aria-hidden /> All reports
      </Link>

      {/* Filters live in the console's own collapsible panel (.h10-am-fpanel), the
          same one the Ad Manager uses — heading, Hide/Show toggle, field grid. */}
      <div className={`h10-am-fpanel${filtersOpen ? '' : ' is-collapsed'}`}>
        <div className="fphead">
          <h3>Filters</h3>
          <button type="button" className="h10-am-link tog" onClick={() => setFiltersOpen((v) => !v)}>
            <ChevronDown size={14} className={filtersOpen ? 'up' : ''} />
            {filtersOpen ? 'Hide Filters' : 'Show Filters'}
          </button>
        </div>
        {filtersOpen && (
        <div className="frow">
        <label className="rpt-field">
          <span>From</span>
          <input
            type="date"
            value={params.from}
            max={params.to}
            onChange={(e) => patch({ from: e.target.value })}
          />
        </label>
        <label className="rpt-field">
          <span>To</span>
          <input
            type="date"
            value={params.to}
            min={params.from}
            onChange={(e) => patch({ to: e.target.value })}
          />
        </label>

        {(result?.options.marketplaces.length ?? 0) > 0 && (
          <label className="rpt-field">
            <span>Markets</span>
            <MultiSelect
              options={(result?.options.marketplaces ?? []).map((m) => ({ value: m, label: m }))}
              value={params.marketplaces}
              onChange={(v) => patch({ marketplaces: v })}
              placeholder="All markets"
            />
          </label>
        )}

        {(result?.options.adProducts.length ?? 0) > 1 && (
          <label className="rpt-field">
            <span>Ad product</span>
            <MultiSelect
              options={(result?.options.adProducts ?? []).map((m) => ({
                value: m,
                label: m.replace('SPONSORED_', 'SP ').toLowerCase(),
              }))}
              value={params.adProducts}
              onChange={(v) => patch({ adProducts: v })}
              placeholder="All"
            />
          </label>
        )}

        <label className="rpt-field">
          <span>Group by</span>
          <MultiSelect
            options={(result?.options.dimensions ?? []).map((d) => ({ value: d.id, label: d.label }))}
            value={result?.applied.groupBy ?? []}
            onChange={(v) => patch({ groupBy: v })}
            placeholder="Default"
          />
        </label>

        <label className="rpt-field grow">
          <span>Search</span>
          <span className="rpt-search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={searchDraft}
              placeholder="Search…"
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </span>
        </label>

        </div>
        )}
      </div>

      {error && (
        <div className="rpt-lede is-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Could not run this report.</b> {error}{' '}
            <button type="button" className="rpt-retry" onClick={() => setParams((p) => ({ ...p }))}>
              <RefreshCw size={12} aria-hidden /> Retry
            </button>
          </span>
        </div>
      )}

      <ReportSummary
        summary={summary}
        loading={summaryLoading}
        focus={focusMetric}
        onFocus={setFocusMetric}
        compare={compare}
        onCompare={setCompare}
      />

      {/* CBN.3 — toolbar + grid + pager are ONE card, exactly as the Ad Manager
          renders them. The row count lives on the left of the toolbar and the
          view controls sit right-aligned after the spacer; the pager carries
          rows-per-page on its right. Previously these were scattered: the count
          floated above the grid, and Columns/Export sat inside the filter row
          where nothing else in this console puts them. */}
      <div className="h10-am-card">
        <div className="h10-am-toolbar">
          <span className="cnt">
            {result ? (
              <>
                Viewing {viewStart.toLocaleString('en-GB')}-{viewEnd.toLocaleString('en-GB')} of{' '}
                <b>{result.total.toLocaleString('en-GB')}</b> rows
                {result.applied.groupBy.length > 0 && <> grouped by {result.applied.groupBy.join(' + ')}</>}
              </>
            ) : 'Loading…'}
          </span>
          {result && (
            <span className="rpt-meta-note">
              {result.applied.from} → {result.applied.to} · {result.elapsedMs} ms
              {loading && ' · refreshing…'}
            </span>
          )}
          <span className="grow" />

          <div className="h10-custwrap">
            <button
              type="button"
              className={`h10-am-btn ${colsOpen ? 'on' : ''}`}
              onClick={() => setColsOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={colsOpen}
            >
              <Settings2 size={13} /> Customize
            </button>
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

          <button type="button" className="h10-am-btn" onClick={() => setMetricsOpen(true)}>
            <Sigma size={13} /> Metrics
          </button>

          <div className="h10-custwrap">
            <button
              type="button"
              className={`h10-am-btn ${exportOpen ? 'on' : ''}`}
              onClick={() => setExportOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={exportOpen}
            >
              <Download size={13} /> Export Data
            </button>
            {exportOpen && (
              <>
                <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setExportOpen(false)} />
                <div className="h10-menu right" role="dialog" aria-label="Export">
                  <button type="button" onClick={() => { download(exportUrl(params, 'csv')); setExportOpen(false) }}>
                    CSV — {(result?.total ?? 0).toLocaleString('en-GB')} rows, raw numbers
                  </button>
                  <button type="button" onClick={() => { download(exportUrl(params, 'xlsx')); setExportOpen(false) }}>
                    Excel — {(result?.total ?? 0).toLocaleString('en-GB')} rows, formatted + manifest
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className={`h10-am-grid${loading ? ' is-loading' : ''}`}>
          <DataGrid<Row>
            columns={gridColumns}
            rows={(result?.rows ?? []) as Row[]}
            rowKey={(row) =>
              (result?.applied.groupBy ?? []).map((g) => String(row[g] ?? '')).join('¦') ||
              JSON.stringify(row)
            }
            showTotals={!!result?.totals && (result?.rows.length ?? 0) > 0}
            emptyState={
              loading ? 'Running…' : 'No rows match these filters. Try widening the date range.'
            }
          />
        </div>

      </div>

      <div className="rpt-pager">
        {pageCount > 1 && (
          <Pagination
            page={page}
            pageCount={pageCount}
            onPage={(n) => setParams((p) => ({ ...p, page: n }))}
          />
        )}
        <div className="rpp">Rows per page:
          <H10Select
            width={84}
            options={[50, 100, 200, 500].map((n) => ({ value: String(n), label: String(n) }))}
            value={String(params.pageSize)}
            onChange={(v) => setParams((p) => ({ ...p, pageSize: Number(v), page: 1 }))}
            ariaLabel="Rows per page"
          />
        </div>
      </div>
    </div>
  )
}
