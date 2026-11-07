'use client'

import { CalendarCheck } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { HEALTH_LIMITS } from '@nexus/factory-domain/safety/health/rules'
import { DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { bookHeld } from '../model'
import type { BookDialogState, HealthPageActions, HealthPageModel } from '../view-model'
import { say, useWhen, useWords } from './parts'

/**
 * design pop:booked — Mark booked (bulk over the chosen open visits): the day of the visit (today or later) and the place. The
 * button counts and says the day: "Mark 6 booked for 14 Nov". Esc closes; the focus returns to the opener.
 */
export function BookDialog({ model, state, actions }: { model: HealthPageModel; state: BookDialogState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const rows = model.due?.status === 'ready' ? model.due.value.rows.filter((row) => state.ids.includes(row.id)) : []
  const held = say(t, bookHeld(rows, state.draft, model.today))
  const set = (change: Partial<typeof state.draft>) => actions?.onBookDraft?.({ ...state.draft, ...change })
  const at = (field: string) => (state.problem?.field === field ? t(state.problem.key) : undefined)
  const label = state.draft.on ? t('book.saveOn', { count: rows.length, day: when.day(state.draft.on) }) : t('book.save', { count: rows.length })
  return (
    <Modal
      open
      onClose={() => actions?.onBookClose?.()}
      title={t('book.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onBookClose?.()}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={state.busy ? t('held.saving') : held} onClick={() => actions?.onBookSave?.()}>
            {state.busy ? <Spinner size={12} /> : <CalendarCheck size={14} aria-hidden />} {label}
          </Button>
        </>
      }
    >
      <div className="fw-hv-form">
        {state.problem && !state.problem.field && <Banner tone="danger" title={t('book.refused')}>{t(state.problem.key)}</Banner>}
        <p className="fw-hv-muted">{t('book.body', { count: rows.length })}</p>
        <div className="fw-hv-form-row">
          <Field label={t('book.day')} required error={at('bookedOn')}>
            <DateField value={state.draft.on} min={model.today} onChange={(value) => set({ on: value })} ariaLabel={t('book.day')} />
          </Field>
          <Field label={t('book.place')} hint={t('book.placeHint', { most: HEALTH_LIMITS.bookedPlace })} error={at('bookedPlace')}>
            <Input value={state.draft.place} maxLength={HEALTH_LIMITS.bookedPlace} onChange={(event) => set({ place: event.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
