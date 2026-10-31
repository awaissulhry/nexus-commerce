import type { Issue } from '../../core/errors'
import { MONITORING_BASES, REFERENCE_MAX, isMonitoringBasis, type MonitoringBasis, type ScanSubject } from '../../production/settings/monitoring'
import type { GatePurpose } from './purposes'

/**
 * The legal gate per site and purpose (B-W2b-27; W2b plan §2 GATE-LABOUR and §12 "two purposes in one gate"; features
 * PLT-209, MES-249, MES-282; Statuto dei Lavoratori, L. 300/1970, art. 4 c.1, c.2, c.3; GDPR arts. 5, 13, 35). One gate
 * row (factory-db PeopleLegalGate) per site and purpose with no switch-off means the purpose is ON there; no row in
 * force means OFF, the safe default, and every later People read of one person's data asks the gate first.
 *
 *   ATTENDANCE   badge clock-in and attendance are a tool to record work (art. 4 c.2): no agreement, but the worker
 *                notice (c.3; GDPR art. 13) and the impact assessment (GDPR art. 35) on record; the basis kept is
 *                counsel's opinion (or an agreement if the company has one) with its reference.
 *   PERFORMANCE  one person's work figures are monitoring (art. 4 c.1): the site's recorded legal basis (Production ›
 *                Settings, B-W1-37: the RSU/RSA agreement, the Ispettorato's authorisation, or counsel's written
 *                opinion), the worker notice and the impact assessment.
 *
 * Switching on asks for a fresh code (step-up) and a reason, and records the company's worker notice in force and its
 * stored impact assessment (the DPIA record of that purpose: Admin › Privacy & notices). Switching off ends the row
 * (when, who, why) and never asks for a code: narrowing is always allowed. A gate's basis, notice and assessment never
 * change while it is on: a new basis is off, then on again (a new row). Leads may see one person's figures only where
 * the recorded basis covers leads (PERFORMANCE on an agreement or an authorisation); widening that asks for a code.
 */

export const GATE_LAW: Readonly<Record<GatePurpose, string>> = Object.freeze({
  ATTENDANCE: 'Statuto dei Lavoratori art. 4 c.2 (the notice under c.3); GDPR arts. 13, 35',
  PERFORMANCE: 'Statuto dei Lavoratori art. 4 c.1; GDPR arts. 5, 13, 35',
})

export const GATE_PURPOSE_WORDS: Readonly<Record<GatePurpose, string>> = Object.freeze({
  ATTENDANCE: 'attendance data (clock-in, attendance days, the LUL calendar)',
  PERFORMANCE: "one person's work figures (efficiency, labour records, My day)",
})

/** The bases that can cover team leads seeing one person's figures (the database's rule too). */
export const LEADS_BASES: readonly MonitoringBasis[] = Object.freeze(['UNION_AGREEMENT', 'INL_AUTHORISATION'])

export const GATE_REASON_MIN = 3
export const GATE_REASON_MAX = 500

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/** One gate row as the rules read it. */
export interface GateRow {
  readonly purpose: GatePurpose
  readonly basis: MonitoringBasis
  readonly basisCoversLeads: boolean
  readonly leadsSeeFigures: boolean
  readonly switchedOffAt: Date | string | null
}

/** A gate row with no switch-off is ON; none is OFF. */
export const gateOpen = (row: Pick<GateRow, 'switchedOffAt'> | null | undefined): boolean => row !== null && row !== undefined && row.switchedOffAt === null

/** What a closed gate answers to a read of one person's data, in words (the refusal's message). */
export function gateClosedWords(purpose: GatePurpose): string {
  return purpose === 'ATTENDANCE'
    ? 'Attendance data is switched off at this site: it opens when the worker notice and the impact assessment are on record and the Owner switches it on (Statuto dei Lavoratori art. 4 c.2-3; GDPR art. 35).'
    : "One person's work figures are switched off at this site: they open when the site's legal basis (a union agreement, the Ispettorato's authorisation or counsel's opinion), the worker notice and the impact assessment are on record and the Owner switches them on (Statuto dei Lavoratori art. 4 c.1)."
}

/** What the company and the site have on record towards switching a purpose on (read by the API, judged here). */
export interface GateFacts {
  readonly purpose: GatePurpose
  /** The company's WORKER_FLOOR notice in force (PUBLISHED), or null. */
  readonly workerNotice: { readonly id: string; readonly label: string } | null
  /** The company's STORED impact assessment, or null. */
  readonly dpia: { readonly id: string; readonly versionNo: number; readonly reviewDueOn: string | null } | null
  /** The site's legal basis in Production › Settings (B-W1-37), or null. */
  readonly siteBasis: { readonly kind: MonitoringBasis; readonly reference: string } | null
  /** Who the site's floor records name. */
  readonly scanSubject: ScanSubject
  /** Today (YYYY-MM-DD, Europe/Rome). */
  readonly today: string
}

export const MISSING_CODES = ['WORKER_NOTICE', 'DPIA', 'SITE_BASIS'] as const
export type MissingCode = (typeof MISSING_CODES)[number]

export interface GateReadiness {
  /** Every precondition is on record: the purpose may be switched on (with a step-up). */
  readonly canSwitchOn: boolean
  /** What is missing, each with what to do, in words. */
  readonly missing: { code: MissingCode; words: string }[]
  /** What is on record but worth a look (never a block). */
  readonly notes: string[]
}

export const MISSING_WORDS: Readonly<Record<MissingCode, string>> = Object.freeze({
  WORKER_NOTICE: 'Publish the worker notice first (Admin › Privacy & notices): the workers are told what is recorded and why before anything is (Statuto art. 4 c.3; GDPR art. 13).',
  DPIA: 'Store the signed impact assessment first (Admin › Privacy & notices; GDPR art. 35).',
  SITE_BASIS: "Record the site's legal basis in Production › Settings first: a union agreement, the Ispettorato's authorisation or counsel's written opinion (Statuto art. 4 c.1).",
})

/** What switching a purpose on at a site needs, and what is missing (the People settings screen's words). */
export function gateReadiness(facts: GateFacts): GateReadiness {
  const missing: { code: MissingCode; words: string }[] = []
  if (!facts.workerNotice) missing.push({ code: 'WORKER_NOTICE', words: MISSING_WORDS.WORKER_NOTICE })
  if (!facts.dpia) missing.push({ code: 'DPIA', words: MISSING_WORDS.DPIA })
  if (facts.purpose === 'PERFORMANCE' && !facts.siteBasis) missing.push({ code: 'SITE_BASIS', words: MISSING_WORDS.SITE_BASIS })
  const notes: string[] = []
  if (facts.dpia?.reviewDueOn && facts.dpia.reviewDueOn < facts.today) notes.push(`The impact assessment (version ${facts.dpia.versionNo}) was due for review on ${facts.dpia.reviewDueOn}: review it (GDPR art. 35(11)).`)
  if (facts.purpose === 'PERFORMANCE' && facts.scanSubject === 'STATION') notes.push("This site's floor records name the station only: no work figure about one person is recorded here.")
  return { canSwitchOn: missing.length === 0, missing, notes }
}

/** What the gate in force recorded against what is in force now: worth a look, never a block (an earlier decision stands). */
export function gateDriftNotes(input: {
  readonly purpose: GatePurpose
  readonly recordedNoticeId: string
  readonly recordedDpiaId: string
  readonly recordedBasis: { readonly kind: MonitoringBasis; readonly reference: string }
  readonly workerNoticeInForceId: string | null
  readonly dpiaInForceId: string | null
  readonly siteBasis: { readonly kind: MonitoringBasis; readonly reference: string } | null
}): string[] {
  const notes: string[] = []
  if (input.workerNoticeInForceId !== input.recordedNoticeId) {
    notes.push('The worker notice changed since this purpose was switched on: switch it off and on again to record the notice in force now.')
  }
  if (input.dpiaInForceId !== input.recordedDpiaId) {
    notes.push('The impact assessment changed since this purpose was switched on: check it still covers this purpose, then switch it off and on again to record it.')
  }
  if (input.purpose === 'PERFORMANCE' && (input.siteBasis?.kind !== input.recordedBasis.kind || input.siteBasis?.reference !== input.recordedBasis.reference)) {
    notes.push("The site's legal basis in Production › Settings changed since this purpose was switched on: switch it off and on again to record the basis in force.")
  }
  return notes
}

/** A switch-on as asked (the body), with what is on record. */
export interface SwitchOnInput {
  readonly facts: GateFacts
  /** ATTENDANCE only: the basis kept (counsel's opinion, or an agreement) and its reference. PERFORMANCE takes the site's. */
  readonly basis?: { readonly kind?: unknown; readonly reference?: unknown } | null | undefined
  readonly basisCoversLeads?: boolean | undefined
  readonly leadsSeeFigures?: boolean | undefined
  readonly reason?: string | null | undefined
}

/** The basis a switch-on records: the site's for PERFORMANCE, the body's for ATTENDANCE (null when not usable). */
export function basisForSwitchOn(input: SwitchOnInput): { readonly kind: MonitoringBasis; readonly reference: string } | null {
  if (input.facts.purpose === 'PERFORMANCE') return input.facts.siteBasis
  const kind = input.basis?.kind
  const reference = input.basis?.reference
  return isMonitoringBasis(kind) && typeof reference === 'string' && filled(reference) && reference.trim().length <= REFERENCE_MAX ? { kind, reference: reference.trim() } : null
}

export function reasonProblems(reason: string | null | undefined, why: string, at = 'body/reason'): Issue[] {
  if (!filled(reason) || reason.trim().length < GATE_REASON_MIN) return [{ path: at, message: why }]
  return reason.trim().length > GATE_REASON_MAX ? [{ path: at, message: `Keep the reason to ${GATE_REASON_MAX} characters.` }] : []
}

/** Everything wrong with a switch-on, in words; empty: it may go ahead (after the step-up). */
export function switchOnProblems(input: SwitchOnInput): Issue[] {
  const { facts } = input
  const problems: Issue[] = []
  for (const missing of gateReadiness(facts).missing) {
    problems.push({ path: missing.code === 'SITE_BASIS' ? 'site/legalBasis' : missing.code === 'DPIA' ? 'company/dpia' : 'company/workerNotice', message: missing.words })
  }
  if (facts.purpose === 'ATTENDANCE') {
    const kind = input.basis?.kind
    const reference = input.basis?.reference
    if (!isMonitoringBasis(kind)) {
      problems.push({ path: 'body/basis/kind', message: `Choose the basis kept for attendance (${MONITORING_BASES.join(', ')}): usually counsel's written opinion that clock-in is a tool to record work (art. 4 c.2), or an agreement if the company has one.` })
    }
    if (typeof reference !== 'string' || !filled(reference)) {
      problems.push({ path: 'body/basis/reference', message: "Give the reference: the opinion's author and date, or the agreement's number and date." })
    } else if (reference.trim().length > REFERENCE_MAX) {
      problems.push({ path: 'body/basis/reference', message: `Keep the reference to ${REFERENCE_MAX} characters; the document itself belongs in the files.` })
    }
    if (input.basisCoversLeads) problems.push({ path: 'body/basisCoversLeads', message: "Leads see one person's figures only under the PERFORMANCE purpose; attendance has no such choice here." })
  } else if (input.basis !== undefined && input.basis !== null) {
    problems.push({ path: 'body/basis', message: "One person's work figures take the site's legal basis from Production › Settings; record or replace it there." })
  }
  const basis = basisForSwitchOn(input)
  if (input.basisCoversLeads && facts.purpose === 'PERFORMANCE' && basis && !LEADS_BASES.includes(basis.kind)) {
    problems.push({ path: 'body/basisCoversLeads', message: "Counsel's opinion does not cover leads: only an agreement with the RSU or RSA, or the Ispettorato's authorisation, can let leads see one person's figures." })
  }
  if (input.leadsSeeFigures && !input.basisCoversLeads) problems.push({ path: 'body/leadsSeeFigures', message: "Leads see one person's figures only where the recorded basis covers leads." })
  problems.push(...reasonProblems(input.reason, 'Say why this purpose opens at this site (kept in the audit log).'))
  return problems
}

/** Everything wrong with a switch-off (a reason; the database requires one too). */
export const switchOffProblems = (reason: string | null | undefined): Issue[] => reasonProblems(reason, 'Say why this purpose closes at this site (kept with the decision).')

export type LeadsChange = 'WIDEN' | 'NARROW' | 'NONE'

export const leadsChangeOf = (from: boolean, to: boolean): LeadsChange => (from === to ? 'NONE' : to ? 'WIDEN' : 'NARROW')

/** Everything wrong with letting leads see one person's figures, or no longer (narrowing never asks). */
export function leadsChangeProblems(input: { readonly gate: GateRow | null; readonly leadsSeeFigures: boolean; readonly reason?: string | null | undefined }): Issue[] {
  if (!gateOpen(input.gate)) return [{ path: 'gate', message: 'This purpose is switched off at this site: there is nothing for leads to see.' }]
  const gate = input.gate as GateRow
  const problems: Issue[] = []
  if (input.leadsSeeFigures && !gate.basisCoversLeads) {
    problems.push({ path: 'body/leadsSeeFigures', message: "The basis recorded for this purpose does not cover leads: leads see one person's figures only under an agreement or an authorisation that says so (switch off and on again with it)." })
  }
  if (leadsChangeOf(gate.leadsSeeFigures, input.leadsSeeFigures) === 'WIDEN') problems.push(...reasonProblems(input.reason, "Say why leads may see one person's figures at this site."))
  return problems
}
