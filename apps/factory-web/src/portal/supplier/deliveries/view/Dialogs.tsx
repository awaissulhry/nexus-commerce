'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { MAX_NOTE, type CancelTarget, type Problem } from '../model'
import { useDeliveryWords } from '../words'

/**
 * SCR-227 › pop:cancel-asn "Cancel this ship notice?" (design: from the notice's ⋯ before receipt; "The lines become open
 * again."; primary "Cancel ship notice"). The DS Modal: Esc closes and gives the focus back to the opener, Tab stays inside.
 * A SENT notice asks why (our dock reads it: the API refuses a cancel without a reason), so this is the Modal with one field
 * and not the DS ActionConfirm, which holds no field; a draft is discarded with nothing to say.
 */

export interface CancelModel {
  target: CancelTarget
  reason: string
  busy: boolean
  /** Why the cancel waits (a key), or null. */
  heldReason: string | null
  problem: Problem | null
}

export interface CancelActions {
  onReason?: (reason: string) => void
  onConfirm?: () => void
  onClose?: () => void
}

export function CancelDialog({ model, actions }: { model: CancelModel; actions?: CancelActions }) {
  const { t } = useDeliveryWords()
  const draft = model.target.status === 'DRAFT'
  const name = model.target.number ?? t('row.draft')
  const fieldError = model.reason.trim().length > MAX_NOTE ? t('terms.problem.long2000') : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={draft ? t('cancel.titleDraft') : t('cancel.title')}
      subtitle={t('cancel.subject', { notice: name, order: model.target.orderNumber })}
      footer={
        <>
          <Button data-autofocus onClick={() => actions?.onClose?.()}>
            {t('cancel.keep')}
          </Button>
          <Button variant="danger" heldReason={model.heldReason ? t(model.heldReason) : null} onClick={() => actions?.onConfirm?.()}>
            {model.busy ? t('state.saving') : draft ? t('cancel.discard') : t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-psn-stack">
        <ul className="fw-psn-list">
          {draft ? <li>{t('cancel.whatDraft')}</li> : <li>{t('cancel.what')}</li>}
          {draft ? null : <li>{t('cancel.dock')}</li>}
          <li>{draft ? t('cancel.againDraft') : t('cancel.again')}</li>
        </ul>
        {draft ? null : (
          <Field label={t('cancel.reason')} required hint={t('cancel.reasonHint')} error={fieldError}>
            <Textarea value={model.reason} rows={3} maxLength={MAX_NOTE} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
        )}
        {model.problem ? <Banner tone="danger" title={t(`problem.${model.problem}`)} /> : null}
      </div>
    </Modal>
  )
}
