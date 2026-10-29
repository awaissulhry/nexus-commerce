import type { Issue } from '../../core/errors'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074 Production › Settings; features MES-278, PLT-208): the monitoring switch.
 * Who a floor record (a scan, a cut log) names: the signed-in WORKER (Q16 (a), the schema's default, also for a site
 * without a row) or the STATION only (Q16 (b)), and the legal basis on record for naming workers (Statuto dei
 * Lavoratori, L. 300/1970, art. 4 c.1: an agreement with the RSU or RSA, the labour inspectorate's authorisation, or
 * counsel's written opinion that neither is needed), with its reference and who recorded it, when.
 *
 * The rules, pure (the API reads the database; the …_production_guards triggers hold the floor's side for every login):
 *   - a site is SET to name workers only with a legal basis on record (kind and reference);
 *   - widening (STATION → WORKER) records more about people: it asks for a fresh code (step-up) and a reason;
 *   - narrowing (WORKER → STATION) is always allowed and never asks;
 *   - a change applies from now on: scans and cut logs are append-only and keep what they recorded;
 *   - a floor record names a worker only after that worker acknowledged the information notice (art. 4 c.3; GDPR
 *     art. 13), and at a STATION site only the station;
 *   - the counts shown are counts: no list here ranks, scores or sorts people by what they did.
 * Real floor use waits for the basis or for the Owner's choice of STATION (PLAN Q16): `floorRulesStatus` says so.
 */

export const SCAN_SUBJECTS = ['WORKER', 'STATION'] as const
export type ScanSubject = (typeof SCAN_SUBJECTS)[number]

/** The schema's default: a site without floor rules names the signed-in worker. */
export const DEFAULT_SCAN_SUBJECT: ScanSubject = 'WORKER'

export const MONITORING_BASES = ['UNION_AGREEMENT', 'INL_AUTHORISATION', 'NOT_REQUIRED'] as const
export type MonitoringBasis = (typeof MONITORING_BASES)[number]

/** The legal basis kinds in words, for answers and audit readers. */
export const MONITORING_BASIS_WORDS: Readonly<Record<MonitoringBasis, string>> = Object.freeze({
  UNION_AGREEMENT: 'an agreement with the union representatives (RSU or RSA)',
  INL_AUTHORISATION: "the labour inspectorate's authorisation (Ispettorato nazionale del lavoro)",
  NOT_REQUIRED: "counsel's written opinion that neither an agreement nor an authorisation is needed",
})

export const SCAN_SUBJECT_WORDS: Readonly<Record<ScanSubject, string>> = Object.freeze({
  WORKER: 'Scans and cut logs name the signed-in worker.',
  STATION: 'Scans and cut logs name the station only, never the worker.',
})

/** The law the switch rests on, as the answers cite it. */
export const MONITORING_LAW = 'L. 300/1970 art. 4 c.1'

export const REFERENCE_MAX = 200
export const REASON_MAX = 500

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

export const isScanSubject = (value: unknown): value is ScanSubject => (SCAN_SUBJECTS as readonly unknown[]).includes(value)
export const isMonitoringBasis = (value: unknown): value is MonitoringBasis => (MONITORING_BASES as readonly unknown[]).includes(value)

/** The site's scan subject: its row's, or the default for a site without one. */
export const scanSubjectOf = (row: { readonly scanSubject: ScanSubject } | null | undefined): ScanSubject => row?.scanSubject ?? DEFAULT_SCAN_SUBJECT

/** What a move of the switch does: WIDEN records more about people, NARROW less, NONE leaves the subject as it is. */
export type MonitoringChange = 'WIDEN' | 'NARROW' | 'NONE'

export function monitoringChangeOf(from: ScanSubject, to: ScanSubject): MonitoringChange {
  if (from === to) return 'NONE'
  return to === 'WORKER' ? 'WIDEN' : 'NARROW'
}

/** Widening asks for a fresh code (A1 §3.10 step-up); narrowing never does. */
export const changeNeedsStepUp = (change: MonitoringChange): boolean => change === 'WIDEN'

/** Widening says why; narrowing and recording a basis may. */
export const changeNeedsReason = (change: MonitoringChange): boolean => change === 'WIDEN'

/** A legal basis as sent: its kind and its reference (the agreement's or authorisation's number and date, or the opinion). */
export interface LegalBasisInput {
  readonly kind: string
  readonly reference: string
}

/** Every problem of a legal basis as sent (empty: none). */
export function legalBasisProblems(input: LegalBasisInput | null | undefined, at = 'body'): Issue[] {
  if (!input || typeof input !== 'object') return [{ path: at, message: `Give the legal basis for naming workers (${MONITORING_LAW}) and its reference.` }]
  const problems: Issue[] = []
  if (!isMonitoringBasis(input.kind)) {
    problems.push({ path: `${at}/kind`, message: 'Choose the legal basis: an agreement with the RSU or RSA, the labour inspectorate\'s authorisation, or counsel\'s written opinion that neither is needed.' })
  }
  if (!filled(input.reference)) {
    problems.push({ path: `${at}/reference`, message: 'Give the reference: the agreement\'s or the authorisation\'s number and date, or the opinion\'s author and date.' })
  } else if (input.reference.trim().length > REFERENCE_MAX) {
    problems.push({ path: `${at}/reference`, message: `Keep the reference to ${REFERENCE_MAX} characters; the document itself belongs in the files.` })
  }
  return problems
}

const reasonProblems = (reason: string | null | undefined, required: boolean, at: string, why: string): Issue[] => {
  if (!filled(reason)) return required ? [{ path: at, message: why }] : []
  return reason.trim().length > REASON_MAX ? [{ path: at, message: `Keep the reason to ${REASON_MAX} characters.` }] : []
}

/** A change of the scan subject as asked. */
export interface ScanSubjectChangeInput {
  readonly from: ScanSubject
  readonly to: ScanSubject
  /** A legal basis is on record once the change is made (the one sent with it, or the one already recorded). */
  readonly basisOnRecord: boolean
  readonly reason?: string | null | undefined
}

/**
 * Every problem of a scan subject change (empty: none). Naming workers needs a legal basis on record, also when the site
 * names them already by default; widening says why. Narrowing is always allowed.
 */
export function scanSubjectChangeProblems(input: ScanSubjectChangeInput, at = 'body'): Issue[] {
  const change = monitoringChangeOf(input.from, input.to)
  const problems: Issue[] = []
  if (input.to === 'WORKER' && !input.basisOnRecord) {
    problems.push({
      path: `${at}/legalBasis`,
      message: `Record the legal basis for naming workers first (${MONITORING_LAW}): the agreement with the RSU or RSA, the labour inspectorate's authorisation, or counsel's written opinion that neither is needed, with its reference.`,
    })
  }
  problems.push(...reasonProblems(input.reason, changeNeedsReason(change), `${at}/reason`, 'Say why floor records will name workers from now on.'))
  return problems
}

/** Problems of the reason that comes with a recorded or replaced legal basis (optional). */
export const basisReasonProblems = (reason: string | null | undefined, at = 'body/reason'): Issue[] => reasonProblems(reason, false, at, '')

/** The people and work a change of the switch reaches at the site (counts only; never a ranking). */
export interface MonitoringAffected {
  /** Work orders the floor works on now: RELEASED or IN_PROGRESS. */
  readonly openWorkOrders: number
  /** ACTIVE workers of the site. */
  readonly workersActive: number
  /** Of them, those with no acknowledgement of the information notice: no floor record names them. */
  readonly workersNotAcknowledged: number
  /** ACTIVE devices of the site without a station: at a STATION site they record nothing. */
  readonly devicesWithoutStation: number
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** What moving the switch from `from` to `to` means at the site, in words (empty when nothing moves). */
export function monitoringImpact(from: ScanSubject, to: ScanSubject, affected: MonitoringAffected): string[] {
  const change = monitoringChangeOf(from, to)
  if (change === 'NONE') return []
  const orders = affected.openWorkOrders > 0 ? ` ${plural(affected.openWorkOrders, 'open work order goes', 'open work orders go')} on that way.` : ''
  const lines: string[] = []
  if (change === 'NARROW') {
    lines.push(`From now on scans and cut logs at this site name the station only, never the worker.${orders}`)
    if (affected.devicesWithoutStation > 0) {
      lines.push(`${plural(affected.devicesWithoutStation, 'floor device has', 'floor devices have')} no station: give each one a station (Admin › Devices), or it records nothing.`)
    }
  } else {
    lines.push(`From now on scans and cut logs at this site name the signed-in worker.${orders}`)
    if (affected.workersNotAcknowledged > 0) {
      lines.push(`${affected.workersNotAcknowledged} of ${plural(affected.workersActive, 'active worker has', 'active workers have')} not acknowledged the information notice: no scan or cut log names them until they do (L. 300/1970 art. 4 c.3; GDPR art. 13).`)
    }
  }
  lines.push('Records already made keep what they recorded: scans and cut logs are never changed.')
  return lines
}

/** Whether the site's rules let real floor work start, and what to do first, in words. */
export interface FloorRulesStatus {
  readonly readyForFloor: boolean
  readonly notes: string[]
}

export function floorRulesStatus(input: { readonly scanSubject: ScanSubject; readonly basisOnRecord: boolean; readonly workersActive?: number; readonly workersNotAcknowledged?: number }): FloorRulesStatus {
  if (input.scanSubject === 'STATION') return { readyForFloor: true, notes: [SCAN_SUBJECT_WORDS.STATION] }
  if (!input.basisOnRecord) {
    return {
      readyForFloor: false,
      notes: [`Floor records name workers, but no legal basis is on record (${MONITORING_LAW}): record it, or name the station only, before real floor work starts.`],
    }
  }
  const notes = [SCAN_SUBJECT_WORDS.WORKER]
  const waiting = input.workersNotAcknowledged ?? 0
  if (waiting > 0) {
    notes.push(`${waiting} of ${plural(input.workersActive ?? waiting, 'active worker has', 'active workers have')} not acknowledged the information notice: they cannot scan or log cuts by name until they do.`)
  }
  return { readyForFloor: true, notes }
}

/** What a floor record at the site names, or why it cannot be written (for scans B-W1-42 and cut logs B-W1-40). */
export type FloorRecordSubject =
  | { readonly ok: true; readonly workerId: string | null; readonly stationId: string | null }
  | { readonly ok: false; readonly message: string }

/**
 * The subject of a floor record, as the …_production_guards triggers will check it: at a STATION site the device's
 * station and no worker; at a WORKER site the signed-in worker, once they acknowledged the notice (the station, when
 * the device has one, is kept as where it happened).
 */
export function floorRecordSubject(input: {
  readonly scanSubject: ScanSubject
  readonly workerId: string | null | undefined
  readonly workerAcknowledged: boolean
  readonly stationId: string | null | undefined
}): FloorRecordSubject {
  if (input.scanSubject === 'STATION') {
    if (!input.stationId) return { ok: false, message: 'This device has no station, and this site names the station on every floor record: an administrator gives the device a station first (Admin › Devices).' }
    return { ok: true, workerId: null, stationId: input.stationId }
  }
  if (!input.workerId) return { ok: false, message: 'Sign in first: this site names the signed-in worker on every scan and cut log.' }
  if (!input.workerAcknowledged) {
    return { ok: false, message: 'Read and acknowledge the information notice first: no scan or cut log names you before that (L. 300/1970 art. 4 c.3; GDPR art. 13).' }
  }
  return { ok: true, workerId: input.workerId, stationId: input.stationId ?? null }
}
