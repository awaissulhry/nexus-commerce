'use client'

import { Landmark } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { PaymentPanel } from '@nexus/ui/components/PaymentPanel/index'
import { Button } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { FAKE_SCENARIOS, type FakeScenario, type FakeStage, type PayMethod } from '../api'
import { dueWords, type PanelState, type PayRow } from '../model'
import { useDocumentWords } from '../words'

/**
 * pop:pay (design portal.customer.documents "Pay invoice FT-2026-0310": amount, due, PaymentPanel; the button "Pay 1,240.00
 * EUR"; Esc closes and gives the focus back to the opener; Tab stays inside): the DS PaymentPanel with card or SEPA, the
 * provider's own fields — today the FAKE provider's (nothing reaches a real payment provider: the tester says what the bank
 * answers), Stripe's own fields once the Owner says yes (GATE-SPEND) — then "Waiting for your bank…", Paid with the receipt
 * line, or why it failed in our words with Try again. The bank transfer is always there. Close waits while a step is sent.
 */

export interface PayDialogModel {
  row: Pick<PayRow, 'target' | 'number' | 'open' | 'total' | 'currency' | 'dueDate' | 'dueDateKnown' | 'daysLate'>
  today: string
  methods: readonly PayMethod[]
  method: PayMethod | null
  state: PanelState
  /** The provider's own fields are the FAKE provider's (local and test). */
  fake: boolean
  /** Which FAKE answers can be given now. */
  stage: FakeStage | null
  /** FAILED: why, a key of `portal-documents` (`failure.*`). */
  failure: string | null
  /** A refused start, a key (`refusal.*`). */
  problem: string | null
  /** The whole panel waits, in words (a preview, a role that may not pay, no connection, no online payment). */
  held: string | null
  /** The payment under way was taken up again (a reload, a second tab). */
  resumed: boolean
  /** A step is on its way: Close waits. */
  sending: boolean
}

export interface PayDialogActions {
  onMethod?: (method: PayMethod) => void
  onStart?: () => void
  onScenario?: (scenario: FakeScenario) => void
  onRetry?: () => void
  onClose?: () => void
}

export function PayDialog({ model, actions }: { model: PayDialogModel; actions?: PayDialogActions }) {
  const { t, day, money } = useDocumentWords()
  const ds = useDsWords()
  const { row } = model
  const invoice = row.target.kind === 'invoice'
  const amount = row.open !== null ? money(row.open, row.currency) : '—'
  const due = dueWords(row, model.today)
  const title = invoice ? t('pay.dialog.title', { number: row.number }) : t('pay.dialog.depositTitle', { number: row.number })
  const scenarios = model.stage ? FAKE_SCENARIOS[model.stage] : []
  const fields =
    model.fake && scenarios.length > 0 ? (
      <div className="fw-pdoc-fake">
        <p className="fw-pdoc-sub">{t(`fake.stage.${model.stage}`)}</p>
        <div className="fw-pdoc-fakebtns" role="group" aria-label={t('fake.label')}>
          {scenarios.map((scenario) => (
            <Button key={scenario} size="sm" variant={scenario === 'succeed' || scenario === 'settle' ? 'primary' : 'secondary'} heldReason={model.sending ? t('pay.dialog.sending') : null} onClick={() => actions?.onScenario?.(scenario)}>
              {t(`fake.${scenario}`)}
            </Button>
          ))}
        </div>
        <p className="fw-pdoc-sub">{t('fake.note')}</p>
      </div>
    ) : null
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onClose?.()}
      closeHeld={model.sending ? t('pay.dialog.closeHeld') : null}
      title={title}
      subtitle={t('pay.dialog.subtitle')}
      footer={
        <Button heldReason={model.sending ? t('pay.dialog.closeHeld') : null} onClick={() => actions?.onClose?.()}>
          {model.state === 'succeeded' ? t('pay.dialog.done') : t('pay.dialog.close')}
        </Button>
      }
    >
      <div className="fw-pdoc-pay">
        <KeyValue
          columns={2}
          items={[
            { label: t('pay.dialog.due'), value: day(row.dueDate), hint: due.key === 'due.overdue' ? t('due.overdue', { count: row.daysLate }) : undefined },
            // The amount is the panel's; a part already paid shows the whole beside it.
            ...(row.total !== null && row.open !== null && row.total !== row.open ? [{ label: t('pay.dialog.total'), value: money(row.total, row.currency), hint: t('pay.dialog.paidSoFar', { paid: money(row.total - row.open, row.currency) }) }] : []),
          ]}
        />
        {model.resumed && model.state !== 'succeeded' && model.state !== 'failed' ? <Banner tone="info" title={t('pay.dialog.resumed')} /> : null}
        {model.problem ? <Banner tone="warning" title={t(model.problem)} /> : null}
        <PaymentPanel
          amount={amount}
          purpose={invoice ? t('pay.dialog.purpose', { number: row.number }) : t('pay.dialog.depositPurpose', { number: row.number })}
          providerName={model.fake ? t('fake.provider') : undefined}
          methods={model.methods.map((method) => ({ id: method, label: t(`method.${method}`), description: t(`method.${method}_hint`) }))}
          method={model.method}
          onMethod={(id) => actions?.onMethod?.(id as PayMethod)}
          state={model.state}
          fields={fields}
          onStart={actions?.onStart}
          heldReason={model.held}
          failure={model.failure ? t(model.failure) : null}
          onRetry={actions?.onRetry}
          succeeded={{ words: t('pay.dialog.paid'), receipt: t('pay.dialog.receipt') }}
          labels={ds.paymentPanel}
        />
        <p className="fw-pdoc-transfer">
          <Landmark size={16} aria-hidden />
          <span>{t(invoice ? 'pay.dialog.transfer' : 'pay.dialog.transferDeposit')}</span>
        </p>
      </div>
    </Modal>
  )
}
