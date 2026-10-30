import type { Issue } from '../../core/errors'
import type { WorkOrderStatus } from '../../production/work-orders/machine'

/**
 * Quality holds (B-W2a-26; QHS-074 place a hold, MES-008 hold and release a work order or a bundle; design quality.holds
 * qh-place, qh-release, production.workorders wo-hold), pure. apps/factory-api's modules/quality/holds says these rules
 * in words before the database's guards (…_quality_plant_w2a_guards QualityHold_guard and the "…_awaits_quality_hold"
 * triggers; …_production_w2a_guards the work order's gate) would refuse the same:
 *
 *   place    one kind of record (a lot, hide, work order, bundle, garment serial, shipment or parcel), one or more of
 *            them, each named once, all of one site and each in a state a hold can hold; a reason of the HOLD reason
 *            list (its note when the reason asks for one); the record that caused it as a type and an id, or neither
 *            (placed by hand); an owner and an expected release date (today or later); the move to quarantine asked
 *            only for stock (lots, hides), to a QUARANTINE place of the site. A work order that is DRAFT, RELEASED or
 *            IN_PROGRESS also goes ON_HOLD (held from that status, with the reason: the floor refuses its work and says
 *            why); one already ON_HOLD stays so; a COMPLETED one keeps its status (its garments are held).
 *   blocks   what each kind blocks while the hold is ACTIVE (BLOCKS): the database's triggers, in words.
 *   release  ACTIVE; by someone other than who placed it (design: "You placed this hold - another person must release
 *            it"; a setting in the design, with no column yet: always on); for held garments (a work order, its bundles
 *            or serials) by someone who made none of them, or who signs that they did not where the floor records do
 *            not name every maker; the conditions of its source met (a Cr VI result PASS for a lab hold, a passed
 *            inspection after the hold for an inspection's hold). A work order goes back to the status it was held from
 *            once no ACTIVE hold names it.
 */

export const HOLD_SUBJECT_TYPES = ['Lot', 'Hide', 'WorkOrder', 'Bundle', 'GarmentSerial', 'Shipment', 'Parcel'] as const
export type HoldSubjectType = (typeof HOLD_SUBJECT_TYPES)[number]

/** The records a hold may come from (both a type and an id, or neither: placed by hand). */
export const HOLD_SOURCE_TYPES = ['Inspection', 'Nonconformance', 'LabResult', 'Certificate', 'QualityReleaseReversal', 'Complaint'] as const
export type HoldSourceType = (typeof HOLD_SOURCE_TYPES)[number]

export const HOLD_STATUSES = ['ACTIVE', 'RELEASED', 'CLOSED'] as const
export type HoldStatus = (typeof HOLD_STATUSES)[number]

export const HOLD_QUARANTINE = ['NOT_NEEDED', 'ASKED', 'MOVED'] as const
export type HoldQuarantine = (typeof HOLD_QUARANTINE)[number]

export const HOLD_LIMITS = Object.freeze({ subjects: 100, note: 2000, reasonNote: 500, holdReason: 200 })

/** The kinds whose stock can be moved to quarantine. */
export const STOCK_SUBJECTS: readonly HoldSubjectType[] = Object.freeze(['Lot', 'Hide'])

/** The kinds of garments a maker check applies to (the database's factory_quality_check_not_maker). */
export const GARMENT_SUBJECTS: readonly HoldSubjectType[] = Object.freeze(['WorkOrder', 'Bundle', 'GarmentSerial'])

const NOUNS: Readonly<Record<HoldSubjectType, readonly [string, string]>> = Object.freeze({
  Lot: ['lot', 'lots'],
  Hide: ['hide', 'hides'],
  WorkOrder: ['work order', 'work orders'],
  Bundle: ['bundle', 'bundles'],
  GarmentSerial: ['garment', 'garments'],
  Shipment: ['shipment', 'shipments'],
  Parcel: ['parcel', 'parcels'],
})
export const subjectNoun = (type: HoldSubjectType, count: number): string => NOUNS[type][count === 1 ? 0 : 1]

/** What a hold of each kind blocks while it is ACTIVE (the database's "…_awaits_quality_hold" triggers). */
export const BLOCKS: Readonly<Record<HoldSubjectType, string>> = Object.freeze({
  Lot: 'issuing and cutting',
  Hide: 'issuing and cutting',
  WorkOrder: 'issuing, cutting, scanning, releasing, packing and shipping',
  Bundle: 'scanning',
  GarmentSerial: 'releasing, packing and shipping',
  Shipment: 'packing and shipping',
  Parcel: 'packing and shipping',
})

/** The preview of the place dialog: "Blocks issuing and cutting of 3 lots (412.0000 DM2)." */
export function holdPreviewWords(type: HoldSubjectType, count: number, quantity: string | null): string {
  return `Blocks ${BLOCKS[type]} of ${count} ${subjectNoun(type, count)}${quantity ? ` (${quantity})` : ''}.`
}

// ---- placing -----------------------------------------------------------------------------------------------------------

/** What a work order's status does when a hold names it. */
export type WorkOrderHoldMove = 'HOLD' | 'ALREADY' | 'KEEP' | 'REFUSED'
export const WORK_ORDER_HOLDABLE: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS'])

export function workOrderHoldMove(status: WorkOrderStatus): WorkOrderHoldMove {
  if (WORK_ORDER_HOLDABLE.includes(status)) return 'HOLD'
  if (status === 'ON_HOLD') return 'ALREADY'
  if (status === 'COMPLETED') return 'KEEP'
  return 'REFUSED'
}

/** A record of a hold's kind, as the place command reads it. */
export interface SubjectFact {
  readonly id: string
  /** Its code or number ("SEED-LOT-LEA-01", "WO-0142", a serial). */
  readonly label: string
  readonly siteId: string
  /** The state the guard reads: a lot's quality status, a hide's state, a work order's status, a bundle's, a serial's, a shipment's (a parcel: its shipment's). */
  readonly state: string
}

/** Why a record cannot be held now (the guard's states), or null. */
export function unholdableWords(type: HoldSubjectType, subject: Pick<SubjectFact, 'label' | 'state'>): string | null {
  const { label, state } = subject
  switch (type) {
    case 'Lot':
      return state === 'REJECTED' ? `Lot ${label} is rejected: it goes back to the supplier or is scrapped, and is never used.` : null
    case 'Hide':
      return state === 'CONSUMED' || state === 'SCRAPPED' ? `Hide ${label} is ${state === 'CONSUMED' ? 'used up' : 'scrapped'}: there is nothing of it left to hold.` : null
    case 'WorkOrder':
      return state === 'CLOSED' || state === 'CANCELLED' ? `Work order ${label} is ${state}: hold its garments (serials, shipments) instead.` : null
    case 'Bundle':
      return state !== 'ACTIVE' ? `Bundle ${label} is ${state}: only an active bundle is held.` : null
    case 'GarmentSerial':
      return state !== 'MADE' && state !== 'RELEASED' ? `Garment ${label} is ${state}: what has left is the PPE register's (a recall), not a hold's.` : null
    case 'Shipment':
    case 'Parcel':
      return state !== 'DRAFT' && state !== 'PACKED' ? `${type === 'Shipment' ? 'Shipment' : 'The parcel of shipment'} ${label} is ${state}: what has left is the PPE register's (a recall), not a hold's.` : null
  }
}

export interface PlaceDraft {
  readonly subjectType: HoldSubjectType
  readonly subjectIds: readonly string[]
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly sourceType?: string | null | undefined
  readonly sourceId?: string | null | undefined
  readonly expectedReleaseOn?: string | null | undefined
  readonly askQuarantine?: boolean | undefined
  readonly note?: string | null | undefined
}

/** The body's own rules (the records, the reason list and the place are the command's). `today`: the site's date. */
export function placeProblems(draft: PlaceDraft, today: string): Issue[] {
  const problems: Issue[] = []
  if (draft.subjectIds.length === 0) problems.push({ path: 'subjectIds', message: `Name what to hold: one or more ${subjectNoun(draft.subjectType, 2)}.` })
  else if (draft.subjectIds.length > HOLD_LIMITS.subjects) problems.push({ path: 'subjectIds', message: `At most ${HOLD_LIMITS.subjects} records in one hold.` })
  else if (new Set(draft.subjectIds).size !== draft.subjectIds.length) problems.push({ path: 'subjectIds', message: 'Name each record once.' })
  if (((draft.sourceType ?? null) === null) !== ((draft.sourceId ?? null) === null)) problems.push({ path: 'sourceType', message: 'Name the record that caused the hold as a type and an id, or neither.' })
  else if (draft.sourceType && !(HOLD_SOURCE_TYPES as readonly string[]).includes(draft.sourceType)) problems.push({ path: 'sourceType', message: 'A hold comes from an inspection, an NCR, a lab result, a certificate, a reversed release or a complaint.' })
  if (draft.expectedReleaseOn && draft.expectedReleaseOn < today) problems.push({ path: 'expectedReleaseOn', message: 'The expected release is today or later.' })
  if (draft.askQuarantine && !STOCK_SUBJECTS.includes(draft.subjectType)) problems.push({ path: 'askQuarantine', message: 'Only stock (lots, hides) moves to quarantine; a work order, a bundle, garments and shipments stay where they are.' })
  if ((draft.reasonNote ?? '').length > HOLD_LIMITS.reasonNote) problems.push({ path: 'reasonNote', message: `At most ${HOLD_LIMITS.reasonNote} characters.` })
  if ((draft.note ?? '').length > HOLD_LIMITS.note) problems.push({ path: 'note', message: `At most ${HOLD_LIMITS.note} characters.` })
  return problems
}

/** The reason a held work order shows on the floor (WorkOrder.holdReason): the reason's words and the note. */
export function workOrderHoldReason(reasonWords: string, note: string | null | undefined): string {
  const text = note?.trim() ? `${reasonWords}: ${note.trim()}` : reasonWords
  return text.length > HOLD_LIMITS.holdReason ? `${text.slice(0, HOLD_LIMITS.holdReason - 1)}…` : text
}

// ---- what a hold blocks, in words (the hooks of scans, issue and packing) ----------------------------------------------

/** "since 21 Nov 2026" (the hold's day, UTC). */
const dayOf = (iso: string): string => {
  const date = new Date(iso)
  return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** An ACTIVE hold of a record, as the hooks read it. */
export interface BlockingHold {
  readonly holdId: string
  readonly subjectType: HoldSubjectType
  /** The held record's code or number. */
  readonly label: string
  /** The reason's words (else its code). */
  readonly reason: string
  readonly placedAt: string
}

/** "Lot LEA-01 is on hold (Quality check, since 21 Nov 2026): it is not issued until quality releases the hold." */
export function blockedWords(hold: BlockingHold, what: string): string {
  const noun = subjectNoun(hold.subjectType, 1)
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${hold.label} is on hold (${hold.reason}, since ${dayOf(hold.placedAt)}): ${what} until quality releases the hold.`
}

/** A work order ON_HOLD (wave 5's columns): "Work order WO-0142 is on hold (Quality check: …): …". */
export function workOrderOnHoldWords(number: string, holdReason: string | null, what: string): string {
  return `Work order ${number} is on hold${holdReason ? ` (${holdReason})` : ''}: ${what} until the hold is lifted.`
}

// ---- releasing ---------------------------------------------------------------------------------------------------------

export const RELEASE_CHECKS = ['ACTIVE', 'NOT_PLACER', 'NOT_MAKER', 'STATEMENT', 'CR_VI', 'REINSPECTION'] as const
export type ReleaseCheckKey = (typeof RELEASE_CHECKS)[number]

/** One line of the release's GateExplainer: ✓ / ✕ and its words. */
export interface ReleaseCheck {
  readonly key: ReleaseCheckKey
  readonly ok: boolean
  readonly words: string
}

export interface ReleaseFacts {
  readonly status: HoldStatus
  readonly subjectType: HoldSubjectType
  /** The releaser is (or is linked to) the person who placed the hold. */
  readonly placedByReleaser: boolean
  /** Held garments only: the work orders whose garments the releaser made (their numbers). */
  readonly madeBy: readonly string[] | null
  /** Held garments only: the floor records of some held work order do not name every maker (the site records the station). */
  readonly makersUnnamed: boolean
  readonly notMakerStatement: boolean
  /** A lab hold: the lots whose Cr VI result is not PASS now, with what it is ("LEA-01 PENDING"). */
  readonly crViOpen: readonly string[] | null
  /** An inspection's hold: the work orders with no inspection PASSED after the hold. */
  readonly reinspectionOpen: readonly string[] | null
}

/** What must be true to release, each line in words (design qh-release GateExplainer and its four-eyes lines). */
export function releaseChecks(facts: ReleaseFacts): ReleaseCheck[] {
  const checks: ReleaseCheck[] = [
    { key: 'ACTIVE', ok: facts.status === 'ACTIVE', words: facts.status === 'ACTIVE' ? 'The hold is active.' : `The hold is ${facts.status.toLowerCase()} already.` },
    {
      key: 'NOT_PLACER',
      ok: !facts.placedByReleaser,
      words: facts.placedByReleaser ? 'You placed this hold - another person must release it.' : 'Released by someone other than the person who placed it.',
    },
  ]
  if (facts.madeBy !== null) {
    checks.push({
      key: 'NOT_MAKER',
      ok: facts.madeBy.length === 0,
      words:
        facts.madeBy.length === 0
          ? 'You made none of the held garments (the floor records).'
          : `You made garments of work order ${facts.madeBy.join(', ')}: another person, who made none of them, releases the hold.`,
    })
    if (facts.makersUnnamed) {
      checks.push({
        key: 'STATEMENT',
        ok: facts.notMakerStatement,
        words: facts.notMakerStatement ? 'You signed that you made none of the held garments.' : 'The floor records name the station only: sign that you made none of the held garments.',
      })
    }
  }
  if (facts.crViOpen !== null) {
    checks.push({ key: 'CR_VI', ok: facts.crViOpen.length === 0, words: facts.crViOpen.length === 0 ? 'Cr VI result PASS.' : `Cr VI result PASS (now: ${facts.crViOpen.join(', ')}).` })
  }
  if (facts.reinspectionOpen !== null) {
    checks.push({
      key: 'REINSPECTION',
      ok: facts.reinspectionOpen.length === 0,
      words: facts.reinspectionOpen.length === 0 ? 'Re-inspection signed (passed after the hold).' : `Re-inspection signed (now: missing for ${facts.reinspectionOpen.join(', ')}).`,
    })
  }
  return checks
}

export const releasable = (checks: readonly ReleaseCheck[]): boolean => checks.every((check) => check.ok)

/** The first check that holds the release, as the refusal's words. */
export const releaseRefusal = (checks: readonly ReleaseCheck[]): ReleaseCheck | null => checks.find((check) => !check.ok) ?? null

/** What the releaser signs (its SHA-256 is QualityHold.releaseSignatureSha256): the hold, the goods, who, when, the checks. */
export function releaseStatement(input: {
  readonly holdId: string
  readonly subjectType: HoldSubjectType
  readonly subjectIds: readonly string[]
  readonly releasedBy: string
  readonly releasedAt: string
  readonly checks: readonly ReleaseCheck[]
  readonly note: string | null
}): string {
  return [
    `Release of quality hold ${input.holdId}`,
    `${input.subjectType}: ${[...input.subjectIds].sort().join(', ')}`,
    `By ${input.releasedBy} at ${input.releasedAt}`,
    ...input.checks.map((check) => `${check.ok ? 'OK' : 'NOT OK'} ${check.key}: ${check.words}`),
    `Note: ${input.note ?? '-'}`,
  ].join('\n')
}

// ---- the list ----------------------------------------------------------------------------------------------------------

/** Whole days a hold has been placed (a released or closed hold: until it ended). */
export function ageDays(placedAt: string, endedAt: string | null, now: string): number {
  return Math.max(0, Math.floor((Date.parse(endedAt ?? now) - Date.parse(placedAt)) / 86_400_000))
}

/** An ACTIVE hold past its expected release date (`today`: the site's date). */
export const isOverdue = (hold: { readonly status: HoldStatus; readonly expectedReleaseOn: string | null }, today: string): boolean =>
  hold.status === 'ACTIVE' && hold.expectedReleaseOn !== null && hold.expectedReleaseOn < today

export type PlacedByKind = 'USER' | 'WORKER' | 'SYSTEM'
export const placedByKind = (hold: { readonly placedById: string | null; readonly placedByWorkerId: string | null }): PlacedByKind =>
  hold.placedById ? 'USER' : hold.placedByWorkerId ? 'WORKER' : 'SYSTEM'
