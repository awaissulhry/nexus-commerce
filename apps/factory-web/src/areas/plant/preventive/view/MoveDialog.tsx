'use client'

import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { atField, machineText, moveDays, moveHeld, typeLabel } from '../model'
import type { MoveState, PreventivePageActions, PreventivePageModel } from '../view-model'
import { problemText, useDay, useWords } from './parts'

/**
 * Move a check (design pop:reschedule; a drag of a due check onto a day, `m` in the Plan window) and Move N (the lists'
 * bulk action): the new date and why (the audit row keeps the reason; the reminder goes again for the new date). Held
 * before the plan's first due date or on the day it has already, each said. Move N moves each plan at the version read
 * when the dialog opened and says which it left. Esc closes; the focus goes back to the opener.
 */
export function MoveDialog({ model, state, actions }: { model: PreventivePageModel; state: MoveState; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const plans = state.plans.status === 'ready' ? state.plans.value : []
  const held = !model.can.manage ? 'held.manage' : state.plans.status === 'error' ? state.plans.problem : moveHeld(state.draft, plans, state.busy)
  const close = () => (state.bulk ? actions?.onMoveMany?.(null) : actions?.onAddress?.({ move: null, date: null }))
  const one = plans.length === 1 ? plans[0]! : null
  const shift = one ? moveDays(one.nextDueOn, state.draft.nextDueOn) : 0
  const error = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }

  return (
    <Modal
      open
      onClose={close}
      title={state.bulk ? t('move.manyTitle', { count: plans.length }) : t('move.title')}
      subtitle={one ? `${typeLabel(one.checkType, locale)} · ${machineText(one.machine)}` : undefined}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMove?.()}>
            {state.busy ? <Spinner size={14} /> : null} {state.bulk ? t('move.many', { count: plans.length }) : t('move.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-form">
        {state.plans.status === 'loading' && <p className="fw-pv-muted">{t('common.reading')}</p>}
        {state.plans.status === 'error' && <Banner tone="danger" title={t(state.plans.problem)} />}
        {one && <p className="fw-pv-muted">{t('move.now', { date: day(one.nextDueOn), first: day(one.firstDueOn) })}</p>}
        {state.bulk && plans.length > 0 && (
          <SummaryTable
            stackOnPhone
            label={t('move.manyTitle', { count: plans.length })}
            columns={[t('col.check'), t('col.machine'), t('col.nextDue')]}
            rows={plans.map((plan) => ({ id: plan.id, cells: [typeLabel(plan.checkType, locale), plan.machine.assetNumber, day(plan.nextDueOn)] }))}
          />
        )}
        <Field label={t('move.date')} required hint={one && shift !== 0 ? t(shift > 0 ? 'move.later' : 'move.earlier', { count: Math.abs(shift) }) : t('move.dateHint')} error={error('nextDueOn')}>
          <DateField value={state.draft.nextDueOn} onChange={(nextDueOn) => actions?.onMoveDraft?.({ ...state.draft, nextDueOn })} ariaLabel={t('move.date')} />
        </Field>
        <Field label={t('move.reason')} required hint={t('move.reasonHint')} error={error('reason')}>
          <Textarea value={state.draft.reason} rows={3} onChange={(event) => actions?.onMoveDraft?.({ ...state.draft, reason: event.target.value })} />
        </Field>
        {state.problem && !state.problem.field && <Banner tone="danger" title={problemText(t, state.problem)} />}
      </div>
    </Modal>
  )
}
