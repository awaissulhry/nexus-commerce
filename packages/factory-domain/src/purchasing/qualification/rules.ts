import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { cleanNote } from '../../parties/rules'
import { ITEM_KINDS, type ItemKind } from '../../product/materials/rules'
import { WORK_CENTRE_KINDS, type WorkCentreKind } from '../../product/routing/operations'
import { dayWords } from './vault'

/**
 * Supplier and subcontractor qualification (B-W2b-315; SCM-027, PLN-162; the table is B-W2b-287's SupplierQualification;
 * design purchasing.suppliers › Documents & qualification › Workshop profile), pure. What a supplier or a workshop is
 * qualified for, by one company: kinds of work (the work centre kind an operation needs: SEWING, FINISHING …) and
 * particular operations of the library ("armour pockets") for a workshop; kinds of material (LEATHER, PROTECTOR …) for a
 * supplier. It rests on evidence: the accepted questionnaire (B-W2b-172) and the documents it put in force, accepted
 * documents from the portal (B-W2b-189), an audit or visit report.
 *
 *   PENDING → APPROVED | CONDITIONAL (with its conditions) | REFUSED (why) | WITHDRAWN;
 *   APPROVED | CONDITIONAL ⇄ SUSPENDED (why: "the DURC expired"); any but REFUSED → WITHDRAWN (why). Scope, days and
 *   evidence change only while PENDING; a decision is made once (a new scope is a new qualification).
 *
 * Planning reads it (`qualificationFor`): qualified now = APPROVED or CONDITIONAL, in its days, its scope naming the work or
 * the material, and no document it rests on expired; the others with the reason, in words (B-W2b-321 / -338 offer only
 * qualified workshops).
 */

export const QUALIFICATION_STATUSES = ['PENDING', 'APPROVED', 'CONDITIONAL', 'REFUSED', 'SUSPENDED', 'WITHDRAWN'] as const
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number]

export const QUALIFICATION_LIMITS = Object.freeze({ operations: 100, evidence: 50, words: 2000 })

export const EVIDENCE_TYPES = ['SupplierQuestionnaireResponse', 'SupplierDocumentUpload', 'StoredFile'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]
export interface Evidence {
  readonly recordType: EvidenceType
  readonly recordId: string
}

export interface Scope {
  readonly workCentreKinds: readonly WorkCentreKind[]
  readonly operationIds: readonly string[]
  readonly materialKinds: readonly ItemKind[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const once = <T>(list: readonly T[]): boolean => new Set(list).size === list.length

/** The scope as it is written (enum order, each once), or its problems; a workshop scope needs the SUBCONTRACTOR role, a material one SUPPLIER. */
export function planScope(scope: Scope, roles: readonly string[]): { readonly ok: true; readonly scope: Scope } | { readonly ok: false; readonly issues: Issue[] } {
  const issues: Issue[] = []
  if (scope.workCentreKinds.some((kind) => !(WORK_CENTRE_KINDS as readonly string[]).includes(kind)) || !once(scope.workCentreKinds)) issues.push({ path: 'body/workCentreKinds', message: 'Kinds of work, each once.' })
  if (scope.materialKinds.some((kind) => !(ITEM_KINDS as readonly string[]).includes(kind)) || !once(scope.materialKinds)) issues.push({ path: 'body/materialKinds', message: 'Kinds of material, each once.' })
  if (scope.operationIds.some((id) => !UUID.test(id)) || !once(scope.operationIds) || scope.operationIds.length > QUALIFICATION_LIMITS.operations) issues.push({ path: 'body/operationIds', message: `Operations of the library, each once, at most ${QUALIFICATION_LIMITS.operations}.` })
  if (scope.workCentreKinds.length + scope.operationIds.length + scope.materialKinds.length === 0) issues.push({ path: 'body/workCentreKinds', message: 'Say what it is qualified for: kinds of work, operations or kinds of material.' })
  if ((scope.workCentreKinds.length > 0 || scope.operationIds.length > 0) && !roles.includes('SUBCONTRACTOR')) issues.push({ path: 'body/workCentreKinds', message: 'Work and operations qualify a workshop: the party needs the subcontractor role.' })
  if (scope.materialKinds.length > 0 && !roles.includes('SUPPLIER')) issues.push({ path: 'body/materialKinds', message: 'Kinds of material qualify a supplier: the party needs the supplier role.' })
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    scope: {
      workCentreKinds: WORK_CENTRE_KINDS.filter((kind) => scope.workCentreKinds.includes(kind)),
      operationIds: [...scope.operationIds].map((id) => id.toLowerCase()),
      materialKinds: ITEM_KINDS.filter((kind) => scope.materialKinds.includes(kind)),
    },
  }
}

/** The evidence as written (each once, at most 50), or its problem. */
export function evidenceProblem(evidence: readonly Evidence[]): Issue | null {
  if (evidence.length > QUALIFICATION_LIMITS.evidence) return { path: 'body/evidence', message: `At most ${QUALIFICATION_LIMITS.evidence} pieces of evidence.` }
  const keys = evidence.map((entry) => `${entry.recordType}:${entry.recordId.toLowerCase()}`)
  if (!once(keys)) return { path: 'body/evidence', message: 'Name each piece of evidence once.' }
  if (evidence.some((entry) => !(EVIDENCE_TYPES as readonly string[]).includes(entry.recordType) || !UUID.test(entry.recordId))) return { path: 'body/evidence', message: 'Evidence is an accepted questionnaire, an accepted document or a file of the supplier.' }
  return null
}

export function daysProblem(validFrom: BusinessDate | null, validUntil: BusinessDate | null): Issue | null {
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) return { path: 'body/validUntil', message: 'It cannot end before it starts.' }
  return null
}

export const DECISIONS = ['APPROVED', 'CONDITIONAL', 'REFUSED'] as const
export type Decision = (typeof DECISIONS)[number]

/** Words trimmed (lines kept), or null when blank; their length is the caller's check (at most 2000). */
export const wordsOf = (value: string | null | undefined): string | null => cleanNote(value ?? null)

/** A reason of 1 to 2000 characters (suspend, withdraw), or its problem. */
export function reasonOf(value: string | null | undefined, what: string): { readonly reason: string } | { readonly issue: Issue } {
  const reason = wordsOf(value)
  if (reason === null || reason.length > QUALIFICATION_LIMITS.words) return { issue: { path: 'body/reason', message: `${what}, in 1 to ${QUALIFICATION_LIMITS.words} characters.` } }
  return { reason }
}

/** What stands against a decision now: PENDING only; APPROVED and CONDITIONAL need the first day and evidence; CONDITIONAL its conditions, REFUSED why. */
export function decisionProblems(input: { readonly status: QualificationStatus; readonly decision: Decision; readonly validFrom: BusinessDate | null; readonly evidence: readonly Evidence[]; readonly conditions: string | null; readonly refuseReason: string | null }): Issue[] {
  if (input.status !== 'PENDING') return [{ path: 'status', message: `It was decided already (${input.status.toLowerCase()}): a new scope is a new qualification.` }]
  const issues: Issue[] = []
  if (input.decision !== 'REFUSED') {
    if (input.validFrom === null) issues.push({ path: 'body/validFrom', message: 'The first day it holds.' })
    if (input.evidence.length === 0) issues.push({ path: 'body/evidence', message: 'What it rests on: the accepted questionnaire, an accepted document or a visit report.' })
  }
  const tooLong = (words: string | null) => words !== null && words.length > QUALIFICATION_LIMITS.words
  if (input.decision === 'CONDITIONAL' && (input.conditions === null || tooLong(input.conditions))) issues.push({ path: 'body/conditions', message: `The conditions, in 1 to ${QUALIFICATION_LIMITS.words} characters.` })
  if (input.decision === 'REFUSED' && (input.refuseReason === null || tooLong(input.refuseReason))) issues.push({ path: 'body/refuseReason', message: `Why not, in 1 to ${QUALIFICATION_LIMITS.words} characters.` })
  return issues
}

export const MOVES = Object.freeze({
  suspend: ['APPROVED', 'CONDITIONAL'] as readonly QualificationStatus[],
  lift: ['SUSPENDED'] as readonly QualificationStatus[],
  withdraw: ['PENDING', 'APPROVED', 'CONDITIONAL', 'SUSPENDED'] as readonly QualificationStatus[],
  change: ['PENDING'] as readonly QualificationStatus[],
})

export const MOVE_REFUSALS = Object.freeze({
  suspend: 'Only an approved qualification is suspended.',
  lift: 'Only a suspended qualification is lifted.',
  withdraw: 'A refused or withdrawn qualification is final.',
  change: 'Scope, days and evidence change only while it is pending: a new scope is a new qualification.',
})

/** What a planner or a buyer asks: a kind of work, an operation of the library, a kind of material. */
export interface Need {
  readonly workCentreKind?: WorkCentreKind | null | undefined
  readonly operationId?: string | null | undefined
  readonly materialKind?: ItemKind | null | undefined
}

export interface QualificationFacts {
  readonly id: string
  readonly status: QualificationStatus
  readonly scope: Scope
  readonly validFrom: BusinessDate | null
  readonly validUntil: BusinessDate | null
  readonly conditions: string | null
  readonly suspendReason: string | null
  readonly refuseReason: string | null
  /** The earliest last day among the documents it rests on that has passed (null: none expired). */
  readonly evidenceExpiredOn: BusinessDate | null
}

export const STANDINGS = ['QUALIFIED', 'CONDITIONAL', 'NOT_YET', 'EXPIRED', 'EVIDENCE_EXPIRED', 'SUSPENDED', 'PENDING', 'REFUSED', 'NONE'] as const
export type Standing = (typeof STANDINGS)[number]

export const covers = (scope: Scope, need: Need): boolean =>
  (need.workCentreKind != null && scope.workCentreKinds.includes(need.workCentreKind)) ||
  (need.operationId != null && scope.operationIds.includes(need.operationId.toLowerCase())) ||
  (need.materialKind != null && scope.materialKinds.includes(need.materialKind))

/** One qualification's standing on a day, with why, in words. */
export function standingOf(row: QualificationFacts, today: BusinessDate): { readonly standing: Standing; readonly words: string } {
  switch (row.status) {
    case 'APPROVED':
    case 'CONDITIONAL': {
      if (row.validFrom !== null && row.validFrom > today) return { standing: 'NOT_YET', words: `Qualified from ${dayWords(row.validFrom)}.` }
      if (row.validUntil !== null && row.validUntil < today) return { standing: 'EXPIRED', words: `The qualification ended on ${dayWords(row.validUntil)}.` }
      if (row.evidenceExpiredOn !== null) return { standing: 'EVIDENCE_EXPIRED', words: `A document it rests on expired on ${dayWords(row.evidenceExpiredOn)}: no valid evidence.` }
      return row.status === 'CONDITIONAL' ? { standing: 'CONDITIONAL', words: `Qualified with conditions: ${row.conditions ?? ''}`.trim() } : { standing: 'QUALIFIED', words: row.validUntil ? `Qualified until ${dayWords(row.validUntil)}.` : 'Qualified.' }
    }
    case 'SUSPENDED':
      return { standing: 'SUSPENDED', words: `Suspended: ${row.suspendReason ?? ''}`.trim() }
    case 'PENDING':
      return { standing: 'PENDING', words: 'Being reviewed: not qualified yet.' }
    case 'REFUSED':
      return { standing: 'REFUSED', words: `Not qualified: ${row.refuseReason ?? ''}`.trim() }
    default:
      return { standing: 'NONE', words: 'Withdrawn.' }
  }
}

const RANK: Readonly<Record<Standing, number>> = Object.freeze({ QUALIFIED: 0, CONDITIONAL: 1, NOT_YET: 2, EVIDENCE_EXPIRED: 3, EXPIRED: 4, SUSPENDED: 5, PENDING: 6, REFUSED: 7, NONE: 8 })

/**
 * Whether a supplier or workshop is qualified for a need on a day (planning's question, PLN-162): the best standing among
 * its qualifications whose scope covers the need; NONE when none does. `qualified` is true for QUALIFIED and CONDITIONAL.
 */
export function qualificationFor(rows: readonly QualificationFacts[], need: Need, today: BusinessDate): { readonly qualified: boolean; readonly standing: Standing; readonly qualificationId: string | null; readonly words: string } {
  const answers = rows.filter((row) => covers(row.scope, need)).map((row) => ({ row, ...standingOf(row, today) }))
  const best = answers.sort((a, b) => RANK[a.standing] - RANK[b.standing] || (a.row.id < b.row.id ? -1 : 1))[0]
  if (!best) return { qualified: false, standing: 'NONE', qualificationId: null, words: 'Not qualified for this work: no qualification covers it.' }
  return { qualified: best.standing === 'QUALIFIED' || best.standing === 'CONDITIONAL', standing: best.standing, qualificationId: best.row.id, words: best.words }
}
