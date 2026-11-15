'use client'

import { Printer, RotateCcw } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { LabelJob, LabelJobs } from '../api'
import { jobHeld, PRINT_TONE, REPRINT_REASON_MAX, reasonProblem, reprintHeld, requesterWords, type ReprintActions, type ReprintModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/** The newest job of each parcel and kind that may be printed again: what "Reprint every label" sends. */
export function newestReprintable(jobs: LabelJobs): string[] {
  return jobs.parcels.flatMap((parcel) => {
    const newest = new Map<string, LabelJob>()
    for (const job of parcel.jobs) if (job.reprintable && job.kind !== 'OTHER') newest.set(job.kind, job)
    return [...newest.values()].map((job) => job.jobId)
  })
}

/**
 * SCR-595 — Carrier & label › Label prints (design sh-labels "W2b Reprint with a reason (logged)"; B-W2b-391 LOG-027): each
 * parcel's label jobs — the carrier label and its carton's marks, and their reprints — with the state on the printer, the
 * printer, the copies, when and who asked (an office person by name; on the floor the device), the reason of a reprint, TEST
 * labels marked; Reprint one, or every label at once, asks the reason (3 to 200 characters, kept on the record) and makes
 * a new job of the same label — nothing is bought or laid out again; a label voided or a carton renumbered says why it
 * cannot be printed again.
 */
export function ReprintView({ model, actions }: { model: ReprintModel; actions?: ReprintActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Reprint model={model} actions={actions} />
    </WithMessages>
  )
}

function Reprint({ model, actions }: { model: ReprintModel; actions?: ReprintActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (title: string) => (
    <h2 className="fw-sh-h2">
      <Printer size={16} aria-hidden /> {title}
    </h2>
  )
  if (model.jobs.state !== 'ready') {
    return (
      <Card padded>
        {head(t('reprint.title'))}
        <PartRead problem={model.jobs.state === 'error' ? model.jobs.problem : null} onRetry={actions?.onRetry} label={t('reprint.title')} />
      </Card>
    )
  }
  const jobs = model.jobs.value
  const all = newestReprintable(jobs)
  const allBlocked = say(reprintHeld({ ...model, picked: all }))
  const any = jobs.parcels.some((parcel) => parcel.jobs.length > 0)
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        {head(t('reprint.title'))}
        {any && (
          <Button size="sm" heldReason={allBlocked} onClick={() => actions?.onPick?.(all)}>
            <RotateCcw size={14} aria-hidden /> {t('reprint.all', { count: all.length })}
          </Button>
        )}
      </div>
      {model.done && (
        <Banner tone="success" title={t('reprint.done', { count: model.done.jobs.length })}>
          {model.done.jobs.some((job) => job.test) ? t('reprint.doneTest') : null}
        </Banner>
      )}
      {model.problem && !model.dialog && <Banner tone="danger" title={say(model.problem) ?? ''} />}
      {!any ? (
        <EmptyState title={t('reprint.none.title')} description={t('reprint.none.body')} />
      ) : (
        <ul className="fw-shd-parcels" aria-label={t('reprint.title')}>
          {jobs.parcels
            .filter((parcel) => parcel.jobs.length > 0)
            .map((parcel) => (
              <li key={parcel.parcelId} className="fw-shd-parcel">
                <span className="fw-shd-parcel-head">
                  <strong>{t('reprint.parcel', { seq: parcel.seq })}</strong>
                  <span className="fw-sh-cell-sub fw-sh-mono">{parcel.trackingNumber ?? t('reprint.noTracking')}</span>
                </span>
                <ul className="fw-shd-jobs">
                  {parcel.jobs.map((job) => {
                    const held = say(jobHeld(job)) ?? (!model.can.pack || !model.can.printLabels ? t('reprint.held.noRight') : model.busy ? t('reprint.held.busy') : null)
                    return (
                      <li key={job.jobId} className="fw-shd-job">
                        <span className="fw-sh-cell">
                          <span className="fw-sh-inline">
                            <strong>{t(`reprint.kind.${job.kind}`)}</strong>
                            {job.test && <Tag tone="warning">{t('reprint.test')}</Tag>}
                            {job.reprintOfId && <Tag tone="neutral">{t('reprint.again')}</Tag>}
                            <Pill tone={PRINT_TONE[job.status]}>{t(`printState.${job.status}`)}</Pill>
                          </span>
                          <span className="fw-sh-cell-sub">
                            {t('reprint.line', { printer: job.printer.name, copies: job.copies, when: formatDateTime(job.createdAt, { locale }) })} · {say(requesterWords(job))}
                          </span>
                          {job.reason && <span className="fw-sh-cell-sub">{t('reprint.why', { reason: job.reason })}</span>}
                        </span>
                        <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onPick?.([job.jobId])} aria-label={t('reprint.oneOf', { kind: t(`reprint.kind.${job.kind}`), seq: parcel.seq })}>
                          {t('reprint.one')}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
        </ul>
      )}
      <p className="fw-sh-hint">{t('reprint.note')}</p>
      {model.dialog && <ReprintDialog jobs={jobs} model={model} actions={actions} />}
    </Card>
  )
}

function ReprintDialog({ jobs, model, actions }: { jobs: LabelJobs; model: ReprintModel; actions?: ReprintActions }) {
  const { t, say } = useDepthWords()
  if (!model.dialog) return null
  const dialog = model.dialog
  const picked = jobs.parcels.flatMap((parcel) => parcel.jobs.filter((job) => model.picked.includes(job.jobId)).map((job) => ({ job, seq: parcel.seq })))
  const held = model.busy ? t('reprint.held.busy') : (say(reprintHeld(model)) ?? say(reasonProblem(dialog.reason)))
  return (
    <DepthDialog
      title={t('reprint.dialogTitle', { count: picked.length })}
      subtitle={jobs.number}
      held={held}
      onGo={() => actions?.onReprint?.()}
      goLabel={t('reprint.go', { count: picked.length })}
      onClose={() => actions?.onDialog?.(null)}
      problem={say(model.problem)}
    >
      <ul className="fw-sh-list">
        {picked.map(({ job, seq }) => (
          <li key={job.jobId}>
            {t('reprint.pickedLine', { kind: t(`reprint.kind.${job.kind}`), seq, printer: job.printer.name })}
            {job.test ? ` · ${t('reprint.test')}` : ''}
          </li>
        ))}
      </ul>
      <Field label={t('reprint.reason')} required hint={t('reprint.reasonHint')}>
        <Textarea rows={2} limit={REPRINT_REASON_MAX} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
      </Field>
      <p className="fw-sh-hint">{t('reprint.nothingBought')}</p>
    </DepthDialog>
  )
}
