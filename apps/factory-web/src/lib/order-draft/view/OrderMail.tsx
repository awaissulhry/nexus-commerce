'use client'

import { Info } from 'lucide-react'
import { Card, Field } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { Textarea } from '../../i18n/ds-parts'
import { SUBJECT_MAX, type HeaderDraft, type HeaderField } from '../model'
import { useDraftWords } from '../words'
import { FilesBox, type FilesBoxActions, type FilesBoxModel } from './files'

/**
 * The mail (od-w1.2, R2; 10-design-r1 § 2): the start and the draft's top are the SAME part — Subject · Message · Attachments, nothing
 * required (no star, no Start button). The first input makes the draft (the host creates it with what was typed); every later input
 * saves on leaving the field. The office says "The customer's message" and that office notes go in the thread. A file may be marked
 * "Logo"; a measurement sheet goes on its product's row (the row's files).
 */

export interface OrderMailModel {
  /** Before the first save: "Nothing is required…" above the fields. */
  start: boolean
  header: Pick<HeaderDraft, 'subject' | 'note'>
  /** Field → a key of the part's words. */
  headerErrors: Partial<Record<HeaderField, string>>
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  attachments: FilesBoxModel
}

export interface OrderMailActions {
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  files?: FilesBoxActions
}

export function OrderMail({ model, actions }: { model: OrderMailModel; actions?: OrderMailActions }) {
  const { t, door } = useDraftWords()
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  const held = model.writeHeld !== null
  return (
    <Card padded>
      <section className="fw-od-section fw-od-mail" aria-label={t('mail.subject')}>
        {model.start ? (
          <p className="fw-od-quiet">
            <Info size={14} aria-hidden /> {t('mail.nothing')}
          </p>
        ) : null}
        <Field label={t('mail.subject')} error={error('subject')}>
          <Input value={model.header.subject} maxLength={SUBJECT_MAX} disabled={held} onChange={(event) => actions?.onHeader?.('subject', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('subject')} />
        </Field>
        <Field label={t('mail.message')} hint={door === 'office' ? t('mail.messageHint') : undefined} error={error('note')}>
          <Textarea value={model.header.note} rows={4} honourRows maxLength={4000} disabled={held} onChange={(event) => actions?.onHeader?.('note', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('note')} />
        </Field>
        <div className="fw-od-stack" role="group" aria-labelledby="od-mail-attachments">
          <span id="od-mail-attachments" className="fw-od-label">
            {t('mail.attachments')}
          </span>
          <FilesBox model={model.attachments} actions={actions?.files} logo />
          <p className="fw-od-quiet">{t('mail.attHint')}</p>
        </div>
      </section>
    </Card>
  )
}
