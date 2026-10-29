'use client'

import Link from 'next/link'
import { CheckCircle2, Clock, Factory, XCircle } from 'lucide-react'
import { Card, EmptyState, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { money } from '../../../quotes/model'
import type { Order, OrderWorkOrder } from '../../api'
import { dayInstant, depositGate, linesNotInProduction, nextStep } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'

const WO_TONE = { DRAFT: 'neutral', RELEASED: 'info', IN_PROGRESS: 'info', COMPLETED: 'success', CLOSED: 'neutral', CANCELLED: 'danger' } as const

/**
 * Production (design `order.prod.gate` + `order.prod.wos`): the deposit gate in words — production waits for the
 * deposit (due …), or may start (paid on …), or needs none — and the work orders that make the order's lines with their
 * floor progress (cut · sewn · finished, totals per work order: no person's output), state, due date and site; the lines
 * no work order covers yet; "Make work orders" opens Production's New work order with this order chosen. The Owner's
 * override of the gate (reason, step-up) waits for its API.
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const gate = depositGate(order)
  const request = gate.request
  const step = nextStep(order, model.can)
  const uncovered = linesNotInProduction(order)
  const makeHref = `${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(order.number)}`
  const mayMake = order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION'
  const makeHeld = !model.can.makeWorkOrders ? t('held.noWorkOrders') : order.status === 'CONFIRMED' && step.held ? t(step.held.key, step.held.params?.date ? { date: formatDate(dayInstant(String(step.held.params.date)), { locale }) } : step.held.params) : null
  const workOrderHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'WorkOrder', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`

  return (
    <div className="fw-so-stack">
      <Card padded>
        <div className="fw-so-gate">
          {gate.state === 'PAID' || gate.state === 'WAIVED' || gate.state === 'NOT_NEEDED' ? (
            <CheckCircle2 size={18} className="fw-so-ico is-ok" aria-hidden />
          ) : gate.state === 'MISSING' ? (
            <XCircle size={18} className="fw-so-ico is-blocked" aria-hidden />
          ) : (
            <Clock size={18} className="fw-so-ico is-waiting" aria-hidden />
          )}
          <div className="fw-so-gate-body">
            <h2 className="fw-so-h2">{t('gate.title')}</h2>
            <p className="fw-so-gate-words">
              {gate.state === 'WAITING' && request
                ? t('gate.waiting', { date: formatDate(dayInstant(request.dueDate), { locale }) })
                : gate.state === 'PAID' && request?.paidAt
                  ? t('gate.paid', { date: formatDate(request.paidAt, { locale }) })
                  : t(`gate.${gate.state === 'PAID' ? 'paidNoDate' : gate.state === 'WAIVED' ? 'waived' : gate.state === 'MISSING' ? 'missing' : 'notNeeded'}`)}
            </p>
            {request && model.can.price && request.amount !== undefined && <p className="fw-so-hint">{t('gate.amount', { amount: money(request.amount, request.currency, locale), kind: t(`depositKind.${request.kind}`) })}</p>}
          </div>
          {request && (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/sales/orders/${order.id}?tab=money`}>{t('gate.open')}</Link>
            </Button>
          )}
        </div>
      </Card>

      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('production.title')}</h2>
          {mayMake &&
            (makeHeld ? (
              <Button size="sm" variant="primary" heldReason={makeHeld}>
                <Factory size={14} aria-hidden /> {t('step.makeWorkOrders')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" asChild>
                <Link href={makeHref}>
                  <Factory size={14} aria-hidden /> {t('step.makeWorkOrders')}
                </Link>
              </Button>
            ))}
        </div>
        {model.workOrders === null ? (
          order.chain.workOrders.length === 0 ? (
            <EmptyState title={t('production.empty.title')} description={t('production.empty.body')} />
          ) : (
            <SummaryTable
              label={t('production.title')}
              columns={[t('production.col.number'), t('production.col.status'), t('production.col.released')]}
              rows={order.chain.workOrders.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-so-link" href={workOrderHref(row)}>
                    {row.number}
                  </Link>,
                  <Pill key="s" tone={WO_TONE[row.status as keyof typeof WO_TONE] ?? 'neutral'}>{t(`woStatus.${row.status}`)}</Pill>,
                  row.releasedAt ? formatDate(row.releasedAt, { locale }) : '—',
                ],
              }))}
              density="roomy"
              stackOnPhone
            />
          )
        ) : model.workOrders.value === null ? (
          <PartState problem={model.workOrders.problem} label={t('production.title')} onRetry={() => actions?.onRetryPart?.('workOrders')} />
        ) : model.workOrders.value.length === 0 ? (
          <EmptyState title={t('production.empty.title')} description={t('production.empty.body')} />
        ) : (
          <WorkOrdersTable rows={model.workOrders.value} href={workOrderHref} />
        )}
        {uncovered > 0 && mayMake && <p className="fw-so-hint">{t('production.uncovered', { count: uncovered })}</p>}
        {model.workOrders === null && <p className="fw-so-hint">{t('production.noProgressRight')}</p>}
      </Card>
    </div>
  )
}

function WorkOrdersTable({ rows, href }: { rows: OrderWorkOrder[]; href: (row: { id: string; number: string }) => string }) {
  const t = useT('orders')
  const locale = useLocale()
  return (
    <SummaryTable
      label={t('production.title')}
      columns={[t('production.col.number'), t('production.col.style'), t('production.col.pieces'), t('production.col.status'), t('production.col.progress'), t('production.col.due'), t('production.col.site')]}
      rows={rows.map((row) => {
        const finished = row.progress?.finished ?? null
        return {
          id: row.id,
          cells: [
            <Link key="n" className="fw-so-link" href={href(row)}>
              {row.number}
            </Link>,
            <span key="st" className="fw-so-cell">
              <span>{row.styleCode}</span>
              <span className="fw-so-cell-sub">{row.colourways.join(', ')}</span>
            </span>,
            String(row.pieces),
            <Pill key="s" tone={WO_TONE[row.status]}>{t(`woStatus.${row.status}`)}</Pill>,
            <span key="p" className="fw-so-progress">
              <ProgressBar value={row.status === 'DRAFT' || finished === null || row.pieces === 0 ? null : Math.round((finished / row.pieces) * 100)} ariaLabel={t('production.progressLabel', { number: row.number })} height={6} />
              <span className="fw-so-cell-sub">{row.progress ? t('production.progress', { cut: row.progress.cut ?? 0, sewn: row.progress.sewn ?? 0, finished: row.progress.finished ?? 0, pieces: row.pieces }) : t('production.notReleased')}</span>
            </span>,
            row.dueDate ? (
              <span key="d" className="fw-so-inline">
                {formatDate(dayInstant(row.dueDate), { locale })}
                {row.daysLate !== null && row.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag>}
              </span>
            ) : (
              '—'
            ),
            row.siteCode,
          ],
        }
      })}
      density="roomy"
      stackOnPhone
      align={['left', 'left', 'right', 'left', 'left', 'right', 'left']}
    />
  )
}
