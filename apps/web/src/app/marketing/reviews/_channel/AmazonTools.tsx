'use client'

/**
 * Reviews › Amazon (build spec §3.5, ruling 5) — the Amazon tools menu and the page's sections: tiles, the "no review
 * text" banner, the rating trend and spread from IMPORTED reviews only (Amazon gives no rating, average or count by API),
 * Amazon's topics (Customer Feedback API: weekly, English, UK/DE/FR/IT/ES, never Amazon.nl, needs the Selling Partner
 * Insights role), seller feedback (Amazon's 1–3 star report, fetched by Nexus, with the removal check per feedback),
 * asking for reviews by Amazon's answer, products to watch. Nexus never asks Amazon to remove feedback (no API for it):
 * "Open Feedback Manager" in Seller Central.
 */
import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import {
  Banner, Card, Disclosure, EmptyState, Listbox, Menu, MetricStrip, PerformanceGraph, RatingBars, StarRating,
  type ChartSeries, type MenuItemDef, type Metric, type RatingStars,
} from '@/design-system/components'
import { NexusGrid, numericColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { inboxHref, productReviewsHref, requestsHref, rulesHref, timingHref } from '../_lib/reviewsLinks'
import { trendRows } from '../_overview/overviewModel'
import { SectionError } from '../_overview/SectionError'
import { ratingAxis } from '../_overview/TrendCard'
import {
  ALL_PRODUCTS, amazonTiles, count, dayMonth, feedbackManagerHref, lockedLinks, periodLabel, plural, requestRows,
  sectionData, sectionError, sellerCentralHref, topicColumns, topicProductOptions, watchView,
  type AmazonSections as AmazonData, type ChannelPeriod, type TileView, type TopicView, type WatchView,
} from './channelModel'
import { lockParams, scopeTitleWords, type ReviewsLock } from './reviewsScope'
import { FetchNowButton } from './FetchNowButton'
import { failedFetchWords, feedbackCardLine, feedbackRowView, fetchHeldWords, REMOVAL_RULES } from './sellerFeedbackModel'
import s from './channel.module.css'

const TILE_MIN_PX = 132
const MANAGE_IMPORT = "You need 'Manage reviews' to import reviews."

/** A plain click stays in the app; a modified click (new tab) follows the native link. */
function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** Tiles from the model, as the DS MetricStrip takes them. */
export function tileMetrics(tiles: readonly TileView[]): Metric[] {
  return tiles.map((t) => {
    const base = { label: t.label, value: t.value, hint: t.hint, accent: t.accent }
    return t.href ? { ...base, href: t.href } : base
  })
}

// ── Tools menu ───────────────────────────────────────────────────────

export function AmazonToolsMenu({ lock }: { lock: ReviewsLock }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const scope = lockParams(lock)
  const inserts = requestsHref({ ...scope, inserts: 1 })
  const removal = inboxHref({ kind: 'seller', channel: 'AMAZON', market: scope.market, period: '90d' })
  const where = scopeTitleWords(lock)
  const items: MenuItemDef[] = [
    // The removal helper: the 1–3 star seller feedback in the Inbox, each with its removal check in the pop-up. Nexus
    // never asks Amazon to remove feedback (no API for it, ruling 5): the helper only checks, the person asks in
    // Feedback Manager.
    {
      id: 'removal',
      label: 'Seller feedback removal helper',
      description: 'Checks 1–3 star feedback against Amazon’s rules · you ask in Feedback Manager',
      href: workspaceHref(browserWorkspaceId(), removal),
    },
    { id: 'inserts', label: 'Package inserts', description: 'A card for the box, as a PDF · opens in Requests', href: workspaceHref(browserWorkspaceId(), inserts) },
    { id: 'feedback-manager', label: 'Open Feedback Manager', description: `Seller Central, ${where} · opens a new tab`, href: feedbackManagerHref(scope.market), target: '_blank' },
  ]
  return (
    <Menu
      label={<>Amazon tools <ChevronDown size={11} aria-hidden /></>}
      items={items}
      open={open}
      onOpenChange={setOpen}
      align="right"
      onNavigate={(event, item) => {
        if ((item.id !== 'inserts' && item.id !== 'removal') || !plainClick(event)) return
        event.preventDefault()
        router.push(item.id === 'inserts' ? inserts : removal)
      }}
    />
  )
}

// ── Sections ─────────────────────────────────────────────────────────

export interface AmazonSectionsProps {
  lock: ReviewsLock
  period: ChannelPeriod
  sections: AmazonData
  busy: boolean
  canManage: boolean
  onRetry: () => void
}

export function AmazonSections({ lock, period, sections, busy, canManage, onRetry }: AmazonSectionsProps) {
  const tiles = sectionData(sections.tiles)
  const metrics = useMemo(() => (tiles ? tileMetrics(amazonTiles(tiles, lock, period)) : null), [tiles, lock, period])
  const scope = lockParams(lock)

  return (
    <>
      {sectionError(sections.tiles) ? (
        <SectionError error={sectionError(sections.tiles)!} onRetry={onRetry} busy={busy} />
      ) : metrics ? (
        <MetricStrip metrics={metrics} linkAs={Link} minTileWidth={TILE_MIN_PX} className={s.tiles} />
      ) : null}

      <Banner
        tone="info"
        title="Amazon gives no review text — only topics."
        action={(
          <Button asChild size="sm">
            <a href={sellerCentralHref(scope.market)} target="_blank" rel="noopener noreferrer">
              Open in Seller Central <ExternalLink size={12} aria-hidden />
            </a>
          </Button>
        )}
      >
        Amazon gives no star rating, average or review count by API: stars on this page come only from reviews you imported.
        Topics are updated weekly per product, in English. Seller feedback comes only as 1–3 star feedback, fetched on request.
        Nobody can reply to a product review on Amazon.
      </Banner>

      <div className={s.row}>
        <TrendCard lock={lock} period={period} sections={sections} busy={busy} canManage={canManage} onRetry={onRetry} />
        <SpreadCard lock={lock} period={period} sections={sections} busy={busy} canManage={canManage} onRetry={onRetry} />
      </div>

      <TopicsCard lock={lock} sections={sections} busy={busy} onRetry={onRetry} />

      <div className={s.row}>
        <SellerFeedbackCard lock={lock} sections={sections} busy={busy} canManage={canManage} onRetry={onRetry} />
        <RequestsCard lock={lock} period={period} sections={sections} busy={busy} onRetry={onRetry} />
      </div>

      <WatchCard lock={lock} period={period} sections={sections} busy={busy} onRetry={onRetry} />

      <p className={s.footnote}>
        Where the numbers come from: stars, the trend and the spread count only reviews you imported from files; topics are Amazon’s own (Customer
        Feedback), weekly and in English, for the UK, Germany, France, Italy and Spain — not available on Amazon.nl; requests are the ones Nexus sent
        through Amazon’s “Request a Review”. Amazon gives no review count, so the review rate is an estimate.
      </p>
    </>
  )
}

interface CardProps {
  lock: ReviewsLock
  period: ChannelPeriod
  sections: AmazonData
  busy: boolean
  canManage: boolean
  onRetry: () => void
}

function bucketWords(bucket: string): string {
  return bucket === 'day' ? 'Imported reviews per day' : bucket === 'month' ? 'Imported reviews per month' : 'Imported reviews per week'
}

function TrendCard({ lock, period, sections, busy, canManage, onRetry }: CardProps) {
  const trend = sectionData(sections.trend)
  const error = sectionError(sections.trend)
  const rows = useMemo(() => (trend ? trendRows(trend.points, trend.bucket) : []), [trend])
  const unit = bucketWords(trend?.bucket ?? 'week')
  const axis = useMemo(() => ratingAxis(trend?.points ?? []), [trend])
  // Recharts takes colours as props (tokens/colors.ts `chart`); a bucket without a rated review is a gap in the line.
  const left = useMemo<ChartSeries>(() => ({ key: 'reviews', label: unit, color: chart.reference, axis: 'left', shape: 'bar', axisLabel: unit, format: (v) => Math.round(v).toLocaleString('en') }), [unit])
  const right = useMemo<ChartSeries>(() => ({ key: 'avg', label: 'Average rating', color: chart.actual, axis: 'right', axisLabel: 'Average rating', format: (v) => v.toFixed(1), domain: axis.domain, ticks: axis.ticks }), [axis])
  const total = trend ? trend.points.reduce((n, p) => n + p.reviews, 0) : 0
  const links = lockedLinks(lock, period)

  return (
    <Card
      className={s.wide}
      header="Rating trend · imported reviews"
      headingLevel={2}
      description={`${unit.replace('Imported reviews', 'From the reviews you imported,')} · ${periodLabel(period)} · Amazon gives no rating by API`}
      headerAction={<Button asChild variant="link" size="sm"><Link href={links.insights('themes')}>See topics over time</Link></Button>}
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : !trend ? (
        <Skeleton height={220} />
      ) : total === 0 ? (
        <EmptyState
          title={`No imported reviews in the ${periodLabel(period)}`}
          description="Amazon gives no rating by API. Import a file of reviews from Seller Central to see the trend here."
          action={canManage
            ? <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}>Import reviews…</Link></Button>
            : <Button size="sm" heldReason={MANAGE_IMPORT}>Import reviews…</Button>}
        />
      ) : (
        <>
          <PerformanceGraph data={rows as unknown as Array<Record<string, number | string>>} xKey="when" left={left} right={right} height={230} />
          <p className="nds-vh">{`${unit}, ${periodLabel(period)}: ${count(total)} in all.`}</p>
        </>
      )}
    </Card>
  )
}

function SpreadCard({ lock, period, sections, busy, canManage, onRetry }: CardProps) {
  const router = useRouter()
  const spread = sectionData(sections.spread)
  const error = sectionError(sections.spread)
  const links = lockedLinks(lock, period)
  const onSelect = useCallback((stars: RatingStars | null) => {
    if (stars) router.push(links.inbox({ stars: [stars] }))
  }, [router, links])
  const file = spread?.lastImportAt ? `file of ${dayMonth(spread.lastImportAt)}` : 'no file imported yet'

  return (
    <Card className={s.narrow} header="Rating spread · imported reviews" headingLevel={2} description={spread ? `From ${plural(spread.rated, 'review', 'reviews')} you imported · ${file}` : 'From the reviews you imported'}>
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : !spread ? (
        <Skeleton height={200} />
      ) : (
        <div className={s.stackGap}>
          <div className={s.bigRating}>
            <span className={s.bigNumber}>{spread.average == null ? '—' : spread.average.toFixed(1)}</span>
            <span className={s.stack}>
              <StarRating value={spread.average} size="md" count={spread.rated || undefined} />
              <span className={s.muted}>{spread.average == null ? 'No rating data from Amazon — import reviews' : 'from imported reviews'}</span>
            </span>
          </div>
          <RatingBars
            counts={spread.counts}
            onSelect={onSelect}
            zeroReason={(n) => `No ${n}-star imported reviews in the ${periodLabel(period)}`}
            label={`Imported ratings by stars, ${periodLabel(period)}`}
          />
          <p className={s.note}>Amazon gives no rating by API: no average, no spread, no count. This spread counts only the reviews you imported from files. A bar opens them in the Inbox.</p>
          <span>
            {canManage
              ? <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}>Import reviews…</Link></Button>
              : <Button size="sm" heldReason={MANAGE_IMPORT}>Import reviews…</Button>}
          </span>
        </div>
      )}
    </Card>
  )
}

function TopicList({ title, tone, note, rows }: { title: string; tone: 'success' | 'danger'; note: string; rows: TopicView[] }) {
  return (
    <section className={s.topicCol} aria-label={title}>
      <h3 className={s.topicHead}><Pill tone={tone}>{title}</Pill><span className={s.muted}>{note}</span></h3>
      {rows.length === 0 ? (
        <p className={s.muted}>No topics here this week.</p>
      ) : (
        <ul className={s.topicList}>
          {rows.map((t) => (
            <li key={t.key} className={s.topicRow}>
              <span className={s.stack}>
                <span className={s.main}>{t.label}</span>
                {t.quote && <span className={s.sub} lang="en">{t.quote}</span>}
              </span>
              <span className={s.stackEnd}>
                <span className={s.main}>{t.mentions}</span>
                <span className={s.sub}>{t.share}</span>
              </span>
              <span className={s.stackEnd}>
                <span className={t.impactTone === 'down' ? s.down : t.impactTone === 'up' ? s.up : s.main} title="Star effect: how much this topic moves the star rating, by Amazon">{t.impact}</span>
                <span className={s.sub}>{t.trend}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TopicsCard({ lock, sections, busy, onRetry }: Omit<CardProps, 'period' | 'canManage'>) {
  const topics = sectionData(sections.topics)
  const error = sectionError(sections.topics)
  const [product, setProduct] = useState<string>(ALL_PRODUCTS)
  const options = useMemo(() => (topics ? topicProductOptions(topics) : []), [topics])
  const columns = useMemo(() => (topics ? topicColumns(topics, product) : null), [topics, product])
  const week = topics?.weekOf ? `week of ${dayMonth(topics.weekOf)}` : 'no week read yet'
  const showsTopics = !!topics && (topics.like.length > 0 || topics.dislike.length > 0)

  return (
    <Card
      header="What buyers say — topics from Amazon"
      headingLevel={2}
      description={`Amazon’s topics, in English, updated weekly · ${week} · no review text, no stars`}
      headerAction={topics && topics.products.length > 1
        ? <Listbox size="sm" ariaLabel="Product" options={options} value={product} onChange={setProduct} searchable />
        : undefined}
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : !topics ? (
        <Skeleton height={180} />
      ) : (
        <div className={s.stackGap}>
          {topics.words && (
            <Banner tone={topics.state === 'role_missing' ? 'warning' : 'info'} title={topics.state === 'role_missing' ? 'Amazon refused this week’s topics.' : undefined}>
              {topics.words}
            </Banner>
          )}
          {showsTopics && columns && (
            <div className={s.topicCols}>
              <TopicList title="Buyers like" tone="success" note="raise the average" rows={columns.like} />
              <TopicList title="Buyers dislike" tone="danger" note="lower the average" rows={columns.dislike} />
            </div>
          )}
          <p className={s.note}>
            {topics.where} {scopeTitleWords(lock)}: each topic shows its mentions, the share of reviews, its effect on stars (±) and a short English snippet.
          </p>
        </div>
      )}
    </Card>
  )
}

/**
 * Amazon seller feedback (PR H): Amazon's report holds only 1–3 star feedback and Amazon cannot schedule it, so Nexus
 * asks for it daily and on "Fetch now". Each feedback shows the removal check (may qualify / struck through, not removed
 * / does not qualify / too old). Nexus never asks Amazon to remove feedback (no API for it, ruling 5): "Open Feedback
 * Manager" in Seller Central, a new tab; a row opens the review pop-up, where "Mark as responded" records a reply.
 */
const FEEDBACK_SHOWN = 6

function SellerFeedbackCard({ lock, sections, busy, canManage, onRetry }: Omit<CardProps, 'period'>) {
  const feedback = sectionData(sections.sellerFeedback)
  const error = sectionError(sections.sellerFeedback)
  const scope = lockParams(lock)
  const rows = useMemo(() => (feedback?.rows ?? []).slice(0, FEEDBACK_SHOWN).map(feedbackRowView), [feedback])
  const failed = feedback ? failedFetchWords(feedback.fetch) : null
  const inbox = inboxHref({ kind: 'seller', channel: 'AMAZON', market: scope.market, period: '90d' })

  return (
    <Card
      className={s.half}
      header="Seller feedback · 1–3 stars"
      headingLevel={2}
      description={feedback ? feedbackCardLine(feedback) : 'Amazon’s report holds only 1–3 star feedback and is fetched on request (it can’t be scheduled)'}
      headerAction={<FetchNowButton held={fetchHeldWords(feedback?.fetch ?? null, canManage)} fetching={feedback?.fetch.fetching} onDone={onRetry} />}
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : !feedback ? (
        <Skeleton height={200} />
      ) : (
        <div className={s.stackGap}>
          {failed && <Banner tone="warning" title="Amazon’s report did not arrive for every market.">{failed}</Banner>}
          {!feedback.fetch.on && feedback.rows.length === 0 ? (
            <EmptyState title="No seller feedback fetched yet" description={feedback.fetch.held ?? 'Nexus asks Amazon for the report every day.'} />
          ) : rows.length === 0 ? (
            <EmptyState title="No 1–3 star feedback" description="Amazon’s report had no feedback of 1 to 3 stars here. Feedback of 4 and 5 stars is never in it." />
          ) : (
            <ul className={s.feedbackList} aria-label={`Seller feedback, ${scopeTitleWords(lock)}`}>
              {rows.map((f) => (
                <li key={f.id} className={s.feedbackRow}>
                  <span className={s.stack}>
                    <StarRating value={f.stars} size="sm" label={f.stars == null ? 'No stars' : `${f.stars} ${f.stars === 1 ? 'star' : 'stars'}`} />
                    <span className={s.sub}>{f.day}</span>
                  </span>
                  <span className={s.stack}>
                    <Link href={inboxHref({ kind: 'seller', channel: 'AMAZON', market: scope.market, period: 'all', review: f.id })} className={s.cellLink}>{f.text}</Link>
                    {f.english && <span className={s.sub} lang="en">{f.english}</span>}
                    <span className={s.sub}>{f.who}</span>
                  </span>
                  <span className={s.stackEnd}>
                    <Pill tone={f.check.tone} dot>{f.check.label}</Pill>
                    <span className={s.sub}>{f.check.why}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Disclosure summary="How the removal check decides">
            <ul className={s.bullets}>
              {(feedback.rules.length ? feedback.rules : REMOVAL_RULES).map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
          </Disclosure>
          <div className={s.buttons}>
            <Button asChild size="sm">
              <a href={feedbackManagerHref(scope.market)} target="_blank" rel="noopener noreferrer">Open Feedback Manager <ExternalLink size={12} aria-hidden /></a>
            </Button>
            <Button asChild size="sm" variant="link"><Link href={inbox}>All seller feedback in the Inbox</Link></Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function RequestsCard({ lock, period, sections, busy, onRetry }: Omit<CardProps, 'canManage'>) {
  const requests = sectionData(sections.requests)
  const error = sectionError(sections.requests)
  const rows = useMemo(() => (requests ? requestRows(requests) : []), [requests])
  const links = lockedLinks(lock, period)

  return (
    <Card className={s.half} header={`Asking for reviews · ${scopeTitleWords(lock)}`} headingLevel={2} description={`${periodLabel(period).replace(/^\w/, (c) => c.toUpperCase())} · one standard email from Amazon; its text is fixed`}>
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : !requests ? (
        <Skeleton height={200} />
      ) : (
        <div className={s.stackGap}>
          <ul className={s.pipeline} aria-label="Requests by Amazon’s answer">
            {rows.map((r) => (
              <li key={r.key} className={s.pipelineRow}>
                <Pill tone={r.tone} dot>{r.label}</Pill>
                <b className={s.num}>{r.value}</b>
                <span className={s.sub}>{r.note}</span>
              </li>
            ))}
          </ul>
          <p className={s.note}>
            Amazon sends one standard email, translated into the buyer’s language, asking for a product review and seller feedback. Allowed once per order,
            5–30 days after delivery. Ask every buyer the same way: asking only happy buyers, or sending unhappy buyers elsewhere, is not allowed.
          </p>
          <div className={s.buttons}>
            <Button asChild size="sm" variant="primary"><Link href={links.requests()}>Open the {scopeTitleWords(lock)} queue</Link></Button>
            <Button asChild size="sm"><Link href={rulesHref()}>Rules</Link></Button>
            <Button asChild size="sm"><Link href={timingHref()}>Timing</Link></Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Products to watch ────────────────────────────────────────────────

function ProductCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <Link href={productReviewsHref(data.productId)} className={s.cellLink}>{data.name}</Link>
      {data.sub && <span className={s.sub}>{data.sub}</span>}
    </span>
  )
}

function StarsCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  if (!data.hasRating) {
    return (
      <span className={s.sub}>
        No rating data from Amazon — <Link href={inboxHref({ import: 1 })} className={s.cellLink}>import reviews</Link>
      </span>
    )
  }
  return (
    <span className={s.inline}>
      <StarRating value={data.rating} size="sm" />
      <b className={s.num}>{data.ratingText}</b>
    </span>
  )
}

function ChangeCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return <span className={`${s.num} ${data.changeTone === 'down' ? s.down : data.changeTone === 'up' ? s.up : ''}`}>{data.change}</span>
}

function TopicCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <span className={s.main}>{data.topic}</span>
      <span className={s.sub}>{data.topicSub}</span>
    </span>
  )
}

const WATCH_COLUMNS: ColDef<WatchView>[] = [
  { colId: 'product', headerName: 'Product', minWidth: 220, flex: 2, cellRenderer: ProductCell },
  { colId: 'stars', headerName: 'Stars · imported', minWidth: 170, flex: 1, cellRenderer: StarsCell },
  { colId: 'change', headerName: 'Change', minWidth: 90, ...numericColumn, cellRenderer: ChangeCell },
  { colId: 'imported', headerName: 'Imported', field: 'imported', minWidth: 100, ...numericColumn },
  { colId: 'topic', headerName: 'Top complaint (Amazon topic)', minWidth: 200, flex: 1, cellRenderer: TopicCell },
]
const watchRowId = (p: { data: WatchView }) => p.data.id

function WatchCard({ lock, period, sections, busy, onRetry }: Omit<CardProps, 'canManage'>) {
  const router = useRouter()
  const watch = sectionData(sections.watch)
  const error = sectionError(sections.watch)
  const rowData = useMemo(() => (watch ?? []).map(watchView), [watch])
  const columnDefs = useMemo(() => WATCH_COLUMNS, [])
  const onRowClicked = useCallback((e: { data?: WatchView; event?: Event | null }) => {
    if (e.event?.target instanceof Element && e.event.target.closest('a, button')) return
    if (e.data) router.push(productReviewsHref(e.data.productId))
  }, [router])
  const links = lockedLinks(lock, period)

  return (
    <Card
      header="Products to watch"
      headingLevel={2}
      description={`Biggest drop first · ${scopeTitleWords(lock)} · stars from imported reviews · topics from Amazon`}
      headerAction={<Button asChild size="sm"><Link href={links.insights('products')}>All products in Insights</Link></Button>}
      padded={false}
    >
      {error ? (
        <div className={s.pad}><SectionError error={error} onRetry={onRetry} busy={busy} /></div>
      ) : !watch ? (
        <div className={s.pad}><Skeleton height={160} /></div>
      ) : rowData.length === 0 ? (
        <EmptyState title="No products to watch" description="Products show here once reviews are imported for them, or Amazon gives topics for them." />
      ) : (
        <div className={s.tableScroll}>
          <NexusGrid<WatchView>
            plain
            density="compact"
            rows="media"
            domLayout="autoHeight"
            rowData={rowData}
            columnDefs={columnDefs}
            getRowId={watchRowId}
            onRowClicked={onRowClicked}
            rowClass={s.clickRow}
          />
        </div>
      )}
    </Card>
  )
}
