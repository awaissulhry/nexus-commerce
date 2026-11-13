'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, Check, CircleSlash, Factory, MoreHorizontal, MoveRight, Search, Truck } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, InfoTip, Input, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { dayAt, phrase } from '../../../../_shared/buying/model'
import type { ActionMessage, PlannedOrder, ProtectableField } from '../api'
import {
  convertHeld,
  convertReach,
  decideHeld,
  DEPTH_NAMESPACE,
  editHeld,
  firmHeld,
  heldOf,
  lateOf,
  materialCode,
  materialLateOf,
  messageHref,
  messageRecord,
  messageWhat,
  openMessages,
  ordersOf,
  protection,
  selectHeld,
  shiftHeld,
  sizesText,
  visiblePlanned,
  type DepthActions,
  type DepthModel,
} from '../model'
import { useDepthSay } from './words'
import '../depth.css'

const MESSAGE_TONE = { EXPEDITE: 'warning', DEFER: 'info', CANCEL: 'danger', INCREASE: 'warning', DECREASE: 'info', NEW: 'neutral' } as const

/**
 * The To make section (design planning.mrp sec:make, W2b): the planned work orders and planned subcontract orders the
 * latest run proposes, on the shared list frame — style and colourway, the size run (the DS SizeGridView in a popover),
 * start and due from backward scheduling (a date the planner set keeps a dot, its plan value in the tip, and Reset to
 * plan), late demand with its earliest day, the material that makes it late (the calculated delays), the line or the
 * workshop with its steps and kit ship-out, the orders it makes — then "Create n work orders" / "Create n subcontract
 * orders" (reviewed first) and "Move n by days". Below it the action messages on existing orders (advance, postpone,
 * increase, decrease, cancel), each Done or Ignored with a note. No money in this section.
 */
export function MakeSection({ model, actions, prefix, timeZone, tools, onWhy }: { model: DepthModel; actions?: DepthActions; prefix: string; timeZone?: string; tools?: ReactNode; onWhy?: (lineId: string) => void }) {
  return (
    <div className="fw-mrd-stack">
      <PlannedList model={model} actions={actions} prefix={prefix} timeZone={timeZone} tools={tools} />
      <MessageList model={model} actions={actions} prefix={prefix} timeZone={timeZone} onWhy={onWhy} />
    </div>
  )
}

function PlannedList({ model, actions, prefix, timeZone, tools }: { model: DepthModel; actions?: DepthActions; prefix: string; timeZone?: string; tools?: ReactNode }) {
  const t = useT(DEPTH_NAMESPACE)
  const say = useDepthSay(timeZone)
  const locale = useLocale()
  const place = { locale, timeZone }
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const list = model.planned?.status === 'ready' ? model.planned.value : null
  const rows = useMemo(() => (list ? visiblePlanned(list.plannedOrders, query) : null), [list, query])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const reach = convertReach(picked)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const day = (value: string) => formatDate(dayAt(value), place)

  const columns = useMemo<ColDef<PlannedOrder>[]>(() => {
    const StyleCell = ({ data }: ICellRendererParams<PlannedOrder>) =>
      data ? (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-ellipsis">
            <Pill tone={data.kind === 'SUBCONTRACT' ? 'info' : 'neutral'}>
              {t(`kind.${data.kind}`)}
            </Pill>{' '}
            {data.style.code} · {data.style.name}
          </span>
          <span className="fw-mrd-sub">{[data.colourway.code, data.sizeGroup ? t('sizeGroup', { group: data.sizeGroup }) : null, data.revision ? t('revision', { revision: data.revision.revision }) : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const SizesCell = ({ data }: ICellRendererParams<PlannedOrder>) =>
      data ? (
        <span className="fw-mrd-cell">
          <DetailPopover trigger={<span className="fw-mrd-ellipsis fw-mrd-num">{sizesText(data)}</span>} triggerLabel={t('sizes.open', { label: `${data.style.code} ${data.colourway.code}`, sizes: sizesText(data) })} triggerClassName="fw-mrd-pop" label={t('sizes.title', { label: `${data.style.code} ${data.colourway.code}` })} hoverDelay={0}>
            <div className="fw-mrd-popbody">
              <SizeGridView
                colours={[{ key: data.colourway.id, label: data.colourway.code }]}
                sizes={data.sizes.map((entry) => ({ key: entry.size, label: entry.size }))}
                value={{ [data.colourway.id]: Object.fromEntries(data.sizes.map((entry) => [entry.size, entry.quantity])) }}
                caption={t('sizes.caption', { label: `${data.style.code} ${data.colourway.code}` })}
                showCaption
                locale={INTL_LOCALE[locale]}
                copy={{ caption: t('sizes.caption', { label: `${data.style.code} ${data.colourway.code}` }), colourHeader: t('sizes.colour'), totalHeader: t('sizes.total'), cellName: (colour, size) => t('sizes.cell', { colour, size }), notOffered: t('sizes.notOffered'), empty: t('sizes.empty') }}
              />
            </div>
          </DetailPopover>
          <span className="fw-mrd-sub">{t('pieces', { count: data.quantity })}</span>
        </span>
      ) : null
    const Dot = ({ data, field }: { data: PlannedOrder; field: ProtectableField }) => {
      const info = protection(data, field)
      if (!info.protectedNow) return null
      const tip = info.plan ? t('protected.tip', { plan: day(info.plan) }) : t('protected.tipNoPlan')
      return (
        <span className="fw-mrd-dot" role="img" aria-label={tip} title={tip}>
          ●
        </span>
      )
    }
    const DatesCell = ({ data }: ICellRendererParams<PlannedOrder>) => {
      if (!data) return null
      const late = lateOf(data)
      const material = materialLateOf(data, latest.current.model.delays)
      const held = editHeld(data, latest.current.model.can)
      return (
        <span className="fw-mrd-cell">
          <Button size="sm" variant="link" className="fw-mrd-btnleft" heldReason={held ? t(held) : null} onClick={() => latest.current.actions?.onDates?.(data.id)} aria-label={t('dates.change', { label: `${data.style.code} ${data.colourway.code}`, start: day(data.startDate), due: day(data.dueDate) })}>
            <span className="fw-mrd-num">
              {day(data.startDate)}
              <Dot data={data} field="startDate" /> → {day(data.dueDate)}
              <Dot data={data} field="dueDate" />
            </span>
          </Button>
          {late ? (
            <span className="fw-mrd-sub fw-mrd-danger">{say(late)}</span>
          ) : material ? (
            <span className="fw-mrd-tipline fw-mrd-sub">
              <span className="fw-mrd-warning fw-mrd-ellipsis">{t('late.material', { date: day(material.earliest), count: material.daysLate })}</span>
              <InfoTip tip={t('late.materialTip', { material: materialCode(material.setBy), date: day(material.earliest), need: day(material.needDate) })} />
            </span>
          ) : (
            <span className="fw-mrd-sub">{t('dates.inTime')}</span>
          )}
        </span>
      )
    }
    const WhereCell = ({ data }: ICellRendererParams<PlannedOrder>) => {
      if (!data) return null
      if (data.kind === 'SUBCONTRACT')
        return (
          <span className="fw-mrd-cell">
            <span className="fw-mrd-ellipsis">
              <Truck size={12} aria-hidden /> {data.workshop ? `${data.workshop.code} · ${data.workshop.name}` : t('where.noWorkshop')}
            </span>
            <span className="fw-mrd-sub">{[data.operations.length > 0 ? t('where.steps', { steps: data.operations.map((step) => step.code).join(', ') }) : null, data.kitDueAt ? t('where.kit', { date: formatDateTime(data.kitDueAt, place) }) : null].filter(Boolean).join(' · ')}</span>
          </span>
        )
      return (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-ellipsis">
            <Factory size={12} aria-hidden /> {data.line ? `${data.line.code} · ${data.line.name}` : t('where.noLine')}
          </span>
          {data.outsideStepsInHouse.length > 0 ? (
            <span className="fw-mrd-tipline fw-mrd-sub">
              <span className="fw-mrd-warning fw-mrd-ellipsis">{t('where.inHouse', { count: data.outsideStepsInHouse.length })}</span>
              <InfoTip tip={t('where.inHouseTip', { steps: data.outsideStepsInHouse.map((step) => `${step.code} ${step.name}`).join(', ') })} />
            </span>
          ) : (
            <span className="fw-mrd-sub">{t('where.inHouseAll')}</span>
          )}
        </span>
      )
    }
    const OrdersCell = ({ data }: ICellRendererParams<PlannedOrder>) => {
      if (!data) return null
      const orders = ordersOf(data)
      return (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-ellipsis">
            {orders.slice(0, 3).map((order, index) => (
              <span key={order.id}>
                {index > 0 ? ', ' : ''}
                <Link className="fw-mrd-link" href={`${prefix}${recordAddress({ type: 'SalesOrder', id: order.id, label: order.number }, latest.current.model.built)}`}>
                  {order.number}
                </Link>
              </span>
            ))}
            {orders.length > 3 ? ` ${t('orders.more', { count: orders.length - 3 })}` : ''}
            {orders.length === 0 ? t('orders.none') : ''}
          </span>
          <span className="fw-mrd-sub">{t('orders.lines', { count: data.demand.length })}</span>
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<PlannedOrder>) => {
      if (!data) return null
      const held = heldOf(data)
      return (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-inline">
            {data.firm && <Pill tone="info">{t('state.firm')}</Pill>}
            {data.protectedFields.length > 0 && <Pill tone="warning">{t('state.protected', { count: data.protectedFields.length })}</Pill>}
            {!data.firm && data.protectedFields.length === 0 && <Pill tone="neutral">{t('state.proposed')}</Pill>}
          </span>
          <span className={held ? 'fw-mrd-sub fw-mrd-warning fw-mrd-ellipsis' : 'fw-mrd-sub'}>{held ? t(held) : t('state.ready')}</span>
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<PlannedOrder>) => {
      if (!data) return null
      const can = latest.current.model.can
      const busy = latest.current.model.busy.includes(data.id)
      const label = `${data.style.code} ${data.colourway.code}`
      const firmBlocked = firmHeld(data, can)
      const editBlocked = editHeld(data, can)
      const converts = convertHeld(data.kind, heldOf(data) === null ? 1 : 0, can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { label }) }}
          items={[
            { id: 'convert', label: t(data.kind === 'MAKE' ? 'row.convertMake' : 'row.convertSubcontract'), disabled: !!converts || busy, onSelect: () => latest.current.actions?.onConvert?.(data.kind, [data.id]) },
            { id: 'dates', label: t('row.dates'), disabled: !!editBlocked || busy, onSelect: () => latest.current.actions?.onDates?.(data.id) },
            ...(['startDate', 'dueDate'] as const).filter((field) => data.protectedFields.includes(field)).map((field) => ({ id: `reset-${field}`, label: t('row.reset', { field: t(`field.${field}`) }), disabled: !can.edit || busy, onSelect: () => latest.current.actions?.onReset?.(data.id, field) })),
            ...data.protectedFields.filter((field) => field !== 'startDate' && field !== 'dueDate').map((field) => ({ id: `reset-${field}`, label: t('row.reset', { field: t(`field.${field}`) }), disabled: !can.edit || busy, onSelect: () => latest.current.actions?.onReset?.(data.id, field) })),
            { id: 'firm', label: t(data.firm ? 'row.unfirm' : 'row.firm'), disabled: !!firmBlocked || busy, onSelect: () => latest.current.actions?.onFirm?.(data.id, !data.firm) },
          ]}
        />
      )
    }
    return [
      { colId: 'style', headerName: t('col.style'), minWidth: 230, flex: 1.6, cellRenderer: StyleCell },
      { colId: 'sizes', headerName: t('col.sizes'), minWidth: 170, flex: 1.1, cellRenderer: SizesCell },
      { colId: 'dates', headerName: t('col.dates'), minWidth: 240, flex: 1.5, cellRenderer: DatesCell },
      { colId: 'where', headerName: t('col.where'), minWidth: 210, flex: 1.4, cellRenderer: WhereCell },
      { colId: 'orders', headerName: t('col.orders'), minWidth: 170, flex: 1.1, cellRenderer: OrdersCell },
      { colId: 'state', headerName: t('col.state'), minWidth: 190, flex: 1.2, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The model is read through `latest`; the busy rows and the delays repaint the cells.
  }, [t, say, locale, timeZone, prefix, model.busy.join(','), model.delays])

  let state: ReactNode = undefined
  if (model.planned?.status === 'error') state = <EmptyState title={t('make.failed')} description={t(model.planned.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
  else if (list && rows && rows.length === 0)
    state = query.trim() ? (
      <EmptyState title={t('make.noMatch')} action={<Button size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>} />
    ) : (
      <EmptyState title={t('make.empty.title')} description={list.run ? t('make.empty.body', { date: formatDateTime(list.run.finishedAt ?? list.run.startedAt, place) }) : t('make.empty.noRun')} />
    )

  const makeHeld = convertHeld('MAKE', reach.make.length, model.can)
  const subHeld = convertHeld('SUBCONTRACT', reach.subcontract.length, model.can)
  const moveHeld = shiftHeld(picked, model.can)

  return (
    <Card padded>
      <div className="fw-mrd-stack">
        <div className="fw-mrd-head">
          <h2 className="fw-mrd-h2">{t('make.title')}</h2>
          <span className="fw-mrd-hint">{list ? t('make.counts', { make: list.counts.make, subcontract: list.counts.subcontract, firm: list.counts.firm }) : t('make.hint')}</span>
        </div>
        <ListFrame<PlannedOrder>
          label={t('make.table')}
          listKey={null}
          rows={state ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          rowKind="two-line"
          count={rows ? t('make.count', { count: rows.length }) : '—'}
          search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('make.search')} placeholder={t('make.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button size="sm" variant="primary" aria-label={t('bulk.make', { count: reach.make.length })} heldReason={makeHeld ? t(makeHeld) : null} onClick={() => actions?.onConvert?.('MAKE', picked.map((row) => row.id))}>
                  <Factory size={13} aria-hidden /> <SelectionLabel>{t('bulk.make', { count: reach.make.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('bulk.subcontract', { count: reach.subcontract.length })} heldReason={subHeld ? t(subHeld) : null} onClick={() => actions?.onConvert?.('SUBCONTRACT', picked.map((row) => row.id))}>
                  <Truck size={13} aria-hidden /> <SelectionLabel>{t('bulk.subcontract', { count: reach.subcontract.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('bulk.move', { count: picked.length })} heldReason={moveHeld ? t(moveHeld) : null} onClick={() => actions?.onShift?.(picked.map((row) => row.id))}>
                  <CalendarClock size={13} aria-hidden /> <SelectionLabel>{t('bulk.move', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          isRowSelectable={(row) => {
            const reason = selectHeld(row, model.can)
            return reason ? t(reason) : null
          }}
          onOpen={(row) => actions?.onDates?.(row.id)}
          state={state}
        />
      </div>
    </Card>
  )
}

function MessageList({ model, actions, prefix, timeZone, onWhy }: { model: DepthModel; actions?: DepthActions; prefix: string; timeZone?: string; onWhy?: (lineId: string) => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const say = useDepthSay(timeZone)
  const locale = useLocale()
  const place = { locale, timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selectedMessages ?? [])
  useEffect(() => setSelected(model.selectedMessages ?? []), [model.selectedMessages])
  const answer = model.messages?.status === 'ready' ? model.messages.value : null
  const rows = answer?.messages ?? null
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const latest = useRef({ model, onWhy })
  latest.current = { model, onWhy }

  const columns = useMemo<ColDef<ActionMessage>[]>(() => {
    const ActionCell = ({ data }: ICellRendererParams<ActionMessage>) => (data ? <Pill tone={MESSAGE_TONE[data.action]}>{t(`action.${data.action}`)}</Pill> : null)
    const RecordCell = ({ data }: ICellRendererParams<ActionMessage>) => {
      if (!data) return null
      const words = say(messageRecord(data))
      const where = messageHref(data, prefix, latest.current.model.built)
      return (
        <span className="fw-mrd-cell">
          {where?.kind === 'page' ? (
            <Link className="fw-mrd-link fw-mrd-ellipsis" href={where.href}>
              {words}
            </Link>
          ) : where?.kind === 'why' ? (
            <Button size="sm" variant="link" onClick={() => latest.current.onWhy?.(where.lineId)} aria-label={t('msg.openWhy', { record: words })}>
              <span className="fw-mrd-ellipsis">{words}</span>
            </Button>
          ) : (
            <span className="fw-mrd-ellipsis">{words}</span>
          )}
          <span className="fw-mrd-sub">{t(`msg.type.${data.record.type}`)}</span>
        </span>
      )
    }
    const WhatCell = ({ data }: ICellRendererParams<ActionMessage>) => {
      if (!data) return null
      const material = typeof data.facts.material === 'string' && data.record.type === 'PurchaseOrderLine' ? data.facts.material : null
      return (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-ellipsis">{say(messageWhat(data))}</span>
          <span className="fw-mrd-sub">{material ? t('msg.material', { material }) : ''}</span>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<ActionMessage>) =>
      data ? (
        <span className="fw-mrd-cell">
          <span className="fw-mrd-inline">
            <Pill tone={data.status === 'OPEN' ? 'warning' : data.status === 'DONE' ? 'success' : 'neutral'}>{t(`msg.status.${data.status}`)}</Pill>
            {data.decidedAt ? <span className="fw-mrd-sub">{formatDateTime(data.decidedAt, place)}</span> : null}
          </span>
          <span className="fw-mrd-sub fw-mrd-ellipsis">{data.decisionNote ?? ''}</span>
        </span>
      ) : null
    return [
      { colId: 'action', headerName: t('msg.col.action'), minWidth: 140, flex: 0.8, cellRenderer: ActionCell },
      { colId: 'record', headerName: t('msg.col.record'), minWidth: 220, flex: 1.4, cellRenderer: RecordCell },
      { colId: 'what', headerName: t('msg.col.what'), minWidth: 260, flex: 1.8, cellRenderer: WhatCell },
      { colId: 'status', headerName: t('msg.col.status'), minWidth: 200, flex: 1.2, cellRenderer: StatusCell },
    ]
  }, [t, say, locale, timeZone, prefix])

  let state: ReactNode = undefined
  if (model.messages?.status === 'error') state = <EmptyState title={t('msg.failed')} description={t(model.messages.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
  else if (answer && answer.messages.length === 0) state = <EmptyState title={answer.run ? t('msg.empty.title') : t('msg.empty.noRun')} description={answer.run ? t('msg.empty.body') : undefined} />

  const open = openMessages(picked)
  const held = decideHeld(picked, model.can)
  const byAction = answer?.byAction.filter((entry) => entry.open > 0) ?? []

  return (
    <Card padded>
      <div className="fw-mrd-stack">
        <div className="fw-mrd-head">
          <h2 className="fw-mrd-h2">{t('msg.title')}</h2>
          <span className="fw-mrd-hint">{answer ? (byAction.length > 0 ? byAction.map((entry) => t(`msg.byAction.${entry.action}`, { count: entry.open })).join(' · ') : t('msg.noneOpen')) : t('msg.hint')}</span>
        </div>
        {answer && answer.counts.open > 0 && <Banner tone="info" title={t('msg.explain')} />}
        <ListFrame<ActionMessage>
          label={t('msg.table')}
          listKey={null}
          rows={state ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          rowKind="two-line"
          count={answer ? t('msg.count', { open: answer.counts.open, done: answer.counts.done, ignored: answer.counts.ignored }) : '—'}
          tools={
            <SegmentedControl
              size="sm"
              ariaLabel={t('msg.show')}
              value={model.allMessages ? 'all' : 'open'}
              options={[
                { value: 'open', label: t('msg.showOpen') },
                { value: 'all', label: t('msg.showAll') },
              ]}
              onChange={(value) => actions?.onAllMessages?.(value === 'all')}
            />
          }
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button size="sm" variant="primary" aria-label={t('msg.bulk.done', { count: open.length })} heldReason={held ? t(held) : null} onClick={() => actions?.onDecide?.(open.map((row) => row.id), 'DONE')}>
                  <Check size={13} aria-hidden /> <SelectionLabel>{t('msg.bulk.done', { count: open.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('msg.bulk.ignore', { count: open.length })} heldReason={held ? t(held) : null} onClick={() => actions?.onDecide?.(open.map((row) => row.id), 'IGNORED')}>
                  <CircleSlash size={13} aria-hidden /> <SelectionLabel>{t('msg.bulk.ignore', { count: open.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          isRowSelectable={(row) => (row.status !== 'OPEN' ? t('held.decided') : !model.can.actions ? t('held.noActions') : null)}
          onOpen={(row) => {
            const where = messageHref(row, prefix, model.built)
            if (where?.kind === 'why') onWhy?.(where.lineId)
          }}
          state={state}
        />
        <p className="fw-mrd-hint">
          <MoveRight size={12} aria-hidden /> {say(phrase('msg.never'))}
        </p>
      </div>
    </Card>
  )
}
