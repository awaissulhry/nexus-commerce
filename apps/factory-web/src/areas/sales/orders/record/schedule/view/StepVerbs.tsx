'use client'

import { useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Milestone, Order } from '../../../api'
import { dayInstant, type Phrase } from '../../../model'
import { Frame } from '../../view/Dialogs'
import type { WaiveTarget } from '../api'
import { dayProblem, stepVerbs, waiveReasonProblem, waiveVerbOf, type StepAbilities } from '../model'

/** B-W2b-16: what "Waive…" is about to waive: a step (and its request), or a request no step names. */
export interface Waiving {
  target: WaiveTarget
  /** The step's words ("Deposit 30 %"), for the title and the notice. */
  label: string
  stepKind: 'DEPOSIT' | 'BEFORE_SHIPPING'
}

/** The schedule card's verbs' view model (OrderRecord holds it; the card draws it and fetches nothing). */
export interface ScheduleStepsModel {
  can: StepAbilities
  /** "Open for payment" of a step without a day: the dialog asks one. */
  opening: Milestone | null
  /** B-W2b-16: "Waive…" open (the reason, then a fresh code). */
  waiving?: Waiving | null
  busy: boolean
  problem: Phrase | null
}

export interface ScheduleStepsActions {
  onOpen?: (step: Milestone | null) => void
  onConfirmOpen?: (step: Milestone, dueDate: string | null) => void
  onInvoice?: (step: Milestone) => void
  onWaive?: (waiving: Waiving | null) => void
  onConfirmWaive?: (waiving: Waiving, reason: string) => void
}

/**
 * A schedule step's verbs (B-W2a-80, B-W2a-F2's note): "Open for payment" on a before-shipping step without its request
 * (its request is then paid like the deposit, its TD02 at payment), "Invoice this step" on a deposit or before-shipping
 * step with its request (the TD02 draft of what is paid and not invoiced; the API says in words when nothing waits).
 */
export function StepVerbs({ step, order, model, actions }: { step: Milestone; order: Order; model: ScheduleStepsModel; actions?: ScheduleStepsActions }) {
  const t = useT('orders')
  const waive = waiveVerbOf(step, order, model.can)
  const verbs = [...stepVerbs(step, order, model.can), ...(waive ? [waive] : [])]
  if (verbs.length === 0) return null
  return (
    <span className="fw-so-inline">
      {verbs.map((verb) => (
        <Button
          key={verb.kind}
          size="sm"
          variant="link"
          heldReason={verb.held ? t(verb.held.key, verb.held.params) : model.busy ? t('schedule.verbs.held.busy') : null}
          onClick={() =>
            verb.kind === 'open'
              ? verb.needsDay
                ? actions?.onOpen?.(step)
                : actions?.onConfirmOpen?.(step, null)
              : verb.kind === 'waive'
                ? actions?.onWaive?.({ target: { kind: 'step', id: step.id, version: step.version }, label: t(`schedule.kind.${step.kind}`), stepKind: step.kind === 'DEPOSIT' ? 'DEPOSIT' : 'BEFORE_SHIPPING' })
                : actions?.onInvoice?.(step)
          }
        >
          {t(`schedule.verbs.${verb.kind}`)}
        </Button>
      ))}
    </span>
  )
}

/** "Open for payment" of a step that has no day: the day its request falls due (today or later). */
export function OpenStepDialog({ step, model, today, actions }: { step: Milestone; model: ScheduleStepsModel; today: string; actions?: ScheduleStepsActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const [day, setDay] = useState(step.dueDate ?? today)
  const problem = dayProblem(day, today)
  const held = model.busy ? t('schedule.verbs.held.busy') : problem ? t(problem) : null
  return (
    <Frame
      title={t('schedule.verbs.openTitle', { step: step.label })}
      held={held}
      go={() => actions?.onConfirmOpen?.(step, day)}
      goLabel={t('schedule.verbs.openGo', { date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatDate(dayInstant(day), { locale }) : '—' })}
      onClose={() => actions?.onOpen?.(null)}
      problem={model.problem ? t(model.problem.key, model.problem.params) : null}
      size="sm"
    >
      <p className="fw-so-hint">{t('schedule.verbs.openBody')}</p>
      <Field label={t('schedule.verbs.day')} error={problem ? t(problem) : undefined}>
        <DateField value={day} onChange={setDay} min={today} locale={INTL_LOCALE[locale]} ariaLabel={t('schedule.verbs.day')} />
      </Field>
    </Frame>
  )
}

/**
 * B-W2b-16 "Waive…" (design orders.depositRequest "Waive… (Owner)", quote.docs.deposit "Waive (Owner, reason)"): the
 * customer need not pay this advance — a waived deposit lets production start, a waived balance is billed on the goods'
 * invoice. The reason stays on the step and its request; the owner confirms with a fresh code (step-up) after Waive.
 */
export function WaiveDialog({ waiving, model, actions }: { waiving: Waiving; model: ScheduleStepsModel; actions?: ScheduleStepsActions }) {
  const t = useT('orders')
  const [reason, setReason] = useState('')
  const problem = waiveReasonProblem(reason)
  const held = model.busy ? t('schedule.verbs.held.busy') : problem ? t(problem) : null
  return (
    <Frame
      title={t('schedule.verbs.waiveTitle', { step: waiving.label })}
      held={held}
      go={() => actions?.onConfirmWaive?.(waiving, reason)}
      goLabel={model.busy ? t('common.working') : t('schedule.verbs.waiveGo')}
      tone="danger"
      onClose={() => actions?.onWaive?.(null)}
      problem={model.problem ? t(model.problem.key, model.problem.params) : null}
      size="sm"
    >
      <p className="fw-so-hint">{t(`schedule.verbs.waiveBody.${waiving.stepKind}`)}</p>
      <Field label={t('schedule.verbs.waiveReason')} hint={t('schedule.verbs.waiveHint')} required>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
      </Field>
    </Frame>
  )
}
