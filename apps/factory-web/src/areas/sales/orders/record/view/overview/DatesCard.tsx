'use client'

import { Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, promiseHeld, readOnlyOnPage } from '../../../model' // F-OP-104: promiseHeld; F-OO-141: Read-only sees no moves (the band's rule)
import { amendHeld } from '../../../daily-model' // F-OP-104
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { readOf } from '../../overview/model'
import { nextDatesOf, planSaysOf, planWarns, promiseRowOf, type PlanSays } from '../../overview/dates'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { DiscussDoor } from '../Discuss' // F-SA-266: Discuss on a next date's row
import './dates.css' // F-OO-141: the card's own rows

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O4 Next dates (P16): "All dates ›" opens Production › Dates & milestones. F-OP-104 (10-order-page §3.4): the order's own two
 * dates, each with Change… in place — the promise (the ONE Change promise dialog, order or lines) and the requested date (edit
 * mode on Lines, its field focused, until F-OO-144's own dialog). Gates stay read-only here.
 *
 * F-OO-141 (10-design §4; review F8): one aligned list — Promised (ex-factory) first, how often it moved, and its Change…; under it
 * "Plan says ready" (derived from the published plan, "(from the plan)", amber when it ends after the promise); Requested by
 * customer with its Change…; then the open gates (late first), parted by a rule. The shipping milestone (its target IS the promise)
 * and "Production start" are not listed; with no open gate the gates' block is left out (no "No dates set yet"). Read-only sees no
 * Change…; a failed read says so with Try again (the order's own dates still show).
 */
export function DatesCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210
  const state = model.production ?? null
  const read = readOf(state)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const promise = promiseRowOf(order, read?.headline ?? null)
  const plan = planSaysOf(order, promise?.date ?? null, read?.dates ?? null)
  const gates = nextDatesOf(read?.dates ?? null)
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const promiseWait = promiseHeld(order, model.can)
  const requestedWait = amendHeld(order, model.can)
  const busy = model.busy ? t('held.busy') : null
  const planWords = (value: PlanSays): string => {
    if (value.kind === 'none') return t('dates.planNone')
    if (value.kind === 'plain') return day(value.date)
    if (value.kind === 'same') return t('dates.planSame', { date: day(value.date) })
    return t(value.kind === 'after' ? 'dates.planAfter' : 'dates.planBefore', { date: day(value.date), days: value.days })
  }
  return (
    <Card padded className="fw-so-dates">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.dates.title')}</h2>
        <TabLink className="fw-so-link fw-so-hint" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#dates`}>
          {t('overview.dates.all')}
        </TabLink>
      </div>
      <div className="fw-so-dates-grid">
        {/* F-OP-104: the order's own dates, each changed in place; F-OO-141: the promise first, what the plan says under it. */}
        <ul className="fw-so-dates-rows" aria-label={t('doors.ownDates')}>
          <li className="fw-so-ov-row">
            <span className="fw-so-dates-label">{t('dates.promisedExFactory')}</span>
            <span>{promise ? (promise.moved ? t(promise.moved.key, { ...promise.moved.params, date: day(promise.date) }) : day(promise.date)) : '—'}</span>
            {!readOnly && (
              <span className="fw-so-ov-doors">
                <Button size="sm" variant="quiet" heldReason={busy ?? (promiseWait ? t(promiseWait.key, promiseWait.params) : null)} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
                  {t('doors.change')}
                </Button>
              </span>
            )}
          </li>
          {plan && (
            <li className="fw-so-ov-row">
              <span className="fw-so-dates-label is-under">{t('dates.planSays')}</span>
              <span className={planWarns(plan) ? 'fw-so-dates-warn' : undefined}>{planWords(plan)}</span>
              <span className="fw-so-ov-doors fw-so-hint">{t('dates.fromPlan')}</span>
            </li>
          )}
          <li className="fw-so-ov-row">
            <span className="fw-so-dates-label">{t('dates.requestedByCustomer')}</span>
            <span>{order.requestedDate ? day(order.requestedDate) : '—'}</span>
            {!readOnly && (
              <span className="fw-so-ov-doors">
                <Button size="sm" variant="quiet" heldReason={busy ?? (requestedWait ? t(requestedWait.key, requestedWait.params) : null)} onClick={() => actions?.onRequestedChange?.()}>
                  {t('doors.change')}
                </Button>
              </span>
            )}
          </li>
        </ul>
        {/* The order's open gates (late first, three at most); while read: a line; a failed read: said, with Try again. */}
        {state?.status === 'failed' ? (
          <ul className="fw-so-dates-rows is-gates">
            <li className="fw-so-dates-note">
              <span className="fw-so-hint">{d('milestone.failed')}</span>{' '}
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetryProduction?.()}>
                {t('common.retry')}
              </Button>
            </li>
          </ul>
        ) : !read ? (
          <ul className="fw-so-dates-rows is-gates" aria-busy="true">
            <li className="fw-so-dates-note">
              <Skeleton height={22} />
            </li>
          </ul>
        ) : gates.length > 0 ? (
          <ul className="fw-so-dates-rows is-gates" aria-label={d('milestone.title')}>
            {gates.map((row) => {
              // F-SA-266: a gate is discussed by its reference (the customer reads its own words).
              const what = row.label ?? d(`gate.${row.gateKind ?? 'OTHER'}`)
              const gateId = row.gateId
              return (
                <li key={row.id} className="fw-so-ov-row">
                  <span className="fw-so-dates-label">{what}</span>
                  <span>
                    {row.target ? d('milestone.target', { date: day(row.target) }) : '—'}
                    {row.late !== null && row.late > 0 && (
                      <>
                        {' '}
                        <Tag tone="warning">{d('milestone.lateBy', { count: row.late })}</Tag>
                      </>
                    )}
                  </span>
                  <span className="fw-so-ov-doors">
                    <DiscussDoor order={order} part={row.target ? `${what} · ${day(row.target)}` : what} target={gateId ? { kind: 'OrderGate', id: gateId } : null} />
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  )
}
