'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import { NOTE_MAX, noteHeldOf, noteProblem } from '../overview/facts'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { DialogProblem, Frame } from './Dialogs'

/**
 * F-OO-210 (order overview 11-design §7.3; Owner D4) — the office note of the order: only the office reads it, the customer never
 * does. Saved by the Orders sheet's own write (its cell: the same command, the order's version; use-overview-acts), so the sheet and
 * this page never disagree. Its limit is the cell's (counted, Save held over it). A refusal is said here in the page's words — someone
 * changed the order first (it is read again), closed or cancelled, the sales right — and what was typed stays. Fetches nothing.
 */
export function OrderNoteDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const current = order.internalNote ?? null
  const [note, setNote] = useState(model.draft?.message ?? current ?? '')
  const refused = model.dialog?.kind === 'note' ? (model.dialog.refused ?? null) : null
  const rule = noteHeldOf(order, model.can, model.busy)
  const problem = noteProblem(note, current)
  const held = rule ? t(rule.key, rule.params) : problem ? t(problem.key, problem.params) : null
  return (
    <Frame
      title={t('facts.note.title', { number: order.number })}
      held={held}
      go={() => actions?.onNoteSave?.(note)}
      goLabel={model.busy ? t('common.working') : t('facts.note.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={t(refused.key, refused.params)} /> : <DialogProblem model={model} />}
    >
      <p className="fw-so-hint">{t('facts.note.hint')}</p>
      <Field label={t('facts.note.label')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} limit={NOTE_MAX} />
      </Field>
    </Frame>
  )
}
