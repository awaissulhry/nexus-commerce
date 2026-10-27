'use client'

/**
 * Reviews › Overview (`/marketing/reviews`, build spec §3.1, PR A): how the business's reviews are going on every
 * channel, and what needs a person now. The page renders its own PageHeader (ruling 1): crumbs from the Reviews
 * navigation, the period (7 days · 30 days · 90 days · 12 months, kept in the address), "Import reviews…" and "Ask for
 * reviews" (held without "Manage reviews"), and the "Reviews" button that opens the sub-sidebar below 1024 px.
 *
 * Reads: GET /api/reviews/area/overview (one answer in sections; a failed section shows only in its card) and
 * GET /api/reviews/area/needs-you (every 60 s, when a review arrives or turns negative, and when a tab changes a
 * review). Every link goes through `_lib/reviewsLinks.ts`, so it opens a page that exists today.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AsOf, MetricStrip, StarRating, type Metric } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { Button, SegmentedControl, Skeleton, TokenChip } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsGet } from '../_lib/reviewsFetch'
import { inboxHref, insightsHref, requestsHref } from '../_lib/reviewsLinks'
import { useReviewEvents } from '../_lib/useReviewEvents'
import { NOT_MEASURABLE, channelMarketWords, rateNotMeasurable } from '../_lib/reviewWords'
import { reviewsCrumbs } from '../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../_shell/ReviewsShell'
import { ChannelTable } from './ChannelTable'
import { NeedsYouCard } from './NeedsYouCard'
import {
  channelViewRows, count, deltaView, headerSubtitle, needsLimit, newReviewsHref, overviewPeriodWords, rateText,
  scopeWords, sectionData, sectionError, watchView, type NeedsYouResponse, type OverviewResponse,
} from './overviewModel'
import {
  EMPTY_OVERVIEW_QUERY, OVERVIEW_PERIODS, parseOverviewQuery, serializeOverviewQuery, toggleShow, withoutScope, withPeriod,
  withStars, type NeedsFilter, type OverviewQuery,
} from './overviewQuery'
import { SectionError } from './SectionError'
import { SetupBanner } from './SetupBanner'
import { SpreadCard } from './SpreadCard'
import { ThemeCards } from './ThemeCards'
import { TrendCard } from './TrendCard'
import { WatchList } from './WatchList'
import s from './overview.module.css'

const PERIOD_OPTIONS = OVERVIEW_PERIODS.map((p) => ({ value: p, label: overviewPeriodWords(p).label.replace(/^last /, '').replace(/^\w/, (c) => c.toUpperCase()) }))
const NEEDS_POLL_MS = 60_000
/** The board's narrowest tile: six fit one row on the 926 px page a 1280 px window leaves (6 × 132 + 5 × 12 gaps = 852;
 *  at 150 it was 960, so the sixth wrapped). Under 760 px the strip shows two per row whatever this says. */
const TILE_MIN_PX = 132
const MANAGE_IMPORT = "You need 'Manage reviews' to import reviews."
const MANAGE_ASK = "You need 'Manage reviews' to ask buyers for reviews."

interface Loaded<T> { key: string; data: T | null; error: string | null; at: number }

function readKey(q: OverviewQuery): string {
  return `${q.period}|${q.channel ?? ''}|${q.market ?? ''}`
}

function waitWords(days: number | null): string {
  if (days == null) return 'nothing waits'
  if (days < 1) return 'oldest waits less than a day'
  return `oldest waits ${days} ${days === 1 ? 'day' : 'days'}`
}

export function OverviewClient() {
  const pathname = usePathname() ?? '/marketing/reviews'
  const { status, has } = useAuth()
  // Until the session is known the actions stay links: the pages behind them check the permission themselves.
  const canManage = status !== 'authed' || has('reviews.manage')

  // ── The address: read once on the client, written back on every change ──
  const [query, setQueryState] = useState<OverviewQuery | null>(null)
  useEffect(() => setQueryState(parseOverviewQuery(window.location.search)), [])
  const setQuery = useCallback((update: (q: OverviewQuery) => OverviewQuery) => setQueryState((q) => update(q ?? EMPTY_OVERVIEW_QUERY)), [])
  useEffect(() => {
    if (!query) return
    const next = `${window.location.pathname}${serializeOverviewQuery(query)}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [query])

  // ── The Overview (one read, sections that fail alone) ──
  const [overview, setOverview] = useState<Loaded<OverviewResponse> | null>(null)
  const [overviewBusy, setOverviewBusy] = useState(false)
  const overviewAbort = useRef<AbortController | null>(null)
  const period = query?.period ?? EMPTY_OVERVIEW_QUERY.period
  const channel = query?.channel ?? null
  const market = query?.market ?? null
  const key = query ? readKey(query) : null

  const loadOverview = useCallback(async () => {
    if (!key) return
    overviewAbort.current?.abort()
    const controller = new AbortController()
    overviewAbort.current = controller
    setOverviewBusy(true)
    try {
      const res = await reviewsGet<OverviewResponse>('/reviews/area/overview', { period, channel, market }, { signal: controller.signal })
      if (controller.signal.aborted) return
      setOverview({ key, data: res.data, error: res.error, at: Date.now() })
    } catch {
      return // aborted: a newer read is on its way
    } finally {
      if (overviewAbort.current === controller) setOverviewBusy(false)
    }
  }, [key, period, channel, market])
  useEffect(() => {
    void loadOverview()
    return () => overviewAbort.current?.abort()
  }, [loadOverview])

  // A read of another period or scope is not shown as this one's.
  const current = overview && overview.key === key ? overview : null
  const sections = current?.data?.sections ?? null
  const failedWhole = current?.error ?? null

  // ── Needs you ──
  const show = query?.show ?? null
  const [needs, setNeeds] = useState<Loaded<NeedsYouResponse> | null>(null)
  const [needsBusy, setNeedsBusy] = useState(false)
  const needsKey = query ? `needs|${show ?? ''}|${channel ?? ''}|${market ?? ''}` : null
  const needsAbort = useRef<AbortController | null>(null)
  const loadNeeds = useCallback(async () => {
    if (!needsKey) return
    needsAbort.current?.abort()
    const controller = new AbortController()
    needsAbort.current = controller
    setNeedsBusy(true)
    try {
      // The Overview's scope too, so the list agrees with the tiles above it.
      const res = await reviewsGet<NeedsYouResponse>('/reviews/area/needs-you', { only: show, limit: needsLimit(show), channel, market }, { signal: controller.signal })
      if (controller.signal.aborted) return
      // A failed refresh keeps the list it has; the error shows only when there is nothing to show.
      setNeeds((prev) => (res.error && prev?.key === needsKey && prev.data ? prev : { key: needsKey, data: res.data, error: res.error, at: Date.now() }))
    } catch {
      return
    } finally {
      if (needsAbort.current === controller) setNeedsBusy(false)
    }
  }, [needsKey, show, channel, market])
  useEffect(() => {
    void loadNeeds()
    const id = window.setInterval(() => void loadNeeds(), NEEDS_POLL_MS)
    return () => {
      window.clearInterval(id)
      needsAbort.current?.abort()
    }
  }, [loadNeeds])
  // One stream: a new or negative review re-reads Needs you; a new alert (audit A9) also the "Open alerts" tile.
  useReviewEvents((event) => {
    void loadNeeds()
    if (event.type === 'review.spike.detected') void loadOverview()
  }, { types: ['review.created', 'review.negative', 'review.spike.detected'] })
  // Another tab (or this one) changed, replied to or imported reviews: both reads are stale.
  useInvalidationChannel(['review.updated', 'review.replied', 'review.imported'], () => {
    void loadNeeds()
    void loadOverview()
  })
  const needsNow = needs && needs.key === needsKey ? needs : null

  // ── Tiles ──
  const tiles = sectionData(sections?.tiles)
  const pressTile = useCallback((kind: NeedsFilter) => setQuery((q) => toggleShow(q, kind)), [setQuery])
  const metrics = useMemo<Metric[] | null>(() => {
    if (!tiles) return null
    const words = overviewPeriodWords(period)
    return [
      {
        label: 'Average rating',
        value: tiles.avgRating == null ? '—' : tiles.avgRating.toFixed(1),
        delta: deltaView(tiles.avgDelta, 'stars', period) ?? undefined,
        // The source words of the one rating (Amazon stars only from imported reviews, eBay as % positive).
        hint: tiles.ratingWords ?? (tiles.avgRating == null ? 'No ratings in this period' : <StarRating value={tiles.avgRating} size="sm" />),
        href: insightsHref('products', { sort: 'rating', channel, market }),
      },
      {
        label: 'New reviews',
        value: count(tiles.newReviews),
        delta: deltaView(tiles.newDelta, 'count', period) ?? undefined,
        // The tile's own period (live audit D07: "opens the Inbox" said nothing about the number).
        hint: words.label,
        href: newReviewsHref(period, channel, market),
      },
      {
        label: 'Needs a reply',
        value: count(tiles.needReply),
        hint: waitWords(tiles.oldestWaitDays),
        accent: 'var(--nds-danger)',
        active: show === 'reply',
        onClick: () => pressTile('reply'),
      },
      {
        label: 'Requests sent',
        value: count(tiles.requestsSent),
        delta: tiles.requestsFailed > 0 ? { value: `${count(tiles.requestsFailed)} failed`, tone: 'negative' } : undefined,
        hint: words.label,
        // Opens the requests it counts (sent, this scope and period), not the problems list.
        href: requestsHref({ status: 'SENT', channel, market, period }),
      },
      {
        label: 'Review rate',
        value: rateNotMeasurable(tiles.reviewRate, tiles.rateWords) ? NOT_MEASURABLE : rateText(tiles.reviewRate),
        delta: deltaView(tiles.rateDelta, 'points', period) ?? undefined,
        hint: tiles.rateWords ?? (tiles.reviewRate == null ? 'nothing sent in this period' : 'reviews per request sent'),
        href: requestsHref({ channel, market, period }),
      },
      {
        label: 'Open alerts',
        value: count(tiles.openAlerts),
        hint: `${count(tiles.newAlertsToday)} new today`,
        accent: 'var(--nds-warning)',
        active: show === 'alerts',
        onClick: () => pressTile('alerts'),
      },
    ]
  }, [tiles, period, channel, market, show, pressTile])

  const channelRows = useMemo(() => {
    const rows = sectionData(sections?.channels)
    // The Etsy placeholder row stays unless the page is scoped to another channel.
    return rows ? channelViewRows(rows, current?.at ?? 0) : null
  }, [sections, current?.at, channel])
  const watchRows = useMemo(() => {
    const rows = sectionData(sections?.watch)
    return rows ? rows.map(watchView) : null
  }, [sections])

  const retryOverview = useCallback(() => void loadOverview(), [loadOverview])
  const retryNeeds = useCallback(() => void loadNeeds(), [loadNeeds])
  const onStars = useCallback((stars: OverviewQuery['stars']) => setQuery((q) => withStars(q, stars)), [setQuery])
  const scope = scopeWords(channel, market)
  const loadingAll = !current

  const subtitle = current?.data
    ? <>{headerSubtitle(period, tiles, sectionData(sections?.channels))} · Updated <AsOf at={current.data.generatedAt} kind="event" /></>
    : failedWhole ? overviewPeriodWords(period).label.replace(/^\w/, (c) => c.toUpperCase()) : 'Loading…'

  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <SegmentedControl size="sm" ariaLabel="Period" options={PERIOD_OPTIONS} value={period} onChange={(p) => setQuery((q) => withPeriod(q, p))} />
      {canManage ? (
        <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}>Import reviews…</Link></Button>
      ) : (
        <Button size="sm" heldReason={MANAGE_IMPORT}>Import reviews…</Button>
      )}
      {canManage ? (
        <Button asChild size="sm" variant="primary"><Link href={requestsHref()}>Ask for reviews</Link></Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={MANAGE_ASK}>Ask for reviews</Button>
      )}
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Reviews" subtitle={subtitle} actions={actions} />

      {scope && (
        <div className={s.chips} role="group" aria-label="This page shows only">
          <TokenChip onRemove={() => setQuery(withoutScope)} removeLabel="Show every channel and market">{scope}</TokenChip>
        </div>
      )}

      {failedWhole ? (
        <SectionError error={failedWhole} onRetry={retryOverview} busy={overviewBusy} />
      ) : (
        <>
          {sectionError(sections?.tiles) ? (
            <SectionError error={sectionError(sections?.tiles)!} onRetry={retryOverview} busy={overviewBusy} />
          ) : metrics ? (
            <MetricStrip metrics={metrics} linkAs={Link} minTileWidth={TILE_MIN_PX} className={s.tiles} />
          ) : (
            <div className={s.tileSkeletons} aria-hidden>
              {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}
            </div>
          )}

          <SetupBanner problems={sectionData(sections?.setup)} error={sectionError(sections?.setup)} loading={overviewBusy} onRetry={retryOverview} />

          <div className={s.row}>
            <TrendCard
              trend={sectionData(sections?.trend)}
              error={sectionError(sections?.trend)}
              loading={overviewBusy || loadingAll}
              period={period}
              scope={channel ? channelMarketWords(channel, market) : null}
              onRetry={retryOverview}
            />
            <SpreadCard
              spread={sectionData(sections?.spread)}
              avgRating={tiles?.avgRating ?? null}
              error={sectionError(sections?.spread)}
              loading={overviewBusy || loadingAll}
              period={period}
              stars={query?.stars ?? null}
              channel={channel}
              market={market}
              onStars={onStars}
              onRetry={retryOverview}
            />
          </div>
        </>
      )}

      <NeedsYouCard
        needs={needsNow?.data ?? null}
        error={needsNow?.data ? null : needsNow?.error ?? null}
        loading={needsBusy}
        show={show}
        canManage={canManage}
        now={needsNow?.at ?? 0}
        channel={channel}
        market={market}
        onClearShow={() => setQuery((q) => toggleShow(q, null))}
        onRetry={retryNeeds}
      />

      {!failedWhole && (
        <>
          <ChannelTable rows={channelRows} error={sectionError(sections?.channels)} loading={overviewBusy} period={period} onRetry={retryOverview} />
          <ThemeCards themes={sectionData(sections?.themes)} error={sectionError(sections?.themes)} loading={overviewBusy} period={period} onRetry={retryOverview} />
          <WatchList rows={watchRows} error={sectionError(sections?.watch)} loading={overviewBusy} period={period} onRetry={retryOverview} />
        </>
      )}

      <p className={s.footnote}>
        Where the numbers come from: Amazon — review topics per product, updated weekly, for the UK, Germany, France, Italy and Spain (not
        available on Amazon.nl); 1–3 star seller feedback from Amazon’s report, fetched daily and on request where it is switched on; stars only from reviews you import, because
        Amazon gives no review text and no rating by API. eBay — seller feedback, read every 30 minutes. Shopify — your store’s review app,
        Judge.me, Okendo, Yotpo or Loox read every 30 minutes once connected, or by file import. Etsy — shop reviews with their one photo, read every 30 minutes.
      </p>
    </div>
  )
}
