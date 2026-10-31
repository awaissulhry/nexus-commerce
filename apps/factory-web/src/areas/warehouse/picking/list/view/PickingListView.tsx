'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ClipboardList, MoreHorizontal, Plus, Printer, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { PickRow, PickView } from '../../api'
import { pickedByWords, TILES } from '../../model'
import { KeysModal, KitPill, NoPickingAccess, PickingMessages, ReadinessButton, say, useWords, type ReadinessLinks } from '../../parts'
import type { PickingListActions, PickingListModel } from '../../view-model'
import { CreateDialog } from './CreateDialog'
import { PickListDialog } from './PickListDialog'

export type { PickingListActions, PickingListModel } from '../../view-model'

/**
 * SCR-237 — Picking & kits (Warehouse › In the warehouse; design warehouse.picking, pk-metrics + pk-grid): what the floor
 * must pick and whether the material is there (PLN-086). The tiles are saved rows (to pick today, waiting for material,
 * kits complete); one row per work order on the shared list frame: work order, style, cut date, the plan's readiness word
 * (its popover says why, with Open PO and Buy), lines picked ("6 of 9"), the kit's place (B-W2b-15: chosen in the pick
 * list), the kit's state and its check by hand, the teams that picked it (never a person), started and finished. A row opens its pick list (J / K walk
 * the rows); the selection prints one paper for all of them (sorted by bin path); Create pick lists (`c`) reserves what
 * the released work orders still need. Quantities only; no money.
 */
export function PickingListView({ model, actions }: { model: PickingListModel; actions?: PickingListActions }) {
  return (
    <PickingMessages>
      <PickingList model={model} actions={actions} />
    </PickingMessages>
  )
}

function PickingList({ model, actions }: { model: PickingListModel; actions?: PickingListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
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
  const [readiness, setReadiness] = useState<string | null>(model.readinessOpen ?? null)
  const rowsKey = model.rows.items?.map((row) => row.workOrder.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.address.view])

  const rows = model.rows.items ?? []
  const picked = rows.filter((row) => selected.includes(row.workOrder.id))
  const printIds = (picked.length > 0 ? picked : rows).slice(0, 20).map((row) => row.workOrder.id)

  // c: Create pick lists, p: print (design kb "p print") — never while typing, in a dialog or a menu. The frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.create || model.sheet || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.reserve) {
        event.preventDefault()
        latest.current?.onCreate?.()
      }
      if (event.key === 'p' && printIds.length > 0) {
        event.preventDefault()
        latest.current?.onPrint?.(printIds)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.create, model.sheet, model.can.reserve, help, printIds])

  const links: ReadinessLinks = useMemo(
    () => ({ order: model.can.purchasing ? (id: string) => `${model.prefix}/purchasing/orders/${encodeURIComponent(id)}` : null, buy: model.can.planning ? `${model.prefix}/planning/mrp` : null }),
    [model.can.purchasing, model.can.planning, model.prefix],
  )

  const columns = useMemo<ColDef<PickRow>[]>(() => {
    const workOrderHref = (row: PickRow) => `${model.prefix}/production/work-orders/${encodeURIComponent(row.workOrder.id)}`
    const NumberCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? (
        <span className="fw-st-cell">
          {model.can.workOrders ? (
            <Link className="fw-st-link fw-pk-code" href={workOrderHref(data)}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span className="fw-pk-code">{data.workOrder.number}</span>
          )}
          <span className="fw-st-sub">{t('list.pieces', { count: data.workOrder.pieces })}</span>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? (
        <span className="fw-st-cell" title={`${data.workOrder.style.code} · ${data.workOrder.style.name}`}>
          <span className="fw-st-ellipsis">{data.workOrder.style.name}</span>
          <span className="fw-st-sub">{data.workOrder.style.code}</span>
        </span>
      ) : null
    const CutCell = ({ data }: ICellRendererParams<PickRow>) => {
      if (!data) return null
      return (
        <span className="fw-st-cell">
          <span className="fw-st-num">{data.cutDate ? formatDate(`${data.cutDate}T12:00:00Z`, place) : '—'}</span>
          {!data.cutDate && <span className="fw-st-sub">{data.workOrder.dueDate ? t('list.due', { date: formatDate(`${data.workOrder.dueDate}T12:00:00Z`, place) }) : t('list.notPlanned')}</span>}
        </span>
      )
    }
    const ReadinessCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? <ReadinessButton row={data} links={links} open={readiness === data.workOrder.id} onOpenChange={(next) => setReadiness(next ? data.workOrder.id : null)} /> : null
    const LinesCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? (
        <span className="fw-st-num" title={t('list.linesTitle', { picked: data.lines.picked, all: data.lines.all })}>
          {data.lines.all === 0 ? '—' : t('list.lines', { picked: data.lines.picked, all: data.lines.all })}
        </span>
      ) : null
    // B-W2b-15: the kit's place (its code; the name on hover) and, once a person checked it, "Checked" with when.
    const PlaceCell = ({ data }: ICellRendererParams<PickRow>) =>
      data?.kit.location ? (
        <span className="fw-st-cell" title={`${data.kit.location.code} · ${data.kit.location.name}`}>
          <span>{data.kit.location.code}</span>
          <span className="fw-st-sub">{data.kit.location.name}</span>
        </span>
      ) : (
        <span className="fw-st-sub">{t('kit.placeNone')}</span>
      )
    const KitCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>
            <KitPill status={data.kit.status} />
            {data.kit.checkedAt && (
              <>
                {' '}
                <Tag tone="success" title={t('kit.checkedAt', { at: formatDateTime(data.kit.checkedAt, { locale, timeZone: model.timeZone }) })}>
                  {t('kit.checked')}
                </Tag>
              </>
            )}
          </span>
          {data.workOrder.onHold ? (
            <span className="fw-st-sub fw-pk-held">{data.workOrder.onHold.reason ? t('list.onHoldWhy', { reason: data.workOrder.onHold.reason }) : t('list.onHold')}</span>
          ) : (
            <span className="fw-st-sub">{data.pickList.created ? t('list.hasList') : t('list.noList')}</span>
          )}
        </span>
      ) : null
    const TeamCell = ({ data }: ICellRendererParams<PickRow>) => {
      const who = data ? pickedByWords(data) : null
      if (!who) return <span className="fw-st-sub">—</span>
      const words = [...who.teams, ...(who.office ? [t('list.office')] : [])].join(', ')
      return (
        <span className="fw-st-ellipsis" title={words}>
          {words}
        </span>
      )
    }
    const TimeCell =
      (pick: (row: PickRow) => string | null) =>
      ({ data }: ICellRendererParams<PickRow>) => {
        const value = data ? pick(data) : null
        if (!value) return <span className="fw-st-num">—</span>
        return (
          <span className="fw-st-cell" title={formatDateTime(value, place)}>
            <span className="fw-st-num">{formatDate(value, place)}</span>
            <span className="fw-st-sub">{formatTime(value, place)}</span>
          </span>
        )
      }
    const MoreCell = ({ data }: ICellRendererParams<PickRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.workOrder.number }) }}
          items={[
            { id: 'open', label: t('list.openList'), onSelect: () => actions?.onOpen?.(data.workOrder.id) },
            { id: 'print', label: t('list.printOne'), onSelect: () => actions?.onPrint?.([data.workOrder.id]) },
            ...(model.can.workOrders ? [{ id: 'wo', label: t('list.openWorkOrder'), href: workOrderHref(data) }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.workOrder'), minWidth: 130, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 150, flex: 1.3, cellRenderer: StyleCell },
      { colId: 'cut', headerName: t('col.cutDate'), minWidth: 110, flex: 0.7, cellRenderer: CutCell },
      { colId: 'readiness', headerName: t('col.readiness'), minWidth: 130, flex: 0.8, cellRenderer: ReadinessCell },
      { colId: 'lines', headerName: t('col.lines'), minWidth: 84, flex: 0.5, type: 'rightAligned', cellRenderer: LinesCell },
      { colId: 'place', headerName: t('col.kitPlace'), minWidth: 110, flex: 0.6, cellRenderer: PlaceCell },
      { colId: 'kit', headerName: t('col.kit'), minWidth: 120, flex: 0.8, cellRenderer: KitCell },
      { colId: 'team', headerName: t('col.team'), minWidth: 120, flex: 0.8, cellRenderer: TeamCell },
      { colId: 'started', headerName: t('col.started'), minWidth: 100, flex: 0.6, cellRenderer: TimeCell((row) => row.startedAt) },
      { colId: 'finished', headerName: t('col.finished'), minWidth: 100, flex: 0.6, cellRenderer: TimeCell((row) => row.finishedAt) },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.workOrders, model.timeZone, links, readiness])

  if (!model.can.view) {
    return (
      <div className="fw-pk">
        <NoPickingAccess />
      </div>
    )
  }

  const tileView = TILES.find((tile) => tile.view === model.address.view)?.view ?? null
  const filtered = model.address.q.trim() !== '' || model.address.view !== 'all' || model.address.siteId !== null
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.create') },
    { keys: ['p'], does: t('keys.print') },
  ]
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onSearch?.('')
        actions?.onView?.('all')
        actions?.onSite?.(null)
      }}
    >
      {t('stock:common.clearFilters')}
    </Button>
  )
  const createButton = (
    <Button size="sm" variant="primary" heldReason={model.can.reserve ? null : t('held.noReserve')} onClick={() => actions?.onCreate?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('band.create')}
    </Button>
  )
  const printLabel = picked.length > 0 ? t('band.printSelected', { count: Math.min(picked.length, 20) }) : t('band.printShown', { count: printIds.length })
  const printButton = (
    <Button size="sm" variant="secondary" heldReason={printIds.length === 0 ? t('held.nothingToPrint') : null} onClick={() => actions?.onPrint?.(printIds)} aria-keyshortcuts="p">
      <Printer size={14} aria-hidden /> {printLabel}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(`stock:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('stock:problem.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} description={t('stock:common.noMatch')} action={clearFilters} />
    ) : (
      <EmptyState icon={<ClipboardList size={22} aria-hidden />} title={t('list.empty')} description={t('list.emptyBody')} action={model.can.reserve ? createButton : undefined} />
    )
  ) : undefined

  const search = (
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
  const views: PickView[] = ['all', 'today', 'waiting', 'complete']
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.viewLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as PickView)}>
        {views.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={t('stock:common.site')} value={model.address.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('stock:common.allSites')}</option>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
    </>
  )

  const ids = rows.map((row) => row.workOrder.id)
  return (
    <div className="fw-pk">
      <div className="fw-pk-head">
        <span className="fw-pk-status" role="status">
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : t('list.notYet')}
          {' · '}
          {t(`stock:live.${model.live}`)}
        </span>
        <span className="fw-pk-band">
          {printButton}
          {createButton}
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('stock:common.close')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`tile.${tile.id}`),
          value: model.tiles ? String(tile.count(model.tiles)) : '—',
          hint: t(`tileHint.${tile.id}`),
          onClick: () => actions?.onView?.(model.address.view === tile.view ? 'all' : tile.view),
          active: tileView === tile.view,
        }))}
      />

      <ListFrame<PickRow>
        label={t('list.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.workOrder.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length, total: model.rows.total ?? model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('band.printSelected', { count: Math.min(picked.length, 20) })} onClick={() => actions?.onPrint?.(picked.slice(0, 20).map((row) => row.workOrder.id))}>
              <Printer size={13} aria-hidden /> <SelectionLabel>{t('band.printSelected', { count: Math.min(picked.length, 20) })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && rows.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.workOrder.id)}
        state={state}
      />
      <p className="fw-pk-hint">{t('list.foot')}</p>

      {model.sheet && <PickListDialog model={model.sheet} ids={ids} prefix={model.prefix} can={model.can} timeZone={model.timeZone} actions={actions} />}
      {model.create && <CreateDialog model={model.create} timeZone={model.timeZone} actions={actions} />}
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
