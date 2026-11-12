'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Search } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { LONG_OUT_DAYS } from '@nexus/factory-domain/purchasing/subcontract-depth/ageing'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import type { OpenBalance } from '../../depth/api'
import { balanceRowsOf, DEPTH, openText } from '../../depth/model'
import { ORDER_VIEWS, STATUS_TONE, type OrderView } from '../../model'
import type { SubcontractingActions, SubcontractingModel } from '../list-model'

/**
 * The saved view of the "Balance open" tile (B-W2b-344; design purchasing.subcontracting sec:tiles "Balance open (W2b)",
 * SCM-144): the jobs whose pieces are all back while kit material we sent is still out — GET …/balances?open=true, the
 * API's own filter, never this list filtered here. In the shared list frame: the order (a link to its Material balance),
 * its state, the workshop, the work order, what is still open per unit, the lines open of the lines sent, since when and
 * how many days (long out past the long-out days); select-all, shift range, x, Export N (CSV) while rows are selected; a
 * search over what was read; Rows ▾ the other saved views. No money.
 */
export function BalanceOpenSection({ model, actions, ownKeys, onHelp }: { model: SubcontractingModel; actions?: SubcontractingActions; ownKeys: ListKey[]; onHelp: () => void }) {
  const t = useT('subcontracting')
  const depth = useT(DEPTH)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState('')
  const items = model.balanceRows.items
  const rows = useMemo(() => (items ? balanceRowsOf(items, query) : null), [items, query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = rows?.map((row) => row.order.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const latest = useRef(actions)
  latest.current = actions

  const columns = useMemo<ColDef<OpenBalance>[]>(() => {
    const href = (row: OpenBalance) => `${model.prefix}/purchasing/subcontracting/${row.order.id}`
    const NumberCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={`${href(data)}?tab=balance`}>
            {data.order.number}
          </Link>
          <span>
            <Pill tone={STATUS_TONE[data.order.status]}>{t(`status.${data.order.status}`)}</Pill>
          </span>
        </span>
      ) : null
    const WorkshopCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? (
        <span className="fw-by-cell" title={data.order.workshop.name}>
          <span className="fw-by-ellipsis">{data.order.workshop.name}</span>
          <span className="fw-by-cell-sub">{data.order.workshop.code}</span>
        </span>
      ) : null
    const WorkOrderCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? (
        model.can.workOrders ? (
          <Link className="fw-by-link" href={`${model.prefix}/production/work-orders/${data.order.workOrder.id}`}>
            {data.order.workOrder.number}
          </Link>
        ) : (
          <span>{data.order.workOrder.number}</span>
        )
      ) : null
    const OpenCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? <span className="fw-by-num fw-sc-late">{openText(data.open, (uom) => depth(`uom.${uom}`), (text) => quantity(text, locale, 4))}</span> : null
    const LinesCell = ({ data }: ICellRendererParams<OpenBalance>) => (data ? <span className="fw-by-num">{depth('balanceView.lines', { open: data.openLines, sent: data.kitLines })}</span> : null)
    const OutCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? (
        data.daysOut === null ? (
          <span className="fw-by-hint">—</span>
        ) : (
          <span className="fw-by-cell">
            <span className="fw-by-inline">
              <span className="fw-by-num">{depth('balance.days', { count: data.daysOut })}</span>
              {data.daysOut > LONG_OUT_DAYS && <Tag tone="danger">{depth('ageing.longOut')}</Tag>}
            </span>
            {data.oldestSentAt && <span className="fw-by-cell-sub">{depth('balanceView.since', { date: formatDate(data.oldestSentAt, place) })}</span>}
          </span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<OpenBalance>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.order.number }) }}
          items={[
            { id: 'balance', label: depth('tab.balance'), href: `${href(data)}?tab=balance` },
            { id: 'open', label: t('common.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: `${href(data)}?tab=balance`, target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.order.number ?? '', cellRenderer: NumberCell },
      { colId: 'workshop', headerName: t('col.workshop'), minWidth: 170, flex: 1.4, valueGetter: (params) => params.data?.order.workshop.name ?? '', cellRenderer: WorkshopCell },
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 120, flex: 0.9, cellRenderer: WorkOrderCell },
      { colId: 'open', headerName: depth('balanceView.col.open'), minWidth: 150, flex: 1.2, cellRenderer: OpenCell },
      { colId: 'lines', headerName: depth('balanceView.col.lines'), minWidth: 120, flex: 0.8, cellRenderer: LinesCell },
      { colId: 'out', headerName: depth('balanceView.col.daysOut'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.daysOut ?? -1, cellRenderer: OutCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, depth, locale, model.prefix, model.can.workOrders, model.timeZone])

  const picked = (rows ?? []).filter((row) => selected.includes(row.order.id))
  const state = model.balanceRows.problem ? (
    <EmptyState title={depth('balanceView.failed')} description={depth(model.balanceRows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={depth('balanceView.empty.title')} description={depth('balanceView.empty.body')} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => setQuery('')}>{t('common.clearFilters')}</Button>} />
  ) : undefined

  return (
    <>
      <p className="fw-by-hint">{depth('balanceView.intro')}</p>
      <ListFrame<OpenBalance>
        label={depth('balanceView.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.order.id}
        columns={columns}
        count={rows ? depth('balanceView.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={depth('balanceView.search')}
            placeholder={depth('balanceView.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => latest.current?.onView?.(event.target.value as OrderView)}>
            {ORDER_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={depth('balanceView.export', { count: picked.length })} onClick={() => actions?.onExportBalances?.(picked.map((row) => row.order.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{depth('balanceView.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.order.id)}
        state={state}
        listKey="purchasing.subcontracting.3"
        focusRow={model.focusRow}
      />
      {model.slow && items === null && !model.balanceRows.problem && (
        <p className="fw-by-hint" role="status">
          {t('list.loadingSlow')}
        </p>
      )}
      <p className="fw-by-hint">{t('list.viewing', { view: t('view.balance') })}</p>
    </>
  )
}
