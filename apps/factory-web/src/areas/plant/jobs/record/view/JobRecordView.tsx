'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, CalendarCheck, CheckCheck, ExternalLink, MoreHorizontal, Pause, Pencil, Play, RotateCcw, Undo2, X } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Menu, Modal, type TabItem } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner, Tag, Textarea, Input } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { RecordPanelsView, type RecordPanelsViewModel } from '../../../../../record-panels/view/RecordPanelsView'
import { JOB_TYPES, MACHINE_AFTER, PRIORITIES, type JobMove, type JobRecord } from '../../../_shared/api'
import { AssigneeField } from '../../../_shared/AssigneeField'
import { ageWords, assigneeWords, dueWords, labelOf, moveHeld, nextMove, personWords } from '../../../_shared/model'
import { JobPill, LiveLine, MachinePill, NoticeBanner, PlantMessages, PriorityTag, RecordFrame, say, SymptomText, useWords, type Translate } from '../../../_shared/parts'
import { JOB_TABS, type JobRecordActions, type JobRecordModel } from '../../view-model'

export type { JobRecordActions, JobRecordModel } from '../../view-model'

const MOVE_ICON: Readonly<Record<JobMove, ReactNode>> = {
  plan: <CalendarCheck size={14} aria-hidden />,
  start: <Play size={14} aria-hidden />,
  wait: <Pause size={14} aria-hidden />,
  handBack: <Undo2 size={14} aria-hidden />,
  reopen: <RotateCcw size={14} aria-hidden />,
  close: <CheckCheck size={14} aria-hidden />,
  cancel: <Ban size={14} aria-hidden />,
}

/**
 * SCR-149 — a maintenance job (design plant.jobs "Record: Maintenance job", a record page): the band (‹ Maintenance jobs,
 * "<number> · type", its state, priority, the machine's live status, overdue; ONE primary next step — Start, Hand back,
 * Close — and the other moves the state allows, each held with its reason; the job sheet in a new tab) and the W2a tabs:
 * Problem (what is wrong and on which machine: the symptom, the words, the requests merged in, the machine's card with the
 * "third failure in 30 days" hint; a machine locked as unsafe says where it is signed safe; the side panel's state,
 * priority, technician and due time with an explicit Apply), Hand-back (the one-screen close: what was done, the time from
 * start, the machine after — running only once signed safe; Retired from the office) and Activity (the record panels).
 * A floor technician is named only here (Owner answer W1).
 */
export function JobRecordView({ model, actions, panels, panelsPreview }: { model: JobRecordModel; actions?: JobRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  return (
    <PlantMessages>
      <JobRecordBody model={model} actions={actions} panels={panels} panelsPreview={panelsPreview} />
    </PlantMessages>
  )
}

function JobRecordBody({ model, actions, panels, panelsPreview }: { model: JobRecordModel; actions?: JobRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/plant/jobs`
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const job = value?.job ?? null
  const base = job ? `${listHref}/${encodeURIComponent(job.id)}` : listHref
  const tabs: TabItem[] = JOB_TABS.map((tab) => ({ id: tab, href: tab === 'problem' ? base : `${base}?tab=${tab}`, label: t(`jobTab.${tab}`), count: tab === 'problem' && value ? value.requests.length || null : null }))
  const can = { manageJobs: model.can.manageJobs && (value?.canManage ?? false), work: model.can.work && (value?.canWork ?? false) }

  let title: ReactNode = null
  let bandActions: ReactNode = null
  let meta: ReactNode = null
  if (job && value) {
    const next = nextMove(job.status)
    const primaryHeld = next ? moveHeld(next, job, can) : null
    const primary = next ? (
      next === 'handBack' && model.tab !== 'handback' ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={`${base}?tab=handback`}>
            {MOVE_ICON.handBack} {t('move.handBack')}
          </Link>
        </Button>
      ) : next === 'handBack' ? null : (
        <Button size="sm" variant="primary" heldReason={primaryHeld ? t(primaryHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.(next)}>
          {model.busy ? <Spinner size={12} /> : MOVE_ICON[next]} {t(`move.${next}`)}
        </Button>
      )
    ) : null
    const others: JobMove[] = (['plan', 'wait', 'reopen'] as const).filter((move) => move !== next && (move === 'plan' ? job.status === 'NEW' : move === 'wait' ? job.status === 'IN_PROGRESS' : job.status === 'HANDED_BACK'))
    title = `${job.number} · ${t(`jobType.${job.type}`)}`
    meta = (
      <>
        <JobPill status={job.status} />
        <PriorityTag priority={job.priority} />
        <MachinePill status={job.machine.status} locked={job.machine.locked} />
        {job.overdue && <Tag tone="danger">{t('jobs.overdue')}</Tag>}
        <Tag tone="neutral">{t(`jobSource.${job.source}`)}</Tag>
      </>
    )
    bandActions = (
      <span className="fw-pl-actions">
        {others.map((move) => {
          const held = moveHeld(move, job, can)
          return (
            <Button key={move} size="sm" heldReason={held ? t(held) : model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.(move)}>
              {MOVE_ICON[move]} {t(`move.${move}`)}
            </Button>
          )
        })}
        {job.open && job.status !== 'HANDED_BACK' && (
          <Button size="sm" variant="danger-outline" heldReason={can.manageJobs ? null : t('held.noManageJobs')} onClick={() => actions?.onCancelJob?.()}>
            {MOVE_ICON.cancel} {t('move.cancel')}
          </Button>
        )}
        {primary}
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            { id: 'sheet', label: t('jobs.sheet'), href: `${base}/sheet`, target: '_blank' },
            { id: 'machine', label: t('list.machineRecord'), href: `${model.prefix}/plant/machines/${encodeURIComponent(job.machine.id)}`, target: '_blank' },
            { id: 'machineJobs', label: t('record.machineJobs'), href: `${listHref}?machine=${encodeURIComponent(job.machine.id)}&view=all` },
          ]}
        />
      </span>
    )
  }

  const activity = panels ?? (panelsPreview ? <RecordPanelsView model={panelsPreview} /> : null)

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('record.backJobs')}
      loaded={model.loaded}
      noun={t('record.job')}
      title={title}
      meta={meta}
      actions={bandActions}
      status={<LiveLine asOf={model.asOf} live={model.live} />}
      tabs={tabs}
      tab={model.tab}
      onRetry={actions?.onRetry}
    >
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {value && model.tab === 'problem' && <ProblemTab model={model} value={value} actions={actions} can={can} t={t} place={place} />}
      {value && model.tab === 'handback' && <HandBackTab model={model} value={value} actions={actions} can={can} t={t} place={place} />}
      {value && model.tab === 'activity' && (activity ?? <p className="fw-pl-hint">{t('record.activityLater')}</p>)}
      {value && model.dialog && <RecordDialog model={model} actions={actions} />}
    </RecordFrame>
  )
}

interface TabProps {
  model: JobRecordModel
  value: JobRecord
  actions?: JobRecordActions
  can: { manageJobs: boolean; work: boolean }
  t: Translate
  place: { locale: ReturnType<typeof useLocale>; timeZone: string }
}

function LockedBanner({ model, value, t }: Pick<TabProps, 'model' | 'value' | 't'>) {
  const job = value.job
  if (!job.machine.locked) return null
  const lock = value.requests.find((request) => request.locking)
  return (
    <Banner
      tone="danger"
      icon={<AlertTriangle size={18} aria-hidden />}
      title={t('record.lockedTitle', { machine: job.machine.assetNumber })}
      action={
        lock ? (
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/plant/requests?open=${encodeURIComponent(lock.id)}`}>{t('record.lockedOpen')}</Link>
          </Button>
        ) : undefined
      }
    >
      {t('record.lockedBody')}
    </Banner>
  )
}

function ProblemTab({ model, value, actions, can, t, place }: TabProps) {
  const job = value.job
  const card = value.card
  const locale = place.locale
  const jobHref = (id: string) => `${model.prefix}/plant/jobs/${encodeURIComponent(id)}`
  const machineHref = `${model.prefix}/plant/machines/${encodeURIComponent(job.machine.id)}`
  const edit = model.edit
  const editHeld = !can.manageJobs ? t('held.noManageJobs') : !job.open ? t('held.jobDone') : null
  const applyHeld = edit && edit.problem.trim().length === 0 ? t('held.problemNeeded') : model.editBusy ? t('held.busy') : null
  return (
    <div className="fw-pl-stack">
      <LockedBanner model={model} value={value} t={t} />
      <div className="fw-pl-split">
        <div className="fw-pl-stack">
          <Card padded>
            <div className="fw-pl-stack tight">
              <h3 className="fw-pl-h3">{t('record.problem')}</h3>
              <SymptomText symptom={job.symptom} description={null} />
              <p className="fw-pl-text">{job.problem}</p>
              <p className="fw-pl-h3">{t('record.requests', { count: value.requests.length })}</p>
              {value.requests.length === 0 ? (
                <p className="fw-pl-hint">{t(job.source === 'REQUEST' ? 'record.requestsGone' : 'record.noRequests')}</p>
              ) : (
                <ul className="fw-pl-plain">
                  {value.requests.map((request) => (
                    <li key={request.id} className="fw-pl-dupe">
                      <span className="fw-pl-cell">
                        <SymptomText symptom={request.symptom} description={request.description} />
                        <span className="fw-pl-sub">
                          {formatDateTime(request.reportedAt, place)} · {personWords(t, request.reportedBy)}
                          {request.photos > 0 ? ` · ${t('list.photos', { count: request.photos })}` : ''}
                          {request.unsafe ? ` · ${request.locking ? t('unsafe.tag') : t('unsafe.signed')}` : ''}
                        </span>
                      </span>
                      <Button size="sm" variant="quiet" asChild>
                        <Link href={`${model.prefix}/plant/requests?open=${encodeURIComponent(request.id)}`}>{t('record.openRequest')}</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
          <Card padded>
            <div className="fw-pl-stack tight">
              <h3 className="fw-pl-h3">
                <Link className="fw-pl-link fw-pl-code" href={machineHref}>
                  {job.machine.assetNumber}
                </Link>
                <MachinePill status={card.machine.status} locked={card.machine.locked} />
              </h3>
              <p className="fw-pl-hint">{[labelOf(card.machine.class, locale), card.machine.make, card.machine.modelName, card.machine.serialNumber].filter(Boolean).join(' · ')}</p>
              {card.repeatFailure && (
                <Tag tone="warning">
                  <AlertTriangle size={11} aria-hidden /> {t('detail.repeatFailure', { count: card.requestsIn30Days })}
                </Tag>
              )}
              <KeyValue
                dense
                labelCase="sentence"
                columns={2}
                items={[
                  { label: t('detail.place'), value: [card.machine.siteCode, card.machine.line?.code, card.machine.station ? `${card.machine.station.code} · ${card.machine.station.name}` : null, card.machine.workCentre?.code].filter(Boolean).join(' · ') || '—' },
                  { label: t('detail.statusSince'), value: formatDateTime(card.machine.statusSince, place) },
                  { label: t('detail.requests30'), value: String(card.requestsIn30Days) },
                  { label: t('record.criticality'), value: t('record.criticalityLater') },
                ]}
              />
              <p className="fw-pl-h3">{t('detail.lastJobs')}</p>
              {card.lastJobs.filter((entry) => entry.id !== job.id).length === 0 ? (
                <p className="fw-pl-hint">{t('detail.noJobs')}</p>
              ) : (
                <ul className="fw-pl-plain">
                  {card.lastJobs
                    .filter((entry) => entry.id !== job.id)
                    .map((entry) => (
                      <li key={entry.id} className="fw-pl-cell">
                        <span className="fw-pl-row">
                          <Link className="fw-pl-link fw-pl-code" href={jobHref(entry.id)}>
                            {entry.number}
                          </Link>
                          <JobPill status={entry.status} />
                        </span>
                        <span className="fw-pl-sub">
                          {formatDate(entry.createdAt, place)} · {t(`jobType.${entry.type}`)} · {entry.problem}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
              <span>
                <Button size="sm" variant="quiet" asChild>
                  <Link href={machineHref} target="_blank">
                    <ExternalLink size={13} aria-hidden /> {t('detail.machineRecord')}
                  </Link>
                </Button>
              </span>
            </div>
          </Card>
        </div>

        <Card padded>
          <aside className="fw-pl-stack tight" aria-label={t('record.side')}>
            <h3 className="fw-pl-h3">
              {t('record.side')} <JobPill status={job.status} />
            </h3>
            {edit ? (
              <form
                className="fw-pl-dialog"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!applyHeld) actions?.onEditApply?.()
                }}
              >
                <Field label={t('field.type')}>
                  <Select value={edit.type} onChange={(event) => actions?.onEditDraft?.({ type: event.target.value as typeof edit.type })}>
                    {JOB_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`jobType.${type}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('field.priority')} hint={t(`priorityHint.${edit.priority}`)}>
                  <Select value={edit.priority} onChange={(event) => actions?.onEditDraft?.({ priority: event.target.value as typeof edit.priority })}>
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`priority.${priority}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <AssigneeField value={edit.assignee} technicians={model.technicians?.technicians ?? null} floorListed={model.technicians?.floorListed ?? false} problem={model.technicians?.problem ?? null} onChange={(assignee) => actions?.onEditDraft?.({ assignee })} />
                <Field label={t('field.due')}>
                  <Input type="datetime-local" value={edit.due} onChange={(event) => actions?.onEditDraft?.({ due: event.target.value })} />
                </Field>
                <Field label={t('field.problem')} required>
                  <Textarea value={edit.problem} rows={3} maxLength={2000} onChange={(event) => actions?.onEditDraft?.({ problem: event.target.value })} />
                </Field>
                <span className="fw-pl-row">
                  <Button size="sm" onClick={() => actions?.onEditCancel?.()}>
                    {t('common.discard')}
                  </Button>
                  <Button size="sm" variant="primary" type="submit" heldReason={applyHeld}>
                    {model.editBusy ? <Spinner size={12} /> : null} {t('common.apply')}
                  </Button>
                </span>
              </form>
            ) : (
              <>
                <KeyValue
                  dense
                  labelCase="sentence"
                  items={[
                    { label: t('field.priority'), value: <PriorityTag priority={job.priority} /> },
                    { label: t('field.type'), value: t(`jobType.${job.type}`) },
                    { label: t('field.assignee'), value: assigneeWords(t, job) },
                    { label: t('field.due'), value: job.dueAt ? formatDateTime(job.dueAt, place) : t('record.noDue'), hint: dueWords(t, job.dueAt, model.now, !job.open || job.status === 'HANDED_BACK') ?? undefined },
                    { label: t('field.source'), value: t(`jobSource.${job.source}`) },
                    { label: t('record.made'), value: formatDateTime(job.createdAt, place), hint: job.createdBy ? personWords(t, job.createdBy) : undefined },
                    { label: t('record.started'), value: job.startedAt ? formatDateTime(job.startedAt, place) : t('record.notStarted') },
                    ...(job.closedAt ? [{ label: t('record.closed'), value: formatDateTime(job.closedAt, place), hint: job.closedBy ? personWords(t, job.closedBy) : undefined }] : []),
                    ...(job.cancelledAt ? [{ label: t('record.cancelled'), value: formatDateTime(job.cancelledAt, place), hint: job.cancelReason ?? undefined }] : []),
                  ]}
                />
                <span>
                  <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.()}>
                    <Pencil size={13} aria-hidden /> {t('common.edit')}
                  </Button>
                </span>
              </>
            )}
          </aside>
        </Card>
      </div>
    </div>
  )
}

function HandBackTab({ model, value, actions, can, t, place }: TabProps) {
  const job = value.job
  const draft = model.handBack
  if (job.handedBack) {
    const closeHeld = moveHeld('close', job, can)
    const reopenHeld = moveHeld('reopen', job, can)
    return (
      <div className="fw-pl-stack">
        <Card padded>
          <div className="fw-pl-stack tight">
            <h3 className="fw-pl-h3">{t('handBack.doneTitle')}</h3>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('handBack.by'), value: personWords(t, job.handedBack.by) },
                { label: t('handBack.at'), value: formatDateTime(job.handedBack.at, place) },
                { label: t('handBack.machineAfter'), value: t(`machineAfter.${job.handedBack.machineAfter}`) },
                { label: t('handBack.time'), value: job.startedAt ? ageWords(t, Math.max(0, Math.round((new Date(job.handedBack.at).getTime() - new Date(job.startedAt).getTime()) / 60_000))) : '—', hint: t('handBack.timeHint') },
              ]}
            />
            <p className="fw-pl-h3">{t('handBack.workDone')}</p>
            <p className="fw-pl-text">{job.handedBack.workDone}</p>
            {job.status === 'HANDED_BACK' && (
              <span className="fw-pl-row">
                <Button size="sm" heldReason={reopenHeld ? t(reopenHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.('reopen')}>
                  {MOVE_ICON.reopen} {t('move.reopen')}
                </Button>
                <Button size="sm" variant="primary" heldReason={closeHeld ? t(closeHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.('close')}>
                  {MOVE_ICON.close} {t('move.close')}
                </Button>
              </span>
            )}
            {job.status === 'HANDED_BACK' && job.handedBack.machineAfter === 'RETIRED' && <p className="fw-pl-hint">{t('handBack.retiresOnClose')}</p>}
            <p className="fw-pl-hint">{t('handBack.confirmLater')}</p>
          </div>
        </Card>
      </div>
    )
  }
  const started = job.status === 'IN_PROGRESS'
  const runningHeld = job.machine.locked ? t('held.lockedRunning') : null
  const held = moveHeld('handBack', job, can, draft.machineAfter ?? undefined)
  const submitHeld = held ? t(held) : draft.workDone.trim().length === 0 ? t('held.workDoneNeeded') : !draft.machineAfter ? t('held.machineAfterNeeded') : model.busy ? t('held.busy') : null
  return (
    <div className="fw-pl-stack">
      <LockedBanner model={model} value={value} t={t} />
      {!started && (
        <Banner tone="info" title={t(job.open ? 'handBack.notStarted' : 'handBack.notOpen')}>
          {job.open && job.status !== 'IN_PROGRESS' ? t('handBack.notStartedBody') : null}
        </Banner>
      )}
      <Card padded>
        <form
          className="fw-pl-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            if (!submitHeld) actions?.onHandBack?.()
          }}
        >
          <h3 className="fw-pl-h3">{t('handBack.title')}</h3>
          <Field label={t('handBack.workDone')} required hint={t('handBack.workDoneHint')}>
            <Textarea value={draft.workDone} rows={4} maxLength={2000} disabled={!started} onChange={(event) => actions?.onHandBackDraft?.({ workDone: event.target.value })} />
          </Field>
          <p className="fw-pl-hint">{t('handBack.failureCodeLater')}</p>
          <p className="fw-pl-hint">{job.startedAt ? t('handBack.timeSoFar', { time: ageWords(t, Math.max(0, Math.round((new Date(model.now).getTime() - new Date(job.startedAt).getTime()) / 60_000))) }) : t('handBack.timeHint')}</p>
          <div className="fw-pl-choices" role="radiogroup" aria-label={t('handBack.machineAfter')}>
            {MACHINE_AFTER.map((after) => {
              const reason = after === 'RUNNING' ? runningHeld : null
              return (
                <RadioCard
                  key={after}
                  name="machine-after"
                  value={after}
                  checked={draft.machineAfter === after}
                  selected={draft.machineAfter === after}
                  disabled={!started || reason !== null}
                  onChange={() => actions?.onHandBackDraft?.({ machineAfter: after })}
                  title={t(`machineAfter.${after}`)}
                  description={reason ?? t(`machineAfterHint.${after}`)}
                />
              )
            })}
          </div>
          <span className="fw-pl-row">
            {job.status !== 'IN_PROGRESS' && job.open && (
              <Button size="sm" heldReason={moveHeld('start', job, can) ? t(moveHeld('start', job, can)!) : model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.('start')}>
                {MOVE_ICON.start} {t('move.start')}
              </Button>
            )}
            <Button size="sm" variant="primary" type="submit" heldReason={submitHeld}>
              {model.busy ? <Spinner size={12} /> : MOVE_ICON.handBack} {t('move.handBack')}
            </Button>
          </span>
        </form>
      </Card>
    </div>
  )
}

function RecordDialog({ model, actions }: { model: JobRecordModel; actions?: JobRecordActions }) {
  const t = useWords()
  const dialog = model.dialog!
  const held = dialog.reason.trim().length === 0 ? t('held.reasonNeeded') : dialog.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('cancelJob.title')}
      size="md"
      footer={
        <>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.back')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => !held && actions?.onDialogSubmit?.()}>
            {dialog.busy ? <Spinner size={12} /> : <X size={14} aria-hidden />} {t('cancelJob.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pl-text">{t('cancelJob.body')}</p>
        <Field label={t('cancelJob.reason')} required>
          <Textarea value={dialog.reason} rows={2} maxLength={500} onChange={(event) => actions?.onDialogDraft?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
