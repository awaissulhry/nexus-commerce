'use client'

import { useState } from 'react'
import { DateField, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Milestone, Order } from '../../../api'
import { dayInstant, type Phrase } from '../../../model'
import { Frame } from '../../view/Dialogs'
import { dayProblem, stepVerbs, type StepAbilities } from '../model'

/** The schedule card's verbs' view model (OrderRecord holds it; the card draws it and fetches nothing). */
export interface ScheduleStepsModel {
  can: StepAbilities
  /** "Open for payment" of a step without a day: the dialog asks one. */
  opening: Milestone | null
  busy: boolean
  problem: Phrase | null
}

export interface ScheduleStepsActions {
  onOpen?: (step: Milestone | null) => void
  onConfirmOpen?: (step: Milestone, dueDate: string | null) => void
  onInvoice?: (step: Milestone) => void
}

/**
 * A schedule step's verbs (B-W2a-80, B-W2a-F2's note): "Open for payment" on a before-shipping step without its request
 * (its request is then paid like the deposit, its TD02 at payment), "Invoice this step" on a deposit or before-shipping
 * step with its request (the TD02 draft of what is paid and not invoiced; the API says in words when nothing waits).
 */
export function StepVerbs({ step, order, model, actions }: { step: Milestone; order: Order; model: ScheduleStepsModel; actions?: ScheduleStepsActions }) {
  const t = useT('orders')
  const verbs = stepVerbs(step, order, model.can)
  if (verbs.length === 0) return null
  return (
    <span className="fw-so-inline">
      {verbs.map((verb) => (
        <Button
          key={verb.kind}
          size="sm"
          variant="link"
          heldReason={verb.held ? t(verb.held.key, verb.held.params) : model.busy ? t('schedule.verbs.held.busy') : null}
          onClick={() => (verb.kind === 'open' ? (verb.needsDay ? actions?.onOpen?.(step) : actions?.onConfirmOpen?.(step, null)) : actions?.onInvoice?.(step))}
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
