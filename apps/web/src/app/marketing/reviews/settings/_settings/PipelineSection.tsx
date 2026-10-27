'use client'

/**
 * Reviews › Settings › Pipeline health — the jobs that read reviews and send requests (GET
 * /api/reviews/settings/pipeline): each job's schedule, last and next run, and state in words; a failure's own code sits
 * in a tooltip (never a setting name). "Fix stuck jobs" marks a run that has hung for over two hours as stopped
 * (`POST /api/reviews/pipeline/sweep-stuck-crons`), so the job runs again at its next time; held when no job is stuck.
 */
import { useCallback, useMemo, useState } from 'react'
import { Banner, Card, useToast } from '@/design-system/components'
import { NexusGrid, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, InfoTip, Pill, Skeleton } from '@/design-system/primitives'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { ReadFailed } from './ReadFailed'
import { NO_STUCK_JOB, everyLocal, pipelineSummary, timeWords, type PipelineJob, type PipelineResponse } from './settingsModel'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

const PILL_TONE = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral', info: 'info' } as const

function JobCell({ data }: ICellRendererParams<PipelineJob>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellStrong}>{data.name}</span>
      <span className={s.cellSub}>{data.what}</span>
    </span>
  )
}

function RunsCell({ data }: ICellRendererParams<PipelineJob>) {
  return data ? <span className={s.cellSub}>{everyLocal(data.every, new Date())}</span> : null
}

function LastCell({ data }: ICellRendererParams<PipelineJob>) {
  return data ? <span className={s.num}>{timeWords(data.lastRunAt, new Date())}</span> : null
}

function NextCell({ data }: ICellRendererParams<PipelineJob>) {
  if (!data) return null
  return <span className={s.num}>{data.nextRunAt ? timeWords(data.nextRunAt, new Date()) : data.state === 'stuck' ? 'after it is fixed' : '—'}</span>
}

function StateCell({ data }: ICellRendererParams<PipelineJob>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellLine}>
        <Pill tone={PILL_TONE[data.tone]} dot>{data.stateWords}</Pill>
        {data.code && <InfoTip tip={`What the job said: ${data.code}`} />}
      </span>
      {data.words && <span className={s.cellSub}>{data.words}</span>}
    </span>
  )
}

const COLUMNS: ColDef<PipelineJob>[] = [
  { colId: 'job', headerName: 'Job', width: 230, minWidth: 200, cellRenderer: JobCell, autoHeight: true },
  { colId: 'runs', headerName: 'Runs', width: 150, minWidth: 130, cellRenderer: RunsCell },
  { colId: 'last', headerName: 'Last run', width: 140, minWidth: 120, cellRenderer: LastCell },
  { colId: 'next', headerName: 'Next run', width: 150, minWidth: 120, cellRenderer: NextCell },
  { colId: 'state', headerName: 'State', flex: 2, minWidth: 260, cellRenderer: StateCell, autoHeight: true },
]

const getRowId = (p: { data: PipelineJob }) => p.data.key

export interface PipelineSectionProps {
  read: SettingsRead<PipelineResponse>
  manageHeld: string | null
}

export function PipelineSection({ read, manageHeld }: PipelineSectionProps) {
  const { toast } = useToast()
  const [fixing, setFixing] = useState(false)
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowData = useMemo(() => read.data?.jobs ?? [], [read.data])
  const summary = read.data ? pipelineSummary(read.data) : null
  const stuck = read.data?.stuck ?? 0

  const fix = useCallback(async () => {
    setFixing(true)
    const res = await reviewsSend<{ swept: number }>('POST', '/reviews/pipeline/sweep-stuck-crons')
    setFixing(false)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    await read.reload()
    const n = res.data?.swept ?? 0
    toast(n === 0 ? 'No run was stuck any more.' : `Marked ${n} stuck ${n === 1 ? 'run' : 'runs'} as stopped. ${n === 1 ? 'The job runs' : 'The jobs run'} again at the next time.`, 'success')
  }, [read, toast])

  const held = manageHeld ?? (fixing ? 'Fixing…' : !read.data ? 'Reading the jobs…' : stuck === 0 ? NO_STUCK_JOB : null)

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <p className={s.lead}>
          The jobs that read reviews and send requests{read.data ? ` · checked ${timeWords(read.data.checkedAt, new Date()).replace(/^Today /, 'at ')}` : ''}.
        </p>
        <span className={s.grow} />
        <Button size="sm" onClick={() => void fix()} heldReason={held}>Fix stuck jobs</Button>
      </div>
      {summary && (
        <Banner tone={stuck > 0 || read.data?.jobs.some((j) => j.state === 'failed') ? 'danger' : 'warning'} title={summary.title}>
          <ul className={s.list}>{summary.words.map((w) => <li key={w}>{w}</li>)}</ul>
        </Banner>
      )}
      <Card padded={false}>
        {read.error && !read.data ? (
          <div className={s.pad}><ReadFailed error={read.error} onRetry={() => void read.reload()} busy={read.loading} /></div>
        ) : !read.data ? (
          <div className={s.skeletonRows} aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={40} />)}</div>
        ) : (
          <div className={s.tableScroll}>
            <NexusGrid<PipelineJob> plain plainMaxHeight={900} density="compact" rowData={rowData} columnDefs={columnDefs} getRowId={getRowId} />
          </div>
        )}
      </Card>
    </div>
  )
}
