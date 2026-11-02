import type { Device, DeviceKind, Enrolment, FloorDeviceMode, Printer, PrinterKind, PrinterStatus } from '../shared/api'
import { PRINTER_CODE } from '../shared/api'
import { reachOf, type BulkReach } from '../shared/reach'
import { matches, type Loaded, type Notice } from '../shared/model'

/**
 * SCR-013 Devices & printers (design 02 admin.devices; PLT-226, GAP-007, MES-184): the enrolled tablets and phones bound
 * to stations, and the sites' printers, on one page. Enrol a device with a one-time QR code (15 minutes), revoke the
 * ticked ones (or one on its record, typed name), add and change printers, pause or resume the ticked ones. The print queue is W1. B-W2b-67 (MES-181,
 * MES-186): a device's mode is chosen at enrolment and changed on its record while nobody is signed in: a station's tablet, a line tablet, a line board
 * (nobody signs in; it opens the line TV), a person's own phone. Pure: the tiles, the rows, the enrol steps, the printer form's checks.
 */

export const DEVICE_MODES = ['devices', 'printers'] as const
export type DevicesMode = (typeof DEVICE_MODES)[number]
export const DEVICE_TILES = ['seenHour', 'notSeen', 'waiting', 'revoked'] as const
export type DeviceTile = (typeof DEVICE_TILES)[number]

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

export function deviceTileMatch(tile: DeviceTile, device: Device, now: number): boolean {
  const seen = device.lastSeenAt ? now - new Date(device.lastSeenAt).getTime() : null
  if (tile === 'seenHour') return device.status === 'ACTIVE' && seen !== null && seen <= HOUR
  if (tile === 'notSeen') return device.status === 'ACTIVE' && (seen === null || seen > DAY)
  if (tile === 'waiting') return device.status === 'PENDING'
  return device.status === 'REVOKED'
}

// ---- the tablet's own state (B-W2a-42; PLT-241; design admin.devices "App version (outdated marked)", "Battery") ----

/** Below this the battery is marked low. */
export const BATTERY_LOW_PERCENT = 20

/** The battery as the tablet last said it; null when it never said (a browser that does not tell, or not reported yet). */
export function batteryOf(device: Device): { percent: number; charging: boolean | null; low: boolean } | null {
  if (device.batteryPercent === null || device.batteryPercent === undefined) return null
  return { percent: device.batteryPercent, charging: device.batteryCharging ?? null, low: device.batteryPercent < BATTERY_LOW_PERCENT && device.batteryCharging !== true }
}

/** An enrolled device whose floor app is not the version the server serves now (it updates once its queue is empty). */
export function isOutdated(device: Device, current: string | null | undefined): boolean {
  return device.status === 'ACTIVE' && Boolean(current) && device.appVersion !== null && device.appVersion !== current
}

/** B-W2b-24: the message key of the network the tablet last said (`devices.network.WIFI`), or null when it never said. */
export function networkKey(device: Pick<Device, 'network'>): string | null {
  return device.network ? `devices.network.${device.network}` : null
}

/** B-W2b-24: since when someone is signed in on it (never who); null when nobody is signed in or the time is not known. */
export function inUseSinceOf(device: Pick<Device, 'inUse' | 'inUseSince'>): string | null {
  return device.inUse && device.inUseSince ? device.inUseSince : null
}

export interface SiteChoice {
  id: string
  name: string
  companyId: string
  stations: ReadonlyArray<{ id: string; code: string; name: string }>
  /** B-W2b-67: the site's active lines (a line tablet and a line board show one). */
  lines: ReadonlyArray<{ id: string; code: string; name: string }>
}

/** A worker a personal phone may be for (a name only inside the dialog and the device's own record). */
export interface PersonChoice {
  id: string
  name: string
}

export interface DevicesAbilities {
  /** devices.manage: enrol, rename, move. */
  manage: boolean
  /** devices.revoke. */
  revoke: boolean
  /** print.view / print.manage. */
  viewPrinters: boolean
  managePrinters: boolean
}

/** The enrol wizard: where it will work → scan the code on the tablet → ready. */
export type EnrolModel =
  | { step: 'where'; siteId?: string | null; mode?: FloorDeviceMode }
  | { step: 'scan'; device: Device; enrolment: Enrolment | null; expired?: boolean }
  | { step: 'ready'; device: Device }

export type PrinterDialog = { kind: 'new'; siteId?: string | null } | { kind: 'edit'; printerId: string }

export interface DevicesViewModel {
  prefix: string
  mode: DevicesMode
  devices: Loaded<Device>
  printers: Loaded<Printer>
  /** Printers with a failed job (the queue itself is W1); null when not read. */
  failedPrinters: number | null
  sites: readonly SiteChoice[]
  tile: DeviceTile | null
  query: string
  /** Pages of 50 rows shown ("Show 50 more" adds one). */
  pages: number
  asOf: string | null
  /** "Now" for "seen in the last hour" (a fixture fixes it). */
  now: string
  /** The floor app version the server serves now (B-W2a-42): a tablet that reports another is outdated. */
  currentVersion?: string | null
  can: DevicesAbilities
  enrol?: EnrolModel | null
  /** The workers of the wizard's site for a personal phone (null: not read yet); `peopleHeld`: no `workers.view`. */
  people?: readonly PersonChoice[] | null
  peopleHeld?: boolean
  printer?: PrinterDialog | null
  /** Rows ticked at first (design fixtures); the view keeps the ticks. */
  selected?: readonly string[]
  /** A bulk action's confirm open at first (design fixtures). */
  bulk?: DevicesBulk | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
}

export function deviceRows(devices: readonly Device[], tile: DeviceTile | null, query: string, sites: readonly SiteChoice[], now: number): Device[] {
  const site = (id: string) => sites.find((item) => item.id === id)
  const station = (device: Device) => site(device.siteId)?.stations.find((item) => item.id === device.stationId)?.name
  return devices
    .filter((device) => (tile ? deviceTileMatch(tile, device, now) : device.status !== 'REVOKED'))
    .filter((device) => matches(query, device.name, site(device.siteId)?.name, station(device)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function printerRows(printers: readonly Printer[], query: string, sites: readonly SiteChoice[]): Printer[] {
  return printers.filter((printer) => matches(query, printer.code, printer.name, sites.find((site) => site.id === printer.siteId)?.name)).sort((a, b) => a.code.localeCompare(b.code))
}

// ---- bulk actions (one call per row: POST /auth/floor/devices/:id/revoke, PATCH /print/printers/:id) ----

export type DevicesBulk = 'revoke' | 'pause' | 'resume'

/** Which ticked devices Revoke reaches: those waiting or enrolled (a revoked one stays revoked). */
export function revokeReach(selected: readonly Device[], can: DevicesAbilities): BulkReach<Device> {
  return reachOf(selected, (device) => device.status !== 'REVOKED', { held: can.revoke ? null : 'right.devices_revoke', none: 'devices.bulk.held.revoke' })
}

/** Which ticked printers Pause (the active ones) or Resume (the paused ones) reaches; an archived printer neither. */
export function printerReach(action: 'pause' | 'resume', selected: readonly Printer[], can: DevicesAbilities): BulkReach<Printer> {
  const held = can.managePrinters ? null : 'right.print_manage'
  return action === 'pause'
    ? reachOf(selected, (printer) => printer.status === 'ACTIVE', { held, none: 'printers.bulk.held.pause' })
    : reachOf(selected, (printer) => printer.status === 'PAUSED', { held, none: 'printers.bulk.held.resume' })
}

export interface EnrolDraft {
  siteId: string
  stationId: string
  name: string
  kind: DeviceKind
  /** B-W2b-67: what it is for; a line tablet and a line board show `lineId`, a phone is for `personalWorkerId`. */
  mode: FloorDeviceMode
  lineId: string
  personalWorkerId: string
}

/** A device shows a line in these modes (factory-domain MODE_RULES showsLine); a phone names its person. */
export const showsLine = (mode: FloorDeviceMode): boolean => mode === 'LINE' || mode === 'DISPLAY'

export function enrolProblems(draft: EnrolDraft): Record<string, string> {
  const out: Record<string, string> = {}
  if (!draft.siteId) out.siteId = 'form.required'
  if (draft.name.trim() === '') out.name = 'form.required'
  else if (draft.name.trim().length > 100) out.name = 'form.tooLong'
  if (showsLine(draft.mode) && !draft.lineId) out.lineId = 'devices.modeProblem.line'
  if (draft.mode === 'PHONE' && !draft.personalWorkerId) out.personalWorkerId = 'devices.modeProblem.person'
  if (draft.mode === 'PHONE' && draft.kind === 'PC') out.kind = 'devices.modeProblem.pc'
  return out
}

/** What POST /auth/floor/devices takes for the draft: only what its mode uses (a phone sits at no station, API rule). */
export function enrolBody(draft: EnrolDraft): { siteId: string; name: string; kind: DeviceKind; mode: FloorDeviceMode; stationId?: string; lineId?: string; personalWorkerId?: string } {
  return {
    siteId: draft.siteId,
    name: draft.name.trim(),
    kind: draft.kind,
    mode: draft.mode,
    ...(draft.mode === 'STATION' && draft.stationId ? { stationId: draft.stationId } : {}),
    ...(showsLine(draft.mode) ? { lineId: draft.lineId } : {}),
    ...(draft.mode === 'PHONE' ? { personalWorkerId: draft.personalWorkerId } : {}),
  }
}

/** A device's binding as its record edits it. */
export interface BindingDraft {
  name: string
  stationId: string
  mode: FloorDeviceMode
  lineId: string
  personalWorkerId: string
}

export const bindingOf = (device: Device): BindingDraft => ({ name: device.name, stationId: device.stationId ?? '', mode: device.mode ?? 'STATION', lineId: device.lineId ?? '', personalWorkerId: device.personalWorkerId ?? '' })

/** The binding's problem (a message key), or null. */
export function bindingProblem(draft: BindingDraft): string | null {
  if (draft.name.trim() === '') return 'form.required'
  if (showsLine(draft.mode) && !draft.lineId) return 'devices.modeProblem.line'
  if (draft.mode === 'PHONE' && !draft.personalWorkerId) return 'devices.modeProblem.person'
  return null
}

/** PATCH's body: the name and station, and the mode, line and person only when they changed (a change needs nobody signed in). */
export function bindingBody(device: Device, draft: BindingDraft): { version: number; name: string; stationId: string | null; mode?: FloorDeviceMode; lineId?: string | null; personalWorkerId?: string | null } {
  const read = bindingOf(device)
  const phone = draft.mode === 'PHONE'
  return {
    version: device.version,
    name: draft.name.trim(),
    stationId: phone || !draft.stationId ? null : draft.stationId,
    ...(draft.mode !== read.mode ? { mode: draft.mode } : {}),
    ...(draft.lineId !== read.lineId ? { lineId: showsLine(draft.mode) ? draft.lineId || null : null } : {}),
    ...(draft.personalWorkerId !== read.personalWorkerId ? { personalWorkerId: phone ? draft.personalWorkerId || null : null } : {}),
  }
}

/** A device's name from its station ("Tablet · Cutting table 1"). */
export const suggestDeviceName = (prefix: string, stationName: string | null | undefined) => (stationName ? `${prefix} · ${stationName}` : '')

export interface PrinterDraft {
  siteId: string
  code: string
  name: string
  kind: PrinterKind
  relayTarget: string
  dpi: string
  labelWidthMm: string
  labelHeightMm: string
  status: PrinterStatus
}

export const LABEL_MM = { minWidth: 76, minHeight: 48, max: 300 } as const

export function printerProblems(draft: PrinterDraft, taken: readonly string[], creating: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  if (creating) {
    if (!draft.siteId) out.siteId = 'form.required'
    const code = draft.code.trim().toUpperCase()
    if (!PRINTER_CODE.test(code)) out.code = 'printers.form.code'
    else if (taken.includes(code)) out.code = 'form.codeTaken'
  }
  if (draft.name.trim() === '') out.name = 'form.required'
  if (draft.relayTarget.trim() === '') out.relayTarget = 'form.required'
  if (draft.kind === 'LABEL_ZPL') {
    const width = Number(draft.labelWidthMm)
    const height = Number(draft.labelHeightMm)
    if (!Number.isInteger(width) || width < LABEL_MM.minWidth || width > LABEL_MM.max) out.labelWidthMm = 'printers.form.width'
    if (!Number.isInteger(height) || height < LABEL_MM.minHeight || height > LABEL_MM.max) out.labelHeightMm = 'printers.form.height'
    if (!['203', '300', '600'].includes(draft.dpi)) out.dpi = 'printers.form.dpi'
  }
  return out
}

export function printerDraft(printer: Printer | null, siteId: string): PrinterDraft {
  if (!printer) return { siteId, code: '', name: '', kind: 'LABEL_ZPL', relayTarget: '', dpi: '203', labelWidthMm: '100', labelHeightMm: '50', status: 'ACTIVE' }
  return {
    siteId: printer.siteId,
    code: printer.code,
    name: printer.name,
    kind: printer.kind,
    relayTarget: printer.relayTarget ?? '',
    dpi: printer.dpi === null ? '' : String(printer.dpi),
    labelWidthMm: printer.labelWidthMm === null ? '' : String(printer.labelWidthMm),
    labelHeightMm: printer.labelHeightMm === null ? '' : String(printer.labelHeightMm),
    status: printer.status,
  }
}

/** The printer body: label stock only for a label printer. */
export function printerBody(draft: PrinterDraft): { name: string; relayTarget: string; dpi: number | null; labelWidthMm: number | null; labelHeightMm: number | null } {
  const label = draft.kind === 'LABEL_ZPL'
  return {
    name: draft.name.trim(),
    relayTarget: draft.relayTarget.trim(),
    dpi: label ? Number(draft.dpi) : null,
    labelWidthMm: label ? Number(draft.labelWidthMm) : null,
    labelHeightMm: label ? Number(draft.labelHeightMm) : null,
  }
}

// ---- a device record ----

export const DEVICE_TABS = ['binding', 'status', 'activity'] as const
export type DeviceTab = (typeof DEVICE_TABS)[number]

export interface DeviceRecordModel {
  prefix: string
  tab: DeviceTab
  device: Device | null
  problem?: string | null
  site: SiteChoice | null
  can: DevicesAbilities
  /** The new enrolment code after "New enrolment code" (shown as the wizard's scan step). */
  enrol?: EnrolModel | null
  revoking?: boolean
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
  now: string
  /** The floor app version the server serves now (B-W2a-42). */
  currentVersion?: string | null
  dockOpen?: boolean
  /** A binding draft (fixture). */
  draft?: BindingDraft | null
  /** The site's workers for a personal phone (null: not read, or no `workers.view`). */
  people?: readonly PersonChoice[] | null
}
