'use client'

import Link from 'next/link'
import { Check, CircleDashed, ExternalLink, SkipForward } from 'lucide-react'
import { Card, EmptyState, Stepper } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Countdown } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Leaver, LeaverStep } from '../../_shared/api'
import { daysUntil, stepHref, zonedInstant, type PeopleCan } from '../../_shared/model'
import { useWords, type Translate } from '../../_shared/parts'
import type { EmployeesListActions, EmployeesListModel } from '../view-model'

/**
 * Leavers in progress (design people.employees sec:leavers, MES-214): step-by-step leaving, visible until every step is
 * done. A card per person: the last working day with its countdown, the steps as a stepper and as a list — each with its
 * state, who ticked it (automatic steps tick themselves: badge off and sessions ended after the last day, access ended
 * when the account is switched off in Admin › Users, shifts cleared, payroll flagged by the export), where it is done, and
 * Mark done / Skip for the steps a person ticks. "Cancel leaving" until the last day. Hidden when nobody is leaving.
 */
export function LeaversPanel({ model, actions }: { model: EmployeesListModel; actions?: EmployeesListActions }) {
  const t = useWords()
  if (model.leavers.problem) {
    return (
      <section className="fw-pp-stack" aria-label={t('leavers.title')}>
        <h2 className="fw-pp-h3">{t('leavers.title')}</h2>
        <EmptyState title={t('leavers.failed')} description={t(model.leavers.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      </section>
    )
  }
  if (!model.leavers.items) {
    return (
      <section className="fw-pp-stack" aria-label={t('leavers.title')} aria-busy="true">
        <h2 className="fw-pp-h3">{t('leavers.title')}</h2>
        <Skeleton height={120} />
      </section>
    )
  }
  if (model.leavers.items.length === 0) return null
  return (
    <section className="fw-pp-stack" aria-label={t('leavers.title')}>
      <h2 className="fw-pp-h3">
        {t('leavers.title')} <Tag tone="warning">{model.leavers.items.length}</Tag>
      </h2>
      <div className="fw-pp-leavers">
        {model.leavers.items.map((leaver) => (
          <LeaverCard key={leaver.id} leaver={leaver} prefix={model.prefix} today={model.today} timeZone={model.timeZone} can={model.can} actions={actions} />
        ))}
      </div>
    </section>
  )
}

export function LeaverCard({
  leaver,
  prefix,
  today,
  timeZone,
  can,
  actions,
  record,
}: {
  leaver: Leaver
  prefix: string
  today: string
  timeZone: string
  can: PeopleCan
  actions?: Pick<EmployeesListActions, 'onStepDone' | 'onStepSkip' | 'onCancelLeaving'>
  /** Inside the record: no link to it, the account and floor ids for "where it is done". */
  record?: { userId: string | null; workerIds: readonly string[] }
}) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const steps = [...leaver.steps].sort((a, b) => a.seq - b.seq)
  const firstOpen = steps.findIndex((step) => step.status === 'OPEN')
  const current = firstOpen === -1 ? steps.length : firstOpen
  const days = daysUntil(today, leaver.lastWorkingDay)
  const lastDay = formatDate(`${leaver.lastWorkingDay}T12:00:00Z`, place)
  const cancellable = days >= 0
  const cancelHeld = !can.manageLeavers ? t('held.noManageLeavers') : !cancellable ? t('held.pastLastDay') : null
  const where = record ?? { userId: null, workerIds: [] }
  return (
    <Card
      padded
      header={record ? t('leavers.recordTitle') : <Link className="fw-pp-link" href={`${prefix}/people/employees/${encodeURIComponent(leaver.employee.id)}`}>{leaver.employee.name}</Link>}
      headingLevel={3}
      description={record ? undefined : [leaver.employee.site.code, leaver.employee.employeeCode].filter(Boolean).join(' · ')}
      headerAction={
        <Button size="sm" variant="quiet" heldReason={cancelHeld} onClick={() => actions?.onCancelLeaving?.(leaver)}>
          {t('leavers.cancel')}
        </Button>
      }
    >
      <div className="fw-pp-card-body">
        <p className="fw-pp-text">
          {t('leavers.lastDay', { day: lastDay })}{' '}
          {days >= 0 ? (
            <Countdown to={zonedInstant(leaver.lastWorkingDay, '23:59', timeZone)} label={(left) => t('leavers.endsIn', { left })} doneLabel={t('leavers.ended')} />
          ) : (
            <Tag tone="neutral">{t('leavers.afterLastDay')}</Tag>
          )}
        </p>
        <Stepper steps={steps.map((step) => ({ key: step.id, label: t(`step.${step.kind}`) }))} current={current} />
        <ul className="fw-pp-steps" aria-label={t('leavers.steps')}>
          {steps.map((step) => (
            <StepLine key={step.id} t={t} step={step} href={stepHref(prefix, step, where)} place={place} can={can} onDone={() => actions?.onStepDone?.(leaver, step)} onSkip={() => actions?.onStepSkip?.(leaver, step)} />
          ))}
        </ul>
      </div>
    </Card>
  )
}

function StepLine({ t, step, href, place, can, onDone, onSkip }: { t: Translate; step: LeaverStep; href: string | null; place: { locale: ReturnType<typeof useLocale>; timeZone: string }; can: PeopleCan; onDone: () => void; onSkip: () => void }) {
  const state =
    step.status === 'DONE' ? (
      <span className="fw-pp-sub">
        {step.doneBy?.kind === 'SYSTEM' || !step.doneBy?.name ? t('step.doneAuto', { at: step.doneAt ? formatDateTime(step.doneAt, place) : '—' }) : t('step.doneBy', { name: step.doneBy.name, at: step.doneAt ? formatDateTime(step.doneAt, place) : '—' })}
      </span>
    ) : step.status === 'SKIPPED' ? (
      <span className="fw-pp-sub">{t('step.skipped', { reason: step.skipReason ?? '—' })}</span>
    ) : step.automatic ? (
      <span className="fw-pp-sub">{step.dueOn ? t('step.autoDue', { day: formatDate(`${step.dueOn}T12:00:00Z`, place) }) : t('step.auto')}</span>
    ) : (
      <span className="fw-pp-sub">{step.dueOn ? t('step.due', { day: formatDate(`${step.dueOn}T12:00:00Z`, place) }) : t('step.open')}</span>
    )
  const held = !can.manageLeavers ? t('held.noManageLeavers') : null
  return (
    <li className="fw-pp-step">
      <span className="fw-pp-cell">
        <span className="fw-pp-step-name">
          {step.status === 'DONE' ? <Check size={14} className="fw-pp-success" aria-hidden /> : step.status === 'SKIPPED' ? <SkipForward size={14} aria-hidden /> : <CircleDashed size={14} aria-hidden />}
          <span>{t(`step.${step.kind}`)}</span>
          <span className="nds-vh">{t(`stepStatus.${step.status}`)}</span>
        </span>
        {state}
      </span>
      <span className="fw-pp-actions">
        {href && (
          <Button size="sm" variant="quiet" asChild>
            <Link href={href}>
              {t('step.where')} <ExternalLink size={12} aria-hidden />
            </Link>
          </Button>
        )}
        {step.status === 'OPEN' && !step.automatic && (
          <>
            <Button size="sm" heldReason={held} onClick={onDone}>
              {t('step.markDone')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={held} onClick={onSkip}>
              {t('step.skip')}
            </Button>
          </>
        )}
      </span>
    </li>
  )
}
