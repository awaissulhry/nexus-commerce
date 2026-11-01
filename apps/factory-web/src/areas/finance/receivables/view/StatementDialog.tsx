'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Mail, Printer } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { DateField, DetailModal, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Statement, StatementLine } from '../api'
import { bucketTone, moneyText, RECEIVABLES_NAMESPACE, statementKey, type ReceivablesCan, type StatementRef } from '../model'
import { AgeBar, dayText } from './parts'

export interface StatementState {
  readonly ref: StatementRef
  readonly period: { readonly from: string | null; readonly to: string | null }
  readonly value: Statement | null
  readonly problem: string | null
  /** The send step ("Send statement": who it goes to, a message) is open. */
  readonly sending?: boolean
  readonly sendProblem?: string | null
}

/**
 * pop:statement — one customer's statement (design "Customer Gamma — statement", a DetailModal: centred, a full-screen
 * sheet on a phone; J / K the next or previous customer of By customer): the period (from 1 January by default), the
 * bridge "Opening balance + invoices − credit notes − payments + refunds = closing balance", every movement with the
 * running balance (an invoice or a payment opens its record), what is open at the end of the period with its age, and
 * the reminders sent. Print opens the statement PDF tab (tab:statement-pdf); Send statement e-mails the PDF to the
 * customer's invoice contacts (after a step that names them). Amounts only with the price grain.
 */
export function StatementDialog({
  state,
  ids,
  can,
  prefix,
  busy,
  onGo,
  onClose,
  onRetry,
  onPeriod,
  onPrint,
  onSend,
  onCurrency,
}: {
  state: StatementState
  ids: readonly string[]
  can: ReceivablesCan
  prefix: string
  busy: boolean
  onGo?: (key: string) => void
  onClose?: () => void
  onRetry?: () => void
  onPeriod?: (period: { from: string | null; to: string | null }) => void
  onPrint?: (ref: StatementRef, period: { from: string | null; to: string | null }) => void
  onSend?: (message: string) => Promise<boolean>
  onCurrency?: (currency: string) => void
}) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const locale = useLocale()
  const [sending, setSending] = useState(state.sending ?? false)
  const [message, setMessage] = useState('')
  const statement = state.value
  const key = statementKey(state.ref)
  const priceHeld = can.price ? null : t('held.price', { permission: 'money.price' })
  const sendHeld = busy
    ? t('held.busy')
    : !can.sendStatements
      ? t('held.sendStatements', { permission: 'receivables.statements.send' })
      : (priceHeld ?? (statement && statement.recipients.length === 0 ? t('held.noRecipients') : null))
  const period = {
    from: statement?.from ?? state.period.from,
    to: statement?.to ?? state.period.to,
  }
  const overdue = statement?.ageing?.overdue ?? 0

  return (
    <>
      <DetailModal
        open
        onClose={() => onClose?.()}
        title={t('statement.title', {
          customer: statement?.customer.name ?? t('statement.thisCustomer'),
        })}
        subtitle={
          statement
            ? t('statement.subtitle', {
                company: statement.company.name,
                from: dayText(statement.from, locale),
                to: dayText(statement.to, locale),
                currency: statement.currency,
              })
            : undefined
        }
        meta={
          statement ? (
            <Pill tone={overdue > 0 ? 'danger' : 'neutral'}>
              {overdue > 0 && can.price
                ? t('statement.overdue', {
                    amount: moneyText(overdue, statement.currency, locale),
                  })
                : statement.openItems.some((item) => item.daysLate > 0)
                  ? t('statement.late')
                  : t('statement.notLate')}
            </Pill>
          ) : undefined
        }
        nav={
          ids.length > 1 && ids.includes(key)
            ? {
                ids,
                current: key,
                onGo: (id) => onGo?.(id),
                noun: t('statement.noun'),
              }
            : undefined
        }
        loading={!statement && !state.problem}
        error={state.problem ? t(state.problem) : undefined}
        onRetry={state.problem ? onRetry : undefined}
        footer={
          statement ? (
            <>
              <span className="grow" />
              <Button size="sm" heldReason={priceHeld} onClick={() => onPrint?.(state.ref, period)}>
                <Printer size={13} aria-hidden /> {t('statement.print')}
              </Button>
              <Button size="sm" variant="primary" heldReason={sendHeld} onClick={() => setSending(true)}>
                <Mail size={13} aria-hidden /> {t('statement.send')}
              </Button>
            </>
          ) : undefined
        }
      >
        {statement && <StatementBody statement={statement} can={can} prefix={prefix} onPeriod={onPeriod} onCurrency={onCurrency} />}
      </DetailModal>
      {sending && statement && (
        <Modal
          open
          onClose={() => setSending(false)}
          title={t('send.title', { customer: statement.customer.name })}
          size="md"
          footer={
            <>
              <Button size="sm" onClick={() => setSending(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                heldReason={sendHeld}
                onClick={async () => {
                  if (await onSend?.(message)) setSending(false)
                }}
              >
                {t('send.confirm', { count: statement.recipients.length })}
              </Button>
            </>
          }
        >
          <div className="fw-frv-form">
            <p className="fw-frv-muted">
              {t('send.body', {
                from: dayText(statement.from, locale),
                to: dayText(statement.to, locale),
              })}
            </p>
            <ul className="fw-frv-muted">
              {statement.recipients.map((recipient) => (
                <li key={recipient.email}>
                  <b>{recipient.name}</b> — {recipient.email}
                </li>
              ))}
            </ul>
            <Field label={t('send.message')} hint={t('send.messageHint')}>
              <Textarea value={message} maxLength={2000} rows={4} onChange={(event) => setMessage(event.target.value)} />
            </Field>
            {state.sendProblem && <Banner tone="danger" title={t(state.sendProblem)} />}
            <p className="fw-frv-muted">{t('send.fake')}</p>
          </div>
        </Modal>
      )}
    </>
  )
}

function lineHref(line: StatementLine, can: ReceivablesCan, prefix: string): string | null {
  if (line.recordType === 'Invoice' && can.invoices) return `${prefix}/finance/invoices/${encodeURIComponent(line.recordId)}`
  if (line.recordType === 'Payment' && can.payments) return `${prefix}/finance/payments/${encodeURIComponent(line.recordId)}`
  return null
}

/** The statement's body (the DetailModal's; the design case draws the same). */
export function StatementBody({
  statement,
  can,
  prefix,
  onPeriod,
  onCurrency,
}: {
  statement: Statement
  can: ReceivablesCan
  prefix: string
  onPeriod?: (period: { from: string | null; to: string | null }) => void
  onCurrency?: (currency: string) => void
}) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const locale = useLocale()
  const money = (value: number | undefined) => moneyText(value ?? null, statement.currency, locale)
  const totals = statement.totals
  return (
    <div className="fw-frv-detail">
      <div className="fw-frv-period">
        <span className="fw-frv-date">
          <DateField
            value={statement.from}
            max={statement.to}
            locale={locale === 'it' ? 'it-IT' : 'en-GB'}
            ariaLabel={t('statement.from')}
            placeholder={t('statement.from')}
            clearLabel={t('band.clear')}
            onChange={(value) => onPeriod?.({ from: value || null, to: statement.to })}
          />
        </span>
        <span className="fw-frv-muted">→</span>
        <span className="fw-frv-date">
          <DateField
            value={statement.to}
            locale={locale === 'it' ? 'it-IT' : 'en-GB'}
            ariaLabel={t('statement.to')}
            placeholder={t('statement.to')}
            clearLabel={t('band.clear')}
            onChange={(value) => onPeriod?.({ from: statement.from, to: value || null })}
          />
        </span>
        {statement.currencies.length > 0 && (
          <span className="fw-frv-inline">
            <span className="fw-frv-muted">{t('statement.otherCurrencies')}</span>
            {statement.currencies.map((currency) => (
              <Button key={currency} size="sm" onClick={() => onCurrency?.(currency)}>
                {currency}
              </Button>
            ))}
          </span>
        )}
      </div>
      {!can.price && <Banner tone="info" title={t('statement.noPrice', { permission: 'money.price' })} />}
      <div className="fw-frv-pair">
        <Card padded aria-label={t('statement.bridge')}>
          <div className="fw-frv-card">
            <h3 className="fw-frv-h3">{t('statement.bridge')}</h3>
            {can.price && totals ? (
              <dl className="fw-frv-bridge">
                <dt>
                  {t('statement.opening', {
                    date: dayText(statement.from, locale),
                  })}
                </dt>
                <dd>{money(statement.opening)}</dd>
                <dt>{t('statement.invoiced')}</dt>
                <dd>+{money(totals.invoiced)}</dd>
                <dt>{t('statement.credited')}</dt>
                <dd>−{money(totals.credited)}</dd>
                <dt>{t('statement.paid')}</dt>
                <dd>−{money(totals.paid)}</dd>
                {totals.refunded > 0 && (
                  <>
                    <dt>{t('statement.refunded')}</dt>
                    <dd>+{money(totals.refunded)}</dd>
                  </>
                )}
                <dt className="is-total">
                  {t('statement.closing', {
                    date: dayText(statement.to, locale),
                  })}
                </dt>
                <dd className="is-total">{money(statement.closing)}</dd>
              </dl>
            ) : (
              <p className="fw-frv-muted">{t('statement.bridgeNoPrice')}</p>
            )}
            <p className="fw-frv-muted">{t('statement.bridgeNote')}</p>
          </div>
        </Card>
        <Card padded aria-label={t('statement.open')}>
          <div className="fw-frv-card">
            <h3 className="fw-frv-h3">{t('statement.open')}</h3>
            {can.price && statement.ageing && <AgeBar buckets={statement.ageing.buckets} currency={statement.currency} legend />}
            {statement.openItems.length === 0 ? (
              <p className="fw-frv-muted">{t('statement.nothingOpen')}</p>
            ) : (
              <SummaryTable
                label={t('statement.open')}
                stackOnPhone
                columns={[t('col.invoice'), t('col.due'), t('col.age'), ...(can.price ? [t('col.open')] : [])]}
                align={['left', 'left', 'left', 'right']}
                rows={statement.openItems.map((item) => ({
                  id: item.invoiceId,
                  cells: [
                    can.invoices ? (
                      <Link key="n" className="fw-frv-link" href={`${prefix}/finance/invoices/${encodeURIComponent(item.invoiceId)}`}>
                        {item.number}
                      </Link>
                    ) : (
                      item.number
                    ),
                    <span key="d">
                      {dayText(item.dueDate, locale)}
                      {!item.dueDateKnown && <span className="fw-frv-cell-sub"> · {t('statement.dueAssumed')}</span>}
                    </span>,
                    <Tag key="a" tone={bucketTone(item.bucket)}>
                      {item.daysLate > 0 ? t('row.daysLate', { count: item.daysLate }) : t(`bucket.${item.bucket}`)}
                    </Tag>,
                    ...(can.price
                      ? [
                          <span key="o" className="fw-frv-num">
                            {money(item.open)}
                          </span>,
                        ]
                      : []),
                  ],
                }))}
              />
            )}
            <p className="fw-frv-muted">{t('statement.remindersSent', { count: statement.remindersSent })}</p>
          </div>
        </Card>
      </div>
      <Card padded aria-label={t('statement.lines')}>
        <div className="fw-frv-card">
          <h3 className="fw-frv-h3">{t('statement.lines')}</h3>
          {statement.lines.length === 0 ? (
            <p className="fw-frv-muted">{t('statement.noLines')}</p>
          ) : (
            <SummaryTable
              label={t('statement.lines')}
              stackOnPhone
              columns={[t('col.date'), t('col.document'), t('col.due'), ...(can.price ? [t('col.debit'), t('col.credit'), t('col.balance')] : [])]}
              align={['left', 'left', 'left', 'right', 'right', 'right']}
              widths={['14%', undefined, '14%', '14%', '14%', '14%']}
              rows={statement.lines.map((line, index) => {
                const href = lineHref(line, can, prefix)
                const label = t(`kind.${line.kind}`, {
                  reference: line.reference ?? '—',
                })
                return {
                  id: `${line.recordType}-${line.recordId}-${index}`,
                  cells: [
                    dayText(line.date, locale),
                    href ? (
                      <Link key="r" className="fw-frv-link" href={href}>
                        {label}
                      </Link>
                    ) : (
                      label
                    ),
                    dayText(line.dueDate, locale),
                    ...(can.price
                      ? [
                          <span key="d" className="fw-frv-num">
                            {line.debit ? money(line.debit) : ''}
                          </span>,
                          <span key="c" className="fw-frv-num">
                            {line.credit ? money(line.credit) : ''}
                          </span>,
                          <span key="b" className="fw-frv-num">
                            {money(line.balance)}
                          </span>,
                        ]
                      : []),
                  ],
                }
              })}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
