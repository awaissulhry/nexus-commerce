'use client'

/**
 * Reviews Overview — "Products to watch": the biggest rating drops against the period before (at least three ratings
 * in each), with the top complaint and six weeks of the rating (DS Sparkline; fewer than three readings say "Too few
 * to trend"). A row opens that product's reviews.
 */
import { useCallback, useMemo } from 'react'
import { Card, EmptyState, Sparkline } from '@/design-system/components'
import { NexusGrid, numericColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, Skeleton, Tag } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { insightsHref } from '../_lib/reviewsLinks'
import { overviewPeriodWords, TOO_FEW_WORDS, watchEmptyWords, type WatchView } from './overviewModel'
import type { OverviewPeriod } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

function ProductCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <Link href={data.href} className={s.cellLink}>{data.name}</Link>
      <span className={s.cellSub}>{data.reviews}</span>
    </span>
  )
}

function NowCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <b className={s.num}>{data.now}</b>
      <span className={s.cellSub}>{data.before}</span>
    </span>
  )
}

function ChangeCell({ data }: ICellRendererParams<WatchView>) {
  return data ? <span className={`${s.num} ${s.down}`}>{data.change}</span> : null
}

function ThemeCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  return data.theme ? <Tag tone="danger">{data.theme}</Tag> : <span className={s.cellSub}>No complaint theme</span>
}

function TrendCell({ data }: ICellRendererParams<WatchView>) {
  if (!data) return null
  if (data.tooFew) return <span className={s.cellSub}>{TOO_FEW_WORDS}</span>
  const pct = data.kind === 'positive'
  return <Sparkline values={data.spark} label={data.sparkLabel} shape="line" format={(n) => (pct ? `${n.toFixed(1)}%` : n.toFixed(1))} />
}

const COLUMNS: ColDef<WatchView>[] = [
  { colId: 'product', headerName: 'Product', minWidth: 230, flex: 2, cellRenderer: ProductCell },
  { colId: 'where', headerName: 'Where', field: 'where', minWidth: 140 },
  { colId: 'now', headerName: 'Rating now', minWidth: 110, cellRenderer: NowCell },
  { colId: 'change', headerName: 'Change', minWidth: 90, ...numericColumn, cellRenderer: ChangeCell },
  { colId: 'theme', headerName: 'Top complaint', minWidth: 150, cellRenderer: ThemeCell },
  { colId: 'trend', headerName: 'Trend', minWidth: 130, cellRenderer: TrendCell },
]

const getRowId = (p: { data: WatchView }) => p.data.id

export interface WatchListProps {
  rows: WatchView[] | null
  error: string | null
  loading: boolean
  period: OverviewPeriod
  onRetry: () => void
}

export function WatchList({ rows, error, loading, period, onRetry }: WatchListProps) {
  const router = useRouter()
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowData = useMemo(() => rows ?? [], [rows])
  const onRowClicked = useCallback((e: { data?: WatchView; event?: Event | null }) => {
    if (e.event?.target instanceof Element && e.event.target.closest('a')) return
    if (e.data) router.push(e.data.href)
  }, [router])
  const words = overviewPeriodWords(period)
  const empty = watchEmptyWords(period)

  return (
    <Card
      className={s.block}
      header="Products to watch"
      headingLevel={2}
      description={`Biggest rating drops · ${words.label} against ${words.prev}`}
      headerAction={<Button asChild variant="link" size="sm"><Link href={insightsHref('products')}>All products</Link></Button>}
      padded={false}
    >
      {error ? (
        <div className={s.pad}><SectionError error={error} onRetry={onRetry} busy={loading} /></div>
      ) : !rows ? (
        <div className={s.pad} aria-hidden>
          {[0, 1, 2].map((i) => <Skeleton key={i} height={40} className={s.skeletonRow} />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={empty.title} description={empty.description} />
      ) : (
        <div className={s.tableScroll}>
          <NexusGrid<WatchView>
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
    </Card>
  )
}
