'use client'

import { Copy } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { PaymentPanel } from '@nexus/ui/components/PaymentPanel/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { LinkQuote } from '../api'
import { groupedIban } from '../model'

const day = (value: string, locale: 'it' | 'en', timeZone?: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone })

/**
 * SCR-099's Deposit (design links.quote sec:deposit; SAL-195, FIN-066; B-W2b-199): how to pay the deposit, in the accepted
 * end state — the bank transfer (beneficiary, IBAN, BIC, reference, amount, due date, each with Copy; W1), "Production
 * starts when the deposit is received", and Pay by card or SEPA (the DS PaymentPanel of links.pay). The accept used the
 * link (one use), so this page has no session left to start a payment with: the panel is held with the reason in words
 * (the deposit's own payment page, SCR-199, takes card and SEPA; the API gap is named in the step's notes). A deposit
 * received says so; one that no longer asks says so. The party's own price only.
 */
export function QuoteDeposit({ quote, timeZone, onCopy }: { quote: LinkQuote; timeZone?: string; onCopy?: (text: string) => void }) {
  return (
    <WithMessages namespaces={['link-pay']}>
      <Deposit quote={quote} timeZone={timeZone} onCopy={onCopy} />
    </WithMessages>
  )
}

function Deposit({ quote, timeZone, onCopy }: { quote: LinkQuote; timeZone?: string; onCopy?: (text: string) => void }) {
  const t = useT('quote-link')
  const pay = useT('link-pay')
  const locale = useLocale()
  const ds = useDsWords()
  const deposit = quote.deposit
  if (!deposit) return null
  const instructions = deposit.instructions
  const bank = instructions.bank
  const sender = quote.quote.seller.tradeName ?? quote.quote.seller.legalName
  const money = (minor: number | undefined, currency: string) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency }))
  const copyable = (label: string, value: string, shown = value) => ({
    label,
    value: (
      <span className="fw-qa-copy">
        <span className="fw-qa-mono">{shown}</span>
        <Button size="sm" variant="quiet" aria-label={t('deposit.copy', { what: label })} onClick={() => onCopy?.(value)}>
          <Copy size={14} aria-hidden /> {t('deposit.copyShort')}
        </Button>
      </span>
    ),
  })
  return (
    <section className="fw-qa-deposit" aria-labelledby="fw-qa-deposit">
      <h3 id="fw-qa-deposit" className="fw-qa-h3">
        {t('deposit.title')}
      </h3>
      {deposit.status === 'PAID' ? (
        <p className="fw-qa-hint" role="status">
          {pay('quoteCard.paid')}
        </p>
      ) : deposit.status !== 'OPEN' ? (
        <p className="fw-qa-hint">{pay('quoteCard.closed')}</p>
      ) : (
        <>
          {bank ? (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                copyable(t('deposit.holder'), bank.accountHolder),
                copyable(t('deposit.iban'), bank.iban.replace(/\s+/g, ''), groupedIban(bank.iban)),
                ...(bank.bic ? [copyable(t('deposit.bic'), bank.bic)] : []),
                ...(bank.bankName ? [{ label: t('deposit.bank'), value: bank.bankName }] : []),
                copyable(t('deposit.reference'), instructions.reference),
                { label: t('deposit.amount'), value: money(instructions.amount, instructions.currency) },
                { label: t('deposit.due'), value: day(instructions.dueDate, locale, timeZone) },
                { label: t('deposit.kind'), value: t(`depositKind.${deposit.kind}`) },
              ]}
            />
          ) : (
            <Banner tone="info" title={t('deposit.noBank')} />
          )}
          <p className="fw-qa-hint">{t('deposit.production')}</p>
          <PaymentPanel
            amount={money(instructions.amount, instructions.currency)}
            purpose={pay('quoteCard.title')}
            headingLevel={4}
            state="idle"
            heldReason={pay('quoteCard.held', { sender })}
            labels={ds.paymentPanel}
          />
        </>
      )}
    </section>
  )
}
