import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEVICES, inShell, NOW, panels, PREFIX, PRINTERS, SITES, STATIONS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { Device } from '../shared/api'
import type { DeviceRecordModel, DevicesViewModel, SiteChoice } from './model'
import { DeviceRecordView } from './view/DeviceRecordView'
import { DevicesView } from './view/DevicesView'

/**
 * SCR-013 Devices & printers with made-up tablets, a made-up enrolment address (example.com, it opens nothing) and
 * invented printer targets.
 */

type Case = { page: 'list'; model: DevicesViewModel } | { page: 'device'; model: DeviceRecordModel; dock?: boolean }

/**
 * B-W2a-42: what each tablet last said of itself (app version, battery, actions waiting to sync), and the version the
 * server serves now: "Tablet cucito 2" runs 1.3.2 (outdated) with 3 actions waiting; "Tablet taglio 2" is low.
 */
const CURRENT_VERSION = '1.4.0'
const REPORTED = DEVICES[0]!.lastSeenAt
const STATE: Readonly<Record<number, Partial<Device>>> = {
  0: { batteryPercent: 82, batteryCharging: true, queuedActions: 0, statusReportedAt: REPORTED },
  1: { batteryPercent: 12, batteryCharging: false, queuedActions: 0, statusReportedAt: DEVICES[1]!.lastSeenAt },
  2: { batteryPercent: 57, batteryCharging: false, queuedActions: 3, statusReportedAt: REPORTED },
}
const STATEFUL: Device[] = DEVICES.map((item, index) => ({ ...item, ...(STATE[index] ?? {}) }))

const sites: SiteChoice[] = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId, stations: site.id === SITES[0]!.id ? STATIONS.map((station) => ({ id: station.id, code: station.code, name: station.name })) : [] }))
const CAN = { manage: true, revoke: true, viewPrinters: true, managePrinters: true }
const ENROLMENT = { code: 'demo-enrolment-code', url: 'https://factory.example.com/floor/enrol#code=DEMO-ONLY', qrSvg: '', expiresAt: '2026-10-29T09:57:00.000Z' }
const list = (over: Partial<DevicesViewModel> = {}): Case => ({
  page: 'list',
  model: { prefix: PREFIX, mode: 'devices', devices: loaded(STATEFUL), printers: loaded(PRINTERS), failedPrinters: 1, sites, tile: null, query: '', pages: 1, asOf: NOW, now: NOW, currentVersion: CURRENT_VERSION, can: CAN, ...over },
})
const device = (index: number, over: Partial<DeviceRecordModel> = {}, dock = false): Case => ({
  page: 'device',
  dock,
  model: { prefix: PREFIX, tab: 'binding', device: STATEFUL[index]!, site: sites.find((site) => site.id === DEVICES[index]!.siteId) ?? null, can: CAN, now: NOW, currentVersion: CURRENT_VERSION, ...over },
})

function DevicesDesign({ model }: { model: Case }) {
  if (model.page === 'list') return inShell('/admin/devices', createElement(DevicesView, { model: model.model }))
  const record = model.model.device
  const panel = record ? panels({ type: 'Device', id: record.id, companyId: SITES[0]!.companyId, siteId: record.siteId }, record.name, 'history') : null
  return inShell(`/admin/devices/${record?.id ?? 'x'}`, createElement(DeviceRecordView, { model: { ...model.model, dockOpen: model.dock }, panels: panel }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-013',
  title: 'Devices & printers, and the Device record',
  view: DevicesDesign,
  cases: [
    { id: 'devices', label: 'Devices', model: list(), note: '"In use" says someone is signed in, never who (Statuto dei Lavoratori art. 4). 1 / 2 switch lists; c enrols. W2a: the app version is marked when it is not the one the server serves; the battery as the tablet said it (low marked).' },
    { id: 'tile-not-seen', label: 'Tile: not seen for 24 h', model: list({ tile: 'notSeen' }) },
    { id: 'printers', label: 'Printers', model: list({ mode: 'printers' }) },
    { id: 'enrol-where', label: 'Enrol 1: where will it work?', model: list({ enrol: { step: 'where', siteId: SITES[0]!.id } }), note: 'Picking a station suggests the name. The mode (Operator, Cutting…) comes with the floor step.' },
    { id: 'enrol-scan', label: 'Enrol 2: scan this on the tablet', model: list({ enrol: { step: 'scan', device: DEVICES[3]!, enrolment: ENROLMENT } }), note: 'A made-up address. The page waits for the tablet and moves on by itself.' },
    { id: 'enrol-expired', label: 'Enrol: the code expired', model: list({ enrol: { step: 'scan', device: DEVICES[3]!, enrolment: ENROLMENT, expired: true } }) },
    { id: 'enrol-ready', label: 'Enrol 3: ready', model: list({ enrol: { step: 'ready', device: { ...DEVICES[3]!, status: 'ACTIVE' } } }) },
    { id: 'printer-new', label: 'Add a printer', model: list({ mode: 'printers', printer: { kind: 'new', siteId: SITES[0]!.id } }) },
    { id: 'printer-edit', label: 'Change a printer', model: list({ mode: 'printers', printer: { kind: 'edit', printerId: PRINTERS[0]!.id } }) },
    { id: 'devices-selected', label: 'Devices: three ticked, Revoke 3', model: list({ selected: [DEVICES[0]!.id, DEVICES[1]!.id, DEVICES[3]!.id] }), note: 'An enrolled, a silent and a waiting device: Revoke reaches all three.' },
    {
      id: 'devices-bulk-revoke',
      label: 'Devices: revoke 3, one confirm',
      model: list({ selected: [DEVICES[0]!.id, DEVICES[1]!.id, DEVICES[3]!.id], bulk: 'revoke' }),
      note: 'The count, that their sign-ins end at once (one is in use now), an optional reason. One device alone is revoked on its record with its name typed.',
    },
    { id: 'devices-revoked-selected', label: 'Devices: a revoked one ticked, Revoke held', model: list({ tile: 'revoked', selected: [DEVICES[4]!.id] }) },
    { id: 'devices-bulk-result', label: 'Devices: the result notice', model: list({ notice: { key: 'devices.bulk.done.revoke', tone: 'warning', params: { count: 2 }, refused: [{ name: 'Lettore magazzino', problem: 'problem.conflict' }] } }) },
    { id: 'printers-selected', label: 'Printers: all three ticked, Pause 2, Resume 1', model: list({ mode: 'printers', selected: PRINTERS.map((printer) => printer.id) }), note: 'Two active, one paused: each action says its reach.' },
    { id: 'printers-bulk-pause', label: 'Printers: pause 2, one confirm', model: list({ mode: 'printers', selected: PRINTERS.map((printer) => printer.id), bulk: 'pause' }) },
    { id: 'printers-bulk-done', label: 'Printers: the result notice', model: list({ mode: 'printers', notice: { key: 'printers.bulk.done.pause', tone: 'success', params: { count: 2 } } }) },
    { id: 'empty', label: 'No tablets yet', model: list({ devices: loaded([]) }) },
    { id: 'printers-empty', label: 'No printers yet', model: list({ mode: 'printers', printers: loaded([]) }) },
    { id: 'loading', label: 'Loading', model: list({ devices: loading(), printers: loading(), failedPrinters: null, asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: list({ devices: failed('problem.unavailable'), asOf: null }) },
    { id: 'viewer', label: 'A viewer: enrol and add held', model: list({ can: { manage: false, revoke: false, viewPrinters: true, managePrinters: false } }) },
    { id: 'device-binding', label: 'Device: station & mode', model: device(0) },
    { id: 'device-status', label: 'Device: status and danger zone', model: device(0, { tab: 'status' }) },
    { id: 'device-silent', label: 'Device: not seen for 3 days', model: device(1, { tab: 'status' }) },
    {
      id: 'device-outdated',
      label: 'Device: an older app version, 3 actions waiting',
      model: device(2, { tab: 'status' }),
      note: 'B-W2a-42, PLT-241: the tablet runs 1.3.2, the server serves 1.4.0; it updates by itself once its queue is empty. Battery and queue as the tablet last said them.',
    },
    {
      id: 'device-not-reported',
      label: 'Device: the tablet has not said its state yet',
      model: { page: 'device', model: { prefix: PREFIX, tab: 'status', device: DEVICES[0]!, site: sites[0] ?? null, can: CAN, now: NOW, currentVersion: CURRENT_VERSION } },
      note: 'A tablet on an older app (before the report) or a browser that never said it: "not reported", never a guess.',
    },
    { id: 'device-new-code', label: 'Device: a new enrolment code', model: device(1, { enrol: { step: 'scan', device: DEVICES[1]!, enrolment: ENROLMENT } }) },
    { id: 'device-revoke', label: 'Device: revoke', model: device(0, { tab: 'status', revoking: true }) },
    { id: 'device-revoked', label: 'Device: revoked', model: device(4, { tab: 'status' }) },
    { id: 'device-activity', label: 'Device: activity', model: device(0, { tab: 'activity' }) },
    { id: 'device-dock', label: 'Device: history beside the binding (≥ 1280 px)', model: device(0, {}, true) },
    { id: 'device-not-found', label: 'Device: not found', model: { page: 'device', model: { prefix: PREFIX, tab: 'binding', device: null, problem: 'problem.notFound', site: null, can: CAN, now: NOW } } },
  ],
})
