'use client'

import { CheckCircle2, Copy } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { LinkDeposit } from '../api'
import { groupedIban, type DepositPayActions, type DepositPayViewModel } from '../model'
import '../deposit-pay.css'

export type { DepositPayViewModel, DepositPayActions } from '../model'

/**
 * SCR-199 — the deposit by bank transfer (design links.pay, its W1 part through the DEPOSIT_INFO purpose; 00 §2.9 one-off
 * link page): the link frame (the sender, the language, whom to ask, the privacy notice) around ONE task — what you pay
 * (the deposit, for which quote and order, the amount, the due date, what is paid) and the bank transfer (beneficiary,
 * IBAN, the reference to write, the amount — each with Copy; "Production starts when the deposit is received"). A paid
 * deposit says thank you. Card payment is W2b. The party's own price only.
 */
export function DepositPayView({ model, actions }: { model: DepositPayViewModel; actions?: DepositPayActions }) {
  return (
    <WithMessages namespaces={['deposit-link']}>
      <DepositPay model={model} actions={actions} />
    </WithMessages>
  )
}

const day = (value: string, locale: 'it' | 'en', timeZone?: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone })

function DepositPay({ model, actions }: { model: DepositPayViewModel; actions?: DepositPayActions }) {
  const t = useT('deposit-link')
  const deposit = model.deposit
  const sender = deposit ? (deposit.from.tradeName ?? deposit.from.legalName) : null
  const valid = model.link === 'valid' && deposit !== null
  return (
    <LinkFrameView
      model={{
        sender: sender ? { name: sender, companyId: null } : null,
        title: deposit ? (deposit.order ? t('title', { order: deposit.order.number }) : t('titleQuote', { quote: deposit.quote?.document ?? '' })) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link === 'valid' ? 'loading' : model.link, purpose: 'DEPOSIT_INFO', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && <DepositBody deposit={deposit} model={model} actions={actions} />}
    </LinkFrameView>
  )
}

function DepositBody({ deposit, model, actions }: { deposit: LinkDeposit; model: DepositPayViewModel; actions?: DepositPayActions }) {
  const t = useT('deposit-link')
  const locale = useLocale()
  const money = (minor: number | undefined, currency: string) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency }))
  const pct = (value: string) => formatNumber(Number(value) / 100, locale, { style: 'percent', maximumFractionDigits: 2 })
  const { instructions } = deposit
  const bank = instructions.bank
  const kind = deposit.deposit.kind === 'CAPARRA' ? t('kind.CAPARRA') : t('kind.ACCONTO')
  const copyable = (label: string, value: string, shown = value) => ({
    label,
    value: (
      <span className="fw-dp-copy">
        <span className="fw-dp-mono">{shown}</span>
        <Button size="sm" variant="quiet" aria-label={t('copy', { what: label })} onClick={() => actions?.onCopy?.(label, value)}>
          <Copy size={14} aria-hidden /> {t('copyShort')}
        </Button>
      </span>
    ),
  })

  if (deposit.deposit.paid) {
    return (
      <Card padded className="fw-dp-card" role="status">
        <h2 className="fw-dp-h2">
          <CheckCircle2 size={20} aria-hidden /> {t('paid.title')}
        </h2>
        <p className="fw-dp-hint">{t('paid.body', { amount: money(deposit.deposit.amount, deposit.deposit.currency) })}</p>
      </Card>
    )
  }

  return (
    <>
      <Card padded className="fw-dp-card">
        <div className="fw-dp-h2">
          {t('what.title')} <Pill tone="warning">{t('what.toPay')}</Pill>
        </div>
        <p className="fw-dp-total">{money(instructions.amount, instructions.currency)}</p>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            // B-W2b-16: an order typed without a quote names only the order.
            { label: t('what.for'), value: deposit.order ? (deposit.quote ? t('what.forOrder', { order: deposit.order.number, quote: deposit.quote.document }) : t('what.forOrderOnly', { order: deposit.order.number })) : (deposit.quote?.document ?? '—') },
            { label: t('what.kind'), value: deposit.deposit.depositPct ? t('what.kindPct', { kind, pct: pct(deposit.deposit.depositPct) }) : kind },
            { label: t('what.due'), value: day(instructions.dueDate, locale, model.timeZone) },
          ]}
        />
      </Card>
      <Card padded className="fw-dp-card">
        <h2 className="fw-dp-h2">{t('bank.title')}</h2>
        {bank ? (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              copyable(t('bank.holder'), bank.accountHolder),
              copyable(t('bank.iban'), bank.iban.replace(/\s+/g, ''), groupedIban(bank.iban)),
              ...(bank.bic ? [copyable(t('bank.bic'), bank.bic)] : []),
              ...(bank.bankName ? [{ label: t('bank.bank'), value: bank.bankName }] : []),
              copyable(t('bank.reference'), instructions.reference),
              copyable(t('bank.amount'), (instructions.amount === undefined ? '' : (instructions.amount / 100).toFixed(2)), money(instructions.amount, instructions.currency)),
            ]}
          />
        ) : (
          <Banner tone="info" title={t('bank.none')} />
        )}
        {model.copied && (
          <p className="fw-dp-hint" role="status">
            {t('copied', { what: model.copied })}
          </p>
        )}
        <p className="fw-dp-hint">{t('bank.production')}</p>
      </Card>
    </>
  )
}
