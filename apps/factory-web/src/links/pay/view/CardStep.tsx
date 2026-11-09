'use client'

import { Banner } from '@nexus/ui/components'
import { PaymentPanel } from '@nexus/ui/components/PaymentPanel/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { FakeScenario, PaymentMethod } from '../../../lib/payments/online'
import { cardState, fakeButtons, failureKey, type CardStepModel, type PayActions } from '../model'

/**
 * Design links.pay sec:card — Pay by card or SEPA Direct Debit: the DS PaymentPanel (RadioCards Card · SEPA Direct Debit,
 * Continue, the provider's own fields, "Waiting for your bank…", the reason it failed in our words, paid). Only the FAKE
 * provider's fields are drawn (its buttons play what a card or a bank does; never an input for card or bank data); any
 * other provider is held by the page (GATE-SPEND). Words from `link-pay` (the page wraps it).
 */
export function CardStep({ card, methods, amount, held, actions }: { card: CardStepModel; methods: readonly PaymentMethod[]; amount: string; held: string | null; actions?: PayActions }) {
  const t = useT('link-pay')
  const ds = useDsWords()
  const state = cardState(card)
  const buttons = fakeButtons(card, state)
  const sepaWaiting = state === 'waiting' && card.method === 'SEPA_DEBIT'
  const scenarioWords = (scenario: FakeScenario) =>
    scenario === 'succeed' ? (card.confirming ? t('card.scenario.confirm') : card.method === 'SEPA_DEBIT' ? t('card.scenario.sepaSucceed', { amount }) : t('card.scenario.succeed', { amount })) : t(`card.scenario.${scenario}`)
  const lead = card.confirming ? t('card.testConfirm') : sepaWaiting ? t('card.testProcessing') : t('card.testNote')
  return (
    <div className="fw-lp-cardstep">
      <PaymentPanel
        amount={amount}
        purpose={t('card.title')}
        headingLevel={2}
        providerName={t('card.testProvider')}
        methods={methods.map((method) => ({ id: method, label: t(`card.method.${method}`), description: t(`card.methodHint.${method}`) }))}
        method={card.method}
        onMethod={(id) => actions?.onMethod?.(id as PaymentMethod)}
        state={state}
        heldReason={held}
        onStart={() => actions?.onStart?.()}
        fields={
          buttons.length > 0 ? (
            <div className="fw-lp-fake">
              <p className="fw-lp-hint">{lead}</p>
              <div className="fw-lp-fake-buttons">
                {buttons.map((scenario, index) => (
                  <Button key={scenario} variant={index === 0 ? 'primary' : 'secondary'} heldReason={card.sending ? ds.paymentPanel.busy : null} onClick={() => actions?.onScenario?.(scenario)}>
                    {scenarioWords(scenario)}
                  </Button>
                ))}
              </div>
            </div>
          ) : state === 'waiting' && !card.fields ? (
            <div className="fw-lp-fake">
              <Button variant="quiet" size="sm" onClick={() => actions?.onResume?.()}>
                {t('card.testAgain')}
              </Button>
            </div>
          ) : null
        }
        failure={state === 'failed' ? t(failureKey(card.intent)) : null}
        onRetry={() => actions?.onAgain?.()}
        succeeded={state === 'succeeded' ? { words: t('card.paid') } : null}
        labels={sepaWaiting ? { ...ds.paymentPanel, waiting: t('card.sepaWaiting') } : ds.paymentPanel}
      />
      {card.resumed && state !== 'succeeded' && state !== 'failed' ? <p className="fw-lp-hint">{t('card.resumed')}</p> : null}
      {card.problem ? <Banner tone="danger" title={t(card.problem)} /> : null}
    </div>
  )
}
