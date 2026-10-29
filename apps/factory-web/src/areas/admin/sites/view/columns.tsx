'use client'

import type { MenuItemDef } from '@nexus/ui/components'
import { actionsColumn, IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Device, Printer, SiteStructure, WorkCentre } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { cellOf as cell } from '../../shared/view/cells'
import { archiveUses, centreName, type SiteDialog, type StructureRow } from '../model'

/** What the Site record's lists draw with. `manage`: the ⋯ menus (rename, move, archive, add a station here). */
export interface SiteColumnsContext {
  t: Translate
  structure: SiteStructure
  manage: boolean
  open: (dialog: SiteDialog) => void
}

const statusCell = (t: Translate, status: string) => <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Pill>

/**
 * SCR-009 Structure: each line (its code and name, how many stations), its stations one step in (code, name, work
 * centre, devices bound, status), then the stations standing alone. The ⋯ of a line adds a station on it, renames or
 * archives it (held while stations are on it); a station's renames, moves or archives it (held while devices are bound).
 */
export function structureColumns(ctx: SiteColumnsContext): ColDef<StructureRow>[] {
  const { t, structure } = ctx
  const menu = (row: StructureRow): MenuItemDef[] => {
    if (!ctx.manage) return []
    if (row.kind === 'group') {
      const add: MenuItemDef = { id: 'add', label: t('site.addStationHere'), onSelect: () => ctx.open({ kind: 'station', lineId: row.line?.id ?? null }) }
      const line = row.line
      if (!line) return [add]
      if (line.status !== 'ACTIVE') return []
      const uses = archiveUses(structure, 'line', line.id)
      return [
        add,
        { id: 'rename', label: t('site.rename'), onSelect: () => ctx.open({ kind: 'rename', target: 'line', id: line.id }) },
        { id: 'archive', label: t('site.archiveLine'), tone: 'danger', ...(uses.stations ? { disabled: true, description: t('site.held.lineStations', { count: uses.stations }) } : {}), onSelect: () => ctx.open({ kind: 'archive', target: 'line', id: line.id }) },
      ]
    }
    const { station } = row
    if (station.status !== 'ACTIVE') return []
    const uses = archiveUses(structure, 'station', station.id)
    return [
      { id: 'rename', label: t('site.rename'), onSelect: () => ctx.open({ kind: 'rename', target: 'station', id: station.id }) },
      { id: 'move', label: t('site.move'), onSelect: () => ctx.open({ kind: 'move', stationId: station.id }) },
      { id: 'archive', label: t('site.archiveStation'), tone: 'danger', ...(uses.devices ? { disabled: true, description: t('site.held.stationDevices', { count: uses.devices }) } : {}), onSelect: () => ctx.open({ kind: 'archive', target: 'station', id: station.id }) },
    ]
  }
  const name = (row: StructureRow) => (row.kind === 'station' ? row.station.name : row.line ? row.line.name : t('site.alone'))
  return [
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => (data ? name(data) : ''),
      sortable: false,
      flex: 2,
      minWidth: 260,
      cellRenderer: cell<StructureRow>((row) =>
        row.kind === 'station' ? (
          <span className="fw-adm-tree-child">{row.station.name}</span>
        ) : (
          <div className="fw-adm-cell2">
            <span className="fw-adm-name">{name(row)}</span>
            <span className="nds-cell-sub">{row.line ? t('site.line.stations', { count: row.stations }) : t('site.aloneHint')}</span>
          </div>
        ),
      ),
    },
    {
      colId: 'code',
      headerName: t('org.col.code'),
      valueGetter: ({ data }) => (!data ? '' : data.kind === 'station' ? data.station.code : (data.line?.code ?? '')),
      sortable: false,
      minWidth: 110,
      flex: 0.7,
      cellRenderer: cell<StructureRow>((row) => <span className="fw-adm-code">{row.kind === 'station' ? row.station.code : (row.line?.code ?? '')}</span>),
    },
    {
      colId: 'centre',
      headerName: t('site.col.centre'),
      valueGetter: ({ data }) => (!data || data.kind === 'group' ? '' : (centreName(structure.workCentres, data.station.workCentreId) ?? '—')),
      sortable: false,
      flex: 1.2,
      minWidth: 160,
    },
    {
      colId: 'devices',
      headerName: t('site.col.devices'),
      valueGetter: ({ data }) => (!data || data.kind === 'group' ? '' : data.station.devices > 0 ? t('site.devicesBound', { count: data.station.devices }) : '—'),
      sortable: false,
      minWidth: 120,
      flex: 0.7,
    },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (!data ? '' : data.kind === 'station' ? data.station.status : (data.line?.status ?? '')),
      sortable: false,
      minWidth: 110,
      flex: 0.6,
      cellRenderer: cell<StructureRow>((row) => {
        const status = row.kind === 'station' ? row.station.status : row.line?.status
        return status ? statusCell(t, status) : null
      }),
    },
    ...(ctx.manage ? [actionsColumn<StructureRow>({ items: menu, menuLabel: (row) => t('common.moreFor', { name: name(row) }) })] : []),
  ]
}

/** SCR-009 Work centres: code, name, kind, active stations in it, status; the ⋯ renames or archives (held while stations use it). */
export function centreColumns(ctx: SiteColumnsContext): ColDef<WorkCentre>[] {
  const { t, structure } = ctx
  const stations = (centre: WorkCentre) => structure.stations.filter((station) => station.workCentreId === centre.id && station.status === 'ACTIVE').length
  const menu = (centre: WorkCentre): MenuItemDef[] => {
    if (!ctx.manage || centre.status !== 'ACTIVE') return []
    const uses = archiveUses(structure, 'centre', centre.id)
    return [
      { id: 'rename', label: t('site.rename'), onSelect: () => ctx.open({ kind: 'rename', target: 'centre', id: centre.id }) },
      { id: 'archive', label: t('site.archiveCentre'), tone: 'danger', ...(uses.stations ? { disabled: true, description: t('site.held.centreStations', { count: uses.stations }) } : {}), onSelect: () => ctx.open({ kind: 'archive', target: 'centre', id: centre.id }) },
    ]
  }
  return [
    {
      colId: 'code',
      headerName: t('org.col.code'),
      valueGetter: ({ data }) => data?.code ?? '',
      minWidth: 110,
      flex: 0.6,
      cellRenderer: cell<WorkCentre>((centre) => <span className="fw-adm-code">{centre.code}</span>),
    },
    { colId: 'name', headerName: t('org.col.name'), valueGetter: ({ data }) => data?.name ?? '', flex: 1.6, minWidth: 180 },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (data ? t(`site.centreKind.${data.kind}`) : ''), flex: 1, minWidth: 140 },
    { colId: 'stations', headerName: t('site.col.stations'), valueGetter: ({ data }) => (data ? stations(data) : null), minWidth: 110, flex: 0.6 },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => data?.status ?? '',
      minWidth: 110,
      flex: 0.6,
      cellRenderer: cell<WorkCentre>((centre) => statusCell(t, centre.status)),
    },
    ...(ctx.manage ? [actionsColumn<WorkCentre>({ items: menu, menuLabel: (centre) => t('common.moreFor', { name: centre.name }) })] : []),
  ]
}

/** SCR-009 the site's tablets: name (the Device record's link), station, status (and "in use", never by whom), last seen in the site's zone. */
export function tabletColumns(ctx: { t: Translate; locale: Locale; prefix: string; structure: SiteStructure }): ColDef<Device>[] {
  const { t, locale, structure } = ctx
  const station = (device: Device) => structure.stations.find((item) => item.id === device.stationId)?.name ?? '—'
  return [
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => data?.name ?? '',
      flex: 1.6,
      minWidth: 200,
      cellRenderer: cell<Device>((device) => <IdentityCell noImage title={device.name} titleAttr={device.name} href={adminHref(ctx.prefix, `/devices/${device.id}`)} />),
    },
    { colId: 'station', headerName: t('devices.col.station'), valueGetter: ({ data }) => (data ? station(data) : ''), flex: 1.4, minWidth: 170 },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (data ? t(`devices.status.${data.status}`) : ''),
      minWidth: 160,
      flex: 0.9,
      cellRenderer: cell<Device>((device) => (
        <span className="fw-adm-celltags">
          <Pill tone={STATUS_TONE[device.status] ?? 'neutral'}>{t(`devices.status.${device.status}`)}</Pill>
          {device.inUse && <Tag tone="info">{t('devices.inUse')}</Tag>}
        </span>
      )),
    },
    {
      colId: 'lastSeen',
      headerName: t('devices.col.lastSeen'),
      valueGetter: ({ data }) => (!data ? '' : data.lastSeenAt ? formatDateTime(data.lastSeenAt, { locale, timeZone: structure.site.timezone }) : '—'),
      minWidth: 170,
      flex: 1,
    },
  ]
}

/** SCR-009 the site's printers: code, name, kind, status. */
export function sitePrinterColumns(ctx: { t: Translate }): ColDef<Printer>[] {
  const { t } = ctx
  return [
    {
      colId: 'code',
      headerName: t('org.col.code'),
      valueGetter: ({ data }) => data?.code ?? '',
      minWidth: 120,
      flex: 0.7,
      cellRenderer: cell<Printer>((printer) => <span className="fw-adm-code">{printer.code}</span>),
    },
    { colId: 'name', headerName: t('org.col.name'), valueGetter: ({ data }) => data?.name ?? '', flex: 1.6, minWidth: 180 },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (data ? t(`printers.kind.${data.kind}`) : ''), flex: 1, minWidth: 150 },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (data ? t(`printers.status.${data.status}`) : ''),
      minWidth: 110,
      flex: 0.6,
      cellRenderer: cell<Printer>((printer) => <Pill tone={STATUS_TONE[printer.status] ?? 'neutral'}>{t(`printers.status.${printer.status}`)}</Pill>),
    },
  ]
}
