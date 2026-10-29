import { FLOOR_SESSION, normalizeShiftEnds, timingProblems } from '@nexus/factory-domain/auth/floor/session'
import type { Device, FloorSettings, Line, Printer, SiteStructure, Station, WorkCentre, WorkCentreKind } from '../shared/api'
import { ORG_CODE } from '../shared/api'
import type { Loaded, Notice } from '../shared/model'

/**
 * SCR-009 a site's structure (design 02 admin.org "Record: Site"; PLT-004, PLT-005, MES-292): Structure (lines and the
 * stations on them, and the stations that stand alone), Work centres, Calendars (when shifts end and how long a tablet
 * waits before signing a worker out), Devices (the site's tablets and printers), Activity. Pure: the groups of the
 * structure, what an archive waits for, the form checks.
 */

export const SITE_TABS = ['structure', 'centres', 'calendars', 'devices', 'activity'] as const
export type SiteTab = (typeof SITE_TABS)[number]

export type SiteDialog =
  | { kind: 'line' }
  | { kind: 'station'; lineId?: string | null }
  | { kind: 'centre' }
  | { kind: 'rename'; target: 'line' | 'station' | 'centre'; id: string }
  | { kind: 'move'; stationId: string }
  | { kind: 'archive'; target: 'line' | 'station' | 'centre' | 'site'; id: string }

export interface SiteAbilities {
  /** sites.manage: lines, stations, work centres, the site itself. */
  manage: boolean
  /** devices.view / devices.manage: the Devices tab, the floor times. */
  viewDevices: boolean
  manageDevices: boolean
  /** print.view: the site's printers. */
  viewPrinters: boolean
}

export interface SiteRecordModel {
  prefix: string
  tab: SiteTab
  structure: SiteStructure | null
  problem?: string | null
  can: SiteAbilities
  floor: { settings: FloorSettings | null; problem?: string | null }
  devices: Loaded<Device>
  printers: Loaded<Printer>
  showArchived: boolean
  dialog?: SiteDialog | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
  dockOpen?: boolean
  /** A floor-times draft being edited (a fixture shows one). */
  floorDraft?: FloorDraft | null
}

/** The structure as the tab draws it: each line with its stations, then the stations that stand alone. */
export function structureGroups(structure: SiteStructure, showArchived: boolean): Array<{ line: Line | null; stations: Station[] }> {
  const visible = <T extends { status: string }>(rows: readonly T[]) => rows.filter((row) => showArchived || row.status === 'ACTIVE')
  const stations = visible(structure.stations)
  const groups: Array<{ line: Line | null; stations: Station[] }> = visible(structure.lines).map((line) => ({ line, stations: stations.filter((station) => station.lineId === line.id) }))
  const known = new Set(groups.map((group) => group.line!.id))
  const alone = stations.filter((station) => station.lineId === null || !known.has(station.lineId))
  if (alone.length > 0 || groups.length === 0) groups.push({ line: null, stations: alone })
  return groups
}

/** What still uses a row (an archive waits until it is empty): kind → count. Empty: it may be archived. */
export function archiveUses(structure: SiteStructure, target: 'line' | 'station' | 'centre' | 'site', id: string): Record<string, number> {
  const active = structure.stations.filter((station) => station.status === 'ACTIVE')
  if (target === 'line') return pickUses({ stations: active.filter((station) => station.lineId === id).length })
  if (target === 'centre') return pickUses({ stations: active.filter((station) => station.workCentreId === id).length })
  if (target === 'station') return pickUses({ devices: structure.stations.find((station) => station.id === id)?.devices ?? 0 })
  const counts = structure.site.counts
  return pickUses({ lines: counts.lines, stations: counts.stations, devices: counts.devices, printers: counts.printers })
}
const pickUses = (uses: Record<string, number>) => Object.fromEntries(Object.entries(uses).filter(([, count]) => count > 0))

export interface PartDraft {
  code: string
  name: string
  kind: WorkCentreKind
  workCentreId: string
  lineId: string
}

/** Field → message key of what is wrong (empty: ready). */
export function partProblems(kind: 'line' | 'station' | 'centre', draft: PartDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const code = draft.code.trim().toUpperCase()
  if (!ORG_CODE.test(code)) out.code = 'form.code'
  else if (taken.includes(code)) out.code = 'form.codeTaken'
  if (draft.name.trim() === '') out.name = 'form.required'
  if (kind === 'station' && !draft.workCentreId) out.workCentreId = 'site.station.needsCentre'
  return out
}

/** The codes already used on the site, per kind (codes are unique on the site). */
export function takenCodes(structure: SiteStructure, kind: 'line' | 'station' | 'centre'): string[] {
  const rows: ReadonlyArray<{ code: string }> = kind === 'line' ? structure.lines : kind === 'centre' ? structure.workCentres : structure.stations
  return rows.map((row) => row.code.toUpperCase())
}

export const centreName = (centres: readonly WorkCentre[], id: string) => centres.find((centre) => centre.id === id)?.name ?? null

// ---- the floor times (Calendars tab) ----

export interface FloorDraft {
  idleMinutes: number
  shiftEnds: string[]
}

export const floorDraft = (settings: FloorSettings): FloorDraft => ({ idleMinutes: settings.idleMinutes, shiftEnds: [...settings.shiftEnds] })
export const sameFloor = (a: FloorDraft, b: FloorDraft) => a.idleMinutes === b.idleMinutes && normalizeShiftEnds(a.shiftEnds).join() === normalizeShiftEnds(b.shiftEnds).join()

/** The floor rules' own check (factory-domain auth/floor/session timingProblems), as message keys by field. */
export function floorProblems(draft: FloorDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of timingProblems(draft)) {
    if (issue.path === 'idleMinutes') out.idleMinutes = 'site.floor.idleRange'
    else if (issue.path.startsWith('shiftEnds/')) out[issue.path] = 'site.floor.timeFormat'
    else out.shiftEnds = draft.shiftEnds.length > FLOOR_SESSION.maxShiftEnds ? 'site.floor.tooMany' : 'site.floor.twice'
  }
  return out
}

export const IDLE_RANGE = { min: FLOOR_SESSION.minIdleMinutes, max: FLOOR_SESSION.maxIdleMinutes }
export { normalizeShiftEnds }
