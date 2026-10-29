import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { SiteStructure } from '../shared/api'
import { CENTRES, COMPANIES, DEVICES, inShell, LINES, panels, PREFIX, PRINTERS, SITES, STATIONS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { SiteRecordModel } from './model'
import { SiteRecordView } from './view/SiteRecordView'

/** SCR-009 a site's structure with a made-up plant ("Stabilimento Demo Nord"): lines, stations, work centres, devices. */

const company = { id: COMPANIES[0]!.id, code: COMPANIES[0]!.code, legalName: COMPANIES[0]!.legalName }
const structure: SiteStructure = { site: SITES[0]!, company, lines: LINES, workCentres: CENTRES, stations: STATIONS }
const bare: SiteStructure = { site: { ...SITES[2]!, companyId: COMPANIES[1]!.id }, company: { id: COMPANIES[1]!.id, code: COMPANIES[1]!.code, legalName: COMPANIES[1]!.legalName }, lines: [], workCentres: [], stations: [] }
const CAN = { manage: true, viewDevices: true, manageDevices: true, viewPrinters: true }
const SETTINGS = { siteId: SITES[0]!.id, idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: false, timeZone: 'Europe/Rome', version: 2 }

const site = (over: Partial<SiteRecordModel> = {}): SiteRecordModel => ({
  prefix: PREFIX,
  tab: 'structure',
  structure,
  can: CAN,
  floor: { settings: SETTINGS },
  devices: loaded(DEVICES.filter((device) => device.siteId === SITES[0]!.id)),
  printers: loaded(PRINTERS.filter((printer) => printer.siteId === SITES[0]!.id)),
  showArchived: false,
  ...over,
})

function SiteDesign({ model }: { model: SiteRecordModel }) {
  const record = model.structure?.site
  const panel = record ? panels({ type: 'Site', id: record.id, companyId: record.companyId, siteId: record.id }, record.name) : null
  return inShell(`/admin/companies/${record?.companyId ?? 'x'}/sites/${record?.id ?? 'x'}`, createElement(SiteRecordView, { model, panels: panel }))
}

export const designScreen = defineDesignScreen<SiteRecordModel>({
  screen: 'SCR-009',
  title: 'Site record: structure, work centres, floor times, devices',
  view: SiteDesign,
  cases: [
    { id: 'structure', label: 'Structure: lines and their stations', model: site(), note: 'Stations on a line, then the ones standing alone (cutting tables, benches). Archive is held while a device is enrolled at the station.' },
    { id: 'structure-empty', label: 'A new plant: nothing yet', model: site({ structure: bare, devices: loaded([]), printers: loaded([]) }) },
    { id: 'add-line', label: 'Add a line', model: site({ dialog: { kind: 'line' } }) },
    { id: 'add-station', label: 'Add a station on a line', model: site({ dialog: { kind: 'station', lineId: LINES[0]!.id } }) },
    { id: 'add-station-refused', label: 'Add a station: code taken', model: site({ dialog: { kind: 'station' }, dialogProblem: 'problem.conflict' }) },
    { id: 'move', label: 'Move a station to another line', model: site({ dialog: { kind: 'move', stationId: STATIONS[2]!.id } }) },
    { id: 'archive-held', label: 'Archive a line: held while stations are on it', model: site({ dialog: { kind: 'archive', target: 'line', id: LINES[0]!.id } }) },
    { id: 'archive-site-held', label: 'Archive the site: what still uses it', model: site({ dialog: { kind: 'archive', target: 'site', id: SITES[0]!.id } }) },
    { id: 'centres', label: 'Work centres', model: site({ tab: 'centres' }) },
    { id: 'add-centre', label: 'Add a work centre', model: site({ tab: 'centres', dialog: { kind: 'centre' } }) },
    { id: 'calendars', label: 'Calendars: floor times; badge alone off', model: site({ tab: 'calendars' }), note: "The Owner's F1 switch (FloorSettings.badgeOnlySignIn): off, every sign-in asks for the badge and the PIN." },
    { id: 'calendars-badge-on', label: 'Calendars: badge alone starts work (on)', model: site({ tab: 'calendars', floor: { settings: { ...SETTINGS, badgeOnlySignIn: true } } }), note: 'The PIN is asked only to sign, to open My day, or for a name sign-in.' },
    { id: 'calendars-badge-switched', label: 'Calendars: switch turned on, not saved yet', model: site({ tab: 'calendars', floorDraft: { idleMinutes: 10, shiftEnds: ['14:00', '22:00'], badgeOnlySignIn: true } }), note: 'Saved with the floor times (EditModeBar, ⌘S).' },
    { id: 'calendars-badge-held', label: 'Calendars: without devices.manage (held)', model: site({ tab: 'calendars', can: { ...CAN, manageDevices: false }, floor: { settings: { ...SETTINGS, badgeOnlySignIn: true } } }), note: 'The state as text with the right it needs; no switch to press.' },
    { id: 'calendars-editing', label: 'Calendars: a wrong time held', model: site({ tab: 'calendars', floorDraft: { idleMinutes: 0, shiftEnds: ['14:00', '14:00'], badgeOnlySignIn: false } }) },
    { id: 'calendars-no-right', label: 'Calendars without devices rights', model: site({ tab: 'calendars', can: { ...CAN, viewDevices: false, manageDevices: false } }) },
    { id: 'devices', label: 'Devices: tablets and printers here', model: site({ tab: 'devices' }) },
    { id: 'devices-empty', label: 'Devices: none yet', model: site({ tab: 'devices', structure: bare, devices: loaded([]), printers: loaded([]) }) },
    { id: 'activity', label: 'Activity (record panels)', model: site({ tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside the structure (≥ 1280 px)', model: site({ dockOpen: true }) },
    { id: 'read-only', label: 'Read-only (no sites.manage)', model: site({ can: { ...CAN, manage: false, manageDevices: false } }) },
    { id: 'saved', label: 'Station added', model: site({ notice: { key: 'site.done.station', tone: 'success' } }) },
    { id: 'archived', label: 'An archived site', model: site({ structure: { ...structure, site: { ...structure.site, status: 'ARCHIVED' } } }) },
    { id: 'loading', label: 'Loading', model: site({ structure: null, devices: loading(), printers: loading(), floor: { settings: null } }) },
    { id: 'not-found', label: 'Not found', model: site({ structure: null, problem: 'problem.notFound', devices: failed('problem.notFound') }) },
  ],
})
