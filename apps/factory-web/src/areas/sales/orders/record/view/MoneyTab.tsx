'use client'

import Link from 'next/link'
import { Banknote, CalendarClock, CheckCircle2, Circle, Clock, Send } from 'lucide-react'
import { Card, EmptyState, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { money, percent } from '../../../quotes/model'
import type { ChainInvoice, DepositRequest, Milestone, Order } from '../../api'
import { isOverdue, MILESTONE_TONE } from '../../daily-model'
import { dayInstant, depositInvoicesOf, depositSteps, linkHeld, paymentHeld, SDI_TONE, sdiSendHeld, stillToPay, type DepositStepState, type Tone } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'
import { waiveHeld } from '../schedule/model'
import { OpenStepDialog, StepVerbs, WaiveDialog } from '../schedule/view/StepVerbs'

const REQUEST_TONE: Record<DepositRequest['status'], Tone> = { OPEN: 'warning', PAID: 'success', WAIVED: 'neutral', CANCELLED: 'neutral' }
const INVOICE_TONE: Record<string, Tone> = { DRAFT: 'neutral', ISSUED: 'info', SENT: 'info', DELIVERED: 'success', NOT_DELIVERABLE: 'warning', REJECTED: 'danger', ERROR: 'danger' }

/**
 * Invoices & payments (design `order.money.deposits` + `order.money.invoices` + `order.money.balance`; Owner answer Q12:
 * an acconto paid by bank transfer): each deposit request as its five steps — asked at acceptance, the bank-details page
 * sent to the customer (DEPOSIT_INFO link: to whom, until when), the payment recorded (what is left), the deposit
 * invoice (TD02) when the VAT rule asks one, and its state at SDI with "Send to SDI" — then the order's invoices and
 * credit notes with their SDI state and what is open, and the balance. Money by grain; the actions say why they wait.
 */
export function MoneyTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const settlement = model.settlement?.value ?? null
  const currency = order.currency
  const requests = order.chain.depositRequests

  return (
    <div className="fw-so-stack">
      {model.can.viewInvoices && model.can.price && (
        <>
          {model.settlement && !settlement ? (
            <PartState problem={model.settlement.problem} label={t('money.balanceTitle')} onRetry={() => actions?.onRetryPart?.('settlement')} />
          ) : (
            <MetricStrip
              metrics={[
                { label: t('money.gross'), value: money(order.grossAmount, currency, locale) },
                { label: t('money.invoiced'), value: money(settlement?.invoicedAmount, currency, locale) },
                { label: t('money.paid'), value: money(settlement?.paidAmount, currency, locale) },
                { label: t('money.depositPaid'), value: money(requests.filter((request) => request.stepKind !== 'BEFORE_SHIPPING').reduce((sum, request) => sum + (request.paidAmount ?? 0), 0), currency, locale) },
                { label: t('money.balance'), value: money(settlement?.balanceDueAmount, currency, locale) },
              ]}
            />
          )}
        </>
      )}

      <div className="fw-so-cards fw-so-cards--wide">
        <div className="fw-so-stack">
          <ScheduleCard order={order} model={model} actions={actions} />
          {requests.length === 0 ? (
            <Card padded>
              <EmptyState title={t('deposit.none.title')} description={t(order.depositRequired ? 'deposit.none.missing' : 'deposit.none.body')} />
            </Card>
          ) : (
            requests.map((request) => <DepositCard key={request.id} request={request} order={order} model={model} actions={actions} />)
          )}
        </div>
        <InvoicesCard order={order} model={model} actions={actions} />
      </div>
      {model.scheduleSteps?.waiving && <WaiveDialog waiving={model.scheduleSteps.waiving} model={model.scheduleSteps} actions={actions?.scheduleSteps} />}
    </div>
  )
}

/**
 * The payment schedule (design `order.money.schedule`, SAL-216; B-W2a-50): the deposit and the balance steps as the
 * terms share them — each step, its share, its amount (price grain), its due day and its state (open, overdue, paid,
 * waived); steps an amendment replaced are counted under it. No steps: paid on invoice terms. Read-only here: the
 * reminder (B-W2a-55) and the payments are Finance's.
 */
export function ScheduleCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const part = model.schedule
  if (!part || !part.value) return <PartState problem={part?.problem ?? null} label={t('schedule.title')} onRetry={() => actions?.onRetryPart?.('schedule')} />
  const schedule = part.value
  const currency = schedule.currency
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const stepWords = (step: Milestone) => {
    const share = step.sharePct ? percent(step.sharePct, locale) : null
    const kind = t(`schedule.kind.${step.kind}`)
    return share ? t('schedule.stepShare', { kind, share }) : kind
  }
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">
          <CalendarClock size={16} aria-hidden /> {t('schedule.title')}
        </h2>
        {model.can.price && schedule.steps.length > 0 && <span className="fw-so-hint">{t('schedule.open', { amount: money(schedule.openAmount, currency, locale) })}</span>}
      </div>
      {schedule.steps.length === 0 ? (
        <p className="fw-so-hint">{t('schedule.empty')}</p>
      ) : (
        <Timeline
          label={t('schedule.label')}
          steps={schedule.steps.map((step) => {
            const overdue = isOverdue(step, model.today)
            return {
              key: step.id,
              tone: overdue ? 'info' : MILESTONE_TONE[step.status],
              label: (
                <span className="fw-so-inline">
                  <span>{stepWords(step)}</span>
                  {model.can.price && <strong>{money(step.amount, currency, locale)}</strong>}
                  <Pill tone={overdue ? 'danger' : MILESTONE_TONE[step.status]}>{overdue ? t('schedule.overdue') : t(`schedule.status.${step.status}`)}</Pill>
                </span>
              ),
              detail: (
                <span className="fw-so-inline">
                  {step.status === 'PAID' && step.paidAt
                    ? t('schedule.paidOn', { date: formatDate(step.paidAt, { locale }) })
                    : step.dueDate
                      ? t(step.kind === 'DEPOSIT' ? 'schedule.dueDeposit' : 'schedule.due', { date: day(step.dueDate) })
                      : t(`schedule.when.${step.kind}`)}
                  {/* B-W2a-80: Open for payment / Invoice this step (B-W2a-F2's note). */}
                  {model.scheduleSteps && <StepVerbs step={step} order={order} model={model.scheduleSteps} actions={actions?.scheduleSteps} />}
                </span>
              ),
            }
          })}
        />
      )}
      {schedule.cancelled.length > 0 && <p className="fw-so-hint">{t('schedule.cancelled', { count: schedule.cancelled.length })}</p>}
      {model.scheduleSteps?.opening && <OpenStepDialog step={model.scheduleSteps.opening} model={model.scheduleSteps} today={model.today} actions={actions?.scheduleSteps} />}
    </Card>
  )
}

function StepIcon({ state }: { state: DepositStepState }) {
  if (state === 'done') return <CheckCircle2 size={16} className="fw-so-ico is-ok" aria-hidden />
  if (state === 'current') return <Clock size={16} className="fw-so-ico is-waiting" aria-hidden />
  return <Circle size={16} className="fw-so-ico" aria-hidden />
}

/** One deposit request: its facts and its five steps, each with the action that moves it on. */
export function DepositCard({ request, order, model, actions }: { request: DepositRequest; order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const td02s = depositInvoicesOf(request, order.chain.invoices)
  const issued = td02s.find((invoice) => invoice.status !== 'DRAFT') ?? null
  const draft = td02s.find((invoice) => invoice.status === 'DRAFT') ?? null
  const sdiPart = issued && model.sdi ? (model.sdi[issued.id] ?? null) : null
  const sdi = sdiPart?.value ?? null
  const steps = depositSteps(request, order.chain.invoices, sdi?.state.code ?? null)
  const left = stillToPay(request)
  const overdue = request.status === 'OPEN' && request.dueDate < model.today
  const linkWait = linkHeld(request, model.can)
  const waiveWait = model.scheduleSteps ? waiveHeld(order, model.scheduleSteps.can) : null
  const payWait = paymentHeld(request, model.can)
  const sendWait = sdi ? sdiSendHeld(model.can, sdi.canSend && sdi.state.next.action === 'SEND') : null
  const invoiceHref = (invoice: ChainInvoice) => `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const busy = model.busy ? t('held.busy') : null
  const linkStateWords = request.link ? t(`link.${request.link.state}`, { to: request.link.to ?? t('link.contact'), date: formatDate(request.link.sentAt, { locale }), until: formatDate(request.link.expiresAt, { locale }) }) : null

  return (
    <Card padded className="fw-so-deposit">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">
          <Banknote size={16} aria-hidden /> {t('deposit.title', { kind: t(`depositKind.${request.kind}`) })}
          {request.depositPct ? <span className="fw-so-title-sub">{percent(request.depositPct, locale)}</span> : null}
        </h2>
        <Pill tone={overdue ? 'danger' : REQUEST_TONE[request.status]}>{overdue ? t('deposit.overdue') : t(`requestStatus.${request.status}`)}</Pill>
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          ...(model.can.price ? [{ label: t('deposit.amount'), value: money(request.amount, request.currency, locale) }] : []),
          { label: t('deposit.due'), value: day(request.dueDate) },
          ...(model.can.price ? [{ label: t('deposit.paidSoFar'), value: money(request.paidAmount, request.currency, locale), hint: left !== null && left > 0 && (request.paidAmount ?? 0) > 0 ? t('deposit.left', { amount: money(left, request.currency, locale) }) : undefined }] : []),
          { label: t('deposit.document'), value: t(request.fiscalDocument === 'TD02' ? 'deposit.documentTd02' : 'deposit.documentNone') },
        ]}
      />
      <ol className="fw-so-steps" aria-label={t('deposit.stepsLabel')}>
        <li className={`fw-so-step is-${steps.requested}`}>
          <StepIcon state={steps.requested} />
          <span className="fw-so-step-body">
            <b>{t('deposit.step.requested')}</b>
            {/* B-W2b-16: a typed order's deposit (no quote) was asked when the office entered the order. */}
            <span>{t(request.quoteVersionId ? 'deposit.step.requestedWords' : 'deposit.step.requestedTyped', { date: formatDate(request.createdAt, { locale }) })}</span>
          </span>
        </li>
        <li className={`fw-so-step is-${steps.page}`}>
          <StepIcon state={steps.page} />
          <span className="fw-so-step-body">
            <b>{t('deposit.step.page')}</b>
            <span>{linkStateWords ?? (request.status === 'OPEN' ? t('deposit.step.pageNotSent') : t('deposit.step.pageNotNeeded'))}</span>
          </span>
          {request.status === 'OPEN' && (
            <Button size="sm" heldReason={linkWait ? t(linkWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'depositLink', requestId: request.id })}>
              <Send size={13} aria-hidden /> {t(request.link ? 'deposit.sendAgain' : 'deposit.send')}
            </Button>
          )}
        </li>
        <li className={`fw-so-step is-${steps.paid}`}>
          <StepIcon state={steps.paid} />
          <span className="fw-so-step-body">
            <b>{t('deposit.step.paid')}</b>
            <span>
              {request.status === 'PAID'
                ? request.paidAt
                  ? t('deposit.step.paidOn', { date: formatDate(request.paidAt, { locale }) })
                  : t('deposit.step.paidDone')
                : request.status === 'OPEN'
                  ? (request.paidAmount ?? 0) > 0 && model.can.price
                    ? t('deposit.step.partPaid', { paid: money(request.paidAmount, request.currency, locale), left: money(left, request.currency, locale) })
                    : t('deposit.step.waitingTransfer')
                  : t(`requestStatus.${request.status}`)}
            </span>
          </span>
          {request.status === 'OPEN' && (
            <Button size="sm" variant="primary" heldReason={payWait ? t(payWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'depositPayment', requestId: request.id })}>
              {t('deposit.record')}
            </Button>
          )}
          {/* B-W2b-16: the owner waives the advance (its step with it), with a reason and a fresh code. */}
          {request.status === 'OPEN' && model.scheduleSteps && (
            <Button size="sm" variant="ghost" heldReason={waiveWait ? t(waiveWait.key) : (request.paidAmount ?? 0) > 0 ? t('schedule.verbs.held.partPaid') : busy} onClick={() => actions?.scheduleSteps?.onWaive?.(waiveTargetOf(request, model, t('deposit.title', { kind: t(`depositKind.${request.kind}`) })))}>
              {t('schedule.verbs.waive')}
            </Button>
          )}
        </li>
        <li className={`fw-so-step is-${steps.invoice}`}>
          <StepIcon state={steps.invoice} />
          <span className="fw-so-step-body">
            <b>{t('deposit.step.invoice')}</b>
            <span>
              {steps.invoice === 'notNeeded' ? (
                t('deposit.step.invoiceNotNeeded')
              ) : issued ? (
                <>
                  <Link className="fw-so-link" href={invoiceHref(issued)}>
                    {t('deposit.step.td02', { number: issued.number ?? '—' })}
                  </Link>
                  {issued.issueDate ? ` · ${t('deposit.step.issuedOn', { date: day(issued.issueDate) })}` : ''}
                </>
              ) : draft ? (
                <Link className="fw-so-link" href={invoiceHref(draft)}>
                  {t('deposit.step.td02Draft')}
                </Link>
              ) : steps.invoice === 'current' ? (
                t('deposit.step.invoiceWaits')
              ) : (
                t('deposit.step.invoiceAfterPayment')
              )}
            </span>
          </span>
        </li>
        <li className={`fw-so-step is-${steps.sdi}`}>
          <StepIcon state={steps.sdi} />
          <span className="fw-so-step-body">
            <b>{t('deposit.step.sdi')}</b>
            <span>
              {steps.sdi === 'notNeeded' ? (
                t('deposit.step.sdiNotNeeded')
              ) : !issued ? (
                t('deposit.step.sdiAfterInvoice')
              ) : !model.sdi ? (
                t('deposit.step.sdiNoRight')
              ) : !sdiPart || (sdiPart.value === null && sdiPart.problem === null) ? (
                <span className="fw-so-inline">
                  <Spinner size={12} /> {t('deposit.step.sdiReading')}
                </span>
              ) : sdi ? (
                <span className="fw-so-inline">
                  <Pill tone={SDI_TONE[sdi.state.code]}>{t(`sdi.state.${sdi.state.code}`)}</Pill> {t(`sdi.next.${sdi.state.next.action}`)}
                </span>
              ) : (
                <span className="fw-so-inline">
                  {t(sdiPart.problem ?? 'problem.read.internal')}
                  <Button size="sm" variant="link" onClick={() => actions?.onRetryPart?.('sdi')}>
                    {t('common.retry')}
                  </Button>
                </span>
              )}
            </span>
          </span>
          {issued && sdi && (sdi.state.next.action === 'SEND' || sdi.state.next.action === 'SEND_AGAIN') && (
            <Button size="sm" heldReason={sendWait ? t(sendWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'sdiSend', invoiceId: issued.id })}>
              <Send size={13} aria-hidden /> {t('deposit.sendSdi')}
            </Button>
          )}
        </li>
      </ol>
    </Card>
  )
}

function InvoicesCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const settlement = model.settlement?.value ?? null
  const invoiceHref = (invoice: ChainInvoice) => `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const showMoney = model.can.price && !!settlement
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('money.invoicesTitle')}</h2>
      {order.chain.invoices.length === 0 ? (
        <EmptyState title={t('money.noInvoices.title')} description={t('money.noInvoices.body')} />
      ) : (
        <SummaryTable
          label={t('money.invoicesTitle')}
          columns={[t('money.col.number'), t('money.col.kind'), t('money.col.status'), ...(model.sdi ? [t('money.col.sdi')] : []), ...(showMoney ? [t('money.col.gross'), t('money.col.open')] : [])]}
          rows={order.chain.invoices.map((invoice) => {
            const sdi = model.sdi?.[invoice.id]?.value ?? null
            const amounts = settlement?.invoices.find((entry) => entry.id === invoice.id)
            return {
              id: invoice.id,
              cells: [
                <span key="n" className="fw-so-cell">
                  <Link className="fw-so-link" href={invoiceHref(invoice)}>
                    {invoice.number ?? t('money.draft')}
                  </Link>
                  <span className="fw-so-cell-sub">{invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : '—'}</span>
                </span>,
                t(`docType.${invoice.docType}`),
                <Pill key="s" tone={INVOICE_TONE[invoice.status] ?? 'neutral'}>{t(`invoiceStatus.${invoice.status}`)}</Pill>,
                ...(model.sdi ? [sdi ? <Pill key="sdi" tone={SDI_TONE[sdi.state.code]}>{t(`sdi.state.${sdi.state.code}`)}</Pill> : invoice.status === 'DRAFT' ? '—' : <Spinner key="w" size={12} />] : []),
                ...(showMoney ? [money(amounts?.grossTotal, order.currency, locale), money(amounts?.openAmount, order.currency, locale)] : []),
              ],
            }
          })}
          density="roomy"
          stackOnPhone
        />
      )}
      {!model.can.viewInvoices && <p className="fw-so-hint">{t('money.noInvoiceRight')}</p>}
      {model.settlement?.problem && (
        <p className="fw-so-hint">
          {t(model.settlement.problem)}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onRetryPart?.('settlement')}>
            {t('common.retry')}
          </Button>
        </p>
      )}
    </Card>
  )
}

/** B-W2b-16: what "Waive…" on a deposit request waives — the open step that names it, else the request itself (at its version). */
function waiveTargetOf(request: DepositRequest, model: OrderRecordModel, words: string) {
  const step = model.schedule?.value?.steps.find((entry) => entry.depositRequestId === request.id && entry.status === 'OPEN') ?? null
  const stepKind: 'DEPOSIT' | 'BEFORE_SHIPPING' = request.stepKind === 'BEFORE_SHIPPING' ? 'BEFORE_SHIPPING' : 'DEPOSIT'
  return step
    ? { target: { kind: 'step' as const, id: step.id, version: step.version }, label: words, stepKind }
    : { target: { kind: 'request' as const, id: request.id, version: request.version }, label: words, stepKind }
}
