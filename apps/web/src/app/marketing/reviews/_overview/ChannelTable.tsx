'use client'

/**
 * Reviews Overview — "By channel and market": rating, reviews, change, requests sent, review rate and the last review
 * per channel and market (DS NexusGrid, a small `plain` table; it scrolls sideways inside its card on a phone). A row
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
      {data.sentNote && <span className={s.cellSub}>{data.sentNote}</span>}
    </span>
  )
}

function LastCell({ data }: ICellRendererParams<ChannelViewRow>) {
  if (!data) return null
  if (data.state === 'later') {
    return (
      <span className={s.cellStack}>
        <Tag tone="neutral">Coming later</Tag>
        <span className={s.cellSub}>{data.lastNote}</span>
      </span>
    )
  }
  if (data.state === 'not_updating') {
    return (
      <span className={s.cellStack}>
        <Pill tone="danger" dot>Not updating</Pill>
        <span className={s.cellSub}>
          {data.reason}
          {data.reconnectHref && <> · <Link href={data.reconnectHref} className={s.inlineLink}>Reconnect</Link></>}
        </span>
      </span>
    )
  }
  return (
    <span className={s.cellStack}>
      <span>{data.last}</span>
      {data.lastNote && <span className={s.cellSub}>{data.lastNote}</span>}
    </span>
  )
}

const COLUMNS: ColDef<ChannelViewRow>[] = [
  { colId: 'channel', headerName: 'Channel and market', minWidth: 190, flex: 2, cellRenderer: NameCell },
  { colId: 'rating', headerName: 'Rating', minWidth: 150, flex: 1, cellRenderer: RatingCell, wrapText: true },
  { colId: 'reviews', headerName: 'Reviews', field: 'reviews', minWidth: 90, ...numericColumn },
  { colId: 'change', headerName: 'Change', minWidth: 90, ...numericColumn, cellRenderer: ChangeCell },
  { colId: 'sent', headerName: 'Requests sent', minWidth: 130, ...numericColumn, cellRenderer: SentCell },
  { colId: 'rate', headerName: 'Review rate', field: 'rate', minWidth: 110, ...numericColumn },
  { colId: 'last', headerName: 'Last review', minWidth: 200, flex: 1.5, cellRenderer: LastCell },
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
