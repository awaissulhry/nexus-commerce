'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { CheckCheck, Download, FileText, MoreHorizontal, PackageSearch } from 'lucide-react'
import { Banner, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { copyHref, type OrderChip, type OrderRow, type OrdersRead } from '../api'
import { bulkConfirmHeld, confirmableOf, deliveryOf, recordHref, stateTone } from '../model'
import { useOrderWords } from '../words'
import { ConfirmAllDialog, type ConfirmAllModel } from './Dialogs'
import '../supplier-orders.css'

/**
 * SCR-189 › Purchase orders (design portal.supplier.orders: sec:chips "Which orders", sec:po-grid "Your purchase orders"):
 * saved filters with counts, the orders in the shared list frame (select-all, shift range, x / Space, the bulk actions in
 * the toolbar while rows are selected, the keys only in the footer's info icon), their reference first. Row → the order;
 * ⌘-click a new tab. Search: our PO, your confirmation no., your article code. No price anywhere (C2).
 */

export interface OrdersListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: OrdersRead | null
  /** The chip asked in the address (null: the API's default). */
  chip: OrderChip | null
  q: string
  prefix: string
  selected: readonly string[]
  facts: { mayAnswer: boolean; preview: boolean; offline: boolean }
  busy: boolean
  dialog: ConfirmAllModel | null
  /** Live: the list changed since it was read. */
  updates: number
  /** Design cases: the keys panel open, a row focused. */
  keysOpen?: boolean
}

export interface OrdersListActions {
  onChip?: (chip: OrderChip) => void
  onSearch?: (q: string) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: OrderRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onConfirm?: (ids: readonly string[]) => void
  onConfirmGo?: () => void
  onCloseDialog?: () => void
  onExport?: (ids: readonly string[] | null) => void
  onHelp?: () => void
}

export function OrdersListView({ model, actions }: { model: OrdersListViewModel; actions?: OrdersListActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const rows = read?.items ?? null
  const chip = read?.chip ?? model.chip

  const columns = useMemo((): ColDef<OrderRow>[] => {
    const OrderCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const href = recordHref(latest.current.model.prefix, data.id, data.canAnswer ? 'confirm' : 'lines')
      return (
        <a className="fw-pso-rowlink" href={href} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          latest.current.actions?.onOpen?.(data)
        }}>
          <RefPair theirs={data.supplierRef} ours={data.documentNumber} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} layout="stacked" size="sm" copy={false} match={latest.current.model.q || null} labels={ds.refPair} />
        </a>
      )
    }
    const SentCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{data.sentAt ? day(data.sentAt.slice(0, 10)) : '—'}</span> : null)
    const VersionCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{t('list.version', { version: data.revision })}</span> : null)
    const LinesCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{data.lines}</span> : null)
    const NeedCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{data.earliestNeedDate ? day(data.earliestNeedDate) : '—'}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      return (
        <span className="fw-pso-status">
          <Pill tone={stateTone(data.state)}>{data.words[locale]}</Pill>
          {data.confirmBy ? <span className="fw-pso-sub">{t('list.answerBy', { date: formatDate(data.confirmBy, { locale }) })}</span> : null}
        </span>
      )
    }
    const DeliveryCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const delivery = deliveryOf(data)
      const text = t(delivery.key, { date: delivery.date ? day(delivery.date) : '' })
      return delivery.tone === 'danger' ? <Pill tone="danger">{text}</Pill> : <span className={delivery.tone === 'success' ? 'fw-pso-ok' : undefined}>{text}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const now = latest.current.model
      const held = data.canAnswer ? bulkConfirmHeld(1, { ...now.facts, busy: now.busy }) : 'held.answered'
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: recordHref(now.prefix, data.id) },
        { id: 'confirm', label: t('row.confirm'), disabled: held !== null, description: held ? t(held) : undefined, onSelect: () => latest.current.actions?.onConfirm?.([data.id]) },
        { id: 'pdf', label: t('row.pdf'), href: copyHref(data.id, locale), target: '_blank', icon: <FileText size={14} aria-hidden /> },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.documentNumber }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<OrderRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<OrderRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: their reference first, our PO.
      { ...column('order', t('col.order'), OrderCell, { flex: 1.5, minWidth: 240 }), valueGetter: ({ data }) => (data ? [data.supplierRef, data.documentNumber].filter(Boolean).join(' · ') : '') },
      column('sent', t('col.sentOn'), SentCell, { flex: 0.7, minWidth: 110 }),
      column('version', t('col.version'), VersionCell, { flex: 0.6, minWidth: 110 }),
      column('lines', t('col.lines'), LinesCell, { flex: 0.4, minWidth: 80 }),
      column('need', t('col.earliest'), NeedCell, { flex: 0.9, minWidth: 170 }),
      column('status', t('col.status'), StatusCell, { flex: 1.2, minWidth: 190 }),
      column('delivery', t('col.delivery'), DeliveryCell, { flex: 1.1, minWidth: 170 }),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, day, words, ds.refPair])

  const selected = model.selected
  const reach = rows ? confirmableOf(rows, selected) : []
  const bulkHeld = bulkConfirmHeld(reach.length, { ...model.facts, busy: model.busy })
  const count = selected.length
  const bulk = (
    <>
      <Button size="sm" variant="primary" heldReason={bulkHeld ? t(bulkHeld) : null} onClick={() => actions?.onConfirm?.(reach.map((row) => row.id))} aria-label={t('bulk.confirm', { count: reach.length, of: count })}>
        <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.confirm', { count: reach.length, of: count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )

  const searching = model.q.trim() !== ''
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      searching ? (
        <EmptyState title={t('list.none')} description={t('list.noMatch', { q: model.q.trim() })} action={<Button size="sm" onClick={() => actions?.onSearch?.('')}>{t('list.clear')}</Button>} />
      ) : chip && chip !== 'ALL' ? (
        <EmptyState title={t('list.none')} description={t(`list.noneIn.${chip}`)} action={<Button size="sm" onClick={() => actions?.onChip?.('ALL')}>{t('list.showAll')}</Button>} />
      ) : (
        <EmptyState icon={<PackageSearch size={24} aria-hidden />} title={t('list.empty')} description={t('list.emptyBody')} />
      )
    ) : undefined

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.confirm') }]

  return (
    <div className="fw-pso">
      <div className="fw-pso-chips" role="group" aria-label={t('chips.label')}>
        {read
          ? read.chips.map((entry) => (
              <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: entry.words[locale], count: entry.count })}>
                {entry.words[locale]} <span className="fw-pso-chip-count">{entry.count}</span>
              </FilterChip>
            ))
          : null}
      </div>
      {read && !read.complete ? <Banner tone="info" title={t('list.capped')} /> : null}
      <ListFrame<OrderRow>
        label={t('list.label')}
        title={t('list.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('list.count', { count: rows.length }) : ''}
        search={
          <Input
            type="search"
            aria-label={t('list.search')}
            placeholder={t('list.searchHint')}
            defaultValue={model.q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
              if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
            }}
            onBlur={(event) => {
              if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
            }}
          />
        }
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        cards={{ hrefOf: (row) => recordHref(model.prefix, row.id, row.canAnswer ? 'confirm' : 'lines') }}
        keysOpen={model.keysOpen}
      />
      {model.dialog ? <ConfirmAllDialog model={model.dialog} actions={{ onConfirm: () => actions?.onConfirmGo?.(), onClose: () => actions?.onCloseDialog?.() }} /> : null}
    </div>
  )
}
