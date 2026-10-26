'use client'

/**
 * Reviews › Settings › Sources — where reviews, feedback and review requests come from, per channel (GET
 * /api/reviews/settings/sources): each source's state in words, when it last worked, and what a person can do. Sources
 * that arrive in a later update say "Coming later" (build spec ruling 3); Amazon gives topics only, never review text
 * or stars (ruling 5). No setting name is ever shown.
 */
import { useMemo } from 'react'
import { Card } from '@/design-system/components'
import { NexusGrid, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, Pill, Skeleton, Tag } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
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
        {data.later && <Tag tone="neutral">{data.later}</Tag>}
      </span>
      <span className={s.cellSub}>{data.words}</span>
    </span>
  )
}

function LastCell({ data }: ICellRendererParams<SourceRow>) {
  if (!data) return null
  return <span className={s.cellSub}>{data.lastAt ? timeWords(data.lastAt, new Date()) : (data.lastWords ?? '—')}</span>
}

function ActionCell({ data }: ICellRendererParams<SourceRow>) {
  if (!data) return null
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
  if (data.later) {
    // ⛔ KEEP — placeholder (build spec ruling 3): this source is read from a later update; "Connect" then opens it.
    return (
      <span className={s.cellActions}>
        <Button size="sm" heldReason={`Coming later: Nexus reads ${data.name.toLowerCase()} in a later update.`}>Connect</Button>
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

export function SourcesSection({ read }: { read: SettingsRead<SourcesResponse> }) {
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowData = useMemo(() => read.data?.rows ?? [], [read.data])
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
            <NexusGrid<SourceRow> plain plainMaxHeight={900} density="compact" rowData={rowData} columnDefs={columnDefs} getRowId={getRowId} />
          </div>
        )}
      </Card>
    </div>
  )
}
