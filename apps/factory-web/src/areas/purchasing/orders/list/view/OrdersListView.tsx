'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, DateField, EmptyState, Field, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, money } from '../../../../_shared/buying/model'
import type { OrderRow } from '../../api'
import { confirmationPhrase, ORDER_TILES, ORDER_VIEWS, STATUS_TONE, type OrdersListActions, type OrdersListModel, type OrderView } from '../../model'
import '../../../../_shared/buying/buying.css'

export type { OrdersListActions, OrdersListModel } from '../../model'

/**
 * SCR-058 — Purchase orders (Purchasing; design purchasing.orders, 00 §2.1 list frame): the tiles "Where POs stand"
 * (drafts to send, waiting for the supplier, not confirmed after 48 h, changes proposed, declined — each a saved view),
 * the shared list frame (search by number; Rows ▾ views; select-all, shift range, x; Export N (CSV) while rows are
 * selected; live changes behind "N updates · Show"), each number a real link to the PO studio, the supplier's answer in
 * words, the need and confirmed dates, the value (cost grain only: the column is not drawn without it), and New purchase
 * order (`c`, `?new=1`): supplier, delivery site, requested date — the number comes from the series when it is made.
 */
export function OrdersListView({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  return (
    <WithMessages namespaces={['buying', 'lists']}>
      <OrdersList model={model} actions={actions} />
    </WithMessages>
  )
}

function OrdersList({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  const t = useT('buying')
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const now = useMemo(() => (model.now ? new Date(model.now) : new Date()), [model.now])
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newOrder || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.poManage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('po.list.keyNew') }]
  const siteName = (id: string) => model.sites.find((site) => site.id === id)?.code ?? '—'
  const picked = (items ?? []).filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<OrderRow>[]>(() => {
    const href = (row: OrderRow) => `${model.prefix}/purchasing/orders/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{data.revision > 1 ? t('po.list.revision', { revision: data.revision }) : formatDate(dayAt(data.orderDate), place)}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`poStatus.${data.status}`)}</Pill> : null)
    const ConfirmationCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const words = confirmationPhrase(data, now)
      const text = t(words.key, words.params)
      return data.status === 'CHANGES_PROPOSED' ? (
        <Link className="fw-by-link" href={`${href(data)}?tab=answer`}>
          {text}
        </Link>
      ) : (
        <span className="fw-by-ellipsis">{text}</span>
      )
    }
    const DatesCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{data.earliestNeedDate ? formatDate(dayAt(data.earliestNeedDate), place) : '—'}</span>
          <span className="fw-by-cell-sub">{data.latestConfirmedDate ? t('po.list.confirmedFor', { date: formatDate(dayAt(data.latestConfirmedDate), place) }) : t('po.list.noConfirmedDate')}</span>
        </span>
      ) : null
    const ValueCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span className="fw-by-num">{money(data.netAmount ?? null, data.currency, locale)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('po.list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('common.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'answer', label: t('po.tab.answer'), href: `${href(data)}?tab=answer` },
            { id: 'receipts', label: t('po.tab.receipts'), href: `${href(data)}?tab=receipts` },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('po.col.number'), field: 'number', minWidth: 140, flex: 1, cellRenderer: NumberCell },
      { colId: 'supplier', headerName: t('po.col.supplier'), field: 'supplierName', minWidth: 170, flex: 1.5, tooltipField: 'supplierName' },
      { colId: 'status', headerName: t('po.col.status'), field: 'status', minWidth: 160, flex: 0.9, cellRenderer: StatusCell },
      { colId: 'confirmation', headerName: t('po.col.confirmation'), minWidth: 200, flex: 1.6, cellRenderer: ConfirmationCell },
      { colId: 'dates', headerName: t('po.col.need'), minWidth: 150, flex: 1.1, cellRenderer: DatesCell },
      { colId: 'lines', headerName: t('po.col.lines'), field: 'lineCount', minWidth: 92, flex: 0.4, type: 'rightAligned' },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('po.col.value'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<OrderRow>] : []),
      { colId: 'site', headerName: t('po.col.site'), minWidth: 80, flex: 0.5, valueGetter: (params) => (params.data ? siteName(params.data.siteId) : '') },
      { colId: 'more', headerName: t('po.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.cost, model.sites, now])

  if (!model.can.poView) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('po.noAccess.title')} description={t('po.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const tileView = ORDER_TILES.find((tile) => tile.view === model.view)?.view ?? null
  const state = model.rows.problem ? (
    <EmptyState title={t('po.list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    model.q.trim() !== '' || model.view !== 'all' ? (
      <EmptyState
        title={t('po.list.noMatch.title')}
        description={t('po.list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onView?.('all')
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('po.list.empty.title')}
        description={
          <>
            {t('po.list.empty.body')}{' '}
            {model.can.planView && (
              <Link className="fw-by-link" href={`${model.prefix}/planning/mrp`}>
                {t('po.list.empty.fromPlan')}
              </Link>
            )}
          </>
        }
        action={
          model.can.poManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              <Plus size={14} aria-hidden /> {t('po.list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-by-actions">
          {model.can.planView && (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/planning/mrp`}>{t('po.list.fromPlan')}</Link>
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={model.can.poManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('po.list.new')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <MetricStrip
        metrics={ORDER_TILES.map((tile) => ({
          label: t(`po.tile.${tile.id}`),
          value: model.summary ? String(tile.count(model.summary)) : '—',
          onClick: () => actions?.onView?.(model.view === tile.view ? 'all' : tile.view),
          active: tileView === tile.view,
        }))}
      />

      <ListFrame<OrderRow>
        label={t('po.list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('po.list.search')}
            placeholder={t('po.list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('po.list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as OrderView)}>
            {ORDER_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`po.view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('po.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('po.bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.view !== 'all' && <p className="fw-by-hint">{t('po.list.viewing', { view: t(`po.view.${model.view}`) })}</p>}

      {model.newOrder && <NewOrderDialog model={model} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-by-list">
            {listKeys(ownKeys, true).map((entry) => (
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

/** New purchase order: an active supplier, the delivery site, a requested date; the number comes from the series. */
function NewOrderDialog({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const draft = model.newOrder!
  const supplier = draft.supplier
  const blocked = supplier && (supplier.status === 'BLOCKED' || supplier.status === 'ARCHIVED')
  const held = draft.busy ? t('held.busy') : !supplier ? t('po.new.pickSupplier') : blocked ? t('po.new.blocked', { supplier: supplier.legalName }) : !draft.siteId ? t('po.new.pickSite') : null
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('po.new.title')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNew?.(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.newOrder?.onCreate?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {draft.busy && <Spinner size={12} />} {t('po.new.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-by-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            actions?.newOrder?.onCreate?.()
          }
        }}
      >
        <Field label={t('po.new.supplier')} required hint={t('po.new.supplierHint')}>
          <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.query} onChange={(event) => actions?.newOrder?.onQuery?.(event.target.value)} placeholder={t('po.new.supplierSearch')} autoFocus />
        </Field>
        {draft.suppliersProblem ? (
          <Banner tone="danger" title={t(draft.suppliersProblem)} />
        ) : draft.suppliers === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : draft.suppliers.length === 0 ? (
          <p className="fw-by-hint">{t('po.new.noSupplier')}</p>
        ) : (
          <div className="fw-by-stack" role="radiogroup" aria-label={t('po.new.supplier')}>
            {draft.suppliers.slice(0, 8).map((option) => (
              <Button key={option.id} size="sm" variant={supplier?.id === option.id ? 'tonal' : 'quiet'} active={supplier?.id === option.id} aria-pressed={supplier?.id === option.id} onClick={() => actions?.newOrder?.onSupplier?.(option)}>
                <span className="fw-by-inline">
                  <b>{option.legalName}</b>
                  <span className="fw-by-hint">
                    {option.code} · {option.country} · {option.currency}
                  </span>
                  {option.status !== 'ACTIVE' && <Tag tone={option.status === 'PROSPECT' ? 'warning' : 'danger'}>{t(`party.${option.status}`)}</Tag>}
                </span>
              </Button>
            ))}
          </div>
        )}
        {supplier?.status === 'PROSPECT' && <Banner tone="warning" title={t('po.new.prospect')} />}
        <div className="fw-by-fields">
          <Field label={t('po.new.site')} required>
            <Select size="sm" value={draft.siteId ?? ''} onChange={(event) => actions?.newOrder?.onSite?.(event.target.value)}>
              <option value="">{t('po.new.pickSite')}</option>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {site.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('po.new.requested')} hint={t('po.new.requestedHint')}>
            <DateField value={draft.requestedDate} onChange={(value) => actions?.newOrder?.onRequestedDate?.(value)} locale={locale === 'it' ? 'it-IT' : 'en-GB'} clearable clearLabel={t('common.clear')} />
          </Field>
        </div>
        <KeyFacts supplierCurrency={supplier?.currency ?? null} />
        {draft.problem && <Banner tone="danger" title={t(draft.problem.key, draft.problem.params)} />}
      </div>
    </Modal>
  )
}

function KeyFacts({ supplierCurrency }: { supplierCurrency: string | null }) {
  const t = useT('buying')
  return (
    <ul className="fw-by-list">
      <li>{supplierCurrency ? t('po.new.currency', { currency: supplierCurrency }) : t('po.new.currencyLater')}</li>
      <li>{t('po.new.number')}</li>
      <li>{t('po.new.afterCreate')}</li>
    </ul>
  )
}

