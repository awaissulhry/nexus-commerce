'use client'

import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { PayPage } from '../api'
import { cardHeld, forOf, groupedIban, paidOnline, STATUS_TONE, titleOf, type PayActions, type PayViewModel } from '../model'
import { CardStep } from './CardStep'
import '../pay.css'

export type { PayViewModel, PayActions } from '../model'

/**
 * SCR-199 — Pay online (design links.pay; 00 §2.9 one-off link page; FIN-123): the link frame (the sender, the language,
 * whom to ask, the privacy notice) around ONE task — what you pay (the document, what it is for, the amount due, the due
 * date, what is paid already; the status pill), the bank transfer (W1, always: beneficiary, IBAN, reference, amount, each
 * with Copy), pay by card or SEPA Direct Debit (the DS PaymentPanel on the FAKE provider: waiting and failed in our
 * words), and Paid (the DS EndState: the receipt, what follows). A PAYMENT link (an invoice or a deposit request) and
 * W1's DEPOSIT_INFO link open it. The party's own price only; never a cost or a margin.
 */
export function PayView({ model, actions }: { model: PayViewModel; actions?: PayActions }) {
  return (
    <WithMessages namespaces={['link-pay']}>
      <Pay model={model} actions={actions} />
    </WithMessages>
  )
}

const day = (value: string, locale: 'it' | 'en', timeZone?: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone })

function useMoney() {
  const locale = useLocale()
  return (minor: number | undefined, currency: string) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency }))
}

function Pay({ model, actions }: { model: PayViewModel; actions?: PayActions }) {
  const t = useT('link-pay')
  const page = model.page
  const sender = page ? (page.from.tradeName ?? page.from.legalName) : null
  const title = page ? titleOf(page) : null
  const valid = model.link === 'valid'
  return (
    <LinkFrameView
      model={{
        sender: sender ? { name: sender } : null,
        title: title ? t(title.key, title.params) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: model.purpose, expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? <Body page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem problem={model.problem} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** The page is read: cards in the shape of the page; after about a second, "Still loading…". */
function Loading() {
  const t = useT('link-pay')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-lp-stack" aria-busy="true">
      <Card padded className="fw-lp-card">
        <Skeleton width="40%" height={22} />
        <Skeleton width="30%" height={36} />
        <Skeleton width="100%" height={72} />
      </Card>
      <Card padded className="fw-lp-card">
        <Skeleton width="35%" height={22} />
        <Skeleton width="100%" height={120} />
      </Card>
      <p className="fw-lp-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

/** A failed read is never drawn as an empty page: the problem in our words and Try again. */
function ReadProblem({ problem, actions }: { problem: string; actions?: PayActions }) {
  const t = useT('link-pay')
  return (
    <Banner
      tone="danger"
      title={t(problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('problem.retry')}
        </Button>
      }
    >
      {t('problem.readBody')}
    </Banner>
  )
}

function Body({ page, model, actions }: { page: PayPage; model: PayViewModel; actions?: PayActions }) {
  const money = useMoney()
  const held = cardHeld(page, model.offline === true)
  const t = useT('link-pay')
  if (page.status !== 'TO_PAY') return <Done page={page} model={model} />
  return (
    <div className="fw-lp-stack">
      <What page={page} model={model} />
      <BankTransfer page={page} model={model} actions={actions} />
      <CardStep card={model.card} methods={page.card.methods} amount={money(page.what.open, page.what.currency)} held={held ? t(held) : null} actions={actions} />
    </div>
  )
}

/** Design sec:what — the document, what it pays, the amount due big, total and already paid, the due date; the status pill. */
function What({ page, model }: { page: PayPage; model: PayViewModel }) {
  const t = useT('link-pay')
  const locale = useLocale()
  const money = useMoney()
  const what = page.what
  const pct = (value: string) => formatNumber(Number(value) / 100, locale, { style: 'percent', maximumFractionDigits: 2 })
  const kind = model.deposit && (model.deposit.kind === 'ACCONTO' || model.deposit.kind === 'CAPARRA') ? t(`kind.${model.deposit.kind}`) : null
  const document =
    what.target === 'INVOICE'
      ? what.issueDate
        ? t('what.invoiceIssued', { number: what.number ?? '', date: day(what.issueDate, locale, model.timeZone) })
        : t('what.invoice', { number: what.number ?? '' })
      : kind
        ? model.deposit?.depositPct
          ? t('kind.pct', { kind, pct: pct(model.deposit.depositPct) })
          : kind
        : t('what.depositRequest')
  const forWhat = forOf(page)
  const settled = (what.settled ?? 0) > 0
  return (
    <Card padded className="fw-lp-card">
      <h2 className="fw-lp-h2">
        {t('what.title')} <Pill tone={STATUS_TONE[page.status]}>{t(`status.${page.status}`)}</Pill>
      </h2>
      <div className="fw-lp-due">
        <span className="fw-lp-due-label">{t('what.open')}</span>
        <span className="fw-lp-total">{money(what.open, what.currency)}</span>
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('what.document'), value: document },
          ...(forWhat ? [{ label: t('what.for'), value: t(forWhat.key, forWhat.params) }] : []),
          ...(settled ? [{ label: t('what.total'), value: money(what.total, what.currency) }, { label: t('what.settled'), value: money(what.settled, what.currency) }] : []),
          ...(what.dueDate ? [{ label: t('what.due'), value: day(what.dueDate, locale, model.timeZone) }] : []),
        ]}
      />
    </Card>
  )
}

/** Design sec:bank — always there (W1): beneficiary, IBAN, BIC, bank, the reference to write, the amount, each with Copy. */
function BankTransfer({ page, model, actions }: { page: PayPage; model: PayViewModel; actions?: PayActions }) {
  const t = useT('link-pay')
  const money = useMoney()
  const transfer = page.bank
  if (!transfer) return null
  const bank = transfer.bank
  const copyable = (label: string, value: string, shown = value) => ({
    label,
    value: (
      <span className="fw-lp-copy">
        <span className="fw-lp-mono">{shown}</span>
        <Button size="sm" variant="quiet" aria-label={t('copy', { what: label })} onClick={() => actions?.onCopy?.(label, value)}>
          <Copy size={14} aria-hidden /> {t('copyShort')}
        </Button>
      </span>
    ),
  })
  const deposit = page.what.target === 'DEPOSIT_REQUEST'
  return (
    <Card padded className="fw-lp-card">
      <h2 className="fw-lp-h2">{t('bank.title')}</h2>
      {bank ? (
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            copyable(t('bank.holder'), bank.accountHolder),
            copyable(t('bank.iban'), bank.iban.replace(/\s+/g, ''), groupedIban(bank.iban)),
            ...(bank.bic ? [copyable(t('bank.bic'), bank.bic)] : []),
            ...(bank.bankName ? [{ label: t('bank.bank'), value: bank.bankName }] : []),
            copyable(t('bank.reference'), transfer.reference),
            copyable(t('bank.amount'), transfer.amount === undefined ? '' : (transfer.amount / 100).toFixed(2), money(transfer.amount, transfer.currency)),
          ]}
        />
      ) : (
        <Banner tone="info" title={deposit ? t('bank.noneDeposit') : t('bank.noneInvoice')} />
      )}
      {model.copied && (
        <p className="fw-lp-hint" role="status">
          {t('copied', { what: model.copied })}
        </p>
      )}
      {deposit && <p className="fw-lp-hint">{t('bank.production')}</p>}
    </Card>
  )
}

/** Design sec:done — Paid (the receipt of a payment made here, what follows) or nothing to pay; the DS EndState. */
function Done({ page, model }: { page: PayPage; model: PayViewModel }) {
  const t = useT('link-pay')
  const locale = useLocale()
  const money = useMoney()
  const ds = useDsWords()
  const sender = page.from.tradeName ?? page.from.legalName
  const deposit = page.what.target === 'DEPOSIT_REQUEST'
  const reference = page.what.target === 'INVOICE' ? page.what.number : (page.what.orderNumber ?? page.what.quoteDocument)
  if (page.status === 'CLOSED') {
    return <EndState tone="neutral" title={t('done.closed')} body={t('done.closedBody')} contact={{ name: sender, detail: t('done.contact') }} labels={ds.endState} />
  }
  const online = paidOnline(page)
  const amount = money(online?.amount ?? page.what.total, page.what.currency)
  const next = [...(online ? [t('done.receipt')] : []), ...(deposit ? [t('done.depositInvoice')] : [])]
  return (
    <EndState
      tone="success"
      title={t('done.paid')}
      body={deposit ? t('done.paidDeposit', { amount }) : t('done.paidInvoice', { number: page.what.number ?? '' })}
      next={next.length > 0 ? next : undefined}
      facts={
        online
          ? [
              { label: t('done.amount'), value: amount },
              { label: t('done.method'), value: t(`card.method.${online.method}`) },
              ...(online.finishedAt ? [{ label: t('done.at'), value: formatDateTime(online.finishedAt, { locale, timeZone: model.timeZone }) }] : []),
              ...(online.providerRef ? [{ label: t('done.reference'), value: <span className="fw-lp-mono">{online.providerRef}</span> }] : []),
            ]
          : undefined
      }
      reference={reference ? { value: reference, label: t('done.document') } : null}
      contact={{ name: sender, detail: t('done.contact') }}
      labels={ds.endState}
    />
  )
}
