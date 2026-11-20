'use client'

import { Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, promiseHeld } from '../../../model' // F-OP-104: promiseHeld
import { amendHeld } from '../../../daily-model' // F-OP-104
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { readOf } from '../../overview/model'
import { nextDatesOf } from '../../overview/dates'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { DiscussDoor } from '../Discuss' // F-SA-266: Discuss on a next date's row

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O4 Next dates (P16): the next three to come, late first in amber; "All dates ›" opens Production › Dates & milestones.
 * F-OP-104 (10-order-page §3.4): the order's own two dates under them, each with Change… in place — the promise (the Change promise
 * dialog, order or lines) and the requested date (edit mode on Lines, its field focused). Gates and milestones stay read-only.
 */
export function DatesCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210
  const state = model.production ?? null
  const read = readOf(state)
  const rows = nextDatesOf(read?.dates ?? null, null) // F-OP-104: the promise has its own row below
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const promiseWait = promiseHeld(order, model.can)
  const requestedWait = amendHeld(order, model.can)
  const busy = model.busy ? t('held.busy') : null
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.dates.title')}</h2>
        <TabLink className="fw-so-link fw-so-hint" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#dates`}>
          {t('overview.dates.all')}
        </TabLink>
      </div>
      {!state || state.status === 'loading' ? (
        <Skeleton height={44} />
      ) : rows.length === 0 ? (
        <p className="fw-so-hint">{t('overview.dates.none')}</p>
      ) : (
        <ul className="fw-so-datelist">
          {rows.map((row) => {
            // F-SA-266: a gate is discussed by its reference (the customer reads its own words); a date of the working plan or the
            // ex-factory date in an office note, in words.
            const what = row.what.kind === 'gate' ? (row.what.label ?? d(`gate.${row.what.gateKind ?? 'OTHER'}`)) : row.what.kind === 'milestone' ? d(`milestone.kind.${row.what.milestone}`) : t('overview.fact.exFactory')
            const gateId = row.what.kind === 'gate' ? ((read?.dates?.milestones ?? []).find((milestone) => milestone.id === row.id)?.gateId ?? null) : null
            return (
            <li key={row.id}>
              <span className="fw-so-inline">
                {what}
                <DiscussDoor order={order} part={row.target ? `${what} · ${day(row.target)}` : what} target={gateId ? { kind: 'OrderGate', id: gateId } : null} />
              </span>
              <span className="fw-so-cell-sub">
                {row.target ? d('milestone.target', { date: day(row.target) }) : '—'}
                {row.late !== null && row.late > 0 && (
                  <>
                    {' '}
                    <Tag tone="warning">{d('milestone.lateBy', { count: row.late })}</Tag>
                  </>
                )}
              </span>
            </li>
            )
          })}
        </ul>
      )}
      {/* F-OP-104: the order's own dates, each changed in place. */}
      <ul className="fw-so-datelist" aria-label={t('doors.ownDates')}>
        <li>
          <span>{t('dates.promised')}</span>
          <span className="fw-so-inline">
            <span className="fw-so-cell-sub">{order.promiseDate ? day(order.promiseDate) : '—'}</span>
            <Button size="sm" variant="quiet" heldReason={busy ?? (promiseWait ? t(promiseWait.key, promiseWait.params) : null)} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
              {t('doors.change')}
            </Button>
          </span>
        </li>
        <li>
          <span>{t('dates.requested')}</span>
          <span className="fw-so-inline">
            <span className="fw-so-cell-sub">{order.requestedDate ? day(order.requestedDate) : '—'}</span>
            <Button size="sm" variant="quiet" heldReason={busy ?? (requestedWait ? t(requestedWait.key, requestedWait.params) : null)} onClick={() => actions?.onRequestedChange?.()}>
              {t('doors.change')}
            </Button>
          </span>
        </li>
      </ul>
    </Card>
  )
}
