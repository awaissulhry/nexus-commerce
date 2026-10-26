'use client'

/**
 * Reviews Overview — "By channel and market": rating, reviews, change, requests sent, review rate and the last review
 * per channel and market (DS NexusGrid, a small `plain` table). Its columns start at the board's widths, which add up to
 * 830 px, so it fits the card a 1280 px window gives it (926 px) and only a narrower card (a phone) scrolls it sideways,
 * inside the card. Notes under a value wrap onto a second line and the row grows to hold them (`autoHeight`). A row
 * opens that channel's reviews. eBay reads as % positive, not stars; Amazon stars come only from imported reviews
 * ("No rating data from Amazon — import reviews" otherwise); Etsy asks its buyers itself, so its requests are "—".
 * A channel that stopped updating shows "Not updating", the reason and Reconnect — never a stale date as if fine.
 */
import { useCallback, useMemo } from 'react'
import { Card, EmptyState, StarRating } from '@/design-system/components'
import { NexusGrid, numericColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Pill, Skeleton, Tag } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { inboxHref } from '../_lib/reviewsLinks'
import { behindWords, overviewPeriodWords, ratingText, type ChannelViewRow } from './overviewModel'
import type { OverviewPeriod } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

function NameCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellLine}>
        {data.href && !data.sample ? <Link href={data.href} className={s.cellLink}>{data.label}</Link> : <span className={s.cellStrong}>{data.label}</span>}
        {data.sample && <Tag tone="neutral">Sample</Tag>}
      </span>
      <span className={s.cellSub}>{data.what}</span>
    </span>
  )
}

function RatingCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  if (data.noAmazonData) {
    return (
      <span className={s.cellWrap}>
        No rating data from Amazon — <Link href={inboxHref({ import: 1 })} className={s.inlineLink}>import reviews</Link>
      </span>
    )
  }
  if (data.rating == null) return <span className={s.cellSub}>—</span>
  if (data.ratingKind === 'positive') {
    return <span className={s.cellLine}><b className={s.num}>{ratingText('positive', data.rating)}</b> <span className={s.cellSub}>positive</span></span>
  }
  return <span className={s.cellLine}><b className={s.num}>{ratingText('stars', data.rating)}</b><StarRating value={data.rating} size="sm" /></span>
}

function ChangeCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  const tone = data.change.tone === 'up' ? s.up : data.change.tone === 'down' ? s.down : s.flat
  return <span className={`${s.num} ${tone}`}>{data.change.text}</span>
}

function SentCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  return (
    <span className={`${s.cellStack} ${s.alignEnd}`}>
      <span className={s.num}>{data.sent}</span>
      {data.sentNote && <span className={s.cellWrap}>{data.sentNote}</span>}
    </span>
  )
}

function LastCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  if (data.state === 'later') {
    return (
      <span className={s.cellStack}>
        <Tag tone="neutral">Coming later</Tag>
        <span className={s.cellWrap}>{data.lastNote}</span>
      </span>
    )
  }
  if (data.state === 'not_updating') {
    return (
      <span className={s.cellStack}>
        <Pill tone="danger" dot>Not updating</Pill>
        <span className={s.cellWrap}>
          {data.reason}
          {data.reconnectHref && <> · <Link href={data.reconnectHref} className={s.inlineLink}>Reconnect</Link></>}
        </span>
      </span>
    )
  }
  return (
    <span className={s.cellStack}>
      <span>{data.last}</span>
      {data.lastNote && <span className={s.cellWrap}>{data.lastNote}</span>}
    </span>
  )
}

/**
 * The board's widths (180 · 124 · 78 · 86 · 112 · 100 · 150 and up), as each column's start and its minimum: 830 px in
 * all. The grid stretches them to its width (`plain`), so at 1280 px (922 px inside the card's and the grid's frames)
 * the table fits with no sideways scroll; "Last review" takes most of what is left.
 */
const COLUMNS: ColDef<ChannelViewRow>[] = [
  { colId: 'channel', headerName: 'Channel and market', width: 180, minWidth: 180, cellRenderer: NameCell },
  { colId: 'rating', headerName: 'Rating', width: 124, minWidth: 124, cellRenderer: RatingCell, autoHeight: true },
  { colId: 'reviews', headerName: 'Reviews', field: 'reviews', width: 78, minWidth: 78, ...numericColumn },
  { colId: 'change', headerName: 'Change', width: 86, minWidth: 86, ...numericColumn, cellRenderer: ChangeCell },
  { colId: 'sent', headerName: 'Requests sent', width: 112, minWidth: 112, ...numericColumn, cellRenderer: SentCell, autoHeight: true },
  { colId: 'rate', headerName: 'Review rate', field: 'rate', width: 100, minWidth: 100, ...numericColumn },
  { colId: 'last', headerName: 'Last review', width: 240, minWidth: 150, cellRenderer: LastCell, autoHeight: true },
]

const getRowId = (p: { data: ChannelViewRow }) => p.data.id

export interface ChannelTableProps {
  rows: ChannelViewRow[] | null
  error: string | null
  loading: boolean
  period: OverviewPeriod
  onRetry: () => void
}

export function ChannelTable({ rows, error, loading, period, onRetry }: ChannelTableProps) {
  const router = useRouter()
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowData = useMemo(() => rows ?? [], [rows])
  const onRowClicked = useCallback((e: { data?: ChannelViewRow; event?: Event | null }) => {
    // A click on a link inside the row (the name, Reconnect, import reviews) follows that link.
    if (e.event?.target instanceof Element && e.event.target.closest('a')) return
    if (e.data?.href && !e.data.sample) router.push(e.data.href)
  }, [router])
  const words = overviewPeriodWords(period)
  const behind = rows ? behindWords(rows) : null

  return (
    <Card
      className={s.block}
      header="By channel and market"
      headingLevel={2}
      description={`${words.label.charAt(0).toUpperCase()}${words.label.slice(1)} · change against ${words.prev} · press a row to open that channel`}
      headerAction={behind ? <Pill tone="warning" dot size="md">{behind}</Pill> : undefined}
      padded={false}
    >
      {error ? (
        <div className={s.pad}><SectionError error={error} onRetry={onRetry} busy={loading} /></div>
      ) : !rows ? (
        <div className={s.pad} aria-hidden>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} className={s.skeletonRow} />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No channel has reviews or requests yet" description="Channels show here once a review arrives or a review request goes out." />
      ) : (
        <div className={s.tableScroll}>
          <NexusGrid<ChannelViewRow>
            plain
            density="compact"
            rows="media"
            rowData={rowData}
            columnDefs={columnDefs}
            getRowId={getRowId}
            onRowClicked={onRowClicked}
            rowClass={s.clickRow}
          />
        </div>
      )}
      <p className={s.footnote}>
        Etsy sends its own review reminder, so Nexus sends no requests there. eBay shows the share of positive feedback, not stars. Amazon stars come only from reviews you imported.
      </p>
    </Card>
  )
}
