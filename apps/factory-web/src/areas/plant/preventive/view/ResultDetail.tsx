'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Pill, Spinner } from '@nexus/ui/primitives'
import { DetailModal, FileDropzone, FileRow, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { REPORT_ACCEPT, REPORT_MAX_BYTES } from '../api'
import { machineText, preventiveAddressText, reportState, typeLabel, withAddress } from '../model'
import type { PreventivePageActions, PreventivePageModel, ResultOpenState } from '../view-model'
import { CheckLaw, OutcomePill, problemText, useDay, useMoment, useWords } from './parts'
import { LOCK_LAW } from './ResultDialog'

/**
 * A result's window (a DetailModal; Enter on a register row or a done chip; J / K over the register): the day, outcome,
 * remarks, who did it, next due, kept until, who recorded it, its plan; the correction chain; the job it made; the body's
 * report files (Open) and the drop zone while a report may be added; "Make a job" and "Lock as unsafe" afterwards where
 * the API allows them (a failed check); Correct (a new result naming this one: a result never changes); the check report
 * PDF in a new tab. Every held button says why.
 */
export function ResultDetail({ model, state, actions }: { model: PreventivePageModel; state: ResultOpenState; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const moment = useMoment()
  const ds = useDsWords()
  const record = state.read.status === 'ready' ? state.read.value : null
  const result = record?.result ?? null
  const ids = useMemo(() => (model.register.status === 'ready' ? model.register.value.rows.map((row) => row.id) : []), [model.register])
  const close = () => actions?.onAddress?.({ result: null })
  const busy = state.busy ? t('held.saving') : null
  const jobHeld = !record ? t('common.reading') : busy ?? (!model.can.makeJob ? t('held.jobRight') : result?.outcome === 'PASSED' ? t('refusal.NO_JOB_FOR_PASSED') : result && result.jobs.some((job) => job.status !== 'CLOSED' && job.status !== 'CANCELLED') ? t('held.jobOpen', { number: result.jobs[0]!.number }) : !record.canMakeJob ? t('held.jobNotNow') : null)
  const lockHeld = !record ? t('common.reading') : busy ?? (!model.can.lock ? t('held.lockRight') : result?.outcome !== 'FAILED' ? t('refusal.LOCK_NEEDS_FAILED') : record.machine.locked ? t('refusal.LOCKED_ALREADY') : !record.canLock ? t('held.lockNotNow') : null)
  const correctHeld = !record ? t('common.reading') : !model.can.manage ? t('held.manage') : result?.correctedBy ? t('refusal.CORRECTED_ALREADY') : !record.canCorrect ? t('held.correctNotNow') : null
  const canAdd = !!record && record.canAddReport && model.can.manage
  const reportHref = result ? `${model.prefix}/plant/preventive/report?result=${encodeURIComponent(result.id)}&language=${locale}` : null

  const footer =
    state.step === 'lock' ? (
      <>
        <Button onClick={() => actions?.onResultStep?.('view')}>{t('common.back')}</Button>
        <span className="grow" />
        <Button variant="danger" heldReason={lockHeld} onClick={() => actions?.onLock?.()}>
          {state.busy ? <Spinner size={14} /> : null} {t('lock.confirm')}
        </Button>
      </>
    ) : (
      <>
        <Button heldReason={correctHeld} onClick={() => result && actions?.onAddress?.({ result: null, corrects: result.id })}>
          {t('result.correct')}
        </Button>
        {result?.outcome === 'FAILED' && (
          <Button heldReason={lockHeld} onClick={() => actions?.onResultStep?.('lock')}>
            {t('result.lockAfter')}
          </Button>
        )}
        <span className="grow" />
        {result?.outcome !== 'PASSED' && (
          <Button variant="primary" heldReason={jobHeld} onClick={() => actions?.onMakeJob?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('result.makeJobAfter')}
          </Button>
        )}
      </>
    )

  return (
    <DetailModal
      open
      onClose={close}
      title={result ? t('result.windowTitle', { check: typeLabel(result.checkType, locale), date: day(result.performedOn) }) : t('result.noun')}
      subtitle={result ? `${machineText(result.machine)} · ${result.site.name}` : undefined}
      meta={
        result ? (
          <span className="fw-pv-row">
            <OutcomePill outcome={result.outcome} say={t} />
            {!result.inForce && <Pill tone="neutral">{t('result.correctedPill')}</Pill>}
            {record?.machine.locked && <Pill tone="danger">{t('chip.locked')}</Pill>}
          </span>
        ) : undefined
      }
      actions={
        reportHref ? (
          <Button size="sm" variant="quiet" onClick={() => window.open(reportHref, '_blank', 'noopener')}>
            <ExternalLink size={13} aria-hidden /> {t('result.pdf')}
          </Button>
        ) : undefined
      }
      nav={ids.includes(state.id) ? { ids, current: state.id, onGo: (id) => actions?.onAddress?.({ result: id }), noun: t('result.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={() => actions?.onRetryResult?.()}
      footer={footer}
    >
      {result && record && (
        <div className="fw-pv-stack">
          {state.saved && <Banner tone="success" title={t(state.saved.key, state.saved.params)} />}
          {state.problem && <Banner tone="danger" title={problemText(t, state.problem)}>{state.problem.unknown ? t('problem.unknownHint') : null}</Banner>}
          {state.step === 'lock' ? (
            <div className="fw-pv-stack">
              <h3 className="fw-pv-h3">{t('lock.title', { machine: record.machine.assetNumber })}</h3>
              <ul className="fw-pv-list">
                <li>{t('lock.reach')}</li>
                <li>{t('lock.reversal')}</li>
                <li>{t('lock.joins')}</li>
              </ul>
              <LawRef law={LOCK_LAW} plain={t('lock.law')} labels={ds.lawRef} />
              <Field label={t('lock.note')} hint={t('lock.noteHint')}>
                <Input value={state.lockNote} maxLength={500} autoFocus onChange={(event) => actions?.onLockNote?.(event.target.value)} />
              </Field>
            </div>
          ) : (
            <>
              <CheckLaw type={result.checkType} say={t} />
              <KeyValue
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('facts.date'), value: day(result.performedOn) },
                  { label: t('facts.by'), value: result.performedBy, hint: result.outsideBody?.name ? t('facts.bodyOf', { body: result.outsideBody.name }) : undefined },
                  { label: t('facts.remarks'), value: result.remarks ?? t('facts.noRemarks') },
                  { label: t('facts.nextDue'), value: result.nextDueOn ? day(result.nextDueOn) : t('nextDue.byPlan'), hint: record.plan && result.inForce ? t('facts.planNext', { date: day(record.plan.nextDueOn) }) : undefined },
                  { label: t('facts.keptUntil'), value: day(result.keptUntil), hint: t('facts.keptHint', { years: result.checkType.keptYears }) },
                  { label: t('facts.recorded'), value: moment(result.recordedAt), hint: result.recordedBy?.name ?? undefined },
                  {
                    label: t('facts.plan'),
                    value: record.plan ? <Link href={`${model.path}${preventiveAddressText(withAddress(model.address, { result: null, plan: record.plan.id }))}`}>{t('facts.planOpen')}</Link> : t('facts.noPlan'),
                  },
                  {
                    label: t('facts.job'),
                    value:
                      result.jobs.length > 0 ? (
                        <span className="fw-pv-row">
                          {result.jobs.map((job) => (
                            <Link key={job.id} href={`${model.prefix}/plant/jobs/${encodeURIComponent(job.id)}`}>
                              {job.number}
                            </Link>
                          ))}
                        </span>
                      ) : (
                        t('facts.noJob')
                      ),
                  },
                ]}
              />
              {(result.corrects || result.correctedBy || record.corrections.length > 0) && (
                <section className="fw-pv-stack" aria-labelledby="fw-pv-chain">
                  <h3 id="fw-pv-chain" className="fw-pv-h3">
                    {t('result.chain')}
                  </h3>
                  <ul className="fw-pv-list">
                    {result.corrects && (
                      <li>
                        <Link href={`${model.path}${preventiveAddressText(withAddress(model.address, { result: result.corrects.id }))}`}>{t('register.corrects', { date: day(result.corrects.performedOn) })}</Link>
                        {result.correctionReason ? ` — ${result.correctionReason}` : ''}
                      </li>
                    )}
                    {result.correctedBy && (
                      <li>
                        <Link href={`${model.path}${preventiveAddressText(withAddress(model.address, { result: result.correctedBy.id }))}`}>{t('register.correctedBy', { date: day(result.correctedBy.performedOn) })}</Link>
                      </li>
                    )}
                  </ul>
                </section>
              )}
              <section className="fw-pv-stack" aria-labelledby="fw-pv-reports">
                <h3 id="fw-pv-reports" className="fw-pv-h3">
                  {t('result.report')}
                </h3>
                {result.reports.length === 0 ? (
                  <p className={reportState(result) === 'missing' ? 'fw-pv-warn' : 'fw-pv-muted'}>{t(`reportLong.${reportState(result)}`)}</p>
                ) : (
                  <div className="fw-pv-files">
                    {result.reports.map((file) => (
                      <FileRow
                        key={file.id}
                        name={file.originalName}
                        size={file.sizeBytes}
                        status={file.availableAt ? t('result.uploadedOn', { date: moment(file.availableAt) }) : t('result.notYet')}
                        actions={
                          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenReport?.(result.id, file.id)}>
                            {t('common.open')}
                          </Button>
                        }
                      />
                    ))}
                  </div>
                )}
                {canAdd ? (
                  <>
                    <FileDropzone onFiles={(files) => actions?.onReports?.(files)} accept={REPORT_ACCEPT} maxBytes={REPORT_MAX_BYTES} multiple disabled={state.uploading} hint={t('result.reportHint')} />
                    {state.uploading && (
                      <p className="fw-pv-muted" role="status">
                        <Spinner size={14} /> {t('result.sending')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="fw-pv-muted">{model.can.manage ? t('held.reportNotNow') : t('held.manage')}</p>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </DetailModal>
  )
}
