'use client'

import Link from 'next/link'
import { Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { ComparisonView } from '@nexus/factory-domain/receivables-figures/contracts'
import { dayInstant, money } from '../../_shared/model'
import { invoiceHref, orderHref, paymentHref, type Tone } from '../model'
import type { FiguresActions, FiguresModel } from './FiguresSection'

const STATE_TONE: Record<ComparisonView['orders'][number]['state'], Tone> = { SAME: 'success', DIFFERS: 'warning', NOT_FOUND: 'danger', NOTHING_OPEN: 'warning', TWICE: 'warning', ONLY_OURS: 'info' }

/**
 * Their figures vs ours, one customer as of one day (design sec:customer-figures; FIN-135): the balance — theirs, ours, the
 * difference —, then per order and per payment what they say against our documents, each line's state in words (the same,
 * differs by…, not found with us, nothing open with us, listed twice, only ours) and its difference (theirs − ours, the
 * price grain). Who recorded them and when, their note, the statement kept (opened through the files' download, files.read).
 * "Correct…" opens the same form with their figures (held without the right or the price grain).
 */
export function FiguresDetail({ model, prefix, actions }: { model: FiguresModel; prefix: string; actions?: FiguresActions }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const open = model.open!
  const answer = open.answer
  const can = model.can
  const currency = answer?.figures.currency ?? 'EUR'
  const amount = (minor: number | undefined) => (can.price ? money(minor === undefined ? null : minor, currency, locale) : '—')
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const correctHeld = !answer ? t('held.busy') : !answer.figures.can.correct ? t('held.figures') : !can.price ? t('held.figuresPrice') : null
  const footer = (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onCloseOpen?.()}>
        {t('common.close')}
      </Button>
      <Button size="sm" variant="primary" heldReason={correctHeld} onClick={() => actions?.onCorrect?.()}>
        {t('figures.correct')}
      </Button>
    </>
  )
  const title = answer ? t('figures.detailTitle', { customer: answer.figures.customer.name, date: day(answer.figures.asOf) }) : t('figures.title')
  return (
    <Modal open onClose={() => actions?.onCloseOpen?.()} title={title} size="xl" footer={footer}>
      <div className="fw-bank-dialog">
        {open.problem ? (
          <EmptyState
            title={t('figures.openFailed')}
            description={t(open.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('open')}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : !answer ? (
          <p className="fw-bank-muted" role="status">
            <Spinner size={12} /> {t('figures.reading')}
          </p>
        ) : (
          <>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('figures.col.customer'), value: `${answer.figures.customer.name} (${answer.figures.customer.code})` },
                { label: t('figures.col.asOf'), value: day(answer.figures.asOf) },
                { label: t('figures.recorded'), value: t('figures.recordedBy', { name: answer.figures.createdBy?.name ?? t('figures.someone'), date: formatDateTime(answer.figures.createdAt, { locale }) }) },
                {
                  label: t('figures.col.file'),
                  value: answer.figures.file ? (
                    <Button size="sm" variant="link" heldReason={can.filesRead ? null : t('held.filesRead')} onClick={() => actions?.onDownload?.(answer.figures.file!.id)}>
                      {answer.figures.file.name}
                    </Button>
                  ) : (
                    t('figures.noFile')
                  ),
                },
                ...(answer.figures.note ? [{ label: t('figures.note'), value: answer.figures.note }] : []),
              ]}
            />
            <Card padded className="fw-bank-card">
              <div className="fw-bank-balance">
                <span className="fw-bank-stack">
                  <span className="fw-bank-muted">{t('figures.theirBalance')}</span>
                  <b className="fw-bank-num">{amount(answer.comparison.balance.theirs)}</b>
                </span>
                <span className="fw-bank-stack">
                  <span className="fw-bank-muted">{t('figures.ourBalance')}</span>
                  <b className="fw-bank-num">{amount(answer.comparison.balance.ours)}</b>
                </span>
                <span className="fw-bank-stack">
                  <span className="fw-bank-muted">{t('figures.col.difference')}</span>
                  <b className="fw-bank-num">{amount(answer.comparison.balance.difference)}</b>
                </span>
                <Pill tone={answer.comparison.differences === 0 ? 'success' : 'warning'}>{answer.comparison.differences === 0 ? t('figures.agrees') : t('figures.differs', { count: answer.comparison.differences })}</Pill>
              </div>
              <p className="fw-bank-muted">{t('figures.balanceHint')}</p>
            </Card>

            <h3 className="fw-bank-h3">{t('figures.orders')}</h3>
            {answer.comparison.orders.length === 0 ? (
              <p className="fw-bank-muted">{t('figures.noOrders')}</p>
            ) : (
              <SummaryTable
                label={t('figures.orders')}
                stackOnPhone
                columns={[t('figures.col.theirReference'), t('figures.col.theirs'), t('figures.col.ours'), t('figures.col.open'), t('figures.col.difference'), t('figures.col.state')]}
                align={['left', 'right', 'left', 'right', 'right', 'left']}
                widths={['22%', '12%', '24%', '12%', '12%', undefined]}
                rows={answer.comparison.orders.map((line, index) => ({
                  id: `${line.index ?? 'o'}-${index}`,
                  cells: [
                    line.reference ?? <span className="nds-summary-sub">{t('figures.notListed')}</span>,
                    line.index === null ? '—' : amount(line.theirs),
                    line.ours ? (
                      <span key="ours" className="fw-bank-stack">
                        {line.ours.kind === 'ORDER' ? (
                          <Link className="fw-bank-link" href={orderHref(prefix, line.ours.id)}>
                            {t('figures.order', { number: line.ours.number })}
                          </Link>
                        ) : (
                          <Link className="fw-bank-link" href={invoiceHref(prefix, line.ours.id)}>
                            {t('panel.invoice', { number: line.ours.number })}
                          </Link>
                        )}
                        {line.ours.kind === 'ORDER' && line.ours.invoices.length > 0 && <span className="nds-summary-sub">{line.ours.invoices.map((invoice) => invoice.number).join(', ')}</span>}
                      </span>
                    ) : (
                      '—'
                    ),
                    line.ours ? amount(line.ours.open) : '—',
                    amount(line.difference),
                    <Pill key="state" tone={STATE_TONE[line.state]}>
                      {t(`figures.state.${line.state}`)}
                    </Pill>,
                  ],
                }))}
              />
            )}

            <h3 className="fw-bank-h3">{t('figures.payments')}</h3>
            <p className="fw-bank-muted">{answer.comparison.paymentsFrom ? t('figures.paymentsFrom', { date: day(answer.comparison.paymentsFrom) }) : t('figures.paymentsNone')}</p>
            {answer.comparison.payments.length > 0 && (
              <SummaryTable
                label={t('figures.payments')}
                stackOnPhone
                columns={[t('figures.col.theirReference'), t('figures.col.day'), t('figures.col.theirs'), t('figures.col.ours'), t('figures.col.ourAmount'), t('figures.col.difference'), t('figures.col.state')]}
                align={['left', 'left', 'right', 'left', 'right', 'right', 'left']}
                widths={['18%', '11%', '11%', '22%', '11%', '11%', undefined]}
                rows={answer.comparison.payments.map((line, index) => ({
                  id: `${line.index ?? 'p'}-${index}`,
                  cells: [
                    line.reference ?? <span className="nds-summary-sub">{t('figures.notListed')}</span>,
                    day(line.date),
                    line.index === null ? '—' : amount(line.theirs),
                    line.ours ? (
                      <span key="ours" className="fw-bank-stack">
                        <Link className="fw-bank-link" href={paymentHref(prefix, line.ours.id)}>
                          {line.ours.reference}
                        </Link>
                        <span className="nds-summary-sub">{`${day(line.ours.receivedOn)}${line.foundBy ? ` · ${t(`figures.foundBy.${line.foundBy}`)}` : ''}`}</span>
                      </span>
                    ) : (
                      '—'
                    ),
                    line.ours ? amount(line.ours.amount) : '—',
                    amount(line.difference),
                    <Pill key="state" tone={STATE_TONE[line.state]}>
                      {t(`figures.state.${line.state}`)}
                    </Pill>,
                  ],
                }))}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
