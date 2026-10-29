'use client'

import { useState } from 'react'
import { CheckCircle2, Copy } from 'lucide-react'
import { Banner, Card, Disclosure, Field, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { LinkQuote } from '../api'
import { answerOf, DECLINE_REASONS, groupedIban, privacyCompany, type DeclineReason, type QuoteAcceptActions, type QuoteAcceptViewModel } from '../model'
import '../quote-accept.css'

export type { QuoteAcceptViewModel, QuoteAcceptActions } from '../model'

/**
 * SCR-099 — Accept a quote (design links.quote; 00 §2.9 one-off link page): the link frame (the sender, the language,
 * whom to ask, the privacy notice) around ONE task — the offer (total VAT included first for a consumer, delivery,
 * payment, the deposit asked), what is in it, the exact PDF with its document code, the terms, then the SignBlock
 * (typed name, the email when the link asks it, the no-withdrawal statement when the law asks it; Accept held with its
 * reason, never disabled) and Decline. The end state says what happens next and how to pay the deposit by bank transfer
 * (each field with Copy). The expired, replaced, withdrawn states offer "Ask for a new link". No cost or margin, ever.
 */
export function QuoteAcceptView({ model, actions }: { model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  return (
    <WithMessages namespaces={['quote-link']}>
      <QuoteAccept model={model} actions={actions} />
    </WithMessages>
  )
}

const day = (value: string, locale: 'it' | 'en', timeZone?: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone })

function QuoteAccept({ model, actions }: { model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-link')
  const quote = model.quote
  const seller = quote ? (quote.quote.seller.tradeName ?? quote.quote.seller.legalName) : null
  const title = quote ? t('title', { number: quote.quote.quoteNumber, revision: quote.quote.revision }) : null
  const valid = model.link === 'valid' && quote !== null
  return (
    <LinkFrameView
      model={{
        sender: seller ? { name: seller, companyId: quote ? privacyCompany(quote.privacy.url) : null } : null,
        title,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link === 'valid' ? 'loading' : model.link, purpose: 'QUOTE_ACCEPT', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && <QuoteBody quote={quote} model={model} actions={actions} />}
    </LinkFrameView>
  )
}

function QuoteBody({ quote, model, actions }: { quote: LinkQuote; model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-link')
  const shell = useT('shell')
  const locale = useLocale()
  const q = quote.quote
  const seller = q.seller.tradeName ?? q.seller.legalName
  const money = (minor: number | undefined) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency: q.currency }))
  const price = (value: string | undefined) => (value === undefined ? '—' : formatNumber(Number(value), locale, { style: 'currency', currency: q.currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }))
  const pct = (value: string) => formatNumber(Number(value) / 100, locale, { style: 'percent', maximumFractionDigits: 2 })
  const consumer = q.priceBasis === 'GROSS'
  const accept = answerOf(quote, 'accept')
  const decline = answerOf(quote, 'decline')
  const deposit = q.deposit
  const state = quote.state

  return (
    <>
      <StateBanner quote={quote} model={model} actions={actions} />

      <Card padded className="fw-qa-card">
        <h2 className="fw-qa-h2">{t('offer.title')}</h2>
        <p className="fw-qa-total">
          <span className="fw-qa-total-label">{t(consumer ? 'offer.totalVatIncluded' : 'offer.total')}</span>
          <span className="fw-qa-total-value">{money(q.totals?.gross)}</span>
        </p>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('offer.from'), value: seller },
            { label: t('offer.for'), value: q.billTo.legalName },
            ...(q.customerRef ? [{ label: t('offer.yourRef'), value: q.customerRef }] : []),
            { label: t('offer.version'), value: t('offer.versionValue', { revision: q.revision, date: day(q.date, locale, model.timeZone) }) },
            { label: t('offer.validUntil'), value: day(q.validUntil, locale, model.timeZone) },
            ...(q.firmOffer ? [{ label: t('offer.firm'), value: t('offer.firmValue', { date: day(q.validUntil, locale, model.timeZone) }) }] : []),
            { label: t('offer.delivery'), value: q.promiseDate ? day(q.promiseDate, locale, model.timeZone) : t('offer.deliveryLater') },
            { label: t('offer.payment'), value: q.paymentTerms ?? '—' },
            { label: t('offer.deposit'), value: deposit ? t('offer.depositValue', { pct: pct(deposit.pct), kind: t(`depositKind.${deposit.kind}`), amount: money(deposit.amount) }) : t('offer.noDeposit') },
            { label: t('offer.shipTo'), value: [q.shipTo.name, q.shipTo.line1, `${q.shipTo.postalCode} ${q.shipTo.city}`, q.shipTo.country].filter(Boolean).join(', ') },
          ]}
        />
      </Card>

      <Card padded className="fw-qa-card">
        <h2 className="fw-qa-h2">{t('lines.title')}</h2>
        <SummaryTable
          label={t('lines.title')}
          columns={[t('lines.item'), t('lines.qty'), t(consumer ? 'lines.unitGross' : 'lines.unit'), t('lines.amount')]}
          align={['left', 'right', 'right', 'right']}
          rows={q.lines.map((line) => ({
            id: String(line.seq),
            cells: [
              <span key="i" className="fw-qa-item">
                <strong>{line.description}</strong>
                <span className="fw-qa-sub">{line.sizesText}</span>
                {line.note && <span className="fw-qa-sub">{line.note}</span>}
              </span>,
              String(line.quantity),
              price(line.unitPrice),
              money(line.netAmount),
            ],
          }))}
          density="roomy"
          stackOnPhone
        />
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('lines.net'), value: money(q.totals?.net) },
            ...(q.totals?.vat ?? []).map((entry) => ({ label: entry.nature ? t('lines.vatNature', { nature: entry.nature }) : t('lines.vatRate', { rate: entry.rate ? pct(entry.rate) : '—' }), value: money(entry.vat) })),
            { label: t(consumer ? 'offer.totalVatIncluded' : 'offer.total'), value: <strong>{money(q.totals?.gross)}</strong> },
          ]}
        />
      </Card>

      <Card padded className="fw-qa-card">
        <h2 className="fw-qa-h2">{t('pdf.title')}</h2>
        {q.document && <p className="fw-qa-hint">{t('pdf.code', { code: q.document.sha256.slice(0, 12) })}</p>}
        {!q.document ? (
          <p className="fw-qa-hint">{t('pdf.none')}</p>
        ) : model.pdf.problem ? (
          <Banner tone="warning" title={t('pdf.problem')} />
        ) : model.pdf.src ? (
          <PdfViewer src={model.pdf.src} title={title(q)} fileName={q.document.name} labels={pdfViewerLabels(shell)} height="min(60vh, 640px)" />
        ) : (
          <p className="fw-qa-hint" role="status">
            <Spinner size={14} /> {t('pdf.loading')}
          </p>
        )}
      </Card>

      <Disclosure summary={t('terms.title', { version: q.terms.termsVersion })}>
        <ol className="fw-qa-terms" lang={q.language}>
          {q.terms.clauses.map((clause) => (
            <li key={clause.code}>{clause.text}</li>
          ))}
        </ol>
      </Disclosure>

      {state === 'OPEN' && accept && model.answer !== 'done' && (
        <SignBlock
          title={t('sign.title', { number: q.quoteNumber, revision: q.revision })}
          summary={<p className="fw-qa-sign-summary">{deposit ? t('sign.summaryDeposit', { number: q.quoteNumber, revision: q.revision, total: money(q.totals?.gross), deposit: money(deposit.amount) }) : t('sign.summary', { number: q.quoteNumber, revision: q.revision, total: money(q.totals?.gross) })}</p>}
          legal={
            <p className="fw-qa-hint">
              {t('sign.legal', { seller, version: q.terms.termsVersion })} {t('sign.retention')}
            </p>
          }
          acknowledgements={[{ id: 'terms', label: t('sign.ackTerms', { version: q.terms.termsVersion }) }, ...(accept.noWithdrawal ? [{ id: 'noWithdrawal', label: t('sign.ackNoWithdrawal') }] : [])]}
          acknowledgementMissingLabel={t('sign.ackMissing')}
          nameLabel={t('sign.name')}
          nameHint={t('sign.nameHint')}
          nameEmptyLabel={t('sign.nameEmpty')}
          email={accept.email ? { label: t('sign.email'), hint: t('sign.emailHint'), emptyLabel: t('sign.emailEmpty'), invalidLabel: t('sign.emailInvalid') } : undefined}
          acceptLabel={t('sign.accept')}
          onAccept={(signed) => actions?.onAccept?.({ name: signed.name, email: signed.email, noWithdrawal: signed.acknowledged.includes('noWithdrawal') })}
          declineLabel={decline ? t('sign.decline') : undefined}
          onDecline={decline ? () => actions?.onDecline?.(true) : undefined}
          state={model.answer === 'busy' ? 'busy' : 'idle'}
          busyLabel={t('sign.busy')}
          message={model.problem ? t(model.problem) : undefined}
          messageTone="danger"
        />
      )}

      {(state === 'ACCEPTED' || model.answer === 'done') && quote.acceptance && <Accepted quote={quote} model={model} actions={actions} />}

      {model.declineOpen && <DeclineDialog quote={quote} model={model} actions={actions} />}
    </>
  )
}

const title = (q: LinkQuote['quote']) => `${q.quoteNumber} v${q.revision}`

function StateBanner({ quote, model, actions }: { quote: LinkQuote; model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-link')
  const locale = useLocale()
  const q = quote.quote
  const seller = q.seller.tradeName ?? q.seller.legalName
  switch (quote.state) {
    case 'OPEN':
      return <Banner tone="info" title={t('state.OPEN.title', { date: day(q.validUntil, locale, model.timeZone) })}>{t(q.firmOffer ? 'state.OPEN.firm' : 'state.OPEN.body', { seller })}</Banner>
    case 'ACCEPTED':
      return null
    case 'DECLINED':
      return <Banner tone="neutral" title={t('state.DECLINED.title')}>{t('state.DECLINED.body', { seller })}</Banner>
    case 'CANCELLED':
      return <Banner tone="warning" title={t('state.CANCELLED.title')}>{t('state.CANCELLED.body', { seller })}</Banner>
    default:
      return (
        <Banner
          tone="warning"
          title={t(`state.${quote.state}.title`, { date: day(q.validUntil, locale, model.timeZone) })}
          action={
            model.newLinkAsked ? undefined : (
              <Button size="sm" onClick={() => actions?.onNewLink?.()}>
                {t('newLink.ask')}
              </Button>
            )
          }
        >
          {model.newLinkAsked ? t('newLink.asked', { seller }) : t(`state.${quote.state}.body`, { seller })}
        </Banner>
      )
  }
}

function Accepted({ quote, model, actions }: { quote: LinkQuote; model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-link')
  const locale = useLocale()
  const acceptance = quote.acceptance!
  const deposit = quote.deposit
  const instructions = deposit?.instructions ?? null
  const bank = instructions?.bank ?? null
  const money = (minor: number | undefined, currency: string) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency }))
  const copyable = (label: string, value: string, shown = value) => ({
    label,
    value: (
      <span className="fw-qa-copy">
        <span className="fw-qa-mono">{shown}</span>
        <Button size="sm" variant="quiet" aria-label={t('deposit.copy', { what: label })} onClick={() => actions?.onCopy?.(value)}>
          <Copy size={14} aria-hidden /> {t('deposit.copyShort')}
        </Button>
      </span>
    ),
  })
  return (
    <Card padded className="fw-qa-card fw-qa-done" role="status">
      <h2 className="fw-qa-h2">
        <CheckCircle2 size={20} aria-hidden className="fw-qa-ok" /> {t('done.title', { name: acceptance.signerName })}
      </h2>
      <p className="fw-qa-hint">{t('done.copy')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('done.name'), value: acceptance.signerName },
          { label: t('done.at'), value: formatDateTime(acceptance.acceptedAt, { locale, timeZone: model.timeZone }) },
          { label: t('done.code'), value: <span className="fw-qa-mono">{acceptance.documentSha256.slice(0, 12)}</span> },
          { label: t('done.terms'), value: acceptance.termsVersion ?? '—' },
        ]}
      />
      <h3 className="fw-qa-h3">{t('done.next')}</h3>
      <ol className="fw-qa-steps">
        {deposit && instructions && <li>{t('done.stepDeposit', { amount: money(instructions.amount, instructions.currency), date: day(instructions.dueDate, locale, model.timeZone) })}</li>}
        <li>{t('done.stepConfirm')}</li>
      </ol>
      {deposit && instructions && (
        <section className="fw-qa-deposit" aria-labelledby="fw-qa-deposit">
          <h3 id="fw-qa-deposit" className="fw-qa-h3">
            {t('deposit.title')}
          </h3>
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
                { label: t('deposit.due'), value: day(instructions.dueDate, locale, model.timeZone) },
                { label: t('deposit.kind'), value: t(`depositKind.${deposit.kind}`) },
              ]}
            />
          ) : (
            <Banner tone="info" title={t('deposit.noBank')} />
          )}
          <p className="fw-qa-hint">{t('deposit.production')}</p>
        </section>
      )}
    </Card>
  )
}

function DeclineDialog({ quote, model, actions }: { quote: LinkQuote; model: QuoteAcceptViewModel; actions?: QuoteAcceptActions }) {
  const t = useT('quote-link')
  const [reason, setReason] = useState<DeclineReason>('price')
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  const needsName = answerOf(quote, 'decline')?.typedName === 'required'
  const held = needsName && name.trim().length < 2 ? t('decline.held.name') : model.answer === 'busy' ? t('sign.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDecline?.(false)}
      title={t('decline.title')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDecline?.(false)}>{t('decline.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => !held && actions?.onDeclineSend?.({ reason, note, name })}>
            {t('decline.go')}
          </Button>
        </>
      }
    >
      <div className="fw-qa-dialog">
        <p className="fw-qa-hint">{t('decline.body')}</p>
        <Field label={t('decline.reason')}>
          <Select value={reason} onChange={(event) => setReason(event.target.value as DeclineReason)}>
            {DECLINE_REASONS.map((item) => (
              <option key={item} value={item}>
                {t(`decline.reasons.${item}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('decline.note')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={400} />
        </Field>
        <Field label={t(needsName ? 'decline.name' : 'decline.nameOptional')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={200} />
        </Field>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
