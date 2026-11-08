'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import { Download, MoreHorizontal, Truck } from 'lucide-react'
import { Banner, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { NoticeRow, NoticeState, NoticesRead } from '../api'
import { chipsOf, isOpenNotice, newHref, noticeHref, orderHref, rowHref, stateTone, writeHeld, type WriteFacts } from '../model'
import { useDeliveryWords } from '../words'
import { CancelDialog, type CancelModel } from './Dialogs'
import '../deliveries.css'

/**
 * SCR-227 › Ship notices (design portal.supplier.asn sec:asn-grid "Deliveries you announced — every ship notice and how it
 * was received"): the states as chips with counts, the notices in the shared list frame (select-all, shift range, x / Space,
 * Export N while rows are selected, the keys only in the footer's info icon), their reference first. Row → the notice (a
 * draft at its steps); ⋯ Change (sent), Cancel… (before receipt). No price anywhere (C2).
 */

export interface DeliveriesListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: NoticesRead | null
  /** The state asked in the address (null: every notice). */
  chip: NoticeState | null
  q: string
  prefix: string
  selected: readonly string[]
  facts: Omit<WriteFacts, 'mayWrite' | 'busy'>
  busy: boolean
  dialog: CancelModel | null
  /** Live: the list changed since it was read. */
  updates: number
  keysOpen?: boolean
}

export interface DeliveriesListActions {
  onChip?: (state: NoticeState | null) => void
  onSearch?: (q: string) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: NoticeRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onCancel?: (row: NoticeRow) => void
  onExport?: (ids: readonly string[] | null) => void
  onHelp?: () => void
  dialog?: { onReason?: (reason: string) => void; onConfirm?: () => void; onClose?: () => void }
}

export function DeliveriesListView({ model, actions }: { model: DeliveriesListViewModel; actions?: DeliveriesListActions }) {
  const words = useDeliveryWords()
  const { t, day } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const rows = read?.items ?? null
  const facts: WriteFacts = { ...model.facts, mayWrite: read?.mayWrite ?? true, busy: model.busy }
  const announceHeld = writeHeld(facts)

  const columns = useMemo((): ColDef<NoticeRow>[] => {
    const follow = (event: MouseEvent, row: NoticeRow) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onOpen?.(row)
    }
    const NoticeCell = ({ data }: ICellRendererParams<NoticeRow>) => {
      if (!data) return null
      const now = latest.current.model
      return (
        <a className="fw-psn-rowlink" href={rowHref(now.prefix, data)} onClick={(event) => follow(event, data)}>
          <RefPair theirs={data.supplierRef} ours={data.number ?? t('row.draft')} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} layout="stacked" size="sm" copy={false} match={now.q || null} labels={ds.refPair} />
        </a>
      )
    }
    const OrderCell = ({ data }: ICellRendererParams<NoticeRow>) => (data ? <a href={orderHref(latest.current.model.prefix, data.purchaseOrder.id)}>{data.purchaseOrder.number}</a> : null)
    // Design: the ship date; the day it arrives under it (our dock plans by it).
    const ShipCell = ({ data }: ICellRendererParams<NoticeRow>) => {
      if (!data) return null
      return (
        <span className="fw-psn-two">
          <span>{data.shipDate ? day(data.shipDate) : '—'}</span>
          {data.expectedDate ? <span className="fw-psn-sub">{t('row.arrives', { date: day(data.expectedDate) })}</span> : null}
        </span>
      )
    }
    const CarrierCell = ({ data }: ICellRendererParams<NoticeRow>) => {
      if (!data) return null
      if (!data.carrier && !data.trackingNumber) return <span>—</span>
      return (
        <span className="fw-psn-two">
          <span>{data.carrier ?? '—'}</span>
          {data.trackingNumber ? <span className="fw-psn-sub">{data.trackingNumber}</span> : null}
        </span>
      )
    }
    const LinesCell = ({ data }: ICellRendererParams<NoticeRow>) => (data ? <span>{data.hides > 0 ? `${t('row.lines', { count: data.lines })} · ${t('row.hides', { count: data.hides })}` : t('row.lines', { count: data.lines })}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<NoticeRow>) => {
      if (!data) return null
      return (
        <span className="fw-psn-two">
          <Pill tone={stateTone(data.state)}>{t(`state.${data.state}`)}</Pill>
          {data.differing > 0 ? <span className="fw-psn-sub fw-psn-warn">{t('row.differing', { count: data.differing })}</span> : null}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<NoticeRow>) => {
      if (!data) return null
      const now = latest.current.model
      const held = writeHeld({ ...now.facts, mayWrite: now.read?.mayWrite ?? true, busy: now.busy })
      const open = isOpenNotice(data.status)
      const items: MenuItemDef[] = [
        { id: 'open', label: data.status === 'DRAFT' ? t('row.continue') : t('row.open'), href: rowHref(now.prefix, data) },
        ...(data.status === 'SENT' ? [{ id: 'change', label: t('row.change'), href: noticeHref(now.prefix, data.id, 'lines'), disabled: held !== null, description: held ? t(held) : undefined }] : []),
        ...(open ? [{ id: 'cancel', label: data.status === 'DRAFT' ? t('row.discard') : t('row.cancel'), disabled: held !== null, description: held ? t(held) : undefined, onSelect: () => latest.current.actions?.onCancel?.(data) }] : []),
        { id: 'order', label: t('row.order', { number: data.purchaseOrder.number }), href: orderHref(now.prefix, data.purchaseOrder.id) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number ?? t('row.draft') }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<NoticeRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<NoticeRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: their reference first, our number.
      { ...column('notice', t('col.notice'), NoticeCell, { flex: 1.2, minWidth: 200 }), valueGetter: ({ data }) => (data ? [data.supplierRef, data.number ?? t('row.draft')].filter(Boolean).join(' · ') : '') },
      column('order', t('col.order'), OrderCell, { flex: 0.8, minWidth: 110 }),
      column('ship', t('col.shipDate'), ShipCell, { flex: 0.9, minWidth: 130 }),
      column('carrier', t('col.carrier'), CarrierCell, { flex: 1, minWidth: 140 }),
      { ...column('ddt', t('col.ddt'), undefined, { flex: 0.8, minWidth: 110 }), valueGetter: ({ data }) => data?.ddtNumber ?? '—' },
      column('lines', t('col.lines'), LinesCell, { flex: 1, minWidth: 150 }),
      column('status', t('col.status'), StatusCell, { flex: 1.1, minWidth: 170 }),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, day, ds.refPair])

  const selected = model.selected
  const count = selected.length
  const bulk = (
    <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
    </Button>
  )

  const searching = model.q.trim() !== ''
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      searching ? (
        <EmptyState title={t('list.none')} description={t('list.noMatch', { q: model.q.trim() })} action={<Button size="sm" onClick={() => actions?.onSearch?.('')}>{t('list.clear')}</Button>} />
      ) : model.chip ? (
        <EmptyState title={t('list.none')} description={t('list.noneIn', { state: t(`state.${model.chip}`) })} action={<Button size="sm" onClick={() => actions?.onChip?.(null)}>{t('list.showAll')}</Button>} />
      ) : (
        <EmptyState
          icon={<Truck size={24} aria-hidden />}
          title={t('list.empty')}
          description={t('list.emptyBody')}
          action={
            <Button size="sm" variant="primary" asChild heldReason={announceHeld ? t(announceHeld) : null}>
              <a href={newHref(model.prefix)}>{t('band.announce')}</a>
            </Button>
          }
        />
      )
    ) : undefined

  return (
    <div className="fw-psn">
      <div className="fw-psn-chips" role="group" aria-label={t('chips.label')}>
        {chipsOf(read, model.chip).map((entry) => {
          const name = entry.state ? t(`state.${entry.state}`) : t('chips.all')
          return (
            <FilterChip key={entry.state ?? 'all'} pressed={entry.state === model.chip} onClick={() => actions?.onChip?.(entry.state)} aria-label={t('chips.chip', { name, count: entry.count })}>
              {name} <span className="fw-psn-chip-count">{entry.count}</span>
            </FilterChip>
          )
        })}
      </div>
      {read?.more ? <Banner tone="info" title={t('list.capped')} /> : null}
      <ListFrame<NoticeRow>
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
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        cards={{ hrefOf: (row) => rowHref(model.prefix, row) }}
        keysOpen={model.keysOpen}
      />
      {model.dialog ? <CancelDialog model={model.dialog} actions={actions?.dialog} /> : null}
    </div>
  )
}
