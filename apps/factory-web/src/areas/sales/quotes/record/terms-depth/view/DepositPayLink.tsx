'use client'

import { CreditCard } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { Words } from '../../lines-depth/model'
import { useDepthWords } from '../../lines-depth/words'

export interface DepositPayLinkModel {
  /** The deposit request asked at acceptance, or null (none yet). */
  deposit: { id: string; status: 'OPEN' | 'PAID' | 'WAIVED' | 'CANCELLED' } | null
  /** The person records payments (the page is sent by whoever may record what it collects). */
  mayRecord: boolean
  /** The contact it goes to (the quote's), or null. */
  to: string | null
  confirm: boolean
  sending: boolean
  sent: { to: string; expiresAt: string; delivery: 'sent' | 'failed' | 'retry' | 'settled' | 'replayed' } | null
  problem: Words | null
}

export interface DepositPayLinkActions {
  onConfirm?: (open: boolean) => void
  onSend?: () => void
}

/**
 * Documents › Deposit request › Pay online link (design quote.docs.deposit, W2b; Links › Pay online of B-W2b-199): mails the
 * deposit's payment page — bank transfer, card or SEPA Direct Debit on the FAKE provider until the Owner's go-live — to
 * the quote's contact (W1's POST /payments/deposit-requests/:id/link; an older live page of that address stops). Held
 * without the right to record payments, and once the deposit is no longer open.
 */
export function DepositPayLink({ model, actions }: { model: DepositPayLinkModel; actions?: DepositPayLinkActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  if (!model.deposit) return null
  const held = !model.mayRecord ? t('pay.held.right') : model.deposit.status !== 'OPEN' ? t('pay.held.notOpen') : model.sending ? t('pay.sending') : null
  return (
    <div className="fw-qd-pay">
      <div className="fw-qd-actions">
        <Button size="sm" heldReason={held} onClick={() => actions?.onConfirm?.(true)}>
          <CreditCard size={14} aria-hidden /> {t('pay.send')}
        </Button>
        <span className="fw-q-hint">{t('pay.hint')}</span>
      </div>
      {model.sent && <Banner tone={model.sent.delivery === 'failed' ? 'danger' : 'success'} title={t(model.sent.delivery === 'failed' ? 'pay.failed' : 'pay.sent', { to: model.sent.to, until: formatDateTime(model.sent.expiresAt, { locale }) })} />}
      {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      {model.confirm && (
        <Modal
          open
          size="sm"
          onClose={() => actions?.onConfirm?.(false)}
          title={t('pay.confirmTitle')}
          footer={
            <>
              <Button onClick={() => actions?.onConfirm?.(false)}>{t('pay.keep')}</Button>
              <Button variant="primary" heldReason={held} onClick={() => actions?.onSend?.()}>
                {t('pay.sendGo')}
              </Button>
            </>
          }
        >
          <p className="fw-q-hint">{model.to ? t('pay.confirmBody', { to: model.to }) : t('pay.confirmBodyNoContact')}</p>
        </Modal>
      )}
    </div>
  )
}
