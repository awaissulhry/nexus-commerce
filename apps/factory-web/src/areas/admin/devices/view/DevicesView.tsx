'use client'

import { useEffect, useMemo, useState } from 'react'
import { Ban, PauseCircle, PlayCircle, Printer as PrinterIcon, Tablet } from 'lucide-react'
import { MetricStrip } from '@nexus/ui/components'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Device, Printer } from '../../shared/api'
import { namesLine } from '../../shared/reach'
import { adminHref, selectedAmong, shownOf } from '../../shared/model'
import { BulkConfirm } from '../../shared/view/BulkConfirm'
import { AdminMessages, BulkButton, FrameState, heldText, ListKeysHelp, ListSearch, NoticeBanner, PageHead } from '../../shared/view/parts'
import { DEVICE_TILES, deviceRows, deviceTileMatch, printerReach, printerRows, revokeReach, type DevicesBulk, type DevicesMode, type DevicesViewModel, type DeviceTile, type EnrolDraft, type PrinterDialog, type PrinterDraft } from '../model'
import { deviceColumns, printerColumns } from './columns'
import { EnrolWizard, PrinterModal } from './DeviceDialogs'

export type { DevicesViewModel } from '../model'

export interface DevicesActions {
  onMode?: (mode: DevicesMode) => void
  onTile?: (tile: DeviceTile | null) => void
  onQuery?: (query: string) => void
  /** "Show 50 more". */
  onMore?: () => void
  onRetry?: () => void
  /** Enter on a device's row: open its record. */
  onOpen?: (href: string) => void
  onEnrol?: (open: boolean) => void
  onCreateDevice?: (draft: EnrolDraft) => Promise<boolean>
  onRenew?: (device: Device) => void
  onPrinter?: (dialog: PrinterDialog | null) => void
  onSavePrinter?: (draft: PrinterDraft, printer: Printer | null) => Promise<boolean>
  /** Revoke the ticked devices it reaches, one call each; resolves true when the run finished (its notice says how). */
  onRevokeDevices?: (devices: readonly Device[], reason: string) => Promise<boolean>
  /** Pause or resume the ticked printers it reaches, one call each (with each one's version). */
  onPrinterStatus?: (action: 'pause' | 'resume', printers: readonly Printer[]) => Promise<boolean>
  /** A bulk confirm closed (its refusal goes away). */
  onBulkClose?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-013 — Admin › Devices & printers (design 02 admin.devices; PLT-226, GAP-007): the tablets and phones enrolled to
 * the sites' stations — seen when, in use or not (never by whom: Statuto dei Lavoratori art. 4) — and the sites'
 * printers, as two lists of one page in the Office list frame (1 / 2 switch; the print queue is W1). Enrol a device
 * with a one-time QR code; add and change printers; tick devices to Revoke them, printers to Pause or Resume them (each
 * says its reach, one confirm, one notice). Fetches nothing (DevicesPage.tsx reads the API).
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
  const devicesMode = model.mode === 'devices'
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [bulk, setBulk] = useState<DevicesBulk | null>(model.bulk ?? null)
  useEffect(() => setBulk(model.bulk ?? null), [model.bulk])
  const [help, setHelp] = useState(false)
  const mode = (next: DevicesMode) => {
    if (next !== model.mode) setSelected([])
    actions?.onMode?.(next)
  }

  // 1 / 2: devices / printers; c: enrol a device (when no field has the focus), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.enrol || model.printer || bulk) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === '1') mode('devices')
      else if (event.key === '2' && model.can.viewPrinters) mode('printers')
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
  const onPrinter = actions?.onPrinter
  const deviceCols = useMemo(() => deviceColumns({ t, locale, prefix: model.prefix, sites: model.sites, now }), [t, locale, model.prefix, model.sites, now])
  const printerCols = useMemo(() => printerColumns({ t, sites: model.sites, onEdit: model.can.managePrinters ? (printer) => onPrinter?.({ kind: 'edit', printerId: printer.id }) : null }), [t, model.sites, model.can.managePrinters, onPrinter])
  const deviceAll = deviceRows(devices ?? [], model.tile, model.query, model.sites, now)
  const printerAll = printerRows(printers ?? [], model.query, model.sites)
  const deviceShown = shownOf(deviceAll, model.pages)
  const printerShown = shownOf(printerAll, model.pages)
  const pickedDevices = selectedAmong(deviceShown.rows, selected)
  const pickedPrinters = selectedAmong(printerShown.rows, selected)
  const revoke = revokeReach(pickedDevices, model.can)
  const pause = printerReach('pause', pickedPrinters, model.can)
  const resume = printerReach('resume', pickedPrinters, model.can)
  const total = devicesMode ? deviceAll.length : printerAll.length
  const shown = devicesMode ? deviceShown : printerShown

  const clearFilters = () => {
    actions?.onQuery?.('')
    actions?.onTile?.(null)
  }
  const state = loadedList.problem ? (
    <FrameState problem={loadedList.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <FrameState
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
  ) : items && total === 0 ? (
    <FrameState noMatch={{ onClear: clearFilters }} />
  ) : undefined
  const own: ListKey[] = [
    { keys: ['1'], does: t('devices.mode.devices') },
    ...(model.can.viewPrinters ? [{ keys: ['2'], does: t('devices.mode.printers') }] : []),
    ...(model.can.manage ? [{ keys: ['c'], does: t('devices.enrol') }] : []),
  ]
  const frame = {
    count: items ? t('list.count', { shown: shown.rows.length, total }) : '—',
    search: <ListSearch label={t('devices.search')} value={model.query} onChange={actions?.onQuery} />,
    tools: (
      <>
        <SegmentedControl
          ariaLabel={t('devices.mode.label')}
          size="sm"
          value={model.mode}
          onChange={(value) => mode(value as DevicesMode)}
          options={[
            { value: 'devices', label: t('devices.mode.devices'), icon: <Tablet size={14} aria-hidden /> },
            ...(model.can.viewPrinters ? [{ value: 'printers', label: t('devices.mode.printers'), icon: <PrinterIcon size={14} aria-hidden /> }] : []),
          ]}
        />
        {devicesMode && model.tile && (
          <span className="fw-adm-tags">
            <Tag tone="info">{t('users.filtered', { tile: t(`devices.tile.${model.tile}`) })}</Tag>
            <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
              {t('list.clearFilter')}
            </Button>
          </span>
        )}
      </>
    ),
    more: shown.more > 0 ? { label: t('list.more', { count: shown.more }), onMore: () => actions?.onMore?.() } : null,
    keys: own,
    onHelp: () => setHelp(true),
    state,
  }

  // The open confirm: its reach and words.
  const finish = (done: Promise<boolean> | undefined) =>
    void done?.then((finished) => {
      if (!finished) return
      setBulk(null)
      setSelected([])
    })
  const confirm =
    bulk === 'revoke'
      ? {
          count: revoke.items.length,
          title: t('devices.bulk.confirm.revoke', { count: revoke.items.length }),
          lines: [
            t('devices.bulk.revokeBody', { count: revoke.items.length }),
            ...(revoke.items.some((device) => device.inUse) ? [t('devices.bulk.inUse', { count: revoke.items.filter((device) => device.inUse).length })] : []),
            namesLine(
              revoke.items.map((device) => device.name),
              (more) => t('common.bulk.andMore', { count: more }),
            ),
            ...(revoke.skipped > 0 ? [t('common.bulk.skipped', { count: revoke.skipped })] : []),
          ],
          label: t('devices.bulk.revoke', { count: revoke.items.length }),
          tone: 'danger' as const,
          reason: true,
          run: (reason: string) => finish(actions?.onRevokeDevices?.(revoke.items, reason)),
        }
      : bulk === 'pause' || bulk === 'resume'
        ? (() => {
            const reach = bulk === 'pause' ? pause : resume
            return {
              count: reach.items.length,
              title: t(bulk === 'pause' ? 'printers.bulk.confirm.pause' : 'printers.bulk.confirm.resume', { count: reach.items.length }),
              lines: [
                t(bulk === 'pause' ? 'printers.bulk.pauseBody' : 'printers.bulk.resumeBody', { count: reach.items.length }),
                namesLine(
                  reach.items.map((printer) => printer.name),
                  (more) => t('common.bulk.andMore', { count: more }),
                ),
                ...(reach.skipped > 0 ? [t('common.bulk.skipped', { count: reach.skipped })] : []),
              ],
              label: t(bulk === 'pause' ? 'printers.bulk.pause' : 'printers.bulk.resume', { count: reach.items.length }),
              tone: bulk === 'pause' ? ('danger' as const) : ('primary' as const),
              reason: false,
              run: () => finish(actions?.onPrinterStatus?.(bulk, reach.items)),
            }
          })()
        : null

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
              mode('devices')
              actions?.onTile?.(model.tile === tile ? null : tile)
            },
          })),
          ...(model.can.viewPrinters ? [{ label: t('devices.tile.failedPrinters'), value: model.failedPrinters === null ? '—' : String(model.failedPrinters), hint: t('devices.tileHint.failedPrinters') }] : []),
        ]}
      />
      {devicesMode ? (
        <ListFrame<Device>
          {...frame}
          label={t('devices.tableLabel')}
          rows={items === null ? null : deviceShown.rows}
          rowId={(device) => device.id}
          columns={deviceCols}
          onOpen={(device) => actions?.onOpen?.(href(`/devices/${device.id}`))}
          selection={{
            selected: pickedDevices.map((device) => device.id),
            onChange: setSelected,
            actions: (
              <BulkButton
                icon={<Ban size={13} aria-hidden />}
                label={revoke.held ? t('devices.revoke.action') : t('devices.bulk.revoke', { count: revoke.items.length })}
                held={heldText(t, revoke.held)}
                tone="danger-outline"
                onClick={() => setBulk('revoke')}
              />
            ),
          }}
        />
      ) : (
        <ListFrame<Printer>
          {...frame}
          label={t('printers.tableLabel')}
          rows={items === null ? null : printerShown.rows}
          rowId={(printer) => printer.id}
          columns={printerCols}
          onOpen={model.can.managePrinters ? (printer) => actions?.onPrinter?.({ kind: 'edit', printerId: printer.id }) : undefined}
          selection={{
            selected: pickedPrinters.map((printer) => printer.id),
            onChange: setSelected,
            actions: (
              <>
                <BulkButton
                  icon={<PauseCircle size={13} aria-hidden />}
                  label={pause.held ? t('printers.bulk.pauseVerb') : t('printers.bulk.pause', { count: pause.items.length })}
                  held={heldText(t, pause.held)}
                  tone="danger-outline"
                  onClick={() => setBulk('pause')}
                />
                <BulkButton
                  icon={<PlayCircle size={13} aria-hidden />}
                  label={resume.held ? t('printers.bulk.resumeVerb') : t('printers.bulk.resume', { count: resume.items.length })}
                  held={heldText(t, resume.held)}
                  onClick={() => setBulk('resume')}
                />
              </>
            ),
          }}
        />
      )}
      <p className="fw-adm-hint">{t('devices.later')}</p>

      <EnrolWizard model={model.enrol} sites={model.sites} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onEnrol?.(false)} onCreate={actions?.onCreateDevice} onRenew={actions?.onRenew} />
      <PrinterModal dialog={model.printer} printers={printers ?? []} sites={model.sites} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onPrinter?.(null)} onSave={actions?.onSavePrinter} />
      <BulkConfirm
        open={!!confirm && confirm.count > 0}
        title={confirm?.title ?? ''}
        lines={confirm?.lines ?? []}
        confirmLabel={confirm?.label ?? ''}
        tone={confirm?.tone}
        reason={confirm?.reason}
        busy={model.busy}
        problem={model.dialogProblem}
        onConfirm={(reason) => confirm?.run(reason)}
        onClose={() => {
          setBulk(null)
          actions?.onBulkClose?.()
        }}
      />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={own} selection />
    </div>
  )
}
