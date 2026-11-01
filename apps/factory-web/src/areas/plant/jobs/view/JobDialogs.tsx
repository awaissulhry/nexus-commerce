'use client'

import { useEffect, useRef, useState } from 'react'
import { ScanLine, Search, UserPlus, Wrench } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { JOB_TYPES, MANUAL_JOB_SOURCES, PRIORITIES } from '../../_shared/api'
import { assigneeWords, labelOf } from '../../_shared/model'
import { MachinePill, say, useWords } from '../../_shared/parts'
import { AssigneeField } from '../../_shared/AssigneeField'
import type { JobsListActions, JobsListModel } from '../view-model'

/**
 * The jobs list's dialogs (design plant.jobs): New job (`c`, `?new=1`: the machine — its asset number typed or scanned
 * into the field, or found by make and model —, the type, the problem, the priority, the source, a technician of the
 * machine's site, the due time, planned or new) and Assign jobs (the selection's technician old → new per job, one
 * site at a time, all or none). Submit held with its reason in words until it may go.
 */
export function JobDialogs({ model, actions }: { model: JobsListModel; actions?: JobsListActions }) {
  if (!model.dialog) return null
  return model.dialog.kind === 'new' ? <NewJobDialog model={model} actions={actions} /> : <AssignDialog model={model} actions={actions} />
}

function NewJobDialog({ model, actions }: { model: JobsListModel; actions?: JobsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const dialog = model.dialog as Extract<NonNullable<JobsListModel['dialog']>, { kind: 'new' }>
  const draft = dialog.draft
  const [query, setQuery] = useState(draft.query)
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFindMachine?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const technicians = draft.machine ? model.technicians[draft.machine.siteId] : undefined
  const held = !model.can.manageJobs
    ? t('held.noManageJobs')
    : !draft.machine
      ? t('held.machineNeeded')
      : draft.machine.status === 'RETIRED'
        ? t('held.machineRetired')
        : draft.problem.trim().length === 0
          ? t('held.problemNeeded')
          : dialog.busy
            ? t('held.busy')
            : null
  const submit = () => !held && actions?.onSubmitDialog?.()
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('newJob.title')}
      size="lg"
      footer={
        <>
          <span className="fw-pl-hint">{draft.plan ? t('newJob.footPlanned') : t('newJob.foot')}</span>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Wrench size={14} aria-hidden />} {t('newJob.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <div className="fw-pl-form">
          <Field label={t('newJob.find')} hint={t('newJob.findHint')}>
            <Input
              type="search"
              autoFocus
              leadingIcon={dialog.searching ? <Spinner size={12} /> : query.length > 0 ? <Search size={13} aria-hidden /> : <ScanLine size={13} aria-hidden />}
              value={query}
              placeholder={t('newJob.findPlaceholder')}
              onChange={(event) => {
                typed.current = true
                setQuery(event.target.value)
                actions?.onNewDraft?.({ query: event.target.value })
              }}
            />
          </Field>
          <Field label={t('report.machine')} required>
            <Select value={draft.machine?.id ?? ''} disabled={!dialog.found || dialog.found.length === 0} onChange={(event) => actions?.onNewDraft?.({ machine: dialog.found?.find((entry) => entry.id === event.target.value) ?? null, assignee: '' })}>
              <option value="">{dialog.found === null ? t('report.findFirst') : dialog.found.length === 0 ? t('report.noneFound') : t('report.pick')}</option>
              {draft.machine && !dialog.found?.some((entry) => entry.id === draft.machine?.id) && <option value={draft.machine.id}>{`${draft.machine.assetNumber} · ${labelOf(draft.machine.class, locale)}`}</option>}
              {(dialog.found ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.assetNumber} · ${labelOf(entry.class, locale)}${entry.station ? ` · ${entry.station.code}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          {draft.machine && (
            <p className="fw-pl-row wide">
              <MachinePill status={draft.machine.status} locked={draft.machine.locked} />
              <span className="fw-pl-hint">{[draft.machine.siteCode, draft.machine.make, draft.machine.modelName, draft.machine.station?.code].filter(Boolean).join(' · ')}</span>
            </p>
          )}
          <Field label={t('field.type')} required>
            <Select value={draft.type} onChange={(event) => actions?.onNewDraft?.({ type: event.target.value as typeof draft.type })}>
              {JOB_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`jobType.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('field.priority')} required hint={t(`priorityHint.${draft.priority}`)}>
            <Select value={draft.priority} onChange={(event) => actions?.onNewDraft?.({ priority: event.target.value as typeof draft.priority })}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`priority.${priority}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('field.problem')} required className="wide">
            <Textarea value={draft.problem} rows={3} maxLength={2000} onChange={(event) => actions?.onNewDraft?.({ problem: event.target.value })} />
          </Field>
          <Field label={t('field.source')} hint={t('field.sourceHint')}>
            <Select value={draft.source} onChange={(event) => actions?.onNewDraft?.({ source: event.target.value as typeof draft.source })}>
              {MANUAL_JOB_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`jobSource.${source}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.machine ? (
            <AssigneeField value={draft.assignee} technicians={technicians === undefined ? null : (technicians?.technicians ?? null)} floorListed={technicians?.floorListed ?? false} problem={technicians?.problem ?? null} onChange={(assignee) => actions?.onNewDraft?.({ assignee })} />
          ) : (
            <Field label={t('field.assignee')} hint={t('newJob.machineFirst')}>
              <Select value="" disabled>
                <option value="">{t('person.nobody')}</option>
              </Select>
            </Field>
          )}
          <Field label={t('field.due')} hint={t('field.dueHint')}>
            <Input type="datetime-local" value={draft.due} onChange={(event) => actions?.onNewDraft?.({ due: event.target.value })} />
          </Field>
          <div className="wide">
            <Checkbox checked={draft.plan} onChange={(event) => actions?.onNewDraft?.({ plan: event.target.checked })} label={t('makeJob.plan')} />
          </div>
        </div>
      </form>
    </Modal>
  )
}

/** Assign jobs (design pop:assign, the ReviewChangesModal's old → new; composed: the DS one speaks English only). */
function AssignDialog({ model, actions }: { model: JobsListModel; actions?: JobsListActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<JobsListModel['dialog']>, { kind: 'assign' }>
  const siteId = dialog.jobs[0]?.siteId ?? null
  const technicians = siteId ? model.technicians[siteId] : undefined
  const named = technicians?.technicians.find((entry) => `${entry.kind}:${entry.id}` === dialog.assignee) ?? null
  const newWords = dialog.assignee === '' ? t('person.nobody') : named ? (named.me ? t('field.assigneeMe', { name: named.name }) : named.name) : '—'
  const changing = dialog.jobs.filter((job) => (job.assignee?.id ? `${job.assignee.kind}:${job.assignee.id}` : '') !== dialog.assignee)
  const held = !model.can.manageJobs ? t('held.noManageJobs') : changing.length === 0 ? t('held.noChange') : dialog.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('assign.title', { count: dialog.jobs.length })}
      size="lg"
      footer={
        <>
          <span className="fw-pl-hint">{t('assign.foot')}</span>
          <span className="fw-pl-grow" />
          <Button size="sm" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onSubmitDialog?.()}>
            {dialog.busy ? <Spinner size={12} /> : <UserPlus size={14} aria-hidden />} {t('assign.submit', { count: changing.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <AssigneeField value={dialog.assignee} technicians={technicians === undefined ? null : (technicians?.technicians ?? null)} floorListed={technicians?.floorListed ?? false} problem={technicians?.problem ?? null} onChange={(assignee) => actions?.onAssignee?.(assignee)} />
        <table className="fw-pl-review">
          <caption className="fw-pl-hint">{t('assign.review')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('col.number')}</th>
              <th scope="col">{t('col.machine')}</th>
              <th scope="col">{t('assign.now')}</th>
              <th scope="col">{t('assign.after')}</th>
            </tr>
          </thead>
          <tbody>
            {dialog.jobs.map((job) => {
              const same = (job.assignee?.id ? `${job.assignee.kind}:${job.assignee.id}` : '') === dialog.assignee
              return (
                <tr key={job.id}>
                  <td className="fw-pl-code">{job.number}</td>
                  <td className="fw-pl-code">{job.machine.assetNumber}</td>
                  <td>{assigneeWords(t, job)}</td>
                  <td>{same ? <span className="fw-pl-hint">{t('assign.same')}</span> : <b>{newWords}</b>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
