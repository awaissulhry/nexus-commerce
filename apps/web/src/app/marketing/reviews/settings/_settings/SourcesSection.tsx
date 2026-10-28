'use client'

/**
 * Reviews › Settings › Sources — where reviews, feedback and review requests come from, per channel (GET
 * /api/reviews/settings/sources): each source's state in words, when it last worked, and what a person can do. Every
 * source is read today; Amazon gives topics only, never review text or stars (ruling 5). Amazon seller feedback (PR H) has "Fetch now", held with its reason when this setup does not
 * fetch it, Amazon is not connected or a fetch runs. The Shopify review app's row opens "Connect your review app"
 * (Judge.me, Okendo, Yotpo or Loox: paste what that app needs; PR I) and reads the rows again after a change. No setting
 * name is ever shown.
 */
import { useMemo, useState } from 'react'
import { FetchNowButton } from '../../_channel/FetchNowButton'
import { MANAGE_FETCH } from '../../_channel/sellerFeedbackModel'
import { Card } from '@/design-system/components'
import { NexusGrid, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { ReviewAppConnect } from '../../_channel/ReviewAppConnect'
import { ReadFailed } from './ReadFailed'
import { sourceActionHref, timeWords, type SourceRow, type SourcesResponse } from './settingsModel'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

const PILL_TONE = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral', info: 'info' } as const

function SourceCell({ data }: ICellRendererParams<SourceRow>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellStrong}>{data.name}</span>
      <span className={s.cellSub}>{data.what}</span>
    </span>
  )
}

function StateCell({ data }: ICellRendererParams<SourceRow>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellLine}>
        <Pill tone={PILL_TONE[data.tone]} dot>{data.stateWords}</Pill>
      </span>
      <span className={s.cellSub}>{data.words}</span>
    </span>
  )
}

function LastCell({ data }: ICellRendererParams<SourceRow>) {
  if (!data) return null
  return <span className={s.cellSub}>{data.lastAt ? timeWords(data.lastAt, new Date()) : (data.lastWords ?? '—')}</span>
}

/** What the action cells ask of the page (AG `context`). */
interface SourcesContext {
  canManage: boolean
  reload: () => void
  openApp: () => void
}

function ActionCell({ data, context }: ICellRendererParams<SourceRow, unknown, SourcesContext>) {
  if (!data) return null
  if (data.action?.kind === 'fetch') {
    const held = context?.canManage === false ? MANAGE_FETCH : (data.action.held ?? null)
    return (
      <span className={s.cellActions}>
        <FetchNowButton held={held} fetching={data.stateWords === 'Fetching'} onDone={context?.reload} />
      </span>
    )
  }
  if (data.action?.kind === 'app') {
    return (
      <span className={s.cellActions}>
        <Button size="sm" variant={data.tone === 'danger' ? 'primary' : 'secondary'} onClick={() => context?.openApp()}>{data.action.label}</Button>
      </span>
    )
  }
  const href = sourceActionHref(data.action)
  if (data.action && href) {
    return (
      <span className={s.cellActions}>
        <Button size="sm" variant={data.tone === 'warning' || data.tone === 'danger' ? 'primary' : 'secondary'} asChild>
          <Link href={href}>{data.action.label}</Link>
        </Button>
      </span>
    )
  }
  return <span className={s.cellSub}>—</span>
}

const COLUMNS: ColDef<SourceRow>[] = [
  { colId: 'source', headerName: 'Source', width: 220, minWidth: 200, cellRenderer: SourceCell, autoHeight: true },
  { colId: 'state', headerName: 'State', flex: 2, minWidth: 300, cellRenderer: StateCell, autoHeight: true },
  { colId: 'last', headerName: 'Last read', width: 150, minWidth: 130, cellRenderer: LastCell, autoHeight: true },
  { colId: 'action', headerName: 'Action', width: 210, minWidth: 180, cellRenderer: ActionCell, autoHeight: true },
]

const getRowId = (p: { data: SourceRow }) => p.data.key

export function SourcesSection({ read, canManage }: { read: SettingsRead<SourcesResponse>; canManage: boolean }) {
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowData = useMemo(() => read.data?.rows ?? [], [read.data])
  const { reload } = read
  const [appOpen, setAppOpen] = useState(false)
  const context = useMemo<SourcesContext>(
    () => ({ canManage, reload: () => void reload(), openApp: () => setAppOpen(true) }),
    [canManage, reload],
  )
  return (
    <div className={s.section}>
      <p className={s.lead}>Where reviews, feedback and review requests come from, per channel.</p>
      <Card padded={false}>
        {read.error && !read.data ? (
          <div className={s.pad}><ReadFailed error={read.error} onRetry={() => void read.reload()} busy={read.loading} /></div>
        ) : !read.data ? (
          <div className={s.skeletonRows} aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={44} />)}</div>
        ) : (
          <div className={s.tableScroll}>
            <NexusGrid<SourceRow> plain plainMaxHeight={900} density="compact" rowData={rowData} columnDefs={columnDefs} getRowId={getRowId} context={context} />
          </div>
        )}
      </Card>
      <ReviewAppConnect open={appOpen} onClose={() => setAppOpen(false)} canManage={canManage} onChanged={() => void read.reload()} />
    </div>
  )
}
