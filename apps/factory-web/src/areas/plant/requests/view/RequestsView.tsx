'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Camera, CheckCheck, Download, MoreHorizontal, Play, Printer, TriangleAlert } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { MaintenanceRequest } from '../../_shared/api'
import { ageTone, ageWords, labelOf, personWords, REQUEST_VIEWS, type RequestsAddress } from '../../_shared/model'
import { KeysModal, LiveLine, MachinePill, NoPlantAccess, NoticeBanner, PlantMessages, RequestPill, StepUpDialog, SymptomText, UnsafeTag, useWords } from '../../_shared/parts'
import type { RequestsListActions, RequestsListModel } from '../view-model'
import { RequestDetail } from './RequestDetail'
import { RequestDialogs } from './RequestDialogs'

export type { RequestsListActions, RequestsListModel } from '../view-model'

const TILES = [
  { tile: 'NEW', count: (tiles: NonNullable<RequestsListModel['tiles']>) => tiles.NEW.count },
  { tile: 'UNSAFE', count: (tiles: NonNullable<RequestsListModel['tiles']>) => tiles.UNSAFE },
  { tile: 'DOWN', count: (tiles: NonNullable<RequestsListModel['tiles']>) => tiles.DOWN },
  { tile: 'WAITING', count: (tiles: NonNullable<RequestsListModel['tiles']>) => tiles.WAITING },
  { tile: 'DUPLICATES', count: (tiles: NonNullable<RequestsListModel['tiles']>) => tiles.DUPLICATES },
] as const

/**
 * SCR-148 — Machine requests (Plant › Maintenance; design plant.requests, an inbox): the breakdowns the stations report,
 * triaged in order. The tiles are saved filters (new and not acknowledged with the oldest's age, machines locked as unsafe,
 * machines down, waiting over 30 minutes, possible duplicates); a machine locked as unsafe raises the banner at once. The
 * queue on the shared list frame: unsafe first, then the oldest; Age (tone by how long it waits), the machine with its live
 * status, the symptom, unsafe, the station, who reported it (an office user by name, else the station: no worker is named
 * in a list, Owner W1), photos, duplicates and the state. Enter opens the request (its DetailModal, J / K); Report a problem
 * and Start triage in the head; Acknowledge N and Export N for the selection; ⋯ prints the open requests for the shift.
 */
export function RequestsView({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  return (
    <PlantMessages>
      <Requests model={model} actions={actions} />
    </PlantMessages>
  )
}

function Requests({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const allSites = model.sites.length > 1 && model.address.siteId === null

  // The cells call the page's latest actions (the grid keeps its columns between renders).
  const act = useRef(actions)
  act.current = actions
  const columns = useMemo<ColDef<MaintenanceRequest>[]>(() => {
    const machineHref = (row: MaintenanceRequest) => `${model.prefix}/plant/machines/${encodeURIComponent(row.machine.id)}`
    const AgeCell = ({ data }: ICellRendererParams<MaintenanceRequest>) => {
      if (!data) return null
      const tone = ageTone(data)
      return (
        <span className="fw-pl-cell" title={formatDateTime(data.reportedAt, place)}>
          <span className={`fw-pl-num strong${tone === 'danger' ? ' fw-pl-danger' : tone === 'warning' ? ' fw-pl-warning' : ''}`}>{ageWords(t, data.ageMinutes)}</span>
          <span className="fw-pl-sub">{data.ageMinutes < 24 * 60 ? formatTime(data.reportedAt, place) : formatDate(data.reportedAt, place)}</span>
        </span>
      )
    }
    const MachineCell = ({ data }: ICellRendererParams<MaintenanceRequest>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link fw-pl-code" href={machineHref(data)}>
            {data.machine.assetNumber}
          </Link>
          <span title={labelOf(data.machine.class, locale)}>
            <MachinePill status={data.machine.status} locked={data.locking} />
          </span>
        </span>
      ) : null
    const SymptomCell = ({ data }: ICellRendererParams<MaintenanceRequest>) =>
      data ? (
        <span className="fw-pl-cell" title={data.description ?? undefined}>
          <SymptomText symptom={data.symptom} description={data.description} />
          {data.symptom && data.description && <span className="fw-pl-sub">{data.description}</span>}
        </span>
      ) : null
    const UnsafeCell = ({ data }: ICellRendererParams<MaintenanceRequest>) => (data?.unsafe ? <UnsafeTag signed={!data.locking} /> : <span className="fw-pl-sub">{t('unsafe.no')}</span>)
    const StationCell = ({ data }: ICellRendererParams<MaintenanceRequest>) =>
      data ? (
        <span className="fw-pl-cell" title={data.station ? `${data.station.code} · ${data.station.name}` : undefined}>
          <span className="fw-pl-ellipsis">{data.station ? data.station.code : t('list.noStation')}</span>
          {data.station && <span className="fw-pl-sub">{data.station.name}</span>}
        </span>
      ) : null
    const ReporterCell = ({ data }: ICellRendererParams<MaintenanceRequest>) => (data ? <span className="fw-pl-ellipsis" title={personWords(t, data.reportedBy)}>{personWords(t, data.reportedBy)}</span> : null)
    const EvidenceCell = ({ data }: ICellRendererParams<MaintenanceRequest>) =>
      data && (data.photos > 0 || data.duplicates > 0) ? (
        <span className="fw-pl-row">
          {data.photos > 0 && (
            <span className="fw-pl-symptom" title={t('list.photos', { count: data.photos })}>
              <Camera size={14} aria-hidden /> <span className="fw-pl-num">{data.photos}</span>
            </span>
          )}
          {data.duplicates > 0 && <Tag tone="warning">{t('list.duplicates', { count: data.duplicates })}</Tag>}
        </span>
      ) : (
        <span className="fw-pl-sub">—</span>
      )
    const StateCell = ({ data }: ICellRendererParams<MaintenanceRequest>) => {
      if (!data) return null
      return (
        <span className="fw-pl-cell">
          <span>
            <RequestPill status={data.status} />
          </span>
          {data.job ? (
            <Link className="fw-pl-link fw-pl-sub" href={`${model.prefix}/plant/jobs/${encodeURIComponent(data.job.id)}`}>
              {data.job.number}
            </Link>
          ) : data.locking ? (
            <span className="fw-pl-sub fw-pl-danger">{t('list.waitsSignSafe')}</span>
          ) : null}
        </span>
      )
    }
    const SiteCell = ({ data }: ICellRendererParams<MaintenanceRequest>) => <span className="fw-pl-code">{data ? (model.sites.find((site) => site.id === data.siteId)?.code ?? '—') : ''}</span>
    const MoreCell = ({ data }: ICellRendererParams<MaintenanceRequest>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { machine: data.machine.assetNumber }) }}
          items={[
            { id: 'open', label: t('list.openRequest'), onSelect: () => act.current?.onOpen?.(data.id) },
            { id: 'machine', label: t('list.machineRecord'), href: machineHref(data), target: '_blank' },
            ...(data.job ? [{ id: 'job', label: t('list.jobRecord', { number: data.job.number }), href: `${model.prefix}/plant/jobs/${encodeURIComponent(data.job.id)}`, target: '_blank' as const }] : []),
          ]}
        />
      ) : null
    const list: ColDef<MaintenanceRequest>[] = [
      { colId: 'age', headerName: t('col.age'), minWidth: 96, flex: 0.5, cellRenderer: AgeCell },
      { colId: 'machine', headerName: t('col.machine'), minWidth: 156, flex: 0.8, cellRenderer: MachineCell },
      { colId: 'symptom', headerName: t('col.symptom'), minWidth: 190, flex: 1.5, cellRenderer: SymptomCell },
      { colId: 'unsafe', headerName: t('col.unsafe'), minWidth: 110, flex: 0.4, cellRenderer: UnsafeCell },
      { colId: 'station', headerName: t('col.station'), minWidth: 130, flex: 0.8, cellRenderer: StationCell },
      { colId: 'reporter', headerName: t('col.reporter'), minWidth: 140, flex: 0.9, cellRenderer: ReporterCell },
      { colId: 'evidence', headerName: t('col.evidence'), minWidth: 124, flex: 0.5, cellRenderer: EvidenceCell },
      { colId: 'state', headerName: t('col.state'), minWidth: 160, flex: 0.8, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    if (allSites) list.splice(1, 0, { colId: 'site', headerName: t('col.site'), minWidth: 88, flex: 0.3, cellRenderer: SiteCell })
    return list
  }, [t, locale, model.prefix, model.timeZone, model.sites, allSites])

  if (!model.can.view) {
    return (
      <div className="fw-pl">
        <NoPlantAccess />
      </div>
    )
  }

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  const pickedNew = picked.filter((row) => row.status === 'NEW')
  const fresh = model.tiles?.NEW.count ?? items.filter((row) => row.status === 'NEW').length
  const firstOpen = items.find((row) => row.status === 'NEW' || row.status === 'ACKNOWLEDGED' || row.locking) ?? null
  const filtered = model.address.view !== 'open' || model.address.tile !== null || model.address.siteId !== null
  const ownKeys: ListKey[] = [
    { keys: ['r'], does: t('keys.report') },
    { keys: ['t'], does: t('keys.triage') },
  ]

  const reportButton = (
    <Button size="sm" heldReason={model.can.report ? null : t('held.noReport')} onClick={() => actions?.onReport?.()} aria-keyshortcuts="r">
      <TriangleAlert size={14} aria-hidden /> {t('requests.report')}
    </Button>
  )
  const triageButton = (
    <Button size="sm" variant="primary" heldReason={firstOpen ? null : t('held.nothingToTriage')} onClick={() => firstOpen && actions?.onOpen?.(firstOpen.id)} aria-keyshortcuts="t">
      <Play size={14} aria-hidden /> {fresh > 0 ? t('requests.startTriageCount', { count: fresh }) : t('requests.startTriage')}
    </Button>
  )

  const state = model.rows.problem ? (
    <EmptyState title={t('requests.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('requests.noMatch')}
        description={t('requests.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              actions?.onTile?.(null)
              actions?.onView?.('open')
              actions?.onSite?.(null)
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('requests.empty')} description={t('requests.emptyBody')} action={model.can.report ? reportButton : undefined} />
    )
  ) : undefined

  const tools = (
    <>
      <Select
        size="sm"
        aria-label={t('list.rowsLabel')}
        value={model.address.tile ? '' : model.address.view}
        onChange={(event) => {
          actions?.onTile?.(null)
          if (event.target.value) actions?.onView?.(event.target.value as RequestsAddress['view'])
        }}
      >
        {model.address.tile && <option value="">{t(`requestTile.${model.address.tile}`)}</option>}
        {REQUEST_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`requestView.${view}`)}
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
          {reportButton}
          {triageButton}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('requests.more') }}
            items={[
              { id: 'print', label: t('requests.print'), href: `${model.prefix}/plant/requests/print${model.address.siteId ? `?site=${encodeURIComponent(model.address.siteId)}` : ''}`, target: '_blank' },
              { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
            ]}
          />
        </span>
      </div>

      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      {model.tiles && model.tiles.UNSAFE > 0 && model.address.tile !== 'UNSAFE' && (
        <Banner
          tone="danger"
          icon={<AlertTriangle size={18} aria-hidden />}
          title={t('requests.lockedBanner', { count: model.tiles.UNSAFE })}
          action={
            <Button size="sm" onClick={() => actions?.onTile?.('UNSAFE')}>
              {t('requests.lockedShow')}
            </Button>
          }
        >
          {t('requests.lockedBannerBody')}
        </Banner>
      )}

      <MetricStrip
        metrics={TILES.map((entry) => ({
          label: t(`requestTile.${entry.tile}`),
          value: model.tiles ? String(entry.count(model.tiles)) : '—',
          hint: entry.tile === 'NEW' && model.tiles?.NEW.oldestMinutes !== null && model.tiles?.NEW.oldestMinutes !== undefined ? t('requestTileHint.NEW_OLDEST', { age: ageWords(t, model.tiles.NEW.oldestMinutes) }) : t(`requestTileHint.${entry.tile}`),
          onClick: () => actions?.onTile?.(model.address.tile === entry.tile ? null : entry.tile),
          active: model.address.tile === entry.tile,
        }))}
      />

      <ListFrame<MaintenanceRequest>
        label={t('requests.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.truncated || model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button
                size="sm"
                aria-label={t('requests.acknowledgeMany', { count: pickedNew.length })}
                heldReason={!model.can.triage ? t('held.noTriage') : pickedNew.length === 0 ? t('held.noneNew') : model.busy ? t('held.busy') : null}
                onClick={() => actions?.onAcknowledgeMany?.(pickedNew.map((row) => row.id))}
              >
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('requests.acknowledgeMany', { count: pickedNew.length })}</SelectionLabel>
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
      <p className="fw-pl-hint">
        <Printer size={12} aria-hidden /> {model.rows.truncated ? t('requests.truncated') : t('requests.foot')}
      </p>

      {model.detail && <RequestDetail model={model} actions={actions} />}
      <RequestDialogs model={model} actions={actions} />
      <StepUpDialog state={model.stepUp} onSubmit={actions?.onSubmitStepUp} onCancel={actions?.onCancelStepUp} />
      {help && <KeysModal own={[...ownKeys, { keys: ['J', 'K'], does: t('keys.walk') }, { keys: ['A'], does: t('keys.acknowledge') }, { keys: ['M'], does: t('keys.makeJob') }, { keys: ['D'], does: t('keys.merge') }, { keys: ['C'], does: t('keys.close') }, { keys: ['S'], does: t('keys.signSafe') }]} onClose={() => setHelp(false)} />}
      <PageKeys enabled={!model.detail && !model.dialog && !help} onReport={() => model.can.report && actions?.onReport?.()} onTriage={() => firstOpen && actions?.onOpen?.(firstOpen.id)} />
    </div>
  )
}

/** r: report a problem; t: start triage (the first request of the queue) — never while typing, in a dialog or a menu. */
function PageKeys({ enabled, onReport, onTriage }: { enabled: boolean; onReport: () => void; onTriage: () => void }) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'r') {
        event.preventDefault()
        onReport()
      } else if (event.key === 't') {
        event.preventDefault()
        onTriage()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onReport, onTriage])
  return null
}
