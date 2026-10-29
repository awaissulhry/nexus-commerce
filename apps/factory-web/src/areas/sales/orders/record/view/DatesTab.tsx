'use client'

import { CalendarClock } from 'lucide-react'
import { Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import { dayInstant, daysUntil, isFinal, nextStep, promiseHeld } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * Dates & promise (design `order.dates.lines` + `order.dates.history`): the order's dates (ordered, requested, promised,
 * first promised — it never changes — and how late or early), each line's own dates when they differ, late lines
 * first, "Change promise date…" for the order or chosen lines (a dialog with the reason), and every promise change with
 * who, when, from → to, for which lines and why. Telling the customer is a message in Activity (W1: no preview here).
 */
export function DatesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const held = promiseHeld(order, model.can)
  const nameOf = (id: string) => order.people.find((person) => person.id === id)?.name ?? t('dates.someone')
  const lineName = (id: string) => {
    const line = order.lines.find((entry) => entry.id === id)
    return line ? `${line.style?.code ?? '—'} ${line.colourway?.code ?? ''}`.trim() : '—'
  }
  const lateness = (promise: string | null) => {
    if (!promise || isFinal(order) || order.status === 'SHIPPED') return null
    const days = daysUntil(promise, model.today)
    return days < 0 ? <Tag tone="danger">{t('dates.late', { count: -days })}</Tag> : <Tag tone="neutral">{t('dates.left', { count: days })}</Tag>
  }
  const lines = [...order.lines].sort((a, b) => (a.promiseDate ?? order.promiseDate ?? '9999').localeCompare(b.promiseDate ?? order.promiseDate ?? '9999') || a.seq - b.seq)

  return (
    <div className="fw-so-cards fw-so-cards--wide">
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('dates.title')}</h2>
          {/* The band's primary is this same action while the order is in production: one button, not two. */}
          {!isFinal(order) && nextStep(order, model.can).kind !== 'changePromise' && (
            <Button size="sm" heldReason={held ? t(held.key) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
              <CalendarClock size={14} aria-hidden /> {t('action.promise')}
            </Button>
          )}
        </div>
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('dates.ordered'), value: day(order.orderDate) },
            { label: t('dates.requested'), value: day(order.requestedDate) },
            {
              label: t('dates.promised'),
              value: (
                <span className="fw-so-inline">
                  {day(order.promiseDate)} {lateness(order.promiseDate)}
                </span>
              ),
            },
            { label: t('dates.firstPromised'), value: day(order.originalPromiseDate) },
          ]}
        />
        <SummaryTable
          label={t('dates.linesLabel')}
          columns={[t('dates.col.line'), t('dates.col.requested'), t('dates.col.promised'), t('dates.col.state')]}
          rows={lines.map((line) => ({
            id: line.id,
            cells: [
              `${line.style?.code ?? '—'} · ${line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—'}`,
              day(line.requestedDate ?? order.requestedDate),
              line.promiseDate ? day(line.promiseDate) : t('dates.asOrder', { date: day(order.promiseDate) }),
              lateness(line.promiseDate ?? order.promiseDate) ?? '—',
            ],
          }))}
          density="roomy"
          stackOnPhone
          align={['left', 'right', 'right', 'right']}
        />
      </Card>
      <Card padded>
        <h2 className="fw-so-h2">{t('dates.historyTitle')}</h2>
        {order.promiseHistory.length === 0 ? (
          <EmptyState title={t('dates.never')} description={t('dates.neverBody')} />
        ) : (
          <SummaryTable
            label={t('dates.historyTitle')}
            columns={[t('dates.col.when'), t('dates.col.who'), t('dates.col.change'), t('dates.col.reason')]}
            rows={order.promiseHistory.map((entry, index) => ({
              id: `${entry.at}-${index}`,
              cells: [
                formatDateTime(entry.at, { locale }),
                nameOf(entry.actorId),
                <span key="c" className="fw-so-cell">
                  <span>{t('dates.fromTo', { from: day(entry.from), to: day(entry.to) })}</span>
                  <span className="fw-so-cell-sub">{entry.lineIds.length === 0 ? t('dates.wholeOrder') : entry.lineIds.map(lineName).join(', ')}</span>
                </span>,
                entry.reason ?? '—',
              ],
            }))}
            density="roomy"
            stackOnPhone
            align={['left', 'left', 'left', 'left']}
          />
        )}
      </Card>
    </div>
  )
}
