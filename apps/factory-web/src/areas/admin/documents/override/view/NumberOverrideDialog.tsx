'use client'

import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Field, Modal } from '@nexus/ui/components'
import { Button, Input, Spinner, Textarea } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { MAX_TYPED_NUMBER_LENGTH, NAMESPACE, overrideHeld, wellFormed, type NumberFieldActions, type OverrideDraft } from '../model'
import '../override.css'

/**
 * The popup "Type a number for a migrated document" (B-W2b-24; PLT-125; design admin.documents popup `override`, opened
 * from a record's number field by who holds numbering.override): the number as the old system printed it and why;
 * clashes are said at once (the host asks POST /numbering/override/check as the person types: `draft.check`); "Use this
 * number" is held with the reason until the number is free and the reason given. ⌘Enter uses it, Esc closes. Nothing is
 * saved here: the host sends the number with the document it makes, and the API checks it again.
 */
export function NumberOverrideDialog({ draft, actions }: { draft: OverrideDraft; actions?: NumberFieldActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <OverrideModal draft={draft} actions={actions} />
    </WithMessages>
  )
}

function OverrideModal({ draft, actions }: { draft: OverrideDraft; actions?: NumberFieldActions | undefined }) {
  const t = useT(NAMESPACE)
  const heldKey = overrideHeld(draft)
  const held = heldKey ? t(heldKey) : null
  const status = !wellFormed(draft.number) ? null : draft.check
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('override.title')}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('override.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onUse?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('override.use')}
          </Button>
        </>
      }
    >
      <div
        className="fw-no-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            // React events cross the portal: ⌘Enter here never reaches the host dialog (it would create the document).
            event.stopPropagation()
            event.preventDefault()
            if (!held) actions?.onUse?.()
          }
        }}
      >
        <p className="fw-no-body">{t('override.body')}</p>
        <Field label={t('override.number')} required hint={t('override.numberHint')}>
          <Input size="sm" value={draft.number} maxLength={MAX_TYPED_NUMBER_LENGTH + 20} onChange={(event) => actions?.onNumber?.(event.target.value)} autoFocus spellCheck={false} autoComplete="off" />
        </Field>
        <p className="fw-no-status" role="status" aria-live="polite" data-state={status ?? 'none'}>
          {status === 'checking' && (
            <>
              <Spinner size={12} /> {t('override.checking')}
            </>
          )}
          {status === 'ok' && (
            <>
              <CheckCircle2 size={14} aria-hidden /> {t('override.ok')}
            </>
          )}
          {status === 'refused' && (
            <>
              <CircleAlert size={14} aria-hidden /> {t(`override.refusal.${draft.refusal ?? 'taken'}`)}
            </>
          )}
          {status === 'failed' && (
            <>
              <CircleAlert size={14} aria-hidden /> {t('override.failed')}
            </>
          )}
          {draft.number.trim() !== '' && !wellFormed(draft.number) && (
            <>
              <CircleAlert size={14} aria-hidden /> {t('override.refusal.shape')}
            </>
          )}
        </p>
        <Field label={t('override.reason')} required hint={t('override.reasonHint')}>
          <Textarea className="fw-no-reason" value={draft.reason} maxLength={500} rows={3} onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
