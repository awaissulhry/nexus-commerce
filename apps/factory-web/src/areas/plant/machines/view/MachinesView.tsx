'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Archive, Check, Download, MoreHorizontal, Plus, QrCode as QrIcon, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Machine } from '../../_shared/api'
import { labelOf, MACHINE_VIEWS, type MachinesAddress } from '../../_shared/model'
import { Cost, KeysModal, LiveLine, MachinePill, NoPlantAccess, NoticeBanner, PlantMessages, say, useWords } from '../../_shared/parts'
import type { CellState, MachinesListActions, MachinesListModel } from '../view-model'
import { MachineDialogs } from './MachineDialogs'

export type { MachinesListActions, MachinesListModel } from '../view-model'

const TILES = [
  { view: 'down', tile: 'DOWN' },
  { view: 'doNotUse', tile: 'DO_NOT_USE' },
  { view: 'underMaintenance', tile: 'UNDER_MAINTENANCE' },
] as const

/**
 * SCR-150 — Machines & tools (Plant › Maintenance; design plant.machines, a workspace list): the register of machines and
 * equipment. The tiles are saved filters (down now, do-not-use, under maintenance). The register on the shared list frame:
 * the asset number (its record), the type, make, model, serial and year, the station (inline) and work centre (inline),
 * the live status with its time, the open jobs and requests, and — with the cost grain only — the purchase cost. New
 * machine (`c`), Print QR tags (the tag sheet in a new tab), Retire N (the reach said; a reason), Export N. A retired
 * machine stays for its history and is shown only when asked.
 */
export function MachinesView({ model, actions }: { model: MachinesListModel; actions?: MachinesListActions }) {
  return (
    <PlantMessages>
      <Machines model={model} actions={actions} />
    </PlantMessages>
  )
}

function CellMark({ cell }: { cell: CellState | undefined }) {
  const t = useWords()
  if (!cell) return null
  if (cell.state === 'saving') return <Spinner size={12} />
  if (cell.state === 'saved') return <Check size={13} className="fw-pl-success" aria-label={t('cell.saved')} />
  return <AlertCircle size={13} className="fw-pl-danger" aria-label={say(t, cell.words) ?? t('cell.failed')} />
}

function Machines({ model, actions }: { model: MachinesListModel; actions?: MachinesListActions }) {
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
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const allSites = model.sites.length > 1 && model.address.siteId === null
  const canEdit = model.can.manageMachines

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manageMachines) {
        event.preventDefault()
        latest.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.can.manageMachines, help])

  // The cells call the page's latest actions (the grid keeps its columns between renders).
  const act = useRef(actions)
  act.current = actions
  const columns = useMemo<ColDef<Machine>[]>(() => {
    const href = (row: Machine) => `${model.prefix}/plant/machines/${encodeURIComponent(row.id)}`
    const siteOf = (row: Machine) => model.sites.find((site) => site.id === row.siteId) ?? null
    const AssetCell = ({ data }: ICellRendererParams<Machine>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link fw-pl-code" href={href(data)}>
            {data.assetNumber}
          </Link>
          <span className="fw-pl-sub">{[labelOf(data.class, locale), data.line?.code].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const MakeCell = ({ data }: ICellRendererParams<Machine>) =>
      data ? (
        <span className="fw-pl-cell">
          <span className="fw-pl-ellipsis">{[data.make, data.modelName].filter(Boolean).join(' · ') || '—'}</span>
          <span className="fw-pl-sub">{[data.serialNumber, data.year].filter(Boolean).join(' · ') || '—'}</span>
        </span>
      ) : null
    const StationCell = ({ data }: ICellRendererParams<Machine>) => {
      if (!data) return null
      const site = siteOf(data)
      if (!canEdit || data.status === 'RETIRED' || !site) return <span className="fw-pl-ellipsis">{data.station ? `${data.station.code} · ${data.station.name}` : t('machine.noStation')}</span>
      return (
        <span className="fw-pl-row">
          <Select size="sm" aria-label={t('cell.station', { machine: data.assetNumber })} value={data.station?.id ?? ''} onChange={(event) => act.current?.onPlace?.(data, { stationId: event.target.value || null })}>
            <option value="">{t('machine.noStation')}</option>
            {site.stations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.name}`}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:stationId`]} />
        </span>
      )
    }
    const CentreCell = ({ data }: ICellRendererParams<Machine>) => {
      if (!data) return null
      const site = siteOf(data)
      if (!canEdit || data.status === 'RETIRED' || !site) return <span className="fw-pl-ellipsis">{data.workCentre ? `${data.workCentre.code} · ${data.workCentre.name}` : '—'}</span>
      return (
        <span className="fw-pl-row">
          <Select size="sm" aria-label={t('cell.workCentre', { machine: data.assetNumber })} value={data.workCentre?.id ?? ''} onChange={(event) => act.current?.onPlace?.(data, { workCentreId: event.target.value || null })}>
            <option value="">{t('machine.noWorkCentre')}</option>
            {site.workCentres.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.name}`}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:workCentreId`]} />
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<Machine>) =>
      data ? (
        <span className="fw-pl-cell">
          <span>
            <MachinePill status={data.status} locked={data.locked} />
          </span>
          <span className="fw-pl-sub">{t('machine.since', { time: formatDateTime(data.statusSince, place) })}</span>
        </span>
      ) : null
    const WorkCell = ({ data }: ICellRendererParams<Machine>) =>
      !data ? null : data.openJobs + data.openRequests === 0 ? (
        <span className="fw-pl-sub">—</span>
      ) : (
        <span className="fw-pl-cell">
          <span className={data.openJobs > 0 ? 'fw-pl-num strong' : 'fw-pl-num'}>{t('machine.jobsCount', { count: data.openJobs })}</span>
          <span className="fw-pl-sub">{t('machine.requestsCount', { count: data.openRequests })}</span>
        </span>
      )
    const CostCell = ({ data }: ICellRendererParams<Machine>) => (data ? <Cost minor={data.purchaseCost} /> : null)
    const SiteCell = ({ data }: ICellRendererParams<Machine>) => <span className="fw-pl-code">{data?.siteCode ?? ''}</span>
    const MoreCell = ({ data }: ICellRendererParams<Machine>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('machines.rowMenu', { machine: data.assetNumber }) }}
          items={[
            { id: 'open', label: t('machines.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'history', label: t('machineTab.history'), href: `${href(data)}?tab=history` },
            { id: 'tag', label: t('machines.printTag'), href: `${model.prefix}/plant/machines/tags?ids=${encodeURIComponent(data.id)}`, target: '_blank' },
            ...(data.status !== 'RETIRED' ? [{ id: 'report', label: t('requests.report'), href: `${model.prefix}/plant/requests?report=1&machine=${encodeURIComponent(data.id)}` }] : []),
          ]}
        />
      ) : null
    const list: ColDef<Machine>[] = [
      { colId: 'asset', headerName: t('col.asset'), minWidth: 150, flex: 0.8, cellRenderer: AssetCell },
      { colId: 'make', headerName: t('col.make'), minWidth: 170, flex: 1, cellRenderer: MakeCell },
      { colId: 'station', headerName: t('col.station'), minWidth: canEdit ? 200 : 150, flex: 1, cellRenderer: StationCell },
      { colId: 'workCentre', headerName: t('col.workCentre'), minWidth: canEdit ? 180 : 130, flex: 0.9, cellRenderer: CentreCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 172, flex: 0.9, cellRenderer: StatusCell },
      { colId: 'work', headerName: t('col.openWork'), minWidth: 132, flex: 0.6, cellRenderer: WorkCell },
      ...(model.can.cost ? [{ colId: 'cost', headerName: t('col.cost'), minWidth: 110, flex: 0.5, type: 'rightAligned', cellRenderer: CostCell } satisfies ColDef<Machine>] : []),
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    if (allSites) list.splice(1, 0, { colId: 'site', headerName: t('col.site'), minWidth: 84, flex: 0.3, cellRenderer: SiteCell })
    return list
  }, [t, locale, model.prefix, model.timeZone, model.sites, model.cells, model.can.cost, allSites, canEdit])

  if (!model.can.view) {
    return (
      <div className="fw-pl">
        <NoPlantAccess />
      </div>
    )
  }

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  const retirable = picked.filter((row) => row.status !== 'RETIRED')
  const filtered = model.address.view !== 'inUse' || model.address.q.trim() !== '' || model.address.siteId !== null || model.address.classId !== null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.newMachine') }]
  const tagIds = (picked.length > 0 ? picked : items).filter((row) => row.status !== 'RETIRED').map((row) => row.id)
  const tagsHref = `${model.prefix}/plant/machines/tags${tagIds.length > 0 && tagIds.length <= 200 ? `?ids=${tagIds.map(encodeURIComponent).join(',')}` : ''}`
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manageMachines ? null : t('held.noManageMachines')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('machines.new')}
    </Button>
  )

  const state = model.rows.problem ? (
    <EmptyState title={t('machines.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('machines.noMatch')}
        description={t('machines.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onView?.('inUse')
              actions?.onSite?.(null)
              actions?.onClass?.(null)
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('machines.empty')} description={t('machines.emptyBody')} action={model.can.manageMachines ? newButton : undefined} />
    )
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('machines.search')}
      placeholder={t('machines.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as MachinesAddress['view'])}>
        {MACHINE_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`machineView.${view}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('machine.type')} value={model.address.classId ?? ''} onChange={(event) => actions?.onClass?.(event.target.value || null)}>
        <option value="">{t('machines.allTypes')}</option>
        {model.classes.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {labelOf(entry, locale)}
          </option>
        ))}
      </Select>
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={t('common.site')} value={model.address.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('common.allSites')}</option>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
    </>
  )

  return (
    <div className="fw-pl">
      <div className="fw-pl-head">
        <LiveLine asOf={model.asOf} live={model.live} />
        <span className="fw-pl-actions">
          <Button size="sm" asChild>
            <Link href={tagsHref} target="_blank">
              <QrIcon size={14} aria-hidden /> {picked.length > 0 ? t('machines.printTagsCount', { count: tagIds.length }) : t('machines.printTags')}
            </Link>
          </Button>
          {newButton}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('machines.more') }}
            items={[
              { id: 'import', label: t('machines.import'), disabled: true, description: t('machines.importHeld') },
              { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
            ]}
          />
        </span>
      </div>

      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.made && (
        <Banner
          tone="success"
          title={t('machines.made', { machine: model.made.assetNumber })}
          action={
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/plant/machines/tags?ids=${encodeURIComponent(model.made.id)}`} target="_blank">
                <QrIcon size={13} aria-hidden /> {t('machines.printItsTag')}
              </Link>
            </Button>
          }
        />
      )}

      <MetricStrip
        metrics={TILES.map((entry) => ({
          label: t(`machineTile.${entry.tile}`),
          value: model.tiles ? String(model.tiles.tiles[entry.tile]) : '—',
          hint: entry.tile === 'DO_NOT_USE' && model.tiles && model.tiles.locked > 0 ? t('machineTileHint.LOCKED', { count: model.tiles.locked }) : t(`machineTileHint.${entry.tile}`),
          onClick: () => actions?.onView?.(model.address.view === entry.view ? 'inUse' : entry.view),
          active: model.address.view === entry.view,
        }))}
      />

      <ListFrame<Machine>
        label={t('machines.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" asChild>
                <Link href={tagsHref} target="_blank" aria-label={t('machines.printTagsCount', { count: tagIds.length })}>
                  <QrIcon size={13} aria-hidden /> <SelectionLabel>{t('machines.printTagsCount', { count: tagIds.length })}</SelectionLabel>
                </Link>
              </Button>
              <Button
                size="sm"
                variant="danger-outline"
                aria-label={t('machines.retireMany', { count: retirable.length })}
                heldReason={!model.can.manageMachines ? t('held.noManageMachines') : retirable.length === 0 ? t('held.noneToRetire') : null}
                onClick={() => actions?.onRetire?.(retirable)}
              >
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('machines.retireMany', { count: retirable.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('common.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      <p className="fw-pl-hint">{t(model.can.cost ? 'machines.footCost' : 'machines.foot')}</p>

      <MachineDialogs model={model} actions={actions} />
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
