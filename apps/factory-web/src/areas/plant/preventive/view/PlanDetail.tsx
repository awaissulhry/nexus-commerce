'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { DetailModal, FileRow, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { machineText, preventiveAddressText, typeLabel, withAddress } from '../model'
import type { PlanOpenState, PreventivePageActions, PreventivePageModel } from '../view-model'
import { CheckLaw, intervalText, OutcomePill, useDay, useMoment, useWords } from './parts'

/** A key the window acts on: no modifier, not typed into a field (the window itself holds the focus). */
export function isWindowKey(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}

/**
 * The Plan window (design pop:plan-detail, a DetailModal; Enter on a plan or a chip; J / K over the plans list): the
 * interval, next due (a tone and words), the reminder, the outside body and owner, the law; its results newest first (each
 * opens its result) and their report files. Record result (primary) and Move a check (`m`), each held with its reason.
 */
export function PlanDetail({ model, state, actions }: { model: PreventivePageModel; state: PlanOpenState; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const moment = useMoment()
  const ds = useDsWords()
  const record = state.read.status === 'ready' ? state.read.value : null
  const plan = record?.plan ?? null
  const ids = useMemo(() => (model.plans.status === 'ready' ? model.plans.value.rows.map((row) => row.id) : []), [model.plans])
  const writeHeld = !plan ? t('common.reading') : !model.can.manage || !record?.canManage ? t('held.manage') : plan.status === 'ENDED' ? t('refusal.PLAN_ENDED') : null
  const recordHeld = !plan ? t('common.reading') : !model.can.manage || !record?.canRecord ? t('held.manage') : plan.status === 'ENDED' ? t('refusal.PLAN_ENDED') : null
  const close = () => actions?.onAddress?.({ plan: null })
  const files = (record?.results ?? []).flatMap((result) => result.reports.map((file) => ({ file, result })))

  // m moves the check (inside the window too; not typed into a field, not with a modifier).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'm' || !isWindowKey(event) || writeHeld || !plan) return
      event.preventDefault()
      actions?.onAddress?.({ plan: null, move: plan.id, date: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <DetailModal
      open
      onClose={close}
      title={plan ? typeLabel(plan.checkType, locale) : t('plan.noun')}
      subtitle={plan ? `${machineText(plan.machine)} · ${plan.site.name}` : undefined}
      meta={
        plan ? (
          <span className="fw-pv-row">
            {plan.status === 'ENDED' ? <Pill tone="neutral">{t('due.ENDED')}</Pill> : <DueCell value={{ due: plan.nextDueOn }} today={model.today} formatDate={(iso) => day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('dueOn', { date: text }) }} />}
            {plan.machine.locked && <Pill tone="danger">{t('chip.locked')}</Pill>}
            <Pill tone="info">{t('kind.STATUTORY')}</Pill>
          </span>
        ) : undefined
      }
      nav={ids.includes(state.id) ? { ids, current: state.id, onGo: (id) => actions?.onAddress?.({ plan: id }), noun: t('plan.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={() => actions?.onRetryPlan?.()}
      footer={
        <>
          <Button aria-keyshortcuts="m" heldReason={writeHeld} onClick={() => plan && actions?.onAddress?.({ plan: null, move: plan.id, date: null })}>
            {t('plan.move')}
          </Button>
          <span className="grow" />
          <Button variant="primary" heldReason={recordHeld} onClick={() => plan && actions?.onAddress?.({ plan: null, record: plan.id })}>
            {t('plan.record')}
          </Button>
        </>
      }
    >
      {plan && record && (
        <div className="fw-pv-stack">
          <CheckLaw type={plan.checkType} say={t} />
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('facts.interval'), value: intervalText(t, plan.interval, plan.intervalUnit) },
              { label: t('facts.nextDue'), value: plan.status === 'ENDED' ? t('due.ENDED') : day(plan.nextDueOn), hint: plan.status === 'ENDED' ? undefined : t('facts.reminderFrom', { date: day(plan.reminderFrom), days: plan.reminderDays }) },
              { label: t('facts.firstDue'), value: day(plan.firstDueOn) },
              { label: t('facts.lastDone'), value: plan.lastDone ? `${day(plan.lastDone.performedOn)} · ${t(`outcome.${plan.lastDone.outcome}`)}` : t('lastDone.none') },
              { label: t('facts.body'), value: plan.outsideBody?.name ?? t('body.inHouse') },
              { label: t('facts.owner'), value: plan.owner?.name ?? t('owner.none') },
              { label: t('facts.machine'), value: <Link href={`${model.prefix}/plant/machines/${encodeURIComponent(plan.machine.id)}`}>{machineText(plan.machine)}</Link> },
              { label: t('facts.reminded'), value: plan.lastRemindedAt ? moment(plan.lastRemindedAt) : t('facts.notReminded') },
              ...(plan.note ? [{ label: t('facts.note'), value: plan.note }] : []),
              ...(plan.status === 'ENDED' ? [{ label: t('facts.ended'), value: moment(plan.endedAt), hint: plan.endedReason ?? undefined }] : []),
            ]}
          />
          <section className="fw-pv-stack" aria-labelledby="fw-pv-plan-results">
            <h3 id="fw-pv-plan-results" className="fw-pv-h3">
              {t('plan.results')}
            </h3>
            {record.results.length === 0 ? (
              <p className="fw-pv-muted">{t('plan.noResults')}</p>
            ) : (
              <SummaryTable
                stackOnPhone
                label={t('plan.results')}
                columns={[t('col.date'), t('col.outcome'), t('col.by'), t('col.report'), t('col.nextDue')]}
                rows={record.results.map((result) => ({
                  id: result.id,
                  cells: [
                    <Link key="d" href={`${model.path}${preventiveAddressText(withAddress(model.address, { plan: null, result: result.id }))}`}>
                      {day(result.performedOn)}
                    </Link>,
                    <span key="o" className="fw-pv-row">
                      <OutcomePill outcome={result.outcome} say={t} />
                      {result.correctedBy ? <span className="fw-pv-muted">{t('register.correctedBy', { date: day(result.correctedBy.performedOn) })}</span> : null}
                    </span>,
                    result.performedBy,
                    result.reports.length > 0 ? result.reports.map((file) => file.originalName).join(', ') : result.inForce && !result.reportOnFile ? t('report.missing') : t('report.byCorrected'),
                    result.nextDueOn ? day(result.nextDueOn) : t('nextDue.byPlan'),
                  ],
                }))}
              />
            )}
          </section>
          <section className="fw-pv-stack" aria-labelledby="fw-pv-plan-files">
            <h3 id="fw-pv-plan-files" className="fw-pv-h3">
              {t('plan.files')}
            </h3>
            {files.length === 0 ? (
              <p className="fw-pv-muted">{t('plan.noFiles')}</p>
            ) : (
              <div className="fw-pv-files">
                {files.map(({ file, result }) => (
                  <FileRow
                    key={file.id}
                    name={file.originalName}
                    size={file.sizeBytes}
                    status={t('plan.fileOf', { date: day(result.performedOn) })}
                    actions={
                      <Button size="sm" variant="quiet" onClick={() => actions?.onOpenReport?.(result.id, file.id)}>
                        {t('common.open')}
                      </Button>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </DetailModal>
  )
}
