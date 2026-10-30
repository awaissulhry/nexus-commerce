'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Banner, DateField, Field, KeyValue, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { amountText, closeHeld, closeNeedsReason, dayInstant, linePromisesAllowed, mayIssueDepositInvoice, parseAmount, paymentProblems, promiseProblems, settlementWords, stillToPay } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { AmendReviewDialog, CancelDialog, CloseLinesDialog, CompareDialog, CopyQuoteDialog, ReopenLinesDialog } from './DailyDialogs'

/**
 * The order studio's dialogs: Change promise date (the order or chosen lines, the reason; the first promise never
 * changes), Mark ready (a reason, while quality release is not in use), Close order (settled: a confirm; not settled:
 * what is missing and a reason), Send the bank-details page (the DEPOSIT_INFO link to the quote's contact, an optional
 * message), Record the payment (amount, day, bank reference; "Issue the deposit invoice (TD02) now" when the rule asks
 * one — a fresh authenticator code then), Send the TD02 to SDI. Esc closes; the focus returns to the opener (DS Modal);
 * ⌘↵ confirms. A refused write is said inside its dialog, what was typed stays.
 */
export function OrderDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'promise':
      return <PromiseDialog order={order} model={model} actions={actions} />
    case 'ready':
      return <ReadyDialog order={order} model={model} actions={actions} />
    case 'close':
      return <CloseDialog order={order} model={model} actions={actions} />
    case 'depositLink':
      return <LinkDialog order={order} requestId={dialog.requestId} model={model} actions={actions} />
    case 'depositPayment':
      return <PaymentDialog order={order} requestId={dialog.requestId} model={model} actions={actions} />
    case 'sdiSend':
      return <SdiDialog order={order} invoiceId={dialog.invoiceId} model={model} actions={actions} />
    case 'amendReview':
      return <AmendReviewDialog order={order} model={model} actions={actions} />
    case 'closeLines':
      return <CloseLinesDialog order={order} model={model} actions={actions} />
    case 'reopenLines':
      return <ReopenLinesDialog order={order} model={model} actions={actions} />
    case 'cancel':
      return <CancelDialog order={order} model={model} actions={actions} />
    case 'copyQuote':
      return <CopyQuoteDialog order={order} model={model} actions={actions} />
    case 'compare':
      return <CompareDialog order={order} amendmentId={dialog.amendmentId} model={model} actions={actions} />
    default:
      return null
  }
}

/** ⌘↵ inside a dialog's form confirms it when nothing holds it. */
const confirmKeys = (held: string | null, go: () => void) => (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
    event.preventDefault()
    go()
  }
}

export function Frame({ title, held, go, goLabel, onClose, children, problem, size = 'md', tone = 'primary', done, closeLabel }: { title: string; held: string | null; go: () => void; goLabel: string; onClose: () => void; children: ReactNode; problem: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: 'primary' | 'danger'; done?: ReactNode; closeLabel?: string }) {
  const t = useT('orders')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size={size}
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={onClose}>
              {closeLabel ?? t('common.cancel')}
            </Button>
            <Button size="sm" variant={tone} heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {goLabel}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-so-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !done) go()
        }}
        onKeyDown={done ? undefined : confirmKeys(held, go)}
      >
        {problem}
        {done ?? children}
      </form>
    </Modal>
  )
}

export function DialogProblem({ model }: { model: OrderRecordModel }) {
  const t = useT('orders')
  return model.dialogProblem ? <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} /> : null
}

function PromiseDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const linesAllowed = linePromisesAllowed(order)
  const [scope, setScope] = useState<'order' | 'lines'>(model.draft?.scope ?? 'order')
  const [date, setDate] = useState(model.draft?.date ?? '')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const [lineIds, setLineIds] = useState<string[]>(model.draft?.lineIds ?? [])
  const problems = promiseProblems({ date, reason, today: model.today, current: order.promiseDate, lineIds, allLines: scope === 'order' })
  const firstProblem = problems.date ?? problems.lines ?? problems.reason ?? null
  const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : null
  const go = () => actions?.onPromise?.({ date, reason: reason.trim(), lineIds: scope === 'lines' ? lineIds : null })
  return (
    <Frame title={t('promise.title', { number: order.number })} held={held} go={go} goLabel={model.busy ? t('common.working') : t('promise.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />}>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('dates.promised'), value: order.promiseDate ? formatDate(dayInstant(order.promiseDate), { locale }) : '—' },
          { label: t('dates.firstPromised'), value: order.originalPromiseDate ? formatDate(dayInstant(order.originalPromiseDate), { locale }) : '—' },
        ]}
      />
      {linesAllowed && order.lines.length > 1 && (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('promise.scope')}</legend>
          <RadioCard variant="row" name="fw-so-scope" value="order" checked={scope === 'order'} selected={scope === 'order'} onChange={() => setScope('order')} title={t('promise.scopeOrder')} description={t('promise.scopeOrderHint')} />
          <RadioCard variant="row" name="fw-so-scope" value="lines" checked={scope === 'lines'} selected={scope === 'lines'} onChange={() => setScope('lines')} title={t('promise.scopeLines')} description={t('promise.scopeLinesHint')} />
        </fieldset>
      )}
      {scope === 'lines' && (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('promise.lines')}</legend>
          {order.lines.map((line) => (
            <Checkbox
              key={line.id}
              checked={lineIds.includes(line.id)}
              onChange={(event) => setLineIds((current) => (event.target.checked ? [...current, line.id] : current.filter((id) => id !== line.id)))}
              label={`${line.style?.code ?? '—'} · ${line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—'} (${t('list.units', { count: line.quantity })})`}
            />
          ))}
          {problems.lines && <p className="fw-so-hint">{t(problems.lines)}</p>}
        </fieldset>
      )}
      <Field label={t('promise.date')} hint={t('promise.dateHint')} error={date && problems.date ? t(problems.date) : undefined}>
        <DateField value={date} onChange={setDate} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('promise.date')} />
      </Field>
      <Field label={t('promise.reason')} hint={t('promise.reasonHint')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
      </Field>
      <p className="fw-so-hint">{t('promise.tellCustomer')}</p>
    </Frame>
  )
}

function ReadyDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const held = model.busy ? t('held.busy') : reason.trim() === '' ? t('ready.reasonNeeded') : null
  return (
    <Frame title={t('ready.title', { number: order.number })} held={held} go={() => actions?.onReady?.(reason.trim())} goLabel={t('ready.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />}>
      <p className="fw-so-hint">{t('ready.body')}</p>
      <Field label={t('ready.reason')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Frame>
  )
}

function CloseDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const needsReason = closeNeedsReason(order)
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const rightHeld = closeHeld(order, model.can)
  const held = model.busy ? t('held.busy') : rightHeld ? t(rightHeld.key) : needsReason && reason.trim() === '' ? t('close.reasonNeeded') : null
  return (
    <Frame
      title={t('close.title', { number: order.number })}
      held={held}
      go={() => actions?.onClose?.(needsReason ? reason.trim() : null)}
      goLabel={t('close.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
      tone={needsReason ? 'danger' : 'primary'}
    >
      {needsReason ? (
        <>
          <Banner tone="warning" title={t('close.notSettled')} />
          <ul className="fw-so-list">
            {settlementWords(order).map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <Field label={t('close.reason')} hint={t('close.reasonHint')}>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
          </Field>
        </>
      ) : (
        <p className="fw-so-hint">{t('close.settled')}</p>
      )}
      <p className="fw-so-hint">{t('close.final')}</p>
    </Frame>
  )
}

function LinkDialog({ order, requestId, model, actions }: { order: Order; requestId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const request = order.chain.depositRequests.find((entry) => entry.id === requestId)
  const [message, setMessage] = useState(model.draft?.message ?? '')
  const sent = model.sentLink
  const held = model.busy ? t('held.busy') : null
  if (!request) return null
  const done = sent ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span>
        {t(sent.delivery === 'failed' ? 'link.sentFailed' : 'link.sentTo', { to: sent.link.to, until: formatDate(sent.link.expiresAt, { locale }) })}
        {sent.link.revokedLinkIds.length > 0 ? ` ${t('link.revoked', { count: sent.link.revokedLinkIds.length })}` : ''}
      </span>
    </div>
  ) : undefined
  return (
    <Frame title={t('link.title')} held={held} go={() => actions?.onSendLink?.(requestId, message)} goLabel={model.busy ? t('common.working') : t('link.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} done={done}>
      <p className="fw-so-hint">{t('link.body')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('link.to'), value: request.link?.to ?? t('link.contact') },
          ...(model.can.price ? [{ label: t('deposit.amount'), value: money(stillToPay(request) ?? request.amount, request.currency, locale) }] : []),
          { label: t('deposit.due'), value: formatDate(dayInstant(request.dueDate), { locale }) },
          { label: t('link.valid'), value: t('link.validValue') },
        ]}
      />
      {request.link?.state === 'LIVE' && <Banner tone="info" title={t('link.replaces')} />}
      <Field label={t('link.message')} hint={t('link.messageHint')}>
        <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={2000} />
      </Field>
    </Frame>
  )
}

function PaymentDialog({ order, requestId, model, actions }: { order: Order; requestId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const request = order.chain.depositRequests.find((entry) => entry.id === requestId)
  const left = request ? stillToPay(request) : null
  const [amount, setAmount] = useState(model.draft?.amount ?? (left !== null ? amountText(left, locale) : ''))
  const [receivedOn, setReceivedOn] = useState(model.draft?.receivedOn ?? model.today)
  const [reference, setReference] = useState(model.draft?.reference ?? '')
  const [note, setNote] = useState('')
  const asksInvoice = request?.fiscalDocument === 'TD02'
  const mayIssue = request ? mayIssueDepositInvoice(request, model.can) : false
  const [issue, setIssue] = useState(model.draft?.issue ?? mayIssue)
  const recorded = model.recorded
  if (!request) return null
  const problems = paymentProblems({ amount, receivedOn, reference, today: model.today, left })
  const firstProblem = problems.amount ?? problems.receivedOn ?? problems.reference ?? null
  const held = model.busy ? t('held.busy') : firstProblem ? t(firstProblem) : null
  const parsed = parseAmount(amount)
  const go = () => {
    if (parsed === null) return
    actions?.onRecordPayment?.(requestId, { amount: parsed, receivedOn, reference: reference.trim(), note: note.trim(), issue: asksInvoice && mayIssue && issue })
  }
  const done = recorded ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack">
        <span>{t(recorded.depositRequest.status === 'PAID' ? 'payment.doneFull' : 'payment.donePart', { amount: money(recorded.payment.amount, request.currency, locale), reference: recorded.payment.externalRef })}</span>
        {recorded.depositInvoice.invoice ? (
          <span>{t(recorded.depositInvoice.filesPending ? 'payment.td02FilesPending' : 'payment.td02Issued', { number: recorded.depositInvoice.invoice.number ?? '—' })}</span>
        ) : recorded.depositInvoice.required ? (
          <span>{t('payment.td02Later')}</span>
        ) : (
          <span>{t('payment.td02NotNeeded')}</span>
        )}
      </span>
    </div>
  ) : undefined
  return (
    <Frame
      title={t('payment.title', { number: order.number })}
      held={held}
      go={go}
      goLabel={model.busy ? t('common.working') : parsed !== null ? t('payment.go', { amount: money(parsed, request.currency, locale) }) : t('payment.goEmpty')}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
      done={done}
    >
      <p className="fw-so-hint">{t('payment.body')}</p>
      <div className="fw-so-two">
        <Field label={t('payment.amount')} hint={left !== null ? t('payment.amountHint', { left: money(left, request.currency, locale) }) : undefined} error={amount && problems.amount ? t(problems.amount) : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('payment.receivedOn')} error={problems.receivedOn ? t(problems.receivedOn) : undefined}>
          <DateField value={receivedOn} onChange={setReceivedOn} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('payment.receivedOn')} />
        </Field>
      </div>
      {problems.over && <Banner tone="info" title={t('payment.over', { left: money(left, request.currency, locale) })} />}
      <Field label={t('payment.reference')} hint={t('payment.referenceHint')} error={reference !== '' && problems.reference ? t(problems.reference) : undefined}>
        <Input value={reference} onChange={(event) => setReference(event.target.value)} autoComplete="off" />
      </Field>
      <Field label={t('payment.note')}>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} autoComplete="off" />
      </Field>
      {asksInvoice ? (
        mayIssue ? (
          <div className="fw-so-stack-tight">
            <Checkbox checked={issue} onChange={(event) => setIssue(event.target.checked)} label={t('payment.issue')} />
            <p className="fw-so-hint">{t(issue ? 'payment.issueHint' : 'payment.issueOff')}</p>
          </div>
        ) : (
          <p className="fw-so-hint">{t('payment.issueByFinance')}</p>
        )
      ) : (
        <p className="fw-so-hint">{t('payment.noInvoice')}</p>
      )}
    </Frame>
  )
}

function SdiDialog({ order, invoiceId, model, actions }: { order: Order; invoiceId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const invoice = order.chain.invoices.find((entry) => entry.id === invoiceId)
  const held = model.busy ? t('held.busy') : null
  if (!invoice) return null
  return (
    <Frame title={t('sdiSend.title', { number: invoice.number ?? '—' })} held={held} go={() => actions?.onSendSdi?.(invoiceId)} goLabel={model.busy ? t('common.working') : t('sdiSend.go')} onClose={() => actions?.onDialog?.(null)} problem={<DialogProblem model={model} />} size="sm">
      <p className="fw-so-hint">{t('sdiSend.body', { date: invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : '—' })}</p>
      {model.busy && (
        <p className="fw-so-hint" role="status">
          <Spinner size={12} /> {t('sdiSend.sending')}
        </p>
      )}
    </Frame>
  )
}
