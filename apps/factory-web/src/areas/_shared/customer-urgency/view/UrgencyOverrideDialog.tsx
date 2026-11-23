'use client'

import { useState } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { CARD_LIMITS, urgencyDialogHeld, type Phrase, type UrgencyAct, type UrgencyOverrideActions, type UrgencyOverrideModel } from '../model'
import '../../../production/_shared/production.css'

const say = (t: ReturnType<typeof useT>, words: Phrase | null): string | null => (words ? t(words.key, words.params) : null)

/**
 * F-CW-302 — the urgency window, MOVED as it is from the work order's Customer card (F-PR-05b), which mounts it as before; the ONE
 * Orders sheet mounts the same one (its row ⋯ and More ▾). Set to regular… · Lock · Unlock: the order named, a reason the customer
 * reads (not for Unlock), a fresh code; no second person. Words: `production` (`customerCard.dialog.*`) — the host provides that
 * catalogue. Draws its model; the hook (use-urgency-override.ts) writes.
 */
export function UrgencyOverrideDialog({ model, actions }: { model: UrgencyOverrideModel; actions?: UrgencyOverrideActions }) {
  const t = useT('production')
  const dialog = model.dialog!
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const [lock, setLock] = useState(dialog.act === 'lock' || !!model.draft?.lock)
  const held = urgencyDialogHeld(dialog.act, reason, model.busy)
  const act: UrgencyAct = dialog.act === 'regular' && lock ? 'lock' : dialog.act
  const go = held ? null : () => actions?.onUrgency?.({ act: dialog.act, partyId: dialog.partyId, orders: dialog.orders, reason, lock })
  const numbers = dialog.orders.map((order) => (order.customerRef ? t('customerCard.po', { po: order.customerRef, number: order.number }) : order.number)).join(', ')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`customerCard.dialog.title.${dialog.act}`, { numbers })}
      size="md"
      footer={
        <span className="fw-pr-actions">
          <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : act === 'unlock' ? <Unlock size={13} aria-hidden /> : act === 'lock' ? <Lock size={13} aria-hidden /> : null} {t(`customerCard.dialog.go.${act}`)}
          </Button>
        </span>
      }
    >
      {/* F-PR-16: no form element — Enter in the reason field sends nothing; the send button and ⌘↵ send. */}
      <div
        className="fw-pr-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
            event.preventDefault()
            go()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <p>{t(`customerCard.dialog.body.${act}`)}</p>
        {dialog.act !== 'unlock' && (
          <>
            <Field label={t('customerCard.dialog.reason')} hint={t('customerCard.dialog.reasonHint', { count: CARD_LIMITS.reason })}>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={CARD_LIMITS.reason} autoFocus />
            </Field>
            {dialog.act === 'regular' && <Checkbox checked={lock} onChange={(event) => setLock(event.target.checked)} label={t('customerCard.dialog.alsoLock')} />}
          </>
        )}
        <p className="fw-pr-hint">{t('customerCard.dialog.stepUp')}</p>
      </div>
    </Modal>
  )
}
