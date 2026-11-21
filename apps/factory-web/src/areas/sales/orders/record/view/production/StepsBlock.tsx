'use client'

import { useMemo } from 'react'
import { Flag, Plus } from 'lucide-react'
import { type MenuItemDef } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Tag } from '@nexus/ui/primitives'
import { useSearchParams } from 'next/navigation'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { heldOf, NAMESPACE as PLANNING } from '../../../../../planning/milestones/model'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { discussAboutOf, rowAnchor } from '../../dock/discuss'
import { readOf } from '../../overview/model'
import { planningGateHref } from '../../overview/dates'
import { nowStepOf, STEP_ACT_ACTION, stepActsOf, stepsChipOf, stepsOf, type StepAct, type StepRow, type StepStatus, type WhoActs } from '../../production/steps'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../LineMenu'
import { PartFailed, PartReading, Quiet } from './Kit'

/**
 * F-PT-202 (order PRODUCTION tab, 10-design §5 Block B; S3) — "Steps to shipping": the deposit first (its door is Money), the order's
 * gates, production start "(working plan)" and shipping "(the promise)" — the DS tracker across, then one row per step: Planned ·
 * Done · Status (ONE word set and tone) · Who acts · its acts. The acts are Planning's OWN dialogs (GateDialogs and the step's window,
 * MilestoneDialog — mounted ONCE for the page in OrderRecordView, Overview › Next dates opens the same), each by the gate's own actions
 * for this reader: a missing right hides it (L9), a refusal of the gate's state holds it in Planning's words. A reader with no gate act
 * may ask the gate's planner for an update (an office note that mentions them). Each gate row is `about-OrderGate-<id>` (B18).
 */
export function StepsBlock(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[PLANNING]}>
      <Steps {...props} />
    </WithMessages>
  )
}

function Steps({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const p = useT(PLANNING)
  const ds = useDsWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const frame = useRecordFrame()
  const state = model.production ?? null
  const read = readOf(state)
  const dates = read?.dates ?? null
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const labels = useMemo(() => ({ ...ds.milestoneTracker, usually: (date: string) => d('milestone.target', { date }), states: { ...ds.milestoneTracker.states, skipped: d('milestone.state.STARTED_BEFORE') } }), [ds, d])
  const gateActs = actions?.gateActs
  const busy = !!model.busy
  const mayAsk = !!model.people?.mayNote
  const promise = read?.headline?.promise.date ?? order.promiseDate

  if (!state || state.status === 'loading') return <PartReading rows={3} height={30} />
  if (state.status === 'failed') return <PartFailed part={t('productionTab.dates.partPlan')} problem={state.problem} onRetry={() => actions?.onRetryProduction?.()} />

  const rows = stepsOf(order, dates, model.today)
  const chip = stepsChipOf(rows)
  const now = nowStepOf(rows)
  const nameOf = (row: StepRow): string => (row.kind === 'DEPOSIT' ? t('productionTab.steps.deposit') : row.kind === 'GATE' ? (row.label ?? d(`gate.${row.gateKind ?? 'OTHER'}`)) : d(`milestone.kind.${row.kind}`))
  const statusWords = (status: StepStatus): string => {
    switch (status.kind) {
      case 'done':
        return t('productionTab.steps.status.done')
      case 'late':
        return t('productionTab.steps.status.late', { count: status.days })
      case 'soon':
        return status.days === 0 ? t('productionTab.steps.status.soonToday') : t('productionTab.steps.status.soon', { count: status.days })
      case 'waiting':
        return t('productionTab.steps.status.waiting')
      case 'startedBefore':
        return t('productionTab.steps.status.startedBefore')
      case 'toCome':
        return t('productionTab.steps.status.toCome')
    }
  }
  // B17: ONE tone rule — late danger, waiting soon warning, started before info, done success, the rest neutral.
  const tone = (status: StepStatus) => (status.kind === 'late' ? 'danger' : status.kind === 'soon' ? 'warning' : status.kind === 'startedBefore' ? 'info' : status.kind === 'done' ? 'success' : 'neutral')
  const whoWords = (who: WhoActs): string => (who.kind === 'planner' ? (who.name ? t('productionTab.steps.who.planner', { name: who.name }) : t('productionTab.steps.who.plannerNobody')) : who.kind === 'nobody' ? t('productionTab.steps.who.plannerNobody') : t(`productionTab.steps.who.${who.kind}`))
  const addGate = dates?.mayAddGate ?? null
  const actWords: Readonly<Record<StepAct, string>> = { done: p('row.done'), move: t('dates.gateMove'), startBefore: p('row.startBefore'), remove: t('productionTab.steps.remove') }
  const run = (act: StepAct, gateId: string) => (act === 'done' ? gateActs?.onPass?.([gateId]) : act === 'move' ? gateActs?.onEdit?.(gateId) : act === 'startBefore' ? gateActs?.onStartBefore?.([gateId]) : gateActs?.onRemove?.(gateId))
  const discuss = (row: StepRow) => {
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    // Every production row's Discuss is an office note (never a reply): a gate is named by its reference.
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part: row.planned ? `${nameOf(row)} · ${day(row.planned)}` : nameOf(row), target: row.gateId ? { kind: 'OrderGate', id: row.gateId } : null, officeOnly: true })
    frame?.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })
  }
  const itemsOf = (row: StepRow, acts: readonly StepAct[]): MenuItemDef[] => {
    const gate = row.gate
    const gateId = row.gateId
    if (!gate?.actions || !gateId) return []
    const held = (act: StepAct) => heldOf(gate.actions![STEP_ACT_ACTION[act]], p, busy)
    return [
      ...acts.map((act): MenuItemDef => {
        const why = held(act)
        return { id: act, label: actWords[act], disabled: !!why, description: why ?? undefined, onSelect: why ? undefined : () => run(act, gateId) }
      }),
      ...(frame?.discuss ? [{ id: 'discuss', label: t('dates.gateDiscuss'), onSelect: () => discuss(row) }] : []),
      ...(model.gateActs?.can.view ? [{ id: 'planning', label: t('wo.link.planning'), href: planningGateHref(model.prefix, order.number, gateId) }] : []),
    ]
  }
  const askPlanner = (row: StepRow) => {
    const name = row.who.kind === 'planner' ? row.who.name : null
    const step = nameOf(row)
    if (!name) return
    actions?.people?.onAsk?.({
      title: t('productionTab.steps.askTitle', { step }),
      body: promise ? t('productionTab.steps.askStarter', { name, step, promise: day(promise) }) : t('productionTab.steps.askStarterNoPromise', { name, step }),
      needsAnswer: false,
      askSupervisor: false,
      send: t('productionTab.steps.askSend'),
    })
  }
  const hasGate = rows.some((row) => row.kind === 'GATE')
  const level = dates?.customer?.level ?? null

  return (
    <div className="fw-pt-blk">
      <h3 className="fw-pt-h3">
        <Flag size={14} aria-hidden /> {t('productionTab.steps.title')}
        {chip ? <Tag tone={chip.kind === 'late' ? 'danger' : 'success'}>{chip.kind === 'late' ? t('productionTab.steps.chip.late', { count: chip.count }) : t(`productionTab.steps.chip.${chip.kind}`)}</Tag> : null}
        <span className="fw-pt-h3-sp" />
        {/* Add a gate… — Planning's own dialog; hidden without its right (L9), held in Planning's words by the order's state. */}
        {addGate && !addGate.needs && (addGate.allowed || addGate.refusal) ? (
          <Button size="sm" heldReason={addGate.allowed ? (busy ? t('held.busy') : null) : p(`refusal.${addGate.refusal!.code}`)} onClick={() => gateActs?.onAdd?.(order.id)}>
            <Plus size={14} aria-hidden /> {t('productionTab.steps.add')}
          </Button>
        ) : null}
      </h3>
      {now ? (
        <p className="fw-pt-hint">
          {[t('productionTab.steps.now', { step: nameOf(now) }), whoWords(now.who), statusWords(now.status), now.planned && now.status.kind !== 'done' ? d('milestone.target', { date: day(now.planned) }) : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <MilestoneTracker
          label={t('productionTab.steps.title')}
          labels={labels}
          steps={rows.map((row) => ({
            id: row.id,
            label: nameOf(row),
            state: row.status.kind === 'done' ? ('done' as const) : row.status.kind === 'startedBefore' ? ('skipped' as const) : ('todo' as const),
            current: row.id === now?.id,
            date: row.done ? day(row.done) : null,
            expected: row.status.kind !== 'done' && row.planned ? day(row.planned) : null,
          }))}
        />
      ) : null}
      {!hasGate ? <Quiet>{t('productionTab.steps.noGate')}</Quiet> : null}
      <div className="fw-pt-steps" role="table" aria-label={t('productionTab.steps.title')}>
        <div className="fw-pt-steps-hd" role="row">
          <div role="columnheader">{t('productionTab.steps.col.step')}</div>
          <div role="columnheader">{t('productionTab.steps.col.planned')}</div>
          <div role="columnheader">{t('productionTab.steps.col.done')}</div>
          <div role="columnheader">{t('productionTab.steps.col.status')}</div>
          <div role="columnheader">{t('productionTab.steps.col.who')}</div>
          <div role="columnheader" />
        </div>
        {rows.map((row) => {
          const opens = row.milestoneId && model.gateActs ? row.milestoneId : null
          const acts = stepActsOf(row, { decide: !!model.can.decideForCustomer && !!opens })
          const name = nameOf(row)
          const items = itemsOf(row, acts.more)
          return (
            <div key={row.id} role="row" className="fw-pt-step" id={row.gateId ? rowAnchor('OrderGate', row.gateId) : undefined} tabIndex={row.gateId ? -1 : undefined}>
              <div role="cell">
                {opens ? (
                  <button type="button" className="fw-pt-link" onClick={() => gateActs?.onOpen?.(opens)}>
                    {name}
                  </button>
                ) : (
                  <b>{name}</b>
                )}
                {row.kind === 'START' ? <span className="fw-pt-sub">{t('productionTab.steps.startHint')}</span> : null}
                {row.kind === 'SHIP' ? (
                  <span className="fw-pt-sub">
                    {t('productionTab.steps.shipHint')}
                    {(read?.headline?.promise.moves ?? 0) > 0 ? (
                      <>
                        {' · '}
                        <a className="fw-pt-link" href="#promise-moves">
                          {t('dates.promisedMovedOnly', { date: promise ? day(promise) : '—', count: read!.headline!.promise.moves })} ›
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div role="cell" className="fw-pt-step-pl">
                <span>{row.planned ? day(row.planned) : '—'}</span>
                <span className="fw-pt-sub">{row.done ? `${t('productionTab.steps.col.done')} ${day(row.done)}` : null}</span>
              </div>
              <div role="cell" className="fw-pt-step-dn">
                {row.done ? day(row.done) : '—'}
              </div>
              <div role="cell">
                <Tag tone={tone(row.status)}>{statusWords(row.status)}</Tag>
              </div>
              <div role="cell" className="fw-pt-sub">
                {whoWords(row.who)}
              </div>
              <div role="cell" className="fw-pt-step-acts">
                {row.kind === 'DEPOSIT' ? (
                  <Button size="sm" variant="quiet" asChild>
                    {/* B11: the deposit is a step; its door is Money (a tab link: the dock's scope kept, F-OP-210). */}
                    <TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'money', search)}>{t('gate.money')}</TabLink>
                  </Button>
                ) : null}
                {acts.primary === 'done' && row.gateId ? (
                  <Button size="sm" heldReason={busy ? t('held.busy') : null} onClick={() => gateActs?.onPass?.([row.gateId!])}>
                    {p('row.done')}
                  </Button>
                ) : null}
                {/* W3 extra: a gate waiting on the customer's sample round — Planning's MilestoneDialog, which holds Decide for {customer}. */}
                {acts.primary === 'decide' && opens ? (
                  <Button size="sm" heldReason={busy ? t('held.busy') : null} onClick={() => gateActs?.onOpen?.(opens)}>
                    {t('productionTab.steps.decide', { customer: order.party?.legalName ?? '' })}
                  </Button>
                ) : null}
                {acts.askOnly && mayAsk && row.who.kind === 'planner' && row.who.name ? (
                  <Button size="sm" variant="quiet" onClick={() => askPlanner(row)}>
                    {t('productionTab.steps.ask', { name: row.who.name })}
                  </Button>
                ) : null}
                {items.length > 0 ? <LineMenuButton label={t('productionTab.steps.more', { step: name })} items={items} /> : null}
              </div>
            </div>
          )
        })}
      </div>
      {level ? <p className="fw-pt-hint">{t(level === 'GATES' || level === 'QUALITY' ? 'productionTab.steps.seesGates' : 'productionTab.steps.seesNone')}</p> : null}
    </div>
  )
}
