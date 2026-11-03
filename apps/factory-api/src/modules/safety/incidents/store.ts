import type { Prisma } from '@nexus/factory-db'
import { countdownOf, filingStateOf, type Countdown, type FilingState, type FilingStatus } from '@nexus/factory-domain/safety/incidents/rules'
import type { CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { dayOf } from './access'

/**
 * The incident's reads (B-W2b-125): what every office role with safety.incidents.view sees, ANONYMISED — the report, where,
 * the severity, the actions, the photos, the INAIL deadlines (state and countdown only) and the people as counts. The values
 * of IncidentPerson and InailFiling (who, the injury, the filing's type, absence, certificate and protocol) are read ONLY in
 * ./protected.ts, after the view is recorded.
 */

export const INCIDENT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  kind: true,
  occurredAt: true,
  reportedAt: true,
  what: true,
  areaId: true,
  stationId: true,
  machineId: true,
  place: true,
  immediateAction: true,
  maintenanceRequestId: true,
  severity: true,
  reportedVia: true,
  reporterAnonymous: true,
  reportedByWorkerId: true,
  reportedById: true,
  deviceId: true,
  seenAt: true,
  seenById: true,
  status: true,
  closedAt: true,
  closedById: true,
  cancelledAt: true,
  cancelledById: true,
  cancelReason: true,
  version: true,
  area: { select: { id: true, code: true, name: true } },
  station: { select: { id: true, code: true, name: true } },
  machine: { select: { id: true, assetNumber: true } },
  site: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.IncidentSelect
export type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_SELECT }>

/** A filing as everyone with the view sees it: its state and deadline, never its type, absence, certificate or protocol. */
export const FILING_STATE_SELECT = { id: true, incidentId: true, status: true, dueAt: true, version: true } as const satisfies Prisma.InailFilingSelect

export interface FilingDeadline {
  readonly id: string
  readonly state: FilingState
  readonly status: FilingStatus
  readonly countdown: Countdown | null
  readonly version: number
}

export function deadlineOf(filing: { readonly id: string; readonly status: FilingStatus; readonly dueAt: Date | null; readonly version: number }, now: Date): FilingDeadline {
  return { id: filing.id, state: filingStateOf(filing, now), status: filing.status, countdown: filing.status === 'DUE' && filing.dueAt ? countdownOf(filing.dueAt, now) : null, version: filing.version }
}

const STATE_ORDER: Readonly<Record<FilingState, number>> = { OVERDUE: 0, DUE: 1, WAITING_CERTIFICATE: 2, FILED: 3, NOT_NEEDED: 4 }

/** An incident's INAIL deadlines in one line: the open ones, the worst state, the nearest countdown. */
export function inailSummaryOf(deadlines: readonly FilingDeadline[]): { readonly open: number; readonly state: FilingState | null; readonly countdown: Countdown | null } {
  const open = deadlines.filter((deadline) => deadline.status === 'WAITING_CERTIFICATE' || deadline.status === 'DUE').length
  const worst = [...deadlines].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])[0] ?? null
  const nearest = deadlines.map((deadline) => deadline.countdown).filter((countdown): countdown is Countdown => countdown !== null).sort((a, b) => a.minutesLeft - b.minutesLeft)[0] ?? null
  return { open, state: worst?.state ?? null, countdown: nearest }
}

export interface Reporter {
  /** ANONYMOUS: sent without a name; WORKER: a floor worker (named only where the site records workers); USER: an office user; SYSTEM: opened from a machine lock. */
  readonly kind: 'ANONYMOUS' | 'WORKER' | 'USER' | 'SYSTEM'
  readonly name: string | null
  /** A floor worker the site's PERFORMANCE gate keeps back (B-W2b-F3: `worker: null`, hidden). */
  readonly hidden: boolean
  readonly device: { readonly id: string; readonly name: string } | null
}

export function reporterOf(row: Pick<IncidentRow, 'reporterAnonymous' | 'reportedVia' | 'reportedById' | 'reportedByWorkerId' | 'deviceId'>, names: { readonly users: ReadonlyMap<string, string>; readonly workers: ReadonlyMap<string, string>; readonly devices: ReadonlyMap<string, string> }, gateOpen: boolean): Reporter {
  if (row.reporterAnonymous) return { kind: 'ANONYMOUS', name: null, hidden: false, device: null }
  if (row.reportedVia === 'OFFICE') {
    if (row.reportedById === SYSTEM_ACTOR_ID) return { kind: 'SYSTEM', name: null, hidden: false, device: null }
    return { kind: 'USER', name: row.reportedById ? (names.users.get(row.reportedById) ?? null) : null, hidden: false, device: null }
  }
  const device = row.deviceId ? { id: row.deviceId, name: names.devices.get(row.deviceId) ?? '' } : null
  return { kind: 'WORKER', name: gateOpen && row.reportedByWorkerId ? (names.workers.get(row.reportedByWorkerId) ?? null) : null, hidden: !gateOpen && row.reportedByWorkerId !== null, device }
}

/** Office users' names (display names), for owners, deciders and office reporters. */
export async function userNames(tx: Pick<CommandTx, 'user'>, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id !== SYSTEM_ACTOR_ID))]
  if (wanted.length === 0) return new Map()
  const rows = await tx.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

/** The place in one object: area, station, machine (each the site's), and the words. */
export function whereOf(row: Pick<IncidentRow, 'area' | 'station' | 'machine' | 'place'>) {
  return {
    area: row.area ? { id: row.area.id, code: row.area.code, name: row.area.name } : null,
    station: row.station ? { id: row.station.id, code: row.station.code, name: row.station.name } : null,
    machine: row.machine ? { id: row.machine.id, assetNumber: row.machine.assetNumber } : null,
    place: row.place,
  }
}

export const isoOrNull = (value: Date | null): string | null => (value === null ? null : value.toISOString())
export const dayOrNull = (value: Date | null): string | null => (value === null ? null : dayOf(value))

/** The people of incidents as counts (the one thing everyone with the view sees: "One person involved"). */
export async function peopleCounts(tx: Pick<CommandTx, 'incidentPerson'>, incidentIds: readonly string[]): Promise<Map<string, { count: number; injured: number }>> {
  const counts = new Map<string, { count: number; injured: number }>()
  if (incidentIds.length === 0) return counts
  const groups = await tx.incidentPerson.groupBy({ by: ['incidentId', 'involvement'], where: { incidentId: { in: [...incidentIds] } }, _count: { _all: true } })
  for (const group of groups) {
    const entry = counts.get(group.incidentId) ?? { count: 0, injured: 0 }
    entry.count += group._count._all
    if (group.involvement === 'INJURED') entry.injured += group._count._all
    counts.set(group.incidentId, entry)
  }
  return counts
}

/** The incidents' INAIL deadlines (state and countdown only). */
export async function deadlinesOf(tx: Pick<CommandTx, 'inailFiling'>, incidentIds: readonly string[], now: Date): Promise<Map<string, FilingDeadline[]>> {
  const map = new Map<string, FilingDeadline[]>()
  if (incidentIds.length === 0) return map
  const rows = await tx.inailFiling.findMany({ where: { incidentId: { in: [...incidentIds] } }, select: FILING_STATE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (const row of rows) map.set(row.incidentId, [...(map.get(row.incidentId) ?? []), deadlineOf(row, now)])
  return map
}

/** Open actions per incident, and how many are past their day. */
export async function actionCounts(tx: Pick<CommandTx, 'incidentAction'>, incidentIds: readonly string[], today: string): Promise<Map<string, { open: number; overdue: number }>> {
  const map = new Map<string, { open: number; overdue: number }>()
  if (incidentIds.length === 0) return map
  const rows = await tx.incidentAction.findMany({ where: { incidentId: { in: [...incidentIds] }, status: 'OPEN' }, select: { incidentId: true, dueOn: true } })
  for (const row of rows) {
    const entry = map.get(row.incidentId) ?? { open: 0, overdue: 0 }
    entry.open += 1
    if (row.dueOn && dayOf(row.dueOn) < today) entry.overdue += 1
    map.set(row.incidentId, entry)
  }
  return map
}

/** Photos of incidents (AVAILABLE PHOTO files of the row, office only): a count per incident. */
export async function photoCounts(tx: Pick<CommandTx, 'storedFile'>, incidentIds: readonly string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (incidentIds.length === 0) return map
  const groups = await tx.storedFile.groupBy({ by: ['recordId'], where: { recordType: 'Incident', recordId: { in: [...incidentIds] }, kind: 'PHOTO', status: 'AVAILABLE' }, _count: { _all: true } })
  for (const group of groups) map.set(group.recordId, group._count._all)
  return map
}
