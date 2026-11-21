'use client'

import type { ReactNode } from 'react'
import { Layers } from 'lucide-react'
import { type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, promiseHeld } from '../../../model'
import { amendHeld } from '../../../daily-model'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { RePromiseNotices } from '../../links/view/OrderLinks'
import { orderWaitingOf, readOf } from '../../overview/model'
import { ageWordsOf, decideDialogOf, planningGateHref, refusedDatesOf } from '../../overview/dates'
import { byLineOf, onTimeOf } from '../../production/by-line'
import { keyDatesOf, type ReadyTile } from '../../production/dates'
import { promiseHistoryOf } from '../../production/history'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { DiscussDoor } from '../Discuss'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { LineMenuButton } from '../LineMenu'
import { Quiet, Section } from './Kit'
import { PromiseHistory } from './PromiseHistory'
import { StepsBlock } from './StepsBlock'

/**
 * F-PT-201 … F-PT-204 (order PRODUCTION tab, 10-design §5) — "Dates & plan" (#dates): Dates, Milestones and Promise moves in ONE
 * section. The head says the promise, what the plan says and the gap — no second health word (Production now's). Block A: the key
 * dates side by side, each with its own door (Customer asked · We promised: their ONE dialogs, hidden without orders.manage and held
 * in words by the order's state; Plan says ready: the line forecast and Planning ›; Customer sees; Shipped), then planning's new-date
 * proposal (Accept / Decline… — the same notices the page banner showed: on this tab they live here) and a new date the customer
 * refused (Decide…). Block B: the steps (StepsBlock). Block C: by line. Block D: the promise history (PromiseHistory) — beside by
 * line when the section is wide and the promise moved, else under it.
 */
export function DatesSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const read = readOf(model.production)
  const headline = read?.headline ?? null
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const keys = keyDatesOf(order, read, headline)
  const busy = model.busy ? t('held.busy') : null
  const promiseWait = promiseHeld(order, model.can)
  const requestedWait = amendHeld(order, model.can)
  const gap = keys.ready.kind === 'day' && keys.ready.days !== null && keys.ready.days !== 0 ? (keys.ready.days > 0 ? d('forecast.short', { count: keys.ready.days }) : d('forecast.spare', { count: -keys.ready.days })) : null
  const answer = keys.promised ? [t('productionTab.dates.answerPromised', { date: day(keys.promised.date) }), keys.ready.kind === 'day' ? t('productionTab.dates.answerReady', { date: day(keys.ready.date) }) : null, gap].filter(Boolean).join(' · ') : t('productionTab.dates.answerNoPromise')
  // F-OO-143: the refused new dates come from the ONE waiting list (the same call as Overview's card and the band).
  const waiting = orderWaitingOf(order, model, locale)
  const refused = waiting.status === 'ready' ? refusedDatesOf(waiting.dates, model.today) : []
  const moved = promiseHistoryOf(order.promiseHistory).moves.length > 0

  const readyWords = (ready: ReadyTile): { value: string; tag: ReactNode } => {
    if (ready.kind === 'reading') return { value: d('forecast.reading'), tag: null }
    if (ready.kind === 'withheld') return { value: t('productionTab.dates.readyWithheld'), tag: null }
    if (ready.kind === 'none') return { value: t('dates.planNone'), tag: null }
    const days = ready.days
    // B7: short (danger) or spare (success) against the promise, in the forecast's own words.
    return { value: day(ready.date), tag: days === null || days === 0 ? null : <Tag tone={days > 0 ? 'danger' : 'success'}>{d(days > 0 ? 'forecast.short' : 'forecast.spare', { count: Math.abs(days) })}</Tag> }
  }
  const ready = readyWords(keys.ready)
  const sees = keys.sees
  const tiles: { id: string; label: string; value: string; words?: boolean; sub?: ReactNode; door?: ReactNode }[] = [
    {
      id: 'asked',
      label: t('productionTab.dates.asked'),
      value: keys.asked ? day(keys.asked) : '—',
      // The requested date's ONE dialog (an amendment that applies at once) — hidden without orders.manage (L9), held by the state.
      door: model.can.manage ? (
        <Button size="sm" variant="quiet" heldReason={busy ?? (requestedWait ? t(requestedWait.key, requestedWait.params) : null)} onClick={() => actions?.onRequestedChange?.()}>
          {t('doors.change')}
        </Button>
      ) : undefined,
    },
    {
      id: 'promised',
      label: t('productionTab.dates.promised'),
      value: keys.promised ? day(keys.promised.date) : '—',
      sub: keys.promised ? (keys.promised.moves > 0 ? [t('productionTab.dates.moved', { count: keys.promised.moves }), keys.promised.first ? t('productionTab.dates.first', { date: day(keys.promised.first) }) : null].filter(Boolean).join(' · ') : t('productionTab.dates.neverMoved')) : undefined,
      // The ONE promise dialog (the whole order or chosen lines; its hint says the portal tells the customer, B14).
      door: model.can.manage ? (
        <Button size="sm" variant="quiet" heldReason={busy ?? (promiseWait ? t(promiseWait.key, promiseWait.params) : null)} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
          {t('doors.change')}
        </Button>
      ) : undefined,
    },
    {
      id: 'ready',
      label: t('dates.planSays'),
      value: ready.value,
      words: keys.ready.kind !== 'day',
      sub: ready.tag,
      door: model.gateActs?.can.view ? (
        <a className="fw-pt-link" href={planningGateHref(model.prefix, order.number, null)}>
          {t('productionTab.dates.planning')}
        </a>
      ) : undefined,
    },
    ...(sees.kind === 'unknown'
      ? []
      : [
          {
            id: 'sees',
            label: t('productionTab.dates.sees'),
            value: sees.kind === 'days' ? t('productionTab.dates.seesDays', { cut: sees.cut ? day(sees.cut) : '—', sew: sees.sew ? day(sees.sew) : '—', finish: sees.finish ? day(sees.finish) : '—' }) : t('productionTab.dates.seesPromise'),
            words: true,
          },
        ]),
    {
      id: 'shipped',
      label: t('productionTab.dates.shipped'),
      value:
        keys.shipped.shipments.length === 0
          ? t('productionTab.dates.nothingShipped')
          : keys.shipped.shipments.map((shipment) => `${shipment.number} · ${shipment.deliveredAt ? t('dates.shippedDelivered', { shipped: formatDate(shipment.shippedAt, { locale }), delivered: formatDate(shipment.deliveredAt, { locale }) }) : t('dates.shippedOn', { shipped: formatDate(shipment.shippedAt, { locale }) })}`).join(' · '),
      words: true,
    },
  ]
  const customer = order.party?.legalName ?? ''

  return (
    <Section id="dates" title={t('productionTab.dates.title')} answer={answer} info={<p>{t('productionTab.dates.infoBody')}</p>}>
      <div className="fw-pt-tiles">
        {tiles.map((tile) => (
          <div key={tile.id} className="fw-pt-tile">
            <span className="fw-pt-label">{tile.label}</span>
            <span className={tile.words ? 'fw-pt-tile-v is-words' : 'fw-pt-tile-v'}>{tile.value}</span>
            {tile.sub ? <span className="fw-pt-sub">{tile.sub}</span> : null}
            {tile.door ? <span className="fw-pt-tile-d">{tile.door}</span> : null}
          </div>
        ))}
      </div>
      {/* Planning's new-date proposals (Accept / Decline…): the page's own notices, here on this tab (the banner steps back). */}
      <RePromiseNotices model={model.links} actions={actions?.links} />
      {/* F-OO-143: a new date the customer refused — Decide… opens the ONE promise dialog with the refusal named. */}
      {refused.map((row) => (
        <p key={row.key} className="fw-pt-hint">
          <span>{[t('waiting.repromise', { customer }), row.age === null ? null : t(ageWordsOf(row.age).key, ageWordsOf(row.age).params)].filter(Boolean).join(' · ')}</span>
          {model.can.manage ? (
            <Button size="sm" variant="quiet" heldReason={busy ?? (promiseWait ? t(promiseWait.key, promiseWait.params) : null)} onClick={() => actions?.onDialog?.(decideDialogOf(row))}>
              {t('dates.decide')}
            </Button>
          ) : null}
        </p>
      ))}
      <StepsBlock order={order} model={model} actions={actions} />
      <div className={moved ? 'fw-pt-cd is-pair' : 'fw-pt-cd'}>
        <ByLine order={order} model={model} actions={actions} />
        <PromiseHistory order={order} model={model} actions={actions} />
      </div>
    </Section>
  )
}

/** F-PT-203: by line — Line · Asked · Promised · Ready · On time?, the worst first; charge lines out (one note); sizes fold. */
function ByLine({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const read = readOf(model.production)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const withheld = !read || read.withheld.includes('dates.forecast')
  const view = byLineOf(order, read?.dates ?? null, withheld)
  const promiseWait = promiseHeld(order, model.can)
  const frame = useRecordFrame()
  const dayOf = (value: { date: string; own: boolean } | null) => (value ? (value.own ? day(value.date) : t('dates.asOrder', { date: day(value.date) })) : '—')
  // fx9 N2: the Actions column only when a row has something in it (a Discuss door or a ⋯) — Read-only has neither.
  const mayDiscuss = !!frame?.discuss && model.people?.mayNote !== false
  const withActs = mayDiscuss || !!model.can.manage
  return (
    <div className="fw-pt-blk">
      <h3 className="fw-pt-h3">
        <Layers size={14} aria-hidden /> {t('productionTab.byLine.title')}
      </h3>
      <table className="fw-pt-table">
        <thead>
          <tr>
            <th scope="col">{t('productionTab.byLine.col.line')}</th>
            <th scope="col">{t('productionTab.byLine.col.asked')}</th>
            <th scope="col">{t('productionTab.byLine.col.promised')}</th>
            {!view.withheld ? <th scope="col">{t('productionTab.byLine.col.ready')}</th> : null}
            {!view.withheld ? <th scope="col">{t('dates.col.state')}</th> : null}
            {withActs ? (
              <th scope="col" className="fw-pt-x">
                <span className="fw-pt-sub">{t('wo.col.acts')}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => {
            const onTime = onTimeOf(row)
            const name = t('discuss.line', { seq: row.seq, name: row.label })
            const items: MenuItemDef[] = model.can.manage ? [{ id: 'promise', label: t('productionTab.byLine.changeLine'), disabled: !!promiseWait, description: promiseWait ? t(promiseWait.key, promiseWait.params) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'promise', lineIds: [row.lineId] }) }] : []
            return (
              <tr key={row.lineId} id={`about-SalesOrderLine-${row.lineId}`}>
                <td className="fw-pt-first">
                  {/* F-OP-115: an older address #line-<lineId> still lands on the line's row. */}
                  <span className="fw-so-anchor" id={`line-${row.lineId}`} tabIndex={-1}>
                    {name}
                  </span>
                  {row.sizes.length > 0 ? <span className="fw-pt-sub">{t('productionTab.byLine.sizes', { sizes: row.sizes.map((group) => t('productionTab.byLine.sizeDay', { sizes: group.sizes, date: group.finish ? day(group.finish) : d('forecast.unknown') })).join(' · ') })}</span> : null}
                </td>
                <td data-label={t('productionTab.byLine.col.asked')}>{dayOf(row.asked)}</td>
                <td data-label={t('productionTab.byLine.col.promised')}>{dayOf(row.promised)}</td>
                {!view.withheld ? (
                  <td data-label={t('productionTab.byLine.col.ready')}>
                    {row.ready ? (row.ready.finish ? day(row.ready.finish) : d('forecast.unknown')) : d('forecast.none')}
                    {row.ready ? <span className="fw-pt-sub">{d(`finish.${row.ready.source}`)}</span> : null}
                  </td>
                ) : null}
                {!view.withheld ? <td data-label={t('dates.col.state')}>{onTime ? <Tag tone={onTime.kind === 'short' ? 'danger' : 'success'}>{d(onTime.kind === 'short' ? 'forecast.short' : 'forecast.spare', { count: onTime.days })}</Tag> : null}</td> : null}
                {withActs ? (
                  <td className="fw-pt-x">
                    {/* A line's dates are discussed by its reference (the customer reads its own words, never a price). */}
                    {mayDiscuss ? <DiscussDoor order={order} part={name} target={{ kind: 'SalesOrderLine', id: row.lineId }} align="end" /> : null}
                    {items.length > 0 ? <LineMenuButton label={t('productionTab.byLine.more', { seq: row.seq })} items={items} /> : null}
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
      {view.withheld && read ? <Quiet>{t('productionTab.dates.readyWithheld')}</Quiet> : null}
      {view.charges > 0 ? <p className="fw-pt-hint">{t('productionTab.byLine.charges', { count: view.charges })}</p> : null}
    </div>
  )
}
