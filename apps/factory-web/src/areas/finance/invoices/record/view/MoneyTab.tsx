'use client'

import Link from 'next/link'
import { Banknote } from 'lucide-react'
import { Card, EmptyState, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Invoice } from '../../../_shared/api'
import { dayInstant, daysBetween, decimal, dueDateOf, money, PAYABLE, STATUS_TONE } from '../../../_shared/model'
import { PartState } from '../../../_shared/parts'
import type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

const REQUEST_TONE: Record<string, 'neutral' | 'warning' | 'success'> = { OPEN: 'warning', PAID: 'success', WAIVED: 'neutral', CANCELLED: 'neutral' }

/**
 * Deposits & payments (design invoice tab "deposits"): what the invoice still asks (gross, credit notes, paid, open, the
 * due date and how late), the deposits of its orders — the request, the kind (acconto or caparra), what was paid and
 * when, the deposit invoice (TD02) that followed or "no fiscal document" when its VAT rule asks none, and what this
 * invoice deducts — and every payment placed on it (the payment record by link; a reversal said as one). Record payment
 * opens Payments with this invoice chosen. Money by grain.
 */
export function MoneyTab({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const related = model.related.value
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const m = (value: number | null | undefined) => money(value, invoice.currency, locale)
  const payable = PAYABLE.includes(invoice.docType)
  const due = dueDateOf(invoice)
  const overdue = payable && due && due < model.today && (invoice.openAmount ?? 0) > 0 ? daysBetween(due, model.today) : 0
  const deducted = invoice.lines.filter((line) => line.kind === 'DEPOSIT_DEDUCTION')
  if (!related) return <PartState problem={model.related.problem} label={t('money.title')} onRetry={() => actions?.onRetryPart?.('related')} />
  const payHeld = !model.can.recordPayments ? t('held.noRecord') : invoice.status === 'DRAFT' ? t('held.payDraft') : !payable ? t('held.payNotPayable') : (invoice.openAmount ?? 1) <= 0 ? t('held.payNothingOpen') : null

  return (
    <div className="fw-fin-stack">
      {model.can.price && payable && invoice.status !== 'DRAFT' && (
        <MetricStrip
          metrics={[
            { label: t('money.gross'), value: m(invoice.grossTotal) },
            { label: t('money.credited'), value: m(invoice.creditedAmount) },
            { label: t('money.paid'), value: m(invoice.paidAmount) },
            { label: t('money.open'), value: m(invoice.openAmount), hint: overdue > 0 ? t('money.overdue', { count: overdue }) : due ? t('money.dueOn', { date: day(due) }) : undefined },
          ]}
        />
      )}
      <div className="fw-fin-cards">
        <Card padded className="fw-fin-card">
          <h2 className="fw-fin-h2">{t('money.depositsTitle')}</h2>
          <p className="fw-fin-hint">{t('money.depositsExplain')}</p>
          {related.depositRequests.length === 0 ? (
            <EmptyState title={t('money.noDeposit.title')} description={t('money.noDeposit.body')} />
          ) : (
            related.depositRequests.map((request) => {
              const td02 = request.depositInvoices.find((entry) => entry.status !== 'DRAFT') ?? request.depositInvoices[0] ?? null
              const order = related.orders.find((entry) => entry.id === request.orderId)
              return (
                <div key={request.id} className="fw-fin-stack-tight">
                  <div className="fw-fin-card-head">
                    <h3 className="fw-fin-h3">
                      <Banknote size={14} aria-hidden /> {t('money.deposit', { kind: t(`depositKind.${request.kind}`), order: order?.number ?? '—' })}
                      {request.depositPct && <span className="fw-fin-title-sub">{decimal(request.depositPct, locale)} %</span>}
                    </h3>
                    <Pill tone={REQUEST_TONE[request.status] ?? 'neutral'}>{t(`requestStatus.${request.status}`)}</Pill>
                  </div>
                  <KeyValue
                    dense
                    labelCase="sentence"
                    columns={2}
                    items={[
                      ...(model.can.price ? [{ label: t('money.asked'), value: money(request.amount, request.currency, locale) }, { label: t('money.paidOnDeposit'), value: money(request.paidAmount, request.currency, locale) }] : []),
                      { label: t('money.paidAt'), value: request.paidAt ? formatDate(request.paidAt, { locale }) : t('money.notPaid') },
                      {
                        label: t('money.document'),
                        value:
                          request.fiscalDocument === 'NONE' ? (
                            t('money.noFiscal')
                          ) : td02 ? (
                            <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${td02.id}`}>
                              {td02.number ? t('money.td02', { number: td02.number }) : t('money.td02Draft')}
                            </Link>
                          ) : (
                            t('money.td02Waits')
                          ),
                      },
                    ]}
                  />
                </div>
              )
            })
          )}
          {deducted.length > 0 && model.can.price && (
            <p className="fw-fin-hint">
              {t('money.deductedHere', { amount: m(deducted.reduce((sum, line) => sum + (line.grossAmount ?? line.netAmount ?? 0), 0)) })}
            </p>
          )}
          {invoice.docType === 'TD02' && <Tag tone="info">{t('money.td02PaidBy')}</Tag>}
        </Card>

        <Card padded className="fw-fin-card">
          <div className="fw-fin-card-head">
            <h2 className="fw-fin-h2">{t('money.paymentsTitle')}</h2>
            {payable && (
              payHeld ? (
                <Button size="sm" variant="primary" heldReason={payHeld}>
                  {t('step.recordPayment')}
                </Button>
              ) : (
                <Button size="sm" variant="primary" asChild>
                  <Link href={`${model.prefix}/finance/payments?new=1&invoice=${invoice.id}`}>{t('step.recordPayment')}</Link>
                </Button>
              )
            )}
          </div>
          {related.payments.length === 0 ? (
            <EmptyState title={t('money.noPayments.title')} description={t(payable ? 'money.noPayments.body' : 'money.noPayments.notPayable')} />
          ) : (
            <SummaryTable
              label={t('money.paymentsTitle')}
              columns={[t('money.col.payment'), t('money.col.date'), ...(model.can.price ? [t('money.col.amount')] : [])]}
              rows={related.payments.map((entry) => ({
                id: entry.allocationId,
                cells: [
                  <span key="p" className="fw-fin-cell">
                    <Link className="fw-fin-link" href={`${model.prefix}/finance/payments/${entry.paymentId}`}>
                      {entry.externalRef}
                    </Link>
                    <span className="nds-summary-sub">{entry.reversalOfId ? t('money.reversal', { note: entry.note ?? '—' }) : entry.reversed ? t('money.reversed') : t('money.placed')}</span>
                  </span>,
                  day(entry.receivedOn),
                  ...(model.can.price ? [m(entry.amount)] : []),
                ],
              }))}
              density="roomy"
              stackOnPhone
            />
          )}
          {related.creditNotes.length > 0 && (
            <>
              <h3 className="fw-fin-h3">{t('money.creditNotesTitle')}</h3>
              <SummaryTable
                label={t('money.creditNotesTitle')}
                columns={[t('money.col.creditNote'), t('money.col.status'), ...(model.can.price ? [t('money.col.amount')] : [])]}
                rows={related.creditNotes.map((note) => ({
                  id: note.id,
                  cells: [
                    <Link key="n" className="fw-fin-link" href={`${model.prefix}/finance/invoices/${note.id}`}>
                      {note.number ?? t('list.draft')}
                    </Link>,
                    <Pill key="s" tone={STATUS_TONE[note.status]}>{t(`invoiceStatus.${note.status}`)}</Pill>,
                    ...(model.can.price ? [m(note.grossTotal)] : []),
                  ],
                }))}
                stackOnPhone
              />
            </>
          )}
          {related.creditOf && (
            <p className="fw-fin-hint">
              {t('money.creditOf')}{' '}
              <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${related.creditOf.id}`}>
                {related.creditOf.number ?? '—'}
              </Link>
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
