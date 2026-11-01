'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, ProgressBar } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import type { OrderRow } from '../../api'
import { dayInstant, depositTone, ROW_VIEWS, shippedPercent, STATUS_TONE, tileCount, TILES, type Layout, type RowView } from '../../model'
import type { OrdersListActions, OrdersListModel } from '../list-model'
import { NewOrderDialog } from './NewOrderDialog'
import { marginColumn } from '../margin/MarginColumn'
import { OrdersBoard } from './OrdersBoard'
import '../../orders.css'

export type { OrdersListActions, OrdersListModel } from '../list-model'

/**
 * SCR-038 — Orders (Sales; design sales.orders, 00 §2.1 list frame): the view switch (List · Board by state, the same
 * filters for both), the tiles (each a saved rows view: Late, Waiting for deposit, In production, Ready to ship), and
 * the shared list frame — search by number or customer PO; Rows ▾; select-all, shift range, x; Export N (CSV) while
 * rows are selected; live changes behind "N updates · Show" — each number a real link to the order studio, the deposit
 * in words, the promise with its days late, what left. B-W2a-50: New order (c; the dialog: customer, contact, customer PO,
 * the number it will get → the typed order's lines), the board in a new tab (left open on a second screen, it follows
 * live). Money only with the price grain: the columns are absent, never zero.
 */
export function OrdersListView({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  return (
    <WithMessages namespaces={['orders', 'lists']}>
      <OrdersList model={model} actions={actions} />
    </WithMessages>
  )
}

function OrdersList({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  const t = useT('orders')
  const lists = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.list.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // v: List ⇄ Board (the design's view key); c: New order — never while typing or inside a dialog. The list frame keeps
  // / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.newOrder) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'v') {
        event.preventDefault()
        actions?.onLayout?.(model.layout === 'list' ? 'board' : 'list')
      }
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewOrder?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [
    { keys: ['v'], does: t('list.keyView') },
    ...(model.can.manage ? [{ keys: ['c'], does: t('list.keyNew') }] : []),
  ]
  const searchField = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('list.search')}
      placeholder={t('list.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const rowsSelect = (
    <Select size="sm" aria-label={t('list.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as RowView)}>
      {ROW_VIEWS.map((view) => (
        <option key={view} value={view}>
          {t(`rows.${view}`)}
        </option>
      ))}
    </Select>
  )

  const columns = useMemo<ColDef<OrderRow>[]>(() => {
    const href = (row: OrderRow) => `${model.prefix}/sales/orders/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-so-cell">
          <Link className="fw-so-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-so-cell-sub">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span className="fw-so-ellipsis">{data.partyName || '—'}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const DepositCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const { state, dueDate } = data.deposit
      const overdue = state === 'OPEN' && dueDate !== null && dueDate < model.today
      return (
        <span className="fw-so-cell">
          <Pill tone={depositTone(state, dueDate, model.today)}>{t(`deposit.${state}`)}</Pill>
          {state === 'OPEN' && dueDate && <span className="fw-so-cell-sub">{t(overdue ? 'list.depositOverdue' : 'list.depositDue', { date: formatDate(dayInstant(dueDate), { locale }) })}</span>}
        </span>
      )
    }
    const UnitsCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-so-cell">
          <span>{t('list.units', { count: data.units })}</span>
          <span className="fw-so-cell-sub">{t('list.lines', { count: data.lineCount })}</span>
        </span>
      ) : null
    const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
    const OrderedCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-so-cell">
          <span>{day(data.orderDate)}</span>
          <span className="fw-so-cell-sub">{data.requestedDate ? t('list.requested', { date: day(data.requestedDate) }) : t('list.noRequested')}</span>
        </span>
      ) : null
    const PromiseCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        data.promiseDate ? (
          <span className="fw-so-inline">
            {day(data.promiseDate)}
            {data.daysLate !== null && data.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: data.daysLate })}</Tag>}
          </span>
        ) : (
          <span>{t('list.noPromise')}</span>
        )
      ) : null
    const ShippedCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-so-progress">
          <ProgressBar value={shippedPercent(data)} ariaLabel={t('list.shippedLabel', { number: data.number })} height={6} />
          <span className="fw-so-cell-sub">{t('list.shipped', { shipped: data.shippedUnits, units: data.units })}</span>
        </span>
      ) : null
    const NetCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{money(data.netAmount, data.currency, locale)}</span> : null)
    const QuoteCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        data.quote ? (
          <Link className="fw-so-link" href={`${model.prefix}/sales/quotes/${data.quote.id}`}>
            {t('list.quoteRef', { number: data.quote.number, revision: data.quote.revision })}
          </Link>
        ) : (
          <span>—</span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            { id: 'deposit', label: t('tab.money'), href: `${href(data)}?tab=money` },
            ...(data.status === 'CONFIRMED' && model.can.makeWorkOrders ? [{ id: 'make', label: t('step.makeWorkOrders'), href: `${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(data.number)}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: NumberCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 150, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 116, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'deposit', headerName: t('col.deposit'), minWidth: 136, flex: 0.9, cellRenderer: DepositCell },
      { colId: 'units', headerName: t('col.units'), field: 'units', minWidth: 90, flex: 0.6, cellRenderer: UnitsCell },
      { colId: 'orderDate', headerName: t('col.orderDate'), field: 'orderDate', minWidth: 124, flex: 0.8, cellRenderer: OrderedCell },
      { colId: 'promised', headerName: t('col.promised'), field: 'promiseDate', minWidth: 128, flex: 0.9, cellRenderer: PromiseCell },
      { colId: 'shipped', headerName: t('col.shipped'), minWidth: 124, flex: 0.9, cellRenderer: ShippedCell },
      ...(model.can.price ? [{ colId: 'net', headerName: t('col.net'), field: 'netAmount' as const, minWidth: 106, flex: 0.7, type: 'rightAligned', cellRenderer: NetCell }] : []),
      // B-W2a-72: Margin % as estimated now (costing.view + the margin grain; Owner answer S2).
      ...(model.margins ? [marginColumn(model.margins, t('col.margin'), t('col.marginHint'), locale)] : []),
      { colId: 'quote', headerName: t('col.quote'), minWidth: 112, flex: 0.7, cellRenderer: QuoteCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.today, model.can.price, model.can.makeWorkOrders, model.margins])

  const narrowed = model.q.trim() !== '' || (model.rows !== 'open' && model.rows !== 'all')
  const clearFilters = () => {
    setQuery('')
    actions?.onSearch?.('')
    actions?.onRows?.('all')
  }
  const state = model.list.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={clearFilters}>{t('list.clearFilters')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          model.can.manage || model.can.viewQuotes ? (
            <span className="fw-so-inline">
              {model.can.manage && (
                <Button size="sm" variant="primary" onClick={() => actions?.onNewOrder?.(true)}>
                  {t('list.new')}
                </Button>
              )}
              {model.can.viewQuotes && (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/sales/quotes`}>{t('list.empty.quotes')}</Link>
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
    )
  ) : undefined

  const pressed = TILES.find((tile) => tile.rows === model.rows)?.key ?? null

  return (
    <div className="fw-so">
      <div className="fw-so-head">
        <span className="fw-so-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-so-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('list.layoutLabel')}
            value={model.layout}
            onChange={(value) => actions?.onLayout?.(value as Layout)}
            options={[
              { value: 'list', label: t('layout.list') },
              { value: 'board', label: t('layout.board') },
            ]}
          />
          <Button size="sm" variant="quiet" asChild>
            <a href={`${model.prefix}/sales/orders?view=board`} target="_blank" rel="noopener" title={t('board.newTabHint')}>
              <ExternalLink size={14} aria-hidden /> <span>{t('board.newTab')}</span>
            </a>
          </Button>
          <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewOrder?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('list.new')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={TILES.map((tile) => {
          const count = tileCount(model.board, tile.key)
          return {
            label: t(`tile.${tile.key}`),
            value: count === null ? '—' : String(count),
            hint: count === null && model.board === null && model.asOf !== null ? t('tile.unknown') : undefined,
            onClick: () => actions?.onRows?.(model.rows === tile.rows ? 'open' : tile.rows),
            active: pressed === tile.key,
          }
        })}
      />

      {model.layout === 'board' ? (
        <OrdersBoard model={model} actions={actions} search={searchField} rowsSelect={rowsSelect} onHelp={() => setHelp(true)} />
      ) : (
        <ListFrame<OrderRow>
          label={t('list.tableLabel')}
          rows={state ? [] : items}
          rowId={(row) => row.id}
          columns={columns}
          count={items ? t(model.list.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
          search={searchField}
          tools={rowsSelect}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.list.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
          focusRow={model.focusRow}
        />
      )}
      {model.rows !== 'open' && <p className="fw-so-hint">{t('list.viewing', { view: t(`rows.${model.rows}`) })}</p>}

      {model.newOrder && <NewOrderDialog model={model.newOrder} actions={actions} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-so-list">
            {listKeys(model.layout === 'board' ? [...ownKeys, { keys: ['j', 'k'], does: t('board.keyWalk') }] : ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
