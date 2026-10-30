'use client'

import { IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Device, Printer } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { cellOf as cell } from '../../shared/view/cells'
import { batteryOf, deviceTileMatch, isOutdated, type SiteChoice } from '../model'

/**
 * SCR-013 devices: name (the Device record's link), kind, site, station, status ("In use" says someone is signed in,
 * never who: Statuto dei Lavoratori art. 4), last seen (marked when not seen for a day), app version (marked when it is
 * not the version the server serves now, B-W2a-42) and battery as the tablet last said it (low marked; W2a).
 */
export function deviceColumns(ctx: { t: Translate; locale: Locale; prefix: string; sites: readonly SiteChoice[]; now: number; currentVersion?: string | null }): ColDef<Device>[] {
  const { t, locale } = ctx
  const site = (device: Device) => ctx.sites.find((item) => item.id === device.siteId)
  const station = (device: Device) => site(device)?.stations.find((item) => item.id === device.stationId)?.name ?? '—'
  return [
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => data?.name ?? '',
      flex: 1.6,
      minWidth: 200,
      cellRenderer: cell<Device>((device) => <IdentityCell noImage title={device.name} titleAttr={device.name} href={adminHref(ctx.prefix, `/devices/${device.id}`)} />),
    },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (data ? t(`devices.kind.${data.kind}`) : ''), minWidth: 120, flex: 0.7 },
    { colId: 'site', headerName: t('devices.col.site'), valueGetter: ({ data }) => (data ? (site(data)?.name ?? '—') : ''), flex: 1.2, minWidth: 170 },
    { colId: 'station', headerName: t('devices.col.station'), valueGetter: ({ data }) => (data ? station(data) : ''), flex: 1.2, minWidth: 170 },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (data ? t(`devices.status.${data.status}`) : ''),
      minWidth: 170,
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
      valueGetter: ({ data }) => (!data ? '' : data.lastSeenAt ? formatDateTime(data.lastSeenAt, { locale }) : '—'),
      minWidth: 170,
      flex: 1,
      cellRenderer: cell<Device>((device) =>
        device.lastSeenAt ? (
          <div className="fw-adm-cell2">
            <span>{formatDateTime(device.lastSeenAt, { locale })}</span>
            {deviceTileMatch('notSeen', device, ctx.now) && (
              <span className="nds-cell-sub">
                <Tag tone="warning">{t('devices.notSeenTag')}</Tag>
              </span>
            )}
          </div>
        ) : (
          '—'
        ),
      ),
    },
    {
      colId: 'version',
      headerName: t('devices.col.version'),
      valueGetter: ({ data }) => (data ? (data.appVersion ?? '—') : ''),
      minWidth: 150,
      flex: 0.8,
      cellRenderer: cell<Device>((device) =>
        device.appVersion ? (
          <div className="fw-adm-cell2">
            <span className="fw-adm-code">{device.appVersion}</span>
            {isOutdated(device, ctx.currentVersion) && (
              <span className="nds-cell-sub">
                <Tag tone="warning">{t('devices.outdatedTag')}</Tag>
              </span>
            )}
          </div>
        ) : (
          '—'
        ),
      ),
    },
    {
      colId: 'battery',
      headerName: t('devices.col.battery'),
      valueGetter: ({ data }) => {
        const battery = data ? batteryOf(data) : null
        return battery ? battery.percent : null
      },
      valueFormatter: ({ value }) => (typeof value === 'number' ? t('devices.battery.percent', { percent: value }) : '—'),
      minWidth: 130,
      flex: 0.6,
      cellRenderer: cell<Device>((device) => {
        const battery = batteryOf(device)
        if (!battery) return '—'
        return (
          <span className="fw-adm-celltags">
            <span>{t('devices.battery.percent', { percent: battery.percent })}</span>
            {battery.charging && <Tag tone="info">{t('devices.battery.charging')}</Tag>}
            {battery.low && <Tag tone="warning">{t('devices.battery.lowTag')}</Tag>}
          </span>
        )
      }),
    },
  ]
}

/** SCR-013 printers: code, name (opens the printer's dialog for who may change it), site, kind, relay, label size, status. */
export function printerColumns(ctx: { t: Translate; sites: readonly SiteChoice[]; onEdit?: ((printer: Printer) => void) | null }): ColDef<Printer>[] {
  const { t } = ctx
  const relay = (printer: Printer) => (t(`printers.relay.${printer.relay}`) === `printers.relay.${printer.relay}` ? printer.relay : t(`printers.relay.${printer.relay}`))
  return [
    {
      colId: 'code',
      headerName: t('org.col.code'),
      valueGetter: ({ data }) => data?.code ?? '',
      minWidth: 120,
      flex: 0.7,
      cellRenderer: cell<Printer>((printer) => <span className="fw-adm-code">{printer.code}</span>),
    },
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => data?.name ?? '',
      flex: 1.3,
      minWidth: 170,
      cellRenderer: cell<Printer>((printer) => (
        <span className="fw-adm-name fw-adm-ellipsis">
          {ctx.onEdit ? (
            <Button size="sm" variant="link" inline onClick={() => ctx.onEdit?.(printer)}>
              {printer.name}
            </Button>
          ) : (
            printer.name
          )}
        </span>
      )),
    },
    { colId: 'site', headerName: t('devices.col.site'), valueGetter: ({ data }) => (data ? (ctx.sites.find((site) => site.id === data.siteId)?.name ?? '—') : ''), flex: 1.2, minWidth: 170 },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (data ? t(`printers.kind.${data.kind}`) : ''), flex: 0.8, minWidth: 130 },
    { colId: 'relay', headerName: t('printers.col.relay'), valueGetter: ({ data }) => (data ? relay(data) : ''), flex: 1.1, minWidth: 190 },
    {
      colId: 'size',
      headerName: t('printers.col.size'),
      valueGetter: ({ data }) => (!data ? '' : data.labelWidthMm && data.labelHeightMm ? `${data.labelWidthMm} × ${data.labelHeightMm} mm` : '—'),
      flex: 0.8,
      minWidth: 120,
    },
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
