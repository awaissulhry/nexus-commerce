'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, Play } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { type ColDef } from '@nexus/ui/grid'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, DetailModal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { cellOf } from '../../../shared/view/cells'
import { BulkButton, FrameState, ListKeysHelp } from '../../../shared/view/parts'
import type { Job, JobList, JobRun } from '../api'
import { durationOf, JOB_STATE_TONE, jobOrder, nameKey, needsCount, RESULT_TONE, runNowHeldKey, runNowReach, whatKey } from '../model'
import '../../../connections/errors/errors.css'

export interface JobsModel {
  prefix: string
  list: { answer: JobList | null; problem: string | null }
  selected: readonly string[]
  /** pop:run-now for one or many jobs. */
  confirm: { keys: readonly string[]; busy: boolean; problem: string | null } | null
  /** A job's runs (row → run history). */
  history: { key: string; runs: readonly JobRun[] | null; nextBefore: string | null; problem: string | null; loadingMore: boolean } | null
  notice: { key: string; tone: 'success' | 'warning' | 'danger'; params: Record<string, string | number> } | null
}

export interface JobsActions {
  onSelect?: (keys: string[]) => void
  onRunNow?: (keys: readonly string[] | null) => void
  onRunNowGo?: () => void
  onOpen?: (key: string | null) => void
  onMoreRuns?: () => void
  onRetry?: () => void
  onRetryRuns?: () => void
  onDismissNotice?: () => void
}

/** The section's words (`admin-integration-health`, prefix `aih.`) and Admin's. */
export function JobsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'admin-integration-health']}>{children}</WithMessages>
}

function useWords() {
  const t = useT('admin-integration-health')
  const ta = useT('admin')
  const locale = useLocale()
  return useMemo(() => {
    const time = (iso: string | null) => (iso ? formatDateTime(iso, { locale }) : '—')
    const name = (job: Pick<Job, 'key' | 'known'>) => {
      const words = nameKey(job)
      return t(words.key, words.params)
    }
    return { t, ta, time, name }
  }, [t, ta, locale])
}
type Words = ReturnType<typeof useWords>

function lastRunCell(job: Job, words: Pick<Words, 't' | 'time'>) {
  const run = job.lastRun
  if (!run) return <span className="fw-adm-hint">{words.t('aih.jobs.neverRan')}</span>
  return (
    <span className="fw-aih-line">
      <span>{words.time(run.startedAt)}</span>
      <Pill tone={RESULT_TONE[run.status]}>{words.t(`aih.result.${run.status}`)}</Pill>
    </span>
  )
}

/** The jobs' columns (exported: a test draws each cell alone). */
export function jobColumns(words: Pick<Words, 't' | 'time' | 'name'>): ColDef<Job>[] {
  const { t } = words
  return [
    {
      colId: 'name',
      headerName: t('aih.jobs.col.name'),
      valueGetter: ({ data }) => (data ? words.name(data) : ''),
      flex: 1.6,
      minWidth: 220,
      cellRenderer: cellOf<Job>((job) => (
        <span className="fw-aih-cell">
          <span className="fw-adm-name">{words.name(job)}</span>
          <span className="fw-adm-hint fw-adm-code">{job.key}</span>
        </span>
      )),
    },
    { colId: 'last', headerName: t('aih.jobs.col.last'), valueGetter: ({ data }) => data?.lastRun?.startedAt ?? '', flex: 1.1, minWidth: 200, cellRenderer: cellOf<Job>((job) => lastRunCell(job, words)) },
    { colId: 'next', headerName: t('aih.jobs.col.next'), valueGetter: ({ data }) => data?.nextRunAt ?? '', width: 160, cellRenderer: cellOf<Job>((job) => words.time(job.nextRunAt)) },
    { colId: 'failures', headerName: t('aih.jobs.col.failures'), valueGetter: ({ data }) => data?.failures7d ?? 0, width: 130 },
    { colId: 'waiting', headerName: t('aih.jobs.col.waiting'), valueGetter: ({ data }) => (data ? (data.waiting ?? '—') : ''), width: 110 },
    {
      colId: 'state',
      headerName: t('aih.jobs.col.state'),
      valueGetter: ({ data }) => (data ? t(`aih.jobState.${data.state}`) : ''),
      width: 140,
      cellRenderer: cellOf<Job>((job) => <Pill tone={JOB_STATE_TONE[job.state]}>{t(`aih.jobState.${job.state}`)}</Pill>),
    },
  ]
}

/**
 * Admin › Security & health › Jobs and integrations (SCR-166 section `jobs`, B-W2b-415; PLT-221; SCR-601): every scheduled job
 * — its name in words, last run and result, next run, failures in 7 days, Run-now requests waiting, its state (missed and stuck
 * jobs first) — in the Office list frame; tick jobs to Run now N (pop:run-now: what it does, its last result, that it runs once
 * in the cluster for this business only); a row opens its runs. A job that sends at its time or waits for a switch is held
 * with why. The tenant's background events waiting and dead are one line above. Fetches nothing (use-jobs.ts).
 */
export function JobsCard({ model, actions }: { model: JobsModel; actions?: JobsActions }) {
  return (
    <JobsMessages>
      <Jobs model={model} actions={actions} />
    </JobsMessages>
  )
}

function Jobs({ model, actions }: { model: JobsModel; actions?: JobsActions }) {
  const words = useWords()
  const { t, ta } = words
  const [help, setHelp] = useState(false)
  const columns = useMemo(() => jobColumns(words), [words])
  const answer = model.list.answer
  const jobs = answer ? jobOrder(answer.jobs, words.name) : null
  const canRun = answer?.canRun ?? false
  const ticked = (jobs ?? []).filter((job) => model.selected.includes(job.key))
  const reach = runNowReach(ticked, canRun)
  const bulkHeld = !canRun ? t('aih.runNow.held.NO_RIGHT') : ticked.length > 0 && reach.applies.length === 0 ? t('aih.runNow.noneTicked') : null
  const state = model.list.problem ? <FrameState problem={model.list.problem} onRetry={actions?.onRetry} /> : jobs && jobs.length === 0 ? <FrameState empty={{ icon: <CalendarClock size={24} aria-hidden />, title: t('aih.jobs.empty.title'), body: t('aih.jobs.empty.body') }} /> : undefined
  const needs = jobs ? needsCount(jobs) : 0
  return (
    <section id="jobs" aria-labelledby="aih-jobs" className="fw-sec-section fw-aih">
      <Card header={<span id="aih-jobs">{t('aih.jobs.title')}</span>} description={t('aih.jobs.hint')} headingLevel={2} padded>
        <div className="fw-aih-stack">
          {answer && (
            <p className="fw-aih-line" role="status">
              <span>{needs > 0 ? t('aih.jobs.needs', { count: needs }) : t('aih.jobs.allWell')}</span>
              <span className="fw-adm-hint">{t('aih.jobs.outbox', { waiting: answer.outbox.waiting, dead: answer.outbox.dead })}</span>
              {!answer.waitingKnown && <Tag tone="warning">{t('aih.jobs.waitingUnknown')}</Tag>}
            </p>
          )}
          {model.notice && <Banner tone={model.notice.tone} title={model.notice.key.startsWith('aih.') ? t(model.notice.key, model.notice.params) : ta(model.notice.key)} onDismiss={actions?.onDismissNotice} />}
          <ListFrame<Job>
            label={t('aih.jobs.title')}
            listKey="admin.security.jobs"
            title={t('aih.jobs.title')}
            rows={model.list.problem ? [] : jobs}
            rowId={(job) => job.key}
            columns={columns}
            count={jobs ? t('aih.jobs.count', { count: jobs.length }) : '—'}
            selection={{
              selected: model.selected,
              onChange: (keys) => actions?.onSelect?.(keys),
              actions: <BulkButton icon={<Play size={13} aria-hidden />} label={t('aih.runNow.bulk', { count: reach.applies.length })} held={bulkHeld} onClick={() => actions?.onRunNow?.(model.selected)} />,
            }}
            isRowSelectable={(job) => {
              const held = runNowHeldKey(job, canRun)
              return held ? t(held) : null
            }}
            onHelp={() => setHelp(true)}
            onOpen={(job) => actions?.onOpen?.(job.key)}
            state={state}
          />
          <p className="fw-adm-hint">{t('aih.jobs.rule')}</p>
        </div>
      </Card>
      <RunsModal model={model} actions={actions} />
      <RunNowConfirm model={model} actions={actions} />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection />
    </section>
  )
}

/** Row → the job's runs: what it does, its schedule, its state, every run (newest first), Run now. */
function RunsModal({ model, actions }: { model: JobsModel; actions?: JobsActions }) {
  const words = useWords()
  const { t, ta } = words
  const history = model.history
  const job = history ? (model.list.answer?.jobs.find((entry) => entry.key === history.key) ?? null) : null
  const ids = (model.list.answer ? jobOrder(model.list.answer.jobs, words.name) : []).map((entry) => entry.key)
  return (
    <DetailModal
      open={!!history && !model.confirm}
      onClose={() => actions?.onOpen?.(null)}
      title={job ? words.name(job) : t('aih.runs.title')}
      subtitle={job ? t(whatKey(job)) : undefined}
      meta={job ? <Pill tone={JOB_STATE_TONE[job.state]}>{t(`aih.jobState.${job.state}`)}</Pill> : undefined}
      nav={history && ids.includes(history.key) ? { ids, current: history.key, onGo: (key) => actions?.onOpen?.(key), noun: t('aih.runs.noun') } : undefined}
    >
      {history && job ? <RunsBody job={job} history={history} canRun={model.list.answer?.canRun ?? false} actions={actions} /> : history?.problem ? <Banner tone="danger" title={ta(history.problem)} /> : null}
    </DetailModal>
  )
}

/** The body of a job's runs (exported for the tests: the DetailModal draws its body only in the browser). */
export function RunsBody({ job, history, canRun, actions }: { job: Job; history: NonNullable<JobsModel['history']>; canRun: boolean; actions?: JobsActions }) {
  const words = useWords()
  const { t, ta } = words
  const held = runNowHeldKey(job, canRun)
  return (
    <div className="fw-adm-modal-body fw-aih-stack">
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('aih.runs.schedule'), value: job.schedule ? <code className="fw-adm-code">{job.schedule}</code> : '—', hint: job.timeZone ? t('aih.runs.zone', { zone: job.timeZone }) : undefined },
          { label: t('aih.jobs.col.next'), value: words.time(job.nextRunAt) },
          { label: t('aih.runs.state'), value: t(`aih.jobState.${job.state}`), hint: job.missedAt ? t('aih.runs.missed', { at: words.time(job.missedAt) }) : undefined },
          { label: t('aih.jobs.col.failures'), value: t('aih.runs.failures', { failed: job.failures7d, runs: job.runs7d }) },
          ...(job.gate ? [{ label: t('aih.runs.switch'), value: t(job.switchedOn ? 'aih.runs.switchOn' : 'aih.runs.switchOff', { name: t(`aih.gate.${job.gate}`) }) }] : []),
        ]}
      />
      <div className="fw-aih-actions">
        <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRunNow?.([job.key])}>
          <Play size={13} aria-hidden /> {t('aih.runNow.action')}
        </Button>
      </div>
      <section aria-labelledby="fw-aih-runs" className="fw-aih-block">
        <h3 id="fw-aih-runs" className="fw-aih-sub">
          {t('aih.runs.list')}
        </h3>
        {history.problem ? (
          <Banner tone="danger" title={ta(history.problem)}>
            <Button size="sm" onClick={() => actions?.onRetryRuns?.()}>
              {ta('common.retry')}
            </Button>
          </Banner>
        ) : history.runs === null ? (
          <p className="fw-adm-loading" role="status">
            <Spinner size={14} /> {t('aih.loading')}
          </p>
        ) : history.runs.length === 0 ? (
          <p className="fw-adm-hint">{t('aih.runs.none')}</p>
        ) : (
          <ul className="fw-aih-runs">
            {history.runs.map((run) => (
              <RunLine key={run.id} run={run} words={words} />
            ))}
          </ul>
        )}
        {history.nextBefore && (
          <Button size="sm" variant="quiet" heldReason={history.loadingMore ? t('aih.held.loading') : null} onClick={() => actions?.onMoreRuns?.()}>
            {t('aih.older')}
          </Button>
        )}
      </section>
    </div>
  )
}

function RunLine({ run, words }: { run: JobRun; words: Words }) {
  const { t } = words
  const duration = durationOf(run.durationMs)
  return (
    <li className="fw-aih-block">
      <span className="fw-aih-line">
        <span>{words.time(run.startedAt)}</span>
        <Tag>{t(run.trigger === 'RUN_NOW' ? 'aih.run.byPerson' : 'aih.run.scheduled')}</Tag>
        <Pill tone={RESULT_TONE[run.status]}>{t(`aih.result.${run.status}`)}</Pill>
        {duration && <span className="fw-adm-hint">{t(duration.key, duration.params)}</span>}
        <span className="fw-adm-hint fw-adm-code">{run.ranOn}</span>
      </span>
      {run.error && <q className="fw-aih-quote">{run.error}</q>}
    </li>
  )
}

/** pop:run-now — "Run 'certificate expiry check' now?": what it does, its last result, that it runs once in the cluster. */
function RunNowConfirm({ model, actions }: { model: JobsModel; actions?: JobsActions }) {
  const words = useWords()
  const { t, ta } = words
  const confirm = model.confirm
  const answer = model.list.answer
  if (!confirm || !answer) return null
  const jobs = answer.jobs.filter((job) => confirm.keys.includes(job.key))
  const reach = runNowReach(jobs, answer.canRun)
  const one = reach.applies.length === 1 ? reach.applies[0]! : null
  const resultOf = (job: Job) => (job.lastFinished ? t('aih.runNow.last', { result: t(`aih.result.${job.lastFinished.status}`), at: words.time(job.lastFinished.finishedAt) }) : t('aih.runNow.lastNone'))
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        title: one ? t('aih.runNow.titleOne', { name: words.name(one) }) : t('aih.runNow.titleMany', { count: reach.applies.length }),
        confirmLabel: confirm.busy ? t('aih.held.saving') : t('aih.runNow.go', { count: reach.applies.length }),
        consequences: [
          ...reach.applies.flatMap((job) => (one ? [t(whatKey(job)), resultOf(job)] : [`${words.name(job)} · ${resultOf(job)}`])),
          t('aih.runNow.once'),
          ...reach.left.map((entry) => t(entry.key, { count: entry.count })),
        ],
        ...(reach.applies.length === 0 ? { unavailable: t('aih.runNow.noneTicked') } : confirm.problem ? { unavailable: ta(confirm.problem) } : {}),
      }}
      onConfirm={() => actions?.onRunNowGo?.()}
      onCancel={() => (confirm.busy ? undefined : actions?.onRunNow?.(null))}
    />
  )
}
