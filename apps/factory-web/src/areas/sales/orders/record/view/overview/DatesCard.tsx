'use client'

import { Card, Menu, type MenuItemDef } from '@nexus/ui/components' // F-OO-145: a gate's More ▾
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { dayInstant, promiseHeld, readOnlyOnPage, type Phrase } from '../../../model' // F-OP-104: promiseHeld; F-OO-141: Read-only sees no moves (the band's rule)
import { amendHeld } from '../../../daily-model' // F-OP-104
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { readOf } from '../../overview/model'
import { planSaysOf, planWarns, promiseRowOf, type PlanSays } from '../../overview/dates'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import './dates.css' // F-OO-141: the card's own rows
// ---- F-OO-143: the new date the customer refused (the ONE waiting list's DATE row) and Decide… (the ONE promise dialog) ----
import type { WaitingState } from '../../overview/model'
import { ageWordsOf, decideDialogOf, refusedDatesOf } from '../../overview/dates'
// ---- end F-OO-143
// ---- F-OO-145: the steps before production in place — Planning's own dialogs (GateDialogs) and words, the gate's moves held by its read ----
import { ChevronDown } from 'lucide-react'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { GateDialogs } from '../../../../../planning/milestones/view/GateDialogs'
import { NAMESPACE as PLANNING } from '../../../../../planning/milestones/model'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { discussAboutOf } from '../../dock/discuss'
import { gateDatesOf, gateMovesOf, gateMovesShown, planningGateHref, type GateDate, type GateMove } from '../../overview/dates'
// ---- end F-OO-145

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
 *
 * F-OO-143 (10-design §4.2; review F1, F3; replaces F-OP-105): under the promise, each new date the customer refused (the ONE waiting
 * list's DATE row, `waiting.dates`: OverviewTab's one call) — "{customer} refused the new date · 2 d", no date (F1) — with Decide…:
 * the ONE promise dialog with the follow-up named (held by promiseHeld, as Change…); a new date closes it in the same command.
 *
 * F-OO-145 (10-design §4.2; B-OO-010): each open gate (late first, three at most, then "{n} more in All dates ›") says its target, its
 * state and how late it is — or how long it waits (its own DATE row's age) — with More ▾: Move the date… · Mark done… · Start before
 * the gate… (Planning's OWN dialogs, mounted here from use-gate-acts' one-order model: never a copy) · Discuss this date · Open in
 * Planning ›. Each is held by the gate's own actions in Planning's words (the right it needs, its refusal code; never the API's
 * English); Sales sees them held. Read-only sees no More ▾ unless the read lets this reader move a gate.
 */
export function DatesCard(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /** F-OO-143: the ONE waiting list (OverviewTab's call). */ waiting?: WaitingState }) {
  // F-OO-145: Planning's catalogue for its dialogs and its held words (the gate's needs and refusals), beside the page's own.
  return (
    <WithMessages namespaces={[PLANNING]}>
      <Dates {...props} />
    </WithMessages>
  )
}

function Dates({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting?: WaitingState }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210
  const state = model.production ?? null
  const read = readOf(state)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const promise = promiseRowOf(order, read?.headline ?? null)
  const plan = planSaysOf(order, promise?.date ?? null, read?.dates ?? null)
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const promiseWait = promiseHeld(order, model.can)
  const requestedWait = amendHeld(order, model.can)
  const busy = model.busy ? t('held.busy') : null
  // F-OO-143: the refused new dates, from the ONE waiting list (nothing claimed while it is read or failed).
  const dateRows = waiting?.status === 'ready' ? waiting.dates : []
  const refused = refusedDatesOf(dateRows, model.today)
  const customer = order.party?.legalName ?? ''
  const say = (words: Phrase): string => t(words.key, words.params)
  const age = (days: number | null): string | null => (days === null ? null : say(ageWordsOf(days)))
  // ---- F-OO-145: the open gates with their state and age, and their moves (Planning's dialogs; its words for why one waits) ----
  const p = useT(PLANNING)
  const frame = useRecordFrame()
  const gates = gateDatesOf(read?.dates ?? null, dateRows, model.today)
  const movesShown = gateMovesShown(readOnly, gates.rows)
  const gateActs = actions?.gateActs
  // F-SA-266: a gate is discussed by its reference (the customer reads its own words).
  const discuss = (row: GateDate, what: string) => {
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part: row.target ? `${what} · ${day(row.target)}` : what, target: row.gateId ? { kind: 'OrderGate', id: row.gateId } : null })
    frame?.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })
  }
  const moveWords: Readonly<Record<GateMove, string>> = { move: t('dates.gateMove'), done: p('row.done'), startBefore: p('row.startBefore'), discuss: t('dates.gateDiscuss'), planning: t('wo.link.planning') }
  const run = (move: GateMove, row: GateDate, what: string) => {
    const gateId = row.gateId
    if (move === 'discuss') return discuss(row, what)
    if (!gateId) return
    if (move === 'move') gateActs?.onEdit?.(gateId)
    else if (move === 'done') gateActs?.onPass?.([gateId])
    else if (move === 'startBefore') gateActs?.onStartBefore?.([gateId])
  }
  const itemsOf = (row: GateDate, what: string): MenuItemDef[] =>
    gateMovesOf(row.gate, order.id, { thread: !!frame?.discuss, planningView: !!model.gateActs?.can.view, busy: !!model.busy }, p).map((move): MenuItemDef => {
      if (move.id === 'planning' && !move.held) return { id: move.id, label: moveWords.planning, href: planningGateHref(model.prefix, order.number, row.gateId) }
      return { id: move.id, label: moveWords[move.id], disabled: !!move.held, description: move.held ?? undefined, onSelect: move.held ? undefined : () => run(move.id, row, what) }
    })
  const waits = (days: number): string => (days === 0 ? t('dates.gateWaitsToday') : t('dates.gateWaits', { days }))
  // ---- end F-OO-145
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
          {/* F-OO-143 (replaces F-OP-105): a new date the customer refused, under the promise; Decide… → the ONE promise dialog. */}
          {refused.map((row) => (
            <li key={row.key} className="fw-so-ov-row">
              <span className="fw-so-dates-wide is-under fw-so-dates-warn">{[t('waiting.repromise', { customer }), age(row.age)].filter(Boolean).join(' · ')}</span>
              {!readOnly && (
                <span className="fw-so-ov-doors">
                  <Button size="sm" variant="quiet" heldReason={busy ?? (promiseWait ? t(promiseWait.key, promiseWait.params) : null)} onClick={() => actions?.onDialog?.(decideDialogOf(row))}>
                    {t('dates.decide')}
                  </Button>
                </span>
              )}
            </li>
          ))}
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
        ) : gates.rows.length > 0 ? (
          <ul className="fw-so-dates-rows is-gates" aria-label={d('milestone.title')}>
            {/* F-OO-145: target · state · late (or how long it waits), More ▾ with Planning's own dialogs; then "{n} more in All dates ›". */}
            {gates.rows.map((row) => {
              const what = row.label ?? d(`gate.${row.gateKind ?? 'OTHER'}`)
              const late = row.late !== null && row.late > 0 ? row.late : null
              return (
                <li key={row.id} className="fw-so-ov-row">
                  <span className="fw-so-dates-label">{what}</span>
                  <span>
                    {row.target ? d('milestone.target', { date: day(row.target) }) : p('row.noTarget')}
                    {` · ${p(`state.${row.state}`)}`}
                    {late !== null ? (
                      <>
                        {' · '}
                        <Tag tone="warning">{d('milestone.lateBy', { count: late })}</Tag>
                      </>
                    ) : row.age !== null ? (
                      ` · ${waits(row.age)}`
                    ) : null}
                  </span>
                  {movesShown && (
                    <span className="fw-so-ov-doors">
                      <Menu
                        align="right"
                        label={
                          <>
                            {t('col.more')} <ChevronDown size={14} aria-hidden />
                          </>
                        }
                        triggerProps={{ 'aria-label': p('row.menu', { name: what, order: order.number }) }}
                        items={itemsOf(row, what)}
                      />
                    </span>
                  )}
                </li>
              )
            })}
            {gates.more > 0 && (
              <li className="fw-so-dates-note">
                <TabLink className="fw-so-link fw-so-hint" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#dates`}>
                  {t('dates.gatesMore', { count: gates.more })}
                </TabLink>
              </li>
            )}
          </ul>
        ) : null}
      </div>
      {/* F-OO-145: Planning's own gate dialogs (Change the gate, Mark done, Start before the gate), from use-gate-acts' one-order model. */}
      {model.gateActs?.dialog && <GateDialogs model={model.gateActs} actions={gateActs} words={{ t: p, locale }} />}
    </Card>
  )
}
