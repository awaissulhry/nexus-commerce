'use client'

/**
 * Reviews › Insights › Themes (`/marketing/reviews/insights/themes`, build spec §3.4, the Themes board): what buyers
 * talk about, across every channel and market in the scope.
 *
 *   Header   the shared Insights header: channel and market, period (both in the address)
 *   Tiles    reviews read · negative share (against the period before) · biggest riser · themes
 *   Banner   Amazon's topics: weekly, English, never Amazon.nl (ruling 5); the markets Nexus could not read
 *   Board    one row per theme (`GET /api/reviews/insights/themes`): mentions, share, star impact, change, 8 weeks,
 *            two quotes that name their source; sort Mentions / Star impact / Change (`?sort=`). A theme opens its
 *            reviews in the Inbox.
 *   Fit      runs small / true to size / runs large per family and size (`fit` of the same read): from reviews that say how
 *            it fits and returns marked "too small" / "too large"; a size needs 5 mentions before it gets a verdict, fewer
 *            is "Too few". "Size-guide fixes" opens Fixes on the Size guide kind.
 *   Heatmap  theme × day (`GET /api/reviews/heatmap`), Mentions / Negative share (`?metric=`); a cell opens the Inbox on
 *            that theme over the shortest period that holds the day.
 * Everything re-reads every 60 s and when this or another tab changes a review.
 */
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { AsOf, Banner, Card, Heatmap, MetricStrip, ProgressBar, Sparkline, SummaryTable, type Metric } from '@/design-system/components'
import {
  GridCard,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  NexusGrid,
  useGridState,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type GridStateKey,
  type ICellRendererParams,
  type NexusGridProps,
} from '@/design-system/grid'
import { GridToolbar } from '@/design-system/patterns'
import { Button, Pill, SegmentedControl, Tag } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { insightsHref } from '../../_lib/reviewsLinks'
import { useGridCustomise, type GridColumnSpec } from '../../requests/gridCustomise'
import { InsightsHeader } from '../_shared/InsightsHeader'
import { periodWords, scopeApiParams, type InsightsScope } from '../_shared/insightsScope'
import { familyMentions, fitPill, fitTableFootnote, type FitTable } from '../_shared/fitView'
import { useAddressSync, useInsightsRead, useInsightsScope, useScopeChoices } from '../_shared/useInsights'
import {
  HEAT_METRIC_OPTIONS,
  MOOD_WORDS,
  THEME_SORT_OPTIONS,
  changeTone,
  heatCellHref,
  heatCellText,
  heatMatrix,
  heatSubtitle,
  impactView,
  parseHeatMetric,
  parseThemeSort,
  pointsWords,
  shareWords,
  sourcesWords,
  themeHref,
  themesTiles,
  topicsBanner,
  trendLabel,
  type HeatMetric,
  type HeatmapAnswer,
  type InsightTheme,
  type ThemeSort,
  type ThemesAnswer,
} from './themesModel'
import shared from '../_shared/insights.module.css'
import s from './themes.module.css'

const REVIEW_EVENTS = ['review.updated', 'review.imported'] as const

/* ── stable grid options (GDS decision 12) ── */
const ROW_ID: NonNullable<NexusGridProps<InsightTheme>['getRowId']> = (p) => p.data.key
const LOADING_PARAMS = { rows: 6 }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility']
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
const NO_ROWS = { title: 'No themes in this period', message: 'No review or Amazon topic in this scope mentions a theme. Pick a longer period, or every channel.' }

const COLUMN_SPECS: GridColumnSpec[] = [
  { key: 'theme', label: 'Theme', locked: true },
  { key: 'mentions', label: 'Mentions' },
  { key: 'share', label: 'Share of reviews' },
  { key: 'impact', label: 'Star impact' },
  { key: 'change', label: 'Change' },
  { key: 'trend', label: '8 weeks' },
  { key: 'say', label: 'What buyers say' },
]

interface ThemesGridContext {
  scope: InsightsScope
}

type Cell = ICellRendererParams<InsightTheme, unknown, { current: ThemesGridContext }>

const ThemeCell = memo(function ThemeCell({ data, context }: Cell) {
  if (!data) return null
  return (
    <span className={shared.stack}>
      <Link className={s.themeLink} href={themeHref(data.key, context.current.scope)} title={`Open the reviews about ${data.label} in the Inbox`}>
        {data.label}
      </Link>
      <span className={shared.sub}>{MOOD_WORDS[data.mood]}</span>
    </span>
  )
})

const MentionsCell = memo(function MentionsCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className={shared.stack}>
      <span className={`${shared.main} ${shared.num}`}>{data.mentions.toLocaleString('en-IE')}</span>
      <span className={shared.sub}>{sourcesWords(data)}</span>
    </span>
  )
})

const ShareCell = memo(function ShareCell({ data }: Cell) {
  if (!data) return null
  if (data.share == null) return <span className={shared.sub}>—</span>
  return (
    <span className={s.share}>
      <ProgressBar value={data.share} height={6} ariaLabel={`${data.label}: ${shareWords(data.share)} of reviews`} />
      <span className={shared.num}>{shareWords(data.share)}</span>
    </span>
  )
})

const ImpactCell = memo(function ImpactCell({ data }: Cell) {
  if (!data) return null
  const view = impactView(data)
  return <span title={view.words} aria-label={view.words}><Pill tone={view.tone}>{view.text}</Pill></span>
})

const ChangeCell = memo(function ChangeCell({ data }: Cell) {
  if (!data) return null
  const tone = changeTone(data)
  return <span className={`${shared.num} ${tone === 'bad' ? shared.bad : tone === 'good' ? shared.good : ''}`}>{pointsWords(data.change)}</span>
})

const TrendCell = memo(function TrendCell({ data }: Cell) {
  if (!data) return null
  if (!data.trend) return <span className={shared.sub}>too few to trend</span>
  return <Sparkline values={data.trend} label={trendLabel(data)} width={96} height={24} />
})

const SayCell = memo(function SayCell({ data }: Cell) {
  if (!data) return null
  if (data.snippets.length === 0) return <span className={shared.sub}>No quote yet</span>
  return (
    <ul className={s.quotes}>
      {data.snippets.map((q, i) => (
        <li key={`${q.reviewId ?? q.from}:${i}`}>
          <Tag tone="neutral">{q.from}</Tag> <span>“{q.text}”</span>
          {q.english && <span className={shared.sub}> — translated: “{q.english}”</span>}
        </li>
      ))}
    </ul>
  )
})

const COLUMNS: ColDef<InsightTheme>[] = [
  { colId: 'theme', headerName: 'Theme', width: 170, minWidth: 140, pinned: 'left', lockPinned: true, lockPosition: 'left', sortable: false, cellRenderer: ThemeCell, cellClass: 'nds-ag-cell', valueGetter: (p) => p.data?.label ?? null },
  { colId: 'mentions', headerName: 'Mentions', width: 150, minWidth: 120, sortable: false, cellRenderer: MentionsCell, cellClass: 'nds-ag-cell', autoHeight: true, wrapText: true },
  { colId: 'share', headerName: 'Share of reviews', width: 150, minWidth: 130, sortable: false, cellRenderer: ShareCell, cellClass: 'nds-ag-cell' },
  { colId: 'impact', headerName: 'Star impact', headerTooltip: 'How many stars the reviews that mention this theme sit above or below your average.', width: 128, minWidth: 120, sortable: false, cellRenderer: ImpactCell, cellClass: 'nds-ag-cell' },
  { colId: 'change', headerName: 'Change', headerTooltip: 'Share of reviews against the period before, in points.', width: 96, minWidth: 88, sortable: false, cellRenderer: ChangeCell, cellClass: 'nds-ag-cell' },
  { colId: 'trend', headerName: '8 weeks', headerTooltip: 'Mentions a week, last 8 weeks (reviews only).', width: 124, minWidth: 110, sortable: false, cellRenderer: TrendCell, cellClass: 'nds-ag-cell' },
  { colId: 'say', headerName: 'What buyers say', flex: 1, minWidth: 260, sortable: false, cellRenderer: SayCell, cellClass: 'nds-ag-cell', autoHeight: true, wrapText: true },
]

/** The fit table: a family per row (its name opens its pop-up on Products), a column per size, what to tell buyers. */
function FitTableView({ fit, scope }: { fit: FitTable; scope: InsightsScope | null }) {
  const min = fit.summary.minimum
  return (
    <div className={s.fitScroll}>
      <div className={s.fitInner} style={{ '--fit-min': `${420 + fit.sizes.length * 130}px` } as CSSProperties}>
        <SummaryTable
          label="Fit by product family and size"
          stackOnPhone
          columns={['Family', ...fit.sizes, 'What to tell buyers']}
          align={['left', ...fit.sizes.map(() => 'left' as const), 'left']}
          widths={['180px', ...fit.sizes.map(() => undefined), '240px']}
          rows={fit.families.map((f) => ({
            id: f.familyId,
            cells: [
              <span key="f" className={shared.stack}>
                <Link className={`${s.themeLink} ${s.fitFamily}`} title={f.name} href={insightsHref('products', { product: f.familyId, channel: scope?.channel, market: scope?.market, period: scope?.period })}>{f.name}</Link>
                <span className="nds-summary-sub">{familyMentions(f)}</span>
              </span>,
              ...f.cells.map((c) => {
                const v = fitPill(c, min)
                return (
                  <span key={c.size} title={v.words}>
                    <Pill tone={v.tone}>{v.text}</Pill>
                    <span className="nds-summary-sub">{v.note}</span>
                  </span>
                )
              }),
              <span key="a">{f.advice}</span>,
            ],
          }))}
        />
      </div>
    </div>
  )
}

export function ThemesClient() {
  const router = useRouter()
  const { scope, initial, setScope } = useInsightsScope()
  // The page's own address values (sort, heatmap mode): read once with the scope, then set by their controls.
  const [own, setOwn] = useState<{ sort?: ThemeSort; metric?: HeatMetric }>({})
  const setPageState = useCallback((next: { sort?: ThemeSort; metric?: HeatMetric }) => setOwn((prev) => ({ ...prev, ...next })), [])
  const currentSort = own.sort ?? parseThemeSort(initial?.get('sort'))
  const currentMetric = own.metric ?? parseHeatMetric(initial?.get('metric'))
  useAddressSync(scope, { sort: currentSort === 'mentions' ? null : currentSort, metric: currentMetric === 'mentions' ? null : currentMetric })

  const api = scope ? scopeApiParams(scope) : {}
  const keep = scope ? `${scope.channel}|${scope.market}|${scope.period}` : null
  const themes = useInsightsRead<ThemesAnswer>(scope ? '/reviews/insights/themes' : null, { ...api, sort: currentSort }, [...REVIEW_EVENTS], { keep })
  const heat = useInsightsRead<HeatmapAnswer>(scope ? '/reviews/heatmap' : null, { ...api, metric: currentMetric }, [...REVIEW_EVENTS], { keep })
  const choices = useScopeChoices(scope?.period ?? null)

  // ── Grid ──
  const context = useRef<ThemesGridContext>({ scope: scope ?? { channel: null, market: null, period: '30d' } })
  if (scope) context.current = { scope }
  const apiRef = useRef<GridApi<InsightTheme> | null>(null)
  const customise = useGridCustomise(apiRef, COLUMN_SPECS)
  const gridState = useGridState<Record<string, never>>({
    surface: 'reviews-insights-themes',
    baseUrl: getBackendUrl(),
    getPageState: NO_PAGE_STATE,
    applyPageState: IGNORE_PAGE_STATE,
    persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const onGridReady = useCallback((e: GridReadyEvent<InsightTheme>) => {
    apiRef.current = e.api
    bindState.current(e.api)
  }, [])
  const rows = useMemo(() => themes.data?.themes ?? [], [themes.data])

  // ── Heatmap ──
  const matrix = useMemo(() => (heat.data ? heatMatrix(heat.data) : null), [heat.data])
  const onCell = useCallback((r: number, c: number) => {
    if (!matrix || !heat.data || !context.current) return
    router.push(heatCellHref(matrix.keys[r], heat.data.dates[c], context.current.scope, new Date()))
  }, [matrix, heat.data, router])
  const cellWords = useCallback((r: number, c: number) => {
    if (!matrix || !heat.data) return ''
    return heatCellText(matrix.rowLabels[r], heat.data.dates[c], matrix.cells[r][c], heat.data.metric)
  }, [matrix, heat.data])

  // ── Header ──
  const data = themes.data
  const topicsFrom = data?.summary.amazonTopicsAt
    ? new Date(data.summary.amazonTopicsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    : null
  const subtitle = !scope || themes.loading
    ? 'Loading…'
    : data
      ? (
        <>
          What buyers say about your products · {data.summary.reviewsRead.toLocaleString('en-IE')} reviews{data.summary.amazonTopicMarkets ? ' and Amazon topics' : ''}
          {topicsFrom ? ` · Amazon topics from ${topicsFrom}` : ''} · Updated <AsOf at={data.generatedAt} kind="event" />
        </>
      )
      : 'What buyers say about your products'

  const tiles = data ? themesTiles(data) : null
  const metrics: Metric[] = tiles
    ? [
        { label: 'Reviews read', value: tiles.read, hint: tiles.readHint },
        { label: 'Negative share', value: tiles.negative, delta: tiles.negativeDelta ?? undefined, hint: 'reviews with 1 or 2 stars' },
        { label: 'Biggest riser', value: tiles.riser, delta: tiles.riserDelta ?? undefined, hint: tiles.riserHint, accent: data?.summary.biggestRiser ? 'var(--nds-danger)' : undefined },
        { label: 'Themes', value: tiles.themes, hint: tiles.themes === '0' ? 'no named theme in this period' : 'named themes, not counting “Other”' },
      ]
    : []
  const banner = data && scope ? topicsBanner(data, scope) : null

  return (
    <div className={shared.page}>
      <InsightsHeader scope={scope} onScope={setScope} subtitle={subtitle} choices={choices.data?.options ?? []} />

      {tiles && <MetricStrip metrics={metrics} minTileWidth={150} />}

      {banner && (
        <Banner tone={banner.tone} title={banner.title}>
          {banner.text}
          {banner.problems.length > 0 && (
            <ul className={s.problems}>
              {banner.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </Banner>
      )}

      {themes.error && !data ? (
        <Banner tone="danger" title="Couldn’t read the themes" action={<Button size="sm" onClick={themes.reload}>Try again</Button>}>{themes.error}</Banner>
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={data ? <><b>{rows.length}</b> {rows.length === 1 ? 'theme' : 'themes'} · {periodWords(scope?.period ?? '30d').label}</> : 'Reading…'}
              right={(
                <>
                  <span className={shared.sub}>Sort by</span>
                  <SegmentedControl size="sm" ariaLabel="Sort themes by" options={THEME_SORT_OPTIONS} value={currentSort} onChange={(v) => setPageState({ sort: parseThemeSort(v) })} />
                  <Button size="sm" onClick={customise.openCustomise}><SlidersHorizontal size={13} aria-hidden /> Customise</Button>
                  <Pill tone={themes.error ? 'danger' : 'success'} dot size="md">{themes.error ? 'Not updating' : themes.updating ? 'Updating…' : 'Up to date'}</Pill>
                </>
              )}
            />
          )}
        >
          <NexusGrid<InsightTheme>
            domLayout="autoHeight"
            suppressCellFocus={false}
            rowData={rows}
            getRowId={ROW_ID}
            columnDefs={COLUMNS}
            context={context}
            initialState={gridState.initialState}
            columnDialog={customise.columnDialog}
            loading={themes.loading}
            loadingOverlayComponent={GridLoadingOverlay}
            loadingOverlayComponentParams={LOADING_PARAMS}
            noRowsOverlayComponent={GridNoRowsOverlay}
            noRowsOverlayComponentParams={NO_ROWS}
            onGridReady={onGridReady}
          />
        </GridCard>
      )}
      {themes.error && data && <p className={shared.muted} role="status">Not updating: {themes.error}</p>}
      <p className={shared.footnote}>
        A review can mention several themes. “Amazon topic” quotes are Amazon’s own short snippets, in English. Press a theme to see its
        reviews in the Inbox.
      </p>

      <Card
        header="Fit: runs small or large"
        description={`What buyers say about the fit, per product family and size · ${periodWords(scope?.period ?? '30d').label}`}
        headerAction={(
          <Button asChild size="sm">
            <Link href={insightsHref('fixes', { kind: 'SIZE_GUIDE', channel: scope?.channel, market: scope?.market, period: scope?.period })}>Size-guide fixes</Link>
          </Button>
        )}
      >
        <div className={shared.cardBody}>
          {!data ? (
            <p className={shared.muted}>{themes.error ? 'Not read: see the error above.' : 'Reading…'}</p>
          ) : data.fit.families.length === 0 ? (
            <p className={shared.muted}>
              No review or return in this scope and period says how a size fits yet. Nexus reads reviews that say a size runs small, true
              to size or large, and returns marked “too small” or “too large”. Pick a longer period, or every channel.
            </p>
          ) : (
            <>
              <FitTableView fit={data.fit} scope={scope} />
              <p className={shared.muted}>{fitTableFootnote(data.fit)}</p>
            </>
          )}
        </div>
      </Card>

      <Card
        header="When themes come up"
        description={heatSubtitle(heat.data, currentMetric, scope?.period ?? '30d')}
        headerAction={<SegmentedControl size="sm" ariaLabel="Heatmap shows" options={HEAT_METRIC_OPTIONS} value={currentMetric} onChange={(v) => setPageState({ metric: parseHeatMetric(v) })} />}
      >
        <div className={shared.cardBody}>
          {heat.error && !heat.data ? (
            <Banner tone="danger" title="Couldn’t read when themes come up" action={<Button size="sm" onClick={heat.reload}>Try again</Button>}>{heat.error}</Banner>
          ) : !matrix ? (
            <p className={shared.muted}>Reading…</p>
          ) : matrix.keys.length === 0 ? (
            <p className={shared.muted}>No review in this scope names a theme in these days.</p>
          ) : (
            <div className={s.heatScroll}>
              <div style={{ minWidth: `${matrix.colTitles.length * 9 + 130}px` }}>
                <Heatmap
                  data={matrix.data}
                  rowLabels={matrix.rowLabels}
                  colLabels={matrix.colLabels}
                  colTitles={matrix.colTitles}
                  labelWidth={120}
                  label="When themes come up: press a day to see its reviews"
                  emptyLabel="no reviews mention it"
                  cellWords={cellWords}
                  onCellClick={onCell}
                />
              </div>
            </div>
          )}
          <p className={shared.muted}>
            {currentMetric === 'negativeShare' ? 'Darker = a larger share of the day’s mentions are negative.' : 'Darker = more mentions that day.'} Striped = no
            reviews mention the theme that day. Hover a day for its numbers; press it to open those reviews.
          </p>
        </div>
      </Card>
      {customise.modal}
    </div>
  )
}

