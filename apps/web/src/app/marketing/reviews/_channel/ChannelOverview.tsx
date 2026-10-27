'use client'

/**
 * Reviews › Amazon / eBay (build spec §3.5, PR F): one channel, every market or one (the path lock,
 * `reviewsScope.ts`). The page renders its own PageHeader (rulings 1 and 9): crumbs "Marketing › Reviews › Amazon ›
 * Italy", the period (kept in the address), the channel's tools and the "Reviews" button that opens the sub-sidebar
 * below 1024 px. Market tabs link to the channel's market pages. No channel or market filter: every tile and link opens
 * the Inbox, Requests or Insights already filtered to this page's channel and market.
 *
 * Read: GET /api/reviews/area/channel (sections that fail alone). Read again when this or another tab changes, replies to
 * or imports reviews, and when a review arrives (SSE). The sections are AmazonTools.tsx / EbayTools.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AsOf, Tabs, ToastProvider } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { SegmentedControl, Skeleton } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsGet } from '../_lib/reviewsFetch'
import { useReviewEvents } from '../_lib/useReviewEvents'
import { SectionError } from '../_overview/SectionError'
import { reviewsCrumbs } from '../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../_shell/ReviewsShell'
import { AmazonSections, AmazonToolsMenu } from './AmazonTools'
import { EbaySections, EbayToolsMenu } from './EbayTools'
import {
  amazonSubtitle, ebaySubtitle, marketTabs, parseChannelPeriod, periodOptions, periodSearch, sectionData,
  type AmazonSections as AmazonData, type ChannelPeriod, type ChannelResponse, type EbaySections as EbayData,
} from './channelModel'
import { channelPath, lockParams, scopeTitleWords, type ReviewsLock } from './reviewsScope'
import s from './channel.module.css'

type AnyResponse = ChannelResponse<AmazonData | EbayData>
interface Loaded { key: string; data: AnyResponse | null; error: string | null }

/** Several changes in a row (a bulk edit, a burst of new reviews) read the page once. */
const SETTLE_MS = 600

function ChannelPage({ lock }: { lock: ReviewsLock }) {
  const pathname = usePathname() ?? channelPath(lock)
  const { status, has, user } = useAuth()
  // Until the session is known the actions stay open: the pages and the API check the permission themselves.
  const canManage = status !== 'authed' || has('reviews.manage')
  const me = user?.displayName || user?.email || null

  // ── The period, read once from the address and written back ──
  const [period, setPeriod] = useState<ChannelPeriod | null>(null)
  useEffect(() => setPeriod(parseChannelPeriod(lock.channel, window.location.search)), [lock.channel])
  useEffect(() => {
    if (!period) return
    const next = `${window.location.pathname}${periodSearch(lock.channel, period)}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [period, lock.channel])

  // ── The page's one read ──
  const { channel, market } = lockParams(lock)
  const key = period ? `${channel}|${market ?? ''}|${period}` : null
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    if (!key || !period) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    try {
      const res = await reviewsGet<AnyResponse>('/reviews/area/channel', { channel, market, period }, { signal: controller.signal })
      if (controller.signal.aborted) return
      // A failed re-read keeps the page it has; the error shows only when there is nothing to show.
      setLoaded((prev) => (res.error && prev?.key === key && prev.data ? prev : { key, data: res.data, error: res.error }))
    } catch {
      return // aborted: a newer read is on its way
    } finally {
      if (abort.current === controller) setBusy(false)
    }
  }, [key, period, channel, market])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])

  const settle = useRef<number | null>(null)
  const reload = useCallback(() => {
    if (settle.current !== null) window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      settle.current = null
      void load()
    }, SETTLE_MS)
  }, [load])
  useEffect(() => () => { if (settle.current !== null) window.clearTimeout(settle.current) }, [])
  useInvalidationChannel(['review.updated', 'review.replied', 'review.imported'], reload)
  useReviewEvents(reload, { types: ['review.created', 'review.responded'] })

  const current = loaded && loaded.key === key ? loaded : null
  const data = current?.data ?? null
  const failed = current?.error ?? null
  const amazon = lock.channel === 'AMAZON' && data ? (data.sections as AmazonData) : null
  const ebay = lock.channel === 'EBAY' && data ? (data.sections as EbayData) : null
  const readState = ebay ? sectionData(ebay.readState) : null

  const tabs = useMemo(() => marketTabs(lock, data?.markets ?? [], readState).map((t) => ({
    id: t.id,
    label: t.label,
    href: `${t.href}${period ? periodSearch(lock.channel, period) : ''}`,
    badge: t.behind ? 'not read' : undefined,
  })), [lock, data?.markets, readState, period])

  const words = amazon
    ? amazonSubtitle(sectionData(amazon.tiles), sectionData(amazon.topics))
    : ebay
      ? ebaySubtitle(lock, readState, sectionData(ebay.summary))
      : null
  const subtitle = data && words
    ? <>{words} · Updated <AsOf at={data.generatedAt} kind="event" /></>
    : failed ? 'Could not load' : 'Loading…'

  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      {period && (
        <SegmentedControl size="sm" ariaLabel="Period" options={periodOptions(lock.channel)} value={period} onChange={(p) => setPeriod(p as ChannelPeriod)} />
      )}
      {lock.channel === 'AMAZON' ? <AmazonToolsMenu lock={lock} sellerFeedbackOn={amazon ? sectionData(amazon.tiles)?.sellerFeedbackOn ?? null : null} /> : <EbayToolsMenu lock={lock} />}
    </div>
  )
  const retry = () => void load()

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title={scopeTitleWords(lock)} subtitle={subtitle} actions={actions} />

      <Tabs ariaLabel={`${scopeTitleWords({ channel: lock.channel, marketplace: '' })} markets`} tabs={tabs} active={lock.marketplace || 'all'} linkAs={Link} overflow="scroll" />

      {failed && !data ? (
        <SectionError error={failed} onRetry={retry} busy={busy} />
      ) : !data || !period ? (
        <div className={s.skeletons} aria-busy="true" aria-label="Loading the channel page">
          <div className={s.tileSkeletons}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}</div>
          <Skeleton height={280} />
          <Skeleton height={240} />
        </div>
      ) : amazon ? (
        <AmazonSections lock={lock} period={period} sections={amazon} busy={busy} canManage={canManage} onRetry={retry} />
      ) : ebay ? (
        <EbaySections lock={lock} period={period} sections={ebay} busy={busy} canManage={canManage} me={me} onRetry={retry} />
      ) : null}
    </div>
  )
}

/** The page with its own toasts (the feedback list's bulk bar reports through them). */
export function ChannelOverview({ lock }: { lock: ReviewsLock }) {
  return (
    <ToastProvider>
      <ChannelPage lock={lock} />
    </ToastProvider>
  )
}
