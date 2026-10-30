'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, Download, MessageSquareWarning, MoreHorizontal, Play, Plus, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Kbd, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { Freshness, NoAccess, PageHead } from '../../_shared/parts'
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES, COMPLAINT_VIEWS, type ComplaintRow, type ComplaintView } from '../api'
import { COMPLAINT_TILES, garmentWords, isFiltered, personName, recordHref, rowStep, type ComplaintTile } from '../model'
import type { ComplaintsListActions, ComplaintsListModel } from '../view-model'
import { LogComplaintModal } from './LogComplaintModal'
import { AcknowledgeDialog, CategoryTag, ComplaintsMessages, DueText, isPageKey, KeysModal, SafetyBanner, say, SeverityTag, StatusPill, useWords } from './parts'
import { TriageModal } from './TriageModal'

export type { ComplaintsListActions, ComplaintsListModel } from '../view-model'

/**
 * SCR-113 Complaints (Quality › Problems; design quality.complaints, W2a part: SAL-416, QHS-113, QHS-115): customer
 * complaints with severity and answer due. The head (one sentence, Updated · Live, Triage (n), Log complaint), the
 * safety banner (a safety complaint the owner has not acknowledged: never timed out), the tiles (each a named saved
 * filter: pressing one puts its chip in the toolbar), then the ONE list frame: count, search, Rows ▾, Filters ▾, chips,
 * ⋯ — swapped for the bulk actions while rows are selected (Triage N, Copy numbers, Export N) — and the footer with Show
 * more and the keys icon. A new complaint opens in the triage DetailModal (J / K), any other its record page. The order's
 * value only with the price grain. Fetches nothing: ComplaintsPage.tsx reads and writes.
 */
export function ComplaintsView({ model, actions }: { model: ComplaintsListModel; actions?: ComplaintsListActions }) {
  return (
    <ComplaintsMessages>
      <Complaints model={model} actions={actions} />
    </ComplaintsMessages>
  )
}

const TILE_COUNT: Readonly<Record<ComplaintTile, (tiles: NonNullable<ComplaintsListModel['counts']>['tiles']) => number>> = {
  new: (tiles) => tiles.new,
  safety: (tiles) => tiles.safety,
  dueSoon: (tiles) => tiles.dueSoon,
  open: (tiles) => tiles.open,
  answeredMonth: (tiles) => tiles.answeredMonth,
}

function Complaints({ model, actions }: { model: ComplaintsListModel; actions?: ComplaintsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const can = model.can
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = useMemo(() => model.rows.items ?? [], [model.rows.items])
  const rowsKey = items.map((row) => row.id).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const address = model.address

  // The cells reach the page's latest actions and words through a ref: the grid keeps its columns between renders.
  const latest = useRef({ actions, can, people: model.rows.people })
  latest.current = { actions, can, people: model.rows.people }
  const columns = useMemo<ColDef<ComplaintRow>[]>(() => {
    const ComplaintCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        <span className="fw-q-cell">
          <Link
            className="fw-q-name fw-q-code"
            href={data.status === 'NEW' ? `${model.prefix}/quality/complaints?open=${encodeURIComponent(data.id)}` : recordHref(model.prefix, data.id)}
            tabIndex={-1}
            onClick={(event) => {
              if (data.status !== 'NEW' || event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              latest.current.actions?.onOpen?.(data)
            }}
          >
            {data.number}
          </Link>
          <span className="fw-q-hint fw-cmp-ellipsis" title={data.summary}>
            {data.summary}
          </span>
        </span>
      ) : null
    const ReceivedCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{formatDate(data.receivedAt, { locale })}</span>
          <span className="fw-q-hint">{t(`channel.${data.channel}`)}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-cmp-ellipsis" title={data.party.legalName}>
            {data.party.legalName}
          </span>
          <span className="fw-q-hint">{data.customerRef ? t('row.theirRef', { ref: data.customerRef }) : data.party.code}</span>
        </span>
      ) : null
    const OrderCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        data.order || data.shipment ? (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.order?.number ?? '—'}</span>
            <span className="fw-q-hint fw-q-code">{data.shipment?.number ?? (data.return ? data.return.number : '')}</span>
          </span>
        ) : (
          <span className="fw-q-hint">{data.return?.number ?? '—'}</span>
        )
      ) : null
    const GarmentCell = ({ data }: ICellRendererParams<ComplaintRow>) => {
      if (!data) return null
      const garment = garmentWords(data)
      return (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.style ? `${data.style.code}${data.size ? ` · ${data.size}` : ''}` : (data.size ?? '—')}</span>
          <span className="fw-q-hint fw-q-code">{garment ? say(t, garment) : ''}</span>
        </span>
      )
    }
    const CategoryCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        // Two lines like the other cells (a wrapping row of three outgrew the row): the tags, then the alert's state.
        <span className="fw-q-cell">
          <span className="fw-cmp-tags">
            <CategoryTag category={data.category} />
            {data.severity && <SeverityTag severity={data.severity} />}
          </span>
          {data.safety.state === 'RAISED' && <span className="fw-q-hint fw-cmp-due-danger">{t('row.notAcknowledged')}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ComplaintRow>) => (data ? <StatusPill status={data.status} /> : null)
    const OwnerCell = ({ data }: ICellRendererParams<ComplaintRow>) => (data ? <span className="fw-cmp-ellipsis">{personName(latest.current.people, data.ownerId) ?? '—'}</span> : null)
    const DueCell = ({ data }: ICellRendererParams<ComplaintRow>) => (data ? <DueText row={data} today={model.today} /> : null)
    const NcrCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        data.ncrs.length > 0 ? (
          <span className="fw-q-cell-row">
            {data.ncrs.slice(0, 2).map((ncr) => (
              <span key={ncr.id} className="fw-q-code">
                {ncr.number}
              </span>
            ))}
            {data.ncrs.length > 2 && <span className="fw-q-hint">{t('row.more', { count: data.ncrs.length - 2 })}</span>}
          </span>
        ) : (
          <span className="fw-q-hint">—</span>
        )
      ) : null
    const RegisterCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? (
        data.register ? (
          <Link className="fw-q-link fw-q-code" href={`${model.prefix}/compliance/register/${encodeURIComponent(data.register.id)}`} tabIndex={-1}>
            {data.register.reference}
          </Link>
        ) : (
          <span className="fw-q-hint">{t('row.notInRegister')}</span>
        )
      ) : null
    const ValueCell = ({ data }: ICellRendererParams<ComplaintRow>) =>
      data ? <span className="fw-q-num">{data.order?.netAmount !== undefined && data.order ? formatNumber(data.order.netAmount / 100, locale, { style: 'currency', currency: data.order.currency }) : '—'}</span> : null
    const MoreCell = ({ data }: ICellRendererParams<ComplaintRow>) => {
      if (!data) return null
      const now = latest.current
      const triage = rowStep(data, 'triage', now.can)
      const register = rowStep(data, 'register', now.can)
      const ncr = rowStep(data, 'createNcr', now.can)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: recordHref(model.prefix, data.id) },
        { id: 'tab', label: t('row.openNewTab'), href: recordHref(model.prefix, data.id), target: '_blank' },
        { id: 'triage', label: t('row.triage'), onSelect: () => now.actions?.onStartTriage?.([data.id]), disabled: !triage.allowed, description: triage.held ? t(triage.held) : undefined },
        { id: 'ncr', label: t('row.createNcr'), href: ncr.allowed ? `${recordHref(model.prefix, data.id)}?do=ncr` : undefined, disabled: !ncr.allowed, description: ncr.held ? t(ncr.held) : undefined },
        { id: 'register', label: t('row.register'), href: register.allowed ? `${recordHref(model.prefix, data.id)}?do=register` : undefined, disabled: !register.allowed, description: register.held ? t(register.held) : undefined },
        { id: 'copy', label: t('row.copy'), onSelect: () => now.actions?.onCopy?.(data.number) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ComplaintRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<ComplaintRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    const list: ColDef<ComplaintRow>[] = [
      column('complaint', t('col.complaint'), ComplaintCell, { flex: 1.5, minWidth: 190 }),
      column('received', t('col.received'), ReceivedCell, { flex: 0.8, minWidth: 110 }),
      column('customer', t('col.customer'), CustomerCell, { flex: 1.2, minWidth: 160 }),
      column('order', t('col.order'), OrderCell, { flex: 0.9, minWidth: 130 }),
      column('garment', t('col.garment'), GarmentCell, { flex: 1, minWidth: 140 }),
      column('category', t('col.category'), CategoryCell, { flex: 1.2, minWidth: 190 }),
      column('status', t('col.status'), StatusCell, { flex: 0.8, minWidth: 120 }),
      column('owner', t('col.owner'), OwnerCell, { flex: 0.9, minWidth: 120 }),
      column('due', t('col.due'), DueCell, { flex: 0.9, minWidth: 130 }),
      column('ncr', t('col.ncr'), NcrCell, { flex: 0.7, minWidth: 100 }),
      { ...column('capa', t('col.capa'), () => <span className="fw-q-hint">—</span>, { flex: 0.5, minWidth: 80 }), headerTooltip: t('col.capaHint') },
      column('register', t('col.register'), RegisterCell, { flex: 0.9, minWidth: 130 }),
      {
        ...column('value', t('col.value'), ValueCell, { flex: 0.8, minWidth: 120 }),
        headerTooltip: can.price ? t('col.valueHint') : t('col.valueNoGrain'),
      },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true, suppressMovable: true },
    ]
    return list
    // The cells close over the words, the prefix and the day: a change of language rebuilds them.
  }, [t, locale, model.prefix, model.today, can.price])

  // c: Log complaint; t: Triage (the queue of new complaints) — never while typing, in a menu or a dialog.
  const dialogOpen = !!(model.triage || model.log || model.acknowledge || help)
  const keys = useRef({ actions, can, offline: model.offline })
  keys.current = { actions, can, offline: model.offline }
  useEffect(() => {
    if (dialogOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event)) return
      const now = keys.current
      if (event.key === 'c' && now.can.log && !now.offline) {
        event.preventDefault()
        now.actions?.onLog?.()
      } else if (event.key === 't' && now.can.manage) {
        event.preventDefault()
        now.actions?.onStartTriage?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const counts = model.counts
  const fresh = counts?.tiles.new ?? null
  const triageHeld = !can.manage ? t('held.NO_PERMISSION.triage') : fresh === 0 ? t('held.nothingToTriage') : null
  const logHeld = !can.log ? t('held.NO_PERMISSION.log') : model.offline ? t('held.offline') : null
  const acknowledgeHeld = !can.acknowledge ? 'held.NO_PERMISSION.acknowledge' : model.offline ? 'held.offline' : null
  const filtered = isFiltered(address)
  const pickedRows = items.filter((row) => selected.includes(row.id))
  const pickedNew = pickedRows.filter((row) => row.status === 'NEW')

  const tile = (id: ComplaintTile) => {
    const active = address.view === id
    return {
      label: t(`tile.${id}`),
      value: counts ? String(TILE_COUNT[id](counts.tiles)) : model.countsFailed ? '—' : <Skeleton width={36} height={22} />,
      hint: model.countsFailed ? t('tile.unknown') : t(`tileHint.${id}`),
      active,
      onClick: () => actions?.onAddress?.({ view: active ? 'open' : id }),
    }
  }

  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') } as MenuItemDef,
    ...(COMPLAINT_VIEWS as readonly ComplaintView[]).map((view) => ({ id: view, label: t(`view.${view}`), checked: address.view === view, onSelect: () => actions?.onAddress?.({ view }) }) as MenuItemDef),
  ]
  const filterItems: MenuItemDef[] = [
    { id: 'category', heading: true, label: t('col.category') } as MenuItemDef,
    ...COMPLAINT_CATEGORIES.map((category) => ({ id: `c-${category}`, label: t(`category.${category}`), checked: address.category === category, onSelect: () => actions?.onAddress?.({ category: address.category === category ? null : category }) }) as MenuItemDef),
    { id: 'sep1', separator: true } as MenuItemDef,
    { id: 'severity', heading: true, label: t('triage.severity') } as MenuItemDef,
    ...COMPLAINT_SEVERITIES.map((severity) => ({ id: `s-${severity}`, label: t(`severity.${severity}`), checked: address.severity === severity, onSelect: () => actions?.onAddress?.({ severity: address.severity === severity ? null : severity }) }) as MenuItemDef),
    { id: 'sep2', separator: true } as MenuItemDef,
    { id: 'mine', label: t('list.mine'), checked: address.mine, onSelect: () => actions?.onAddress?.({ mine: !address.mine }) },
  ]
  const filterCount = (address.category ? 1 : 0) + (address.severity ? 1 : 0) + (address.mine ? 1 : 0)
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const linked = address.partyId || address.salesOrderId || address.shipmentId || address.returnId
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${address.view}`) })} items={viewItems} />
      <Menu label={filterCount > 0 ? t('list.filtersCount', { count: filterCount }) : t('list.filters')} items={filterItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {address.view !== 'open' && chip('view', t(`view.${address.view}`), () => actions?.onAddress?.({ view: 'open' }))}
          {address.category && chip('category', t(`category.${address.category}`), () => actions?.onAddress?.({ category: null }))}
          {address.severity && chip('severity', t(`severity.${address.severity}`), () => actions?.onAddress?.({ severity: null }))}
          {address.mine && chip('mine', t('list.mine'), () => actions?.onAddress?.({ mine: false }))}
          {linked && chip('linked', t('list.linked'), () => actions?.onAddress?.({ partyId: null, salesOrderId: null, shipmentId: null, returnId: null }))}
          {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => actions?.onAddress?.({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )
  const moreItems: MenuItemDef[] = [
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(items), disabled: items.length === 0, description: items.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: items.length }) },
    { id: 'print', label: t('list.print'), onSelect: () => window.print() },
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
  ]

  const bulkActions = (
    <>
      <Button size="sm" aria-label={t('list.bulkTriage', { count: pickedNew.length })} heldReason={!can.manage ? t('held.NO_PERMISSION.triage') : pickedNew.length === 0 ? t('held.noneNew') : null} onClick={() => actions?.onStartTriage?.(pickedNew.map((row) => row.id))}>
        <Play size={13} aria-hidden /> <SelectionLabel>{t('list.bulkTriage', { count: pickedNew.length })}</SelectionLabel>
      </Button>
      <Button size="sm" aria-label={t('list.bulkCopy', { count: pickedRows.length })} onClick={() => actions?.onCopy?.(pickedRows.map((row) => row.number).join(', '))}>
        <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.bulkCopy', { count: pickedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" aria-label={t('list.bulkExport', { count: pickedRows.length })} onClick={() => actions?.onExport?.(pickedRows)}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: pickedRows.length })}</SelectionLabel>
      </Button>
    </>
  )

  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : model.rows.items !== null && items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<MessageSquareWarning size={24} aria-hidden />}
        title={t('list.empty')}
        description={t('list.emptyBody')}
        action={
          <Button variant="primary" heldReason={logHeld} onClick={() => actions?.onLog?.()}>
            {t('log.action')}
          </Button>
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.log') },
    { keys: ['t'], does: t('keys.triage') },
  ]

  return (
    <div className="fw-q">
      <PageHead
        intro={t('intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Button size="sm" heldReason={triageHeld} onClick={() => actions?.onStartTriage?.()} aria-keyshortcuts="t">
              <Play size={14} aria-hidden /> {fresh === null ? t('head.triage') : t('head.triageCount', { count: fresh })} <Kbd>T</Kbd>
            </Button>
            <Button size="sm" variant="primary" heldReason={logHeld} onClick={() => actions?.onLog?.()} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('log.action')} <Kbd>C</Kbd>
            </Button>
          </>
        }
      />
      {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.notice.detail ? say(t, model.notice.detail) : null}
        </Banner>
      )}
      {counts && <SafetyBanner alerts={counts.safetyAlerts} more={counts.moreSafetyAlerts} prefix={model.prefix} acknowledgeHeld={acknowledgeHeld} onAcknowledge={(alert) => actions?.onAcknowledge?.(alert)} />}
      <MetricStrip metrics={COMPLAINT_TILES.map(tile)} />

      <ListFrame<ComplaintRow>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={address.q}
            onChange={(event) => actions?.onAddress?.({ q: event.target.value })}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected, onChange: setSelected, actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: model.rows.loadingMore ? t('common.loading') : null } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        title={t('list.exportTitle')}
      />

      {model.triage && <TriageModal model={model.triage} prefix={model.prefix} actions={actions} />}
      {model.log && <LogComplaintModal model={model.log} prefix={model.prefix} actions={actions} />}
      <AcknowledgeDialog
        open={!!model.acknowledge}
        number={model.acknowledge?.alert.number ?? ''}
        busy={!!model.acknowledge?.busy}
        problem={model.acknowledge?.problem ?? null}
        onConfirm={(note) => actions?.onAcknowledgeConfirm?.(note)}
        onClose={() => actions?.onAcknowledgeClose?.()}
      />
      {help && <KeysModal own={[...ownKeys, { keys: ['J', 'K'], does: t('keys.walk') }, { keys: ['⌘', '↵'], does: t('keys.saveNext') }]} onClose={() => setHelp(false)} />}
    </div>
  )
}
