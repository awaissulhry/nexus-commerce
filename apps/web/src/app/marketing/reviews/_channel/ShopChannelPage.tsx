'use client'

/**
 * Reviews › Etsy and Reviews › Shopify (build spec §3.5, PR I) — one page each (no markets), drawn like the Amazon and
 * eBay pages (ChannelOverview): the page's own PageHeader with the crumbs, the "Reviews" button that opens the
 * sub-sidebar below 1024 px, tiles that open the Inbox already filtered to the channel, and the review list
 * (ShopReviewList: ticks, bulk Mark as responded / Assign / Export; a row opens the Inbox's review pop-up).
 *
 * Etsy: Etsy shares reviews to read only — the banner says how replies work (on Etsy.com, once, within 100 days of the
 * buyer's last edit, no edit), each row shows the one photo, the last edit and the reply window ("Day 2 of 100",
 * "4 days left", "Closed"). Shopify: the review app — "Connect your review app" until Judge.me is connected (Okendo,
 * Yotpo and Loox "Coming later", or import a file), then its reviews with photos and the video mark; a reply goes out
 * to Judge.me from the review pop-up.
 *
 * Read: GET /api/reviews/area/shop-channel?channel= (sections that fail alone), again when a review changes, a reply goes
 * out, an import lands or the review app is connected (this tab or another), and when a review arrives (SSE).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, MessageSquareReply, Upload, Video } from 'lucide-react'
import { AsOf, Banner, Card, MetricStrip, StarRating, Thumbnail, ToastProvider } from '@/design-system/components'
import type { ColDef, ICellRendererParams } from '@/design-system/grid'
import { PageHeader } from '@/design-system/patterns'
import { Button, Pill, Skeleton, Tag } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsGet } from '../_lib/reviewsFetch'
import { inboxHref, reviewsSettingsHref } from '../_lib/reviewsLinks'
import { STATUS_WORD } from '../_lib/reviewWords'
import { useReviewEvents } from '../_lib/useReviewEvents'
import { SectionError } from '../_overview/SectionError'
import { reviewsCrumbs } from '../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../_shell/ReviewsShell'
import { agoWords, productWords } from '../inbox/inboxTiles'
import { tileMetrics } from './AmazonTools'
import { sectionData, sectionError } from './channelModel'
import { ReviewAppConnect } from './ReviewAppConnect'
import { ShopReviewList, type ShopListContext } from './ShopReviewList'
import {
  ETSY_REVIEWS_HREF, etsyReplyCell, etsySubtitle, etsyTileViews, isAppConnected, judgeme, lastEditWords, mediaWords, shopifyReplyNote,
  shopifySubtitle, shopifyTileViews, shortTime, windowWords,
  type EtsyRow, type EtsySections, type ShopChannel, type ShopChannelResponse, type ShopifyRow, type ShopifySections,
} from './shopChannelModel'
import s from './channel.module.css'

const TILE_MIN_PX = 132
/** Several changes in a row read the page once. */
const SETTLE_MS = 600

type AnyResponse = ShopChannelResponse<EtsySections | ShopifySections>

// ── Cells shared by both lists ───────────────────────────────────────

interface CellContext extends ShopListContext { canManage: boolean; appConnected: boolean }
type EtsyCell = ICellRendererParams<EtsyRow, unknown, CellContext>
type ShopifyCell = ICellRendererParams<ShopifyRow, unknown, CellContext>

function StarsCell({ data }: { data?: EtsyRow | ShopifyRow }) {
  if (!data) return null
  return <span className={s.stack}><StarRating value={data.rating} size="sm" /><span className={s.sub}>{data.rating == null ? 'No stars' : `${data.rating} of 5`}</span></span>
}

function ItemCell({ data }: { data?: EtsyRow | ShopifyRow }) {
  if (!data) return null
  const product = productWords(data)
  return (
    <span className={s.stack}>
      <span className={product ? s.main : s.sub}>{product ?? 'No product link'}</span>
      <span className={s.sub}>{data.order?.label ?? 'No order'}</span>
    </span>
  )
}

// ── Etsy ─────────────────────────────────────────────────────────────

function EtsyPhotoCell({ data, context }: EtsyCell) {
  if (!data) return null
  if (!data.photoUrl) return <span className={s.sub}>None</span>
  return <Thumbnail src={data.photoUrl} alt={`Photo from ${data.buyer ?? 'the buyer'}`} title="Open the photo" onClick={() => context?.openPhotos(data, 0)} />
}

function EtsyReviewCell({ data }: EtsyCell) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <span className={s.snippet}>{data.snippet || 'No text, stars only'}</span>
      <span className={s.sub}>{[data.buyer ?? 'Buyer not named', lastEditWords(data)].join(' · ')}</span>
    </span>
  )
}

function EtsyWindowCell({ data }: EtsyCell) {
  if (!data) return null
  const w = windowWords(data.window)
  return (
    <span className={s.stack}>
      <span className={s.main}>{w.label}</span>
      {w.tone === 'danger' ? <Pill tone="danger">{w.note}</Pill> : <span className={s.sub}>{w.note}</span>}
    </span>
  )
}

function EtsyReplyCell({ data, context }: EtsyCell) {
  if (!data) return null
  const cell = etsyReplyCell(data, context?.canManage ?? false)
  return (
    <span className={s.stack}>
      <span className={s.inline}>
        {cell.write.href
          ? <Button asChild size="sm"><Link href={cell.write.href}><MessageSquareReply size={13} aria-hidden /> {cell.note === 'Responded' ? 'See the reply' : 'Write a reply'}</Link></Button>
          : <Button size="sm" heldReason={cell.write.held}><MessageSquareReply size={13} aria-hidden /> Write a reply</Button>}
        <Button asChild size="sm" variant="ghost">
          <a href={ETSY_REVIEWS_HREF} target="_blank" rel="noopener noreferrer" aria-label="Open on Etsy (opens a new tab)">Open on Etsy <ExternalLink size={11} aria-hidden /></a>
        </Button>
      </span>
      <span className={s.sub}>{cell.note === 'Responded' ? 'Marked as responded' : STATUS_WORD[data.status] ?? data.status}{data.assignee ? ` · ${data.assignee}` : ''}</span>
    </span>
  )
}

const ETSY_COLUMNS: ColDef<EtsyRow>[] = [
  { colId: 'photo', headerName: 'Photo', width: 86, cellRenderer: EtsyPhotoCell },
  { colId: 'stars', headerName: 'Stars', width: 110, cellRenderer: StarsCell },
  { colId: 'review', headerName: 'Review', minWidth: 240, flex: 1, cellRenderer: EtsyReviewCell },
  { colId: 'item', headerName: 'Item · order', width: 190, cellRenderer: ItemCell },
  { colId: 'window', headerName: 'Reply window', width: 140, cellRenderer: EtsyWindowCell },
  { colId: 'reply', headerName: 'Reply', width: 310, minWidth: 300, cellRenderer: EtsyReplyCell },
]

const etsyPhotos = (row: EtsyRow) => (row.photoUrl ? [{ url: row.photoUrl }] : [])

function EtsyPage({ data, busy, canManage, me, onRetry }: { data: EtsySections; busy: boolean; canManage: boolean; me: string | null; onRetry: () => void }) {
  const source = sectionData(data.source)
  const tiles = sectionData(data.tiles)
  const metrics = useMemo(() => (tiles ? tileMetrics(etsyTileViews(tiles)) : null), [tiles])
  const list = sectionData(data.reviews)
  const cellContext = useMemo(() => ({ canManage, appConnected: false }), [canManage])
  const empty = useMemo(() => ({
    title: 'No Etsy reviews yet',
    message: source?.state === 'ok' || source?.state === 'waiting' ? 'Reviews show here as Nexus reads them from Etsy, every 30 minutes.' : 'Reviews show here once Nexus reads the Etsy shop.',
  }), [source?.state])
  return (
    <>
      <Banner tone="info" title="Etsy shares reviews to read only.">
        Nexus reads each review with its one photo (no video). Reply on Etsy.com: one public reply, within 100 days of the buyer’s last edit. It
        can’t be edited (only deleted, no second reply), and after you reply the buyer can no longer change the review. Write and copy the reply
        in the review’s window to save time.
      </Banner>
      {sectionError(data.source) && <SectionError error={sectionError(data.source)!} onRetry={onRetry} busy={busy} />}
      {source && source.state !== 'ok' && (
        <Banner
          tone={source.tone === 'danger' ? 'danger' : source.tone === 'warning' ? 'warning' : 'info'}
          title={source.stateWords}
          action={source.reconnectHref ? <Button asChild size="sm"><Link href={source.reconnectHref}>{source.state === 'needs_fix' ? 'Reconnect Etsy' : 'Connect Etsy'}</Link></Button> : undefined}
        >
          {source.words}
        </Banner>
      )}
      {sectionError(data.tiles) ? (
        <SectionError error={sectionError(data.tiles)!} onRetry={onRetry} busy={busy} />
      ) : metrics ? (
        <MetricStrip metrics={metrics} linkAs={Link} minTileWidth={TILE_MIN_PX} className={s.tiles} />
      ) : null}
      <ShopReviewList<EtsyRow>
        channel="ETSY"
        list={list}
        error={sectionError(data.reviews)}
        busy={busy}
        onRetry={onRetry}
        columns={ETSY_COLUMNS}
        canManage={canManage}
        me={me}
        empty={empty}
        photosOf={etsyPhotos}
        cellContext={cellContext}
      />
      <p className={s.footnote}>
        After you post on Etsy, press “Mark as responded” in the reply box. Etsy’s API has no replies, so Nexus records only what you mark. The
        100 days count from the buyer’s last edit.
      </p>
    </>
  )
}

// ── Shopify ──────────────────────────────────────────────────────────

function ShopifyMediaCell({ data, context }: ShopifyCell) {
  if (!data) return null
  if (data.photoItems.length === 0 && !data.hasVideo) return <span className={s.sub}>None</span>
  // One line: the first photo (the Lightbox has them all) and, beside it, the video mark (Judge.me gives no video URL).
  return (
    <span className={s.inline}>
      {data.photoItems[0] && (
        <Thumbnail src={data.photoItems[0].thumb} photoCount={data.photoItems.length} alt={`Photo from ${data.buyer ?? 'the reviewer'}`} title="Open the photos" onClick={() => context?.openPhotos(data, 0)} />
      )}
      {data.hasVideo && <Tag tone="neutral" title="This review has a video: watch it in Judge.me"><Video size={11} aria-label="Video" /></Tag>}
    </span>
  )
}

function ShopifyReviewCell({ data }: ShopifyCell) {
  if (!data) return null
  const media = mediaWords(data)
  return (
    <span className={s.stack}>
      <span className={s.snippet}>{data.snippet || 'No text, stars only'}</span>
      <span className={s.sub}>{[data.buyer ?? 'Reviewer not named', agoWords(data.postedAt, Date.now()), media || null].filter(Boolean).join(' · ')}</span>
    </span>
  )
}

function ShopifyStatusCell({ data }: ShopifyCell) {
  if (!data) return null
  return <span className={s.stack}><span className={s.main}>{STATUS_WORD[data.status] ?? data.status}</span><span className={s.sub}>{data.assignee ?? 'Nobody'}</span></span>
}

function ShopifyReplyCell({ data, context }: ShopifyCell) {
  if (!data) return null
  const note = shopifyReplyNote(data, context?.appConnected ?? false)
  const held = context?.canManage ? null : 'You need ‘Manage reviews’ to reply to reviews.'
  return (
    <span className={s.stack}>
      {held
        ? <Button size="sm" heldReason={held}><MessageSquareReply size={13} aria-hidden /> Reply</Button>
        : <Button asChild size="sm"><Link href={inboxHref({ channel: 'SHOPIFY', review: data.id })}><MessageSquareReply size={13} aria-hidden /> {note === 'Responded' ? 'See the reply' : 'Reply'}</Link></Button>}
      <span className={s.sub}>{note}</span>
    </span>
  )
}

const SHOPIFY_COLUMNS: ColDef<ShopifyRow>[] = [
  { colId: 'media', headerName: 'Media', width: 130, cellRenderer: ShopifyMediaCell },
  { colId: 'stars', headerName: 'Stars', width: 110, cellRenderer: StarsCell },
  { colId: 'review', headerName: 'Review', minWidth: 240, flex: 1, cellRenderer: ShopifyReviewCell },
  { colId: 'item', headerName: 'Product · order', width: 190, cellRenderer: ItemCell },
  { colId: 'status', headerName: 'Status', width: 120, cellRenderer: ShopifyStatusCell },
  { colId: 'reply', headerName: 'Reply', width: 170, cellRenderer: ShopifyReplyCell },
]

const shopifyPhotos = (row: ShopifyRow) => row.photoItems.map((p) => ({ url: p.url }))

function ShopifyPage({ data, busy, canManage, me, onRetry, onConnect }: {
  data: ShopifySections; busy: boolean; canManage: boolean; me: string | null; onRetry: () => void; onConnect: () => void
}) {
  const apps = sectionData(data.app)
  const app = judgeme(apps)
  const connected = isAppConnected(app)
  const tiles = sectionData(data.tiles)
  const metrics = useMemo(() => (tiles ? tileMetrics(shopifyTileViews(tiles)) : null), [tiles])
  const list = sectionData(data.reviews)
  const cellContext = useMemo(() => ({ canManage, appConnected: connected }), [canManage, connected])
  const empty = useMemo(() => ({
    title: 'No Shopify reviews yet',
    message: connected ? 'Reviews show here as Nexus reads them from Judge.me, every 30 minutes.' : 'Connect Judge.me, or import a file from the review app.',
  }), [connected])

  return (
    <>
      {sectionError(data.app) && <SectionError error={sectionError(data.app)!} onRetry={onRetry} busy={busy} />}
      {apps && !connected && (
        <Card
          header={<span className={s.inline}>Connect your review app <Pill tone={app?.tone ?? 'neutral'} dot>{app?.stateWords ?? 'Not connected'}</Pill></span>}
          headingLevel={2}
          description={apps.imported > 0
            ? `Until then, Shopify reviews arrive only by file import (${apps.imported.toLocaleString('en')} so far${apps.lastImportAt ? `, last file ${shortTime(apps.lastImportAt)}` : ''}).`
            : 'Until then, Shopify reviews arrive only by file import.'}
          headerAction={<Button size="sm" variant="primary" onClick={onConnect} heldReason={canManage ? null : 'You need ‘Manage reviews’ to connect a review app.'}>Connect Judge.me…</Button>}
        >
          <div className={s.stackGap}>
            {app?.state === 'needs_fix' && <Banner tone="danger" title="Judge.me needs a new token.">{app.words}</Banner>}
            <ul className={s.sampleList} aria-label="Review apps">
              {apps.apps.map((a) => (
                <li key={a.app} className={s.sampleRow}>
                  <span className={s.stack}><span className={s.main}>{a.name}</span><span className={s.sub}>{a.what}</span></span>
                  {/* ⛔ KEEP — placeholders (build spec ruling 3): Okendo, Yotpo and Loox connect in a later update; their words stay. */}
                  {a.connectable ? <Pill tone={a.tone} dot>{a.stateWords}</Pill> : <Tag tone="neutral">Coming later</Tag>}
                </li>
              ))}
              <li className={s.sampleRow}>
                <span className={s.stack}><span className={s.main}>Another app, or none</span><span className={s.sub}>Import a file from the app now and then. Nexus cannot read it live.</span></span>
                <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}><Upload size={13} aria-hidden /> Import reviews…</Link></Button>
              </li>
            </ul>
            <ul className={s.bullets} aria-label="What connecting does">
              <li>Nexus reads new reviews every 30 minutes, with their photos; a video is marked (watch it in Judge.me).</li>
              <li>Judge.me, and Okendo on its Enterprise plan, let Nexus post your reply under the review. Yotpo and Loox are read only: you copy the reply and post it there.</li>
              <li>You paste a key from Judge.me. Nexus never sees your Shopify password.</li>
              <li>Disconnect any time in Reviews settings; the reviews already read stay.</li>
            </ul>
          </div>
        </Card>
      )}
      {apps && connected && app && (
        <Banner
          tone={app.tone === 'warning' ? 'warning' : app.state === 'waiting' ? 'info' : 'success'}
          title={`Connected to Judge.me${app.shopDomain ? ` · ${app.shopDomain}` : ''}`}
          action={<Button size="sm" onClick={onConnect}>Manage Judge.me…</Button>}
        >
          {app.words}
        </Banner>
      )}
      {sectionError(data.tiles) ? (
        <SectionError error={sectionError(data.tiles)!} onRetry={onRetry} busy={busy} />
      ) : metrics && (connected || (tiles?.reviews ?? 0) > 0) ? (
        <MetricStrip metrics={metrics} linkAs={Link} minTileWidth={TILE_MIN_PX} className={s.tiles} />
      ) : null}
      {(connected || (list?.total ?? 0) > 0 || sectionError(data.reviews)) && (
        <ShopReviewList<ShopifyRow>
          channel="SHOPIFY"
          list={list}
          error={sectionError(data.reviews)}
          busy={busy}
          onRetry={onRetry}
          columns={SHOPIFY_COLUMNS}
          canManage={canManage}
          me={me}
          empty={empty}
          photosOf={shopifyPhotos}
          cellContext={cellContext}
        />
      )}
      <p className={s.footnote}>
        Judge.me gives Nexus the review’s photos and says when it has a video; a reply sent from Nexus is posted
        under the review on the store and e-mailed to the reviewer by Judge.me. Imported reviews are answered in the review app, then marked as responded.
      </p>
    </>
  )
}

// ── The page ─────────────────────────────────────────────────────────

function ShopChannel({ channel }: { channel: ShopChannel }) {
  const pathname = usePathname() ?? `/marketing/reviews/${channel.toLowerCase()}`
  const { status, has, user } = useAuth()
  // Until the session is known the actions stay open: the API checks the permission itself.
  const canManage = status !== 'authed' || has('reviews.manage')
  const me = user?.displayName || user?.email || null

  const [loaded, setLoaded] = useState<{ data: AnyResponse | null; error: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    try {
      const res = await reviewsGet<AnyResponse>('/reviews/area/shop-channel', { channel }, { signal: controller.signal })
      if (controller.signal.aborted) return
      // A failed re-read keeps the page it has; the error shows only when there is nothing to show.
      setLoaded((prev) => (res.error && prev?.data ? prev : { data: res.data, error: res.error }))
    } catch {
      return
    } finally {
      if (abort.current === controller) setBusy(false)
    }
  }, [channel])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])

  const settle = useRef<number | null>(null)
  const reload = useCallback(() => {
    if (settle.current !== null) window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => { settle.current = null; void load() }, SETTLE_MS)
  }, [load])
  useEffect(() => () => { if (settle.current !== null) window.clearTimeout(settle.current) }, [])
  useInvalidationChannel(['review.updated', 'review.replied', 'review.imported', 'review.settings.changed'], reload)
  useReviewEvents(reload, { types: ['review.created', 'review.responded'] })

  const [connectOpen, setConnectOpen] = useState(false)
  const data = loaded?.data ?? null
  const etsy = channel === 'ETSY' && data ? (data.sections as EtsySections) : null
  const shopify = channel === 'SHOPIFY' && data ? (data.sections as ShopifySections) : null
  const words = etsy
    ? etsySubtitle(sectionData(etsy.source), sectionData(etsy.tiles))
    : shopify ? shopifySubtitle(sectionData(shopify.app)) : null
  const subtitle = data && words ? <>{words} · Updated <AsOf at={data.generatedAt} kind="event" /></> : loaded?.error ? 'Could not load' : 'Loading…'

  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <Button asChild size="sm"><Link href={inboxHref({ channel })}>Open in the Inbox</Link></Button>
      {channel === 'ETSY' ? (
        <Button asChild size="sm">
          <a href={ETSY_REVIEWS_HREF} target="_blank" rel="noopener noreferrer" aria-label="Open reviews on Etsy (opens a new tab)">Open on Etsy <ExternalLink size={11} aria-hidden /></a>
        </Button>
      ) : (
        <>
          <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}><Upload size={13} aria-hidden /> Import reviews…</Link></Button>
          <Button asChild size="sm"><Link href={reviewsSettingsHref('sources')}>Review settings</Link></Button>
        </>
      )}
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title={channel === 'ETSY' ? 'Etsy' : 'Shopify'} subtitle={subtitle} actions={actions} />
      {loaded?.error && !data ? (
        <SectionError error={loaded.error} onRetry={() => void load()} busy={busy} />
      ) : !data ? (
        <div className={s.skeletons} aria-busy="true" aria-label="Loading the channel page">
          <div className={s.tileSkeletons}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}</div>
          <Skeleton height={320} />
        </div>
      ) : etsy ? (
        <EtsyPage data={etsy} busy={busy} canManage={canManage} me={me} onRetry={() => void load()} />
      ) : shopify ? (
        <ShopifyPage data={shopify} busy={busy} canManage={canManage} me={me} onRetry={() => void load()} onConnect={() => setConnectOpen(true)} />
      ) : null}
      {channel === 'SHOPIFY' && (
        <ReviewAppConnect open={connectOpen} onClose={() => setConnectOpen(false)} canManage={canManage} onChanged={() => void load()} />
      )}
    </div>
  )
}

/** The page with its own toasts (the list's bulk bar and the connect window report through them). */
export function ShopChannelOverview({ channel }: { channel: ShopChannel }) {
  return (
    <ToastProvider>
      <ShopChannel channel={channel} />
    </ToastProvider>
  )
}
