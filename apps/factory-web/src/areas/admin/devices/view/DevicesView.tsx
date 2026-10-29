'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { Printer as PrinterIcon, Search, Tablet } from 'lucide-react'
import { MetricStrip } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Device, Printer } from '../../shared/api'
import { adminHref, pageOf, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, ListState, ListTable, NoticeBanner, PageHead } from '../../shared/view/parts'
import { DEVICE_TILES, deviceRows, deviceTileMatch, printerRows, type DevicesMode, type DevicesViewModel, type DeviceTile, type EnrolDraft, type PrinterDialog, type PrinterDraft } from '../model'
import { EnrolWizard, PrinterModal, RevokeConfirm } from './DeviceDialogs'

export type { DevicesViewModel } from '../model'

export interface DevicesActions {
  onMode?: (mode: DevicesMode) => void
  onTile?: (tile: DeviceTile | null) => void
  onQuery?: (query: string) => void
  onPage?: (page: number) => void
  onRetry?: () => void
  onEnrol?: (open: boolean) => void
  onCreateDevice?: (draft: EnrolDraft) => Promise<boolean>
  onRenew?: (device: Device) => void
  onPrinter?: (dialog: PrinterDialog | null) => void
  onSavePrinter?: (draft: PrinterDraft, printer: Printer | null) => Promise<boolean>
  onRevoke?: (deviceId: string | null) => void
  onRevokeConfirm?: (device: Device) => Promise<boolean>
  onDismissNotice?: () => void
}

/**
 * SCR-013 — Admin › Devices & printers (design 02 admin.devices; PLT-226, GAP-007): the tablets and phones enrolled to
 * the sites' stations — seen when, in use or not (never by whom: Statuto dei Lavoratori art. 4) — and the sites'
 * printers, as two lists of one page (1 / 2 switch; the print queue is W1). Enrol a device with a one-time QR code;
 * add and change printers; revoke with the device's name typed. Fetches nothing (DevicesPage.tsx reads the API).
 */
export function DevicesView({ model, actions }: { model: DevicesViewModel; actions?: DevicesActions }) {
  return (
    <AdminMessages>
      <Devices model={model} actions={actions} />
    </AdminMessages>
  )
}

function Devices({ model, actions }: { model: DevicesViewModel; actions?: DevicesActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const href = (path: string) => adminHref(model.prefix, path)
  const now = new Date(model.now).getTime()
  const site = (id: string) => model.sites.find((item) => item.id === id)
  const devicesMode = model.mode === 'devices'

  // 1 / 2: devices / printers; c: enrol a device (when no field has the focus), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.enrol || model.printer || model.revokeId) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === '1') actions?.onMode?.('devices')
      else if (event.key === '2' && model.can.viewPrinters) actions?.onMode?.('printers')
      else if (event.key === 'c' && model.can.manage) actions?.onEnrol?.(true)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const devices = model.devices.items
  const printers = model.printers.items
  const loadedList = devicesMode ? model.devices : model.printers
  const items = loadedList.items

  let table: { columns: string[]; rows: Array<{ id: string; cells: ReactNode[] }>; total: number; page: number; pageCount: number; widths: string[] } | null = null
  if (devicesMode && devices) {
    const rows = deviceRows(devices, model.tile, model.query, model.sites, now)
    const paged = pageOf(rows, model.page)
    table = {
      total: rows.length,
      page: paged.page,
      pageCount: paged.pageCount,
      columns: [t('org.col.name'), t('org.col.kind'), t('devices.col.site'), t('devices.col.station'), t('org.col.status'), t('devices.col.lastSeen'), t('devices.col.version')],
      widths: ['22%', '10%', '18%', '18%', '12%', '12%', '8%'],
      rows: paged.rows.map((device) => {
        const at = site(device.siteId)
        const notSeen = deviceTileMatch('notSeen', device, now)
        return {
          id: device.id,
          cells: [
            <Link key="name" className="fw-adm-name" href={href(`/devices/${device.id}`)}>
              {device.name}
            </Link>,
            t(`devices.kind.${device.kind}`),
            dash(at?.name),
            dash(at?.stations.find((station) => station.id === device.stationId)?.name),
            <span key="status" className="fw-adm-tags">
              <Pill tone={STATUS_TONE[device.status] ?? 'neutral'}>{t(`devices.status.${device.status}`)}</Pill>
              {device.inUse && <Tag tone="info">{t('devices.inUse')}</Tag>}
            </span>,
            device.lastSeenAt ? (
              <span key="seen" className="fw-adm-cell">
                <span>{formatDateTime(device.lastSeenAt, { locale })}</span>
                {notSeen && <Tag tone="warning">{t('devices.notSeenTag')}</Tag>}
              </span>
            ) : (
              '—'
            ),
            dash(device.appVersion),
          ],
        }
      }),
    }
  } else if (!devicesMode && printers) {
    const rows = printerRows(printers, model.query, model.sites)
    const paged = pageOf(rows, model.page)
    table = {
      total: rows.length,
      page: paged.page,
      pageCount: paged.pageCount,
      columns: [t('org.col.code'), t('org.col.name'), t('devices.col.site'), t('org.col.kind'), t('printers.col.relay'), t('printers.col.size'), t('org.col.status')],
      widths: ['12%', '22%', '18%', '12%', '12%', '12%', '12%'],
      rows: paged.rows.map((printer) => ({
        id: printer.id,
        cells: [
          <span key="code" className="fw-adm-code">{printer.code}</span>,
          model.can.managePrinters ? (
            <Button key="name" size="sm" variant="link" onClick={() => actions?.onPrinter?.({ kind: 'edit', printerId: printer.id })}>
              {printer.name}
            </Button>
          ) : (
            printer.name
          ),
          dash(site(printer.siteId)?.name),
          t(`printers.kind.${printer.kind}`),
          t(`printers.relay.${printer.relay}`) === `printers.relay.${printer.relay}` ? printer.relay : t(`printers.relay.${printer.relay}`),
          printer.labelWidthMm && printer.labelHeightMm ? `${printer.labelWidthMm} × ${printer.labelHeightMm} mm` : '—',
          <Pill key="status" tone={STATUS_TONE[printer.status] ?? 'neutral'}>{t(`printers.status.${printer.status}`)}</Pill>,
        ],
      })),
    }
  }

  const revoking = model.revokeId ? (devices ?? []).find((device) => device.id === model.revokeId) ?? null : null
  return (
    <div className="fw-adm">
      <PageHead
        intro={t('devices.intro')}
        asOf={model.asOf}
        actions={
          <>
            {model.can.viewPrinters && (
              <Button size="sm" onClick={() => actions?.onPrinter?.({ kind: 'new' })} heldReason={model.can.managePrinters ? (model.sites.length === 0 ? t('devices.held.noSite') : null) : t('held.needs', { right: t('right.print_manage') })}>
                {t('printers.add')}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => actions?.onEnrol?.(true)} heldReason={model.can.manage ? (model.sites.length === 0 ? t('devices.held.noSite') : null) : t('held.needs', { right: t('right.devices_manage') })}>
              {t('devices.enrol')}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={[
          ...DEVICE_TILES.map((tile) => ({
            label: t(`devices.tile.${tile}`),
            value: devices ? String(devices.filter((device) => deviceTileMatch(tile, device, now)).length) : '—',
            active: model.tile === tile,
            onClick: () => {
              actions?.onMode?.('devices')
              actions?.onTile?.(model.tile === tile ? null : tile)
            },
          })),
          ...(model.can.viewPrinters ? [{ label: t('devices.tile.failedPrinters'), value: model.failedPrinters === null ? '—' : String(model.failedPrinters), hint: t('devices.tileHint.failedPrinters') }] : []),
        ]}
      />
      <div className="fw-adm-toolbar">
        <SegmentedControl
          ariaLabel={t('devices.mode.label')}
          size="sm"
          value={model.mode}
          onChange={(value) => actions?.onMode?.(value as DevicesMode)}
          options={[
            { value: 'devices', label: t('devices.mode.devices'), icon: <Tablet size={14} aria-hidden /> },
            ...(model.can.viewPrinters ? [{ value: 'printers', label: t('devices.mode.printers'), icon: <PrinterIcon size={14} aria-hidden /> }] : []),
          ]}
        />
        <span className="fw-adm-toolbar-search">
          <Input size="sm" fieldClassName="fw-adm-fill" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('devices.search')} placeholder={t('devices.search')} value={model.query} onChange={(event) => actions?.onQuery?.(event.target.value)} />
        </span>
        {devicesMode && model.tile && (
          <span className="fw-adm-tags">
            <Tag tone="info">{t('users.filtered', { tile: t(`devices.tile.${model.tile}`) })}</Tag>
            <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
              {t('list.clearFilter')}
            </Button>
          </span>
        )}
      </div>

      {loadedList.problem || items === null ? (
        <ListState problem={loadedList.problem} loading={items === null} onRetry={actions?.onRetry} />
      ) : items.length === 0 ? (
        <ListState
          loading={false}
          empty={{
            icon: devicesMode ? <Tablet size={24} aria-hidden /> : <PrinterIcon size={24} aria-hidden />,
            title: t(devicesMode ? 'devices.empty.title' : 'printers.empty.title'),
            body: t(devicesMode ? 'devices.empty.body' : 'printers.empty.body'),
            action:
              devicesMode && model.can.manage ? (
                <Button variant="primary" onClick={() => actions?.onEnrol?.(true)}>
                  {t('devices.enrol')}
                </Button>
              ) : !devicesMode && model.can.managePrinters ? (
                <Button variant="primary" onClick={() => actions?.onPrinter?.({ kind: 'new' })}>
                  {t('printers.add')}
                </Button>
              ) : undefined,
          }}
        />
      ) : table && table.total === 0 ? (
        <ListState
          loading={false}
          empty={{
            title: t('list.noMatch'),
            action: (
              <Button
                size="sm"
                onClick={() => {
                  actions?.onQuery?.('')
                  actions?.onTile?.(null)
                }}
              >
                {t('list.clearFilters')}
              </Button>
            ),
          }}
        />
      ) : table ? (
        <ListTable
          label={t(devicesMode ? 'devices.tableLabel' : 'printers.tableLabel')}
          columns={table.columns}
          rows={table.rows}
          widths={table.widths}
          page={table.page}
          pageCount={table.pageCount}
          onPage={actions?.onPage}
          count={t('list.count', { shown: table.rows.length, total: table.total })}
        />
      ) : null}
      <p className="fw-adm-hint">{t('devices.later')}</p>

      <EnrolWizard model={model.enrol} sites={model.sites} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onEnrol?.(false)} onCreate={actions?.onCreateDevice} onRenew={actions?.onRenew} />
      <PrinterModal dialog={model.printer} printers={printers ?? []} sites={model.sites} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onPrinter?.(null)} onSave={actions?.onSavePrinter} />
      <RevokeConfirm device={revoking} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onRevoke?.(null)} onRevoke={actions?.onRevokeConfirm} />
    </div>
  )
}
