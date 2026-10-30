import { isBusinessDate, type BusinessDate } from '../../core/time'
import { defineMachine } from '../../state/machine'
import { daysBetween } from '../certificates/rules'

/**
 * Changes to an approved type (B-W2a-66; PRD-285, QHS-104; Reg. (EU) 2016/425 Annex V 7.2: the manufacturer tells the
 * notified body of every change to the approved type that may affect conformity, and the notified body decides whether
 * it needs a new examination or an addition to the certificate), pure.
 *
 *   found     when a style revision is RELEASED, its BOM is compared with the approved type of each certificate covering
 *             the style: the outer leather, the leather's thickness, the protector model, the seams (their thread) and
 *             the lining. Anything that differs opens ONE review per revision and certificate (TypeChangeReview, OPEN).
 *             The approved type is the revision released before, unless that one still waits for (or was refused) an
 *             answer: then the type that review was compared with. A style's first release compares with nothing: the
 *             first revision IS the examined type ("first order changes nothing").
 *   decided   OPEN → NOTIFIED (the notified body was told; a fact typed in, nothing is sent) or NOT_NEEDED (compliance
 *             decides, with its reason, the change does not touch the approved type); NOTIFIED → APPROVED (an addition
 *             to the certificate) or REFUSED (a new examination is needed), with the answer's day, reference and file.
 *   held      while a revision has a review for the certificate that covers a garment which is OPEN, NOTIFIED or
 *             REFUSED, that revision's garments print no class label (the label gate, B-W1-19's garment label).
 *
 * What counts as relevant, and what the notified body must be told, is the notified body's and the maker's call: the
 * kinds below only find candidates; NOT_NEEDED is the person's decision with its reason.
 */

export const CHANGE_KINDS = ['OUTER_LEATHER', 'THICKNESS', 'PROTECTOR', 'SEAMS', 'LINING', 'OTHER'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export const REVIEW_STATUSES = ['OPEN', 'NOTIFIED', 'APPROVED', 'REFUSED', 'NOT_NEEDED'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** The same moves the …_supply_w2a_guards trigger allows. */
export const reviewMachine = defineMachine<ReviewStatus>({
  name: 'type-change review',
  states: REVIEW_STATUSES,
  transitions: { OPEN: ['NOTIFIED', 'NOT_NEEDED'], NOTIFIED: ['APPROVED', 'REFUSED'] },
})

/** A review in one of these holds the revision's class label (the answer is not recorded, or it was a refusal). */
export const HOLDING_STATUSES = ['OPEN', 'NOTIFIED', 'REFUSED'] as const satisfies readonly ReviewStatus[]
export const holdsLabel = (status: string): boolean => (HOLDING_STATUSES as readonly string[]).includes(status)
/** Still waiting: for a decision (OPEN) or for the notified body's answer (NOTIFIED). */
export const WAITING_STATUSES = ['OPEN', 'NOTIFIED'] as const satisfies readonly ReviewStatus[]
export const isWaiting = (status: string): boolean => (WAITING_STATUSES as readonly string[]).includes(status)

export const NOTE_MAX = 1000
export const REFERENCE_MAX = 100

// ---- what changed --------------------------------------------------------------------------------------------------------------

/** A material of a BOM line, as the comparison reads it (Item: kind, the PPE component flag, the thickness range). */
export interface TypeMaterial {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly isPpeComponent: boolean
  /** Decimal strings in millimetres, or null. */
  readonly thicknessMinMm: string | null
  readonly thicknessMaxMm: string | null
}

export interface TypeLine {
  readonly id: string
  readonly itemId: string
  readonly placement: string | null
}

/** One revision's BOM as the comparison reads it. */
export interface TypeSnapshot {
  readonly lines: readonly TypeLine[]
  readonly materials: Readonly<Record<string, TypeMaterial | undefined>>
}

/** One change, as TypeChangeReview.changes stores it. */
export interface TypeChange {
  readonly kind: ChangeKind
  /** In English (stored data; the screens say the kind in their own words). */
  readonly what: string
  readonly before: string
  readonly after: string
  /** A line of the new revision that carries it, when one does. */
  readonly bomLineId: string | null
}

/** The kind of change a material stands for, or null when the approved type does not depend on it here. */
export function kindOfMaterial(material: Pick<TypeMaterial, 'kind' | 'isPpeComponent'>): Exclude<ChangeKind, 'THICKNESS' | 'OTHER'> | null {
  if (material.kind === 'LEATHER') return 'OUTER_LEATHER'
  if (material.kind === 'LINING') return 'LINING'
  if (material.kind === 'PROTECTOR' || material.isPpeComponent) return 'PROTECTOR'
  if (material.kind === 'THREAD') return 'SEAMS'
  return null
}

const WHAT: Readonly<Record<ChangeKind, string>> = Object.freeze({
  OUTER_LEATHER: 'Outer leather',
  THICKNESS: 'Leather thickness',
  PROTECTOR: 'Protector model',
  SEAMS: 'Seams (thread)',
  LINING: 'Lining',
  OTHER: 'Other construction',
})

/** "1.1–1.3 mm", "1.1 mm", or null. */
export function thicknessText(material: Pick<TypeMaterial, 'thicknessMinMm' | 'thicknessMaxMm'>): string | null {
  const show = (value: string | null) => (value === null ? null : String(Number(value)))
  const min = show(material.thicknessMinMm)
  const max = show(material.thicknessMaxMm)
  if (min === null && max === null) return null
  if (min === null || max === null || min === max) return `${min ?? max} mm`
  return `${min}–${max} mm`
}

const materialText = (material: TypeMaterial): string => {
  const thickness = material.kind === 'LEATHER' ? thicknessText(material) : null
  return `${material.code} ${material.name}${thickness ? ` ${thickness}` : ''}`
}

/** None of a kind: a dash (stored text is read in both languages). */
const listText = (materials: readonly TypeMaterial[]): string => (materials.length === 0 ? '—' : materials.map(materialText).join('; '))

/** The materials of a kind in a snapshot: unique, by code. */
function materialsOf(snapshot: TypeSnapshot, kind: ChangeKind): TypeMaterial[] {
  const found = new Map<string, TypeMaterial>()
  for (const line of snapshot.lines) {
    const material = snapshot.materials[line.itemId]
    if (material && kindOfMaterial(material) === kind) found.set(material.id, material)
  }
  return [...found.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

const sameIds = (a: readonly TypeMaterial[], b: readonly TypeMaterial[]): boolean => a.length === b.length && a.every((entry, index) => entry.id === b[index]!.id)

/**
 * What changed from the approved type (`base`) to the new revision (`next`) that the notified body may need to know: per
 * kind, the set of materials (outer leather, lining, protector, thread); and the leather's thickness ranges. Empty when
 * nothing relevant changed (a quantity, a placement, a colour, a trim: none of them changes the examined type here).
 */
export function typeChanges(base: TypeSnapshot, next: TypeSnapshot): TypeChange[] {
  const changes: TypeChange[] = []
  const lineOf = (materials: readonly TypeMaterial[], before: readonly TypeMaterial[]): string | null => {
    const added = materials.find((material) => !before.some((entry) => entry.id === material.id)) ?? materials[0]
    return added ? (next.lines.find((line) => line.itemId === added.id)?.id ?? null) : null
  }
  for (const kind of ['OUTER_LEATHER', 'PROTECTOR', 'SEAMS', 'LINING'] as const) {
    const before = materialsOf(base, kind)
    const after = materialsOf(next, kind)
    if (!sameIds(before, after)) changes.push({ kind, what: WHAT[kind], before: listText(before), after: listText(after), bomLineId: lineOf(after, before) })
    if (kind === 'OUTER_LEATHER') {
      const thick = (materials: readonly TypeMaterial[]) => [...new Set(materials.map(thicknessText).filter((text): text is string => text !== null))].sort()
      const was = thick(before)
      const now = thick(after)
      if (was.length > 0 && now.length > 0 && was.join('|') !== now.join('|')) changes.push({ kind: 'THICKNESS', what: WHAT.THICKNESS, before: was.join('; '), after: now.join('; '), bomLineId: lineOf(after, before) })
    }
  }
  return changes
}

/** The kinds of a list of changes, once each, in CHANGE_KINDS order. */
export const kindsOf = (changes: readonly Pick<TypeChange, 'kind'>[]): ChangeKind[] => CHANGE_KINDS.filter((kind) => changes.some((change) => change.kind === kind))

/** A stored `changes` value read back (anything unreadable is left out). */
export function readChanges(value: unknown): TypeChange[] {
  if (!Array.isArray(value)) return []
  const out: TypeChange[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const kind = (CHANGE_KINDS as readonly string[]).includes(row.kind as string) ? (row.kind as ChangeKind) : 'OTHER'
    out.push({ kind, what: typeof row.what === 'string' ? row.what : WHAT[kind], before: typeof row.before === 'string' ? row.before : '', after: typeof row.after === 'string' ? row.after : '', bomLineId: typeof row.bomLineId === 'string' ? row.bomLineId : null })
  }
  return out
}

// ---- the approved type ---------------------------------------------------------------------------------------------------------

/**
 * The revision a newly released one is compared with, for one certificate: the revision released before it, unless
 * that one's review for the certificate still holds its label (OPEN, NOTIFIED, REFUSED): then the type that review was
 * compared with (its own base, when known). Null: no revision was released before (the first is the examined type).
 */
export function approvedBaseOf(previousRevisionId: string | null, previousReviews: readonly { readonly status: string; readonly comparedRevisionId: string | null }[]): string | null {
  if (previousRevisionId === null) return null
  const holding = previousReviews.find((review) => holdsLabel(review.status))
  return holding?.comparedRevisionId ?? previousRevisionId
}

// ---- the label hold ------------------------------------------------------------------------------------------------------------

export interface HoldingReview {
  readonly id: string
  readonly status: string
  readonly revision: number
  readonly certificateNumber: string
  readonly kinds: readonly ChangeKind[]
}

/** The sentence a held label says (the label gate's reason), or null when no review holds it. */
export function labelHoldWords(reviews: readonly HoldingReview[]): string | null {
  const holding = reviews.filter((review) => holdsLabel(review.status))
  if (holding.length === 0) return null
  const first = holding[0]!
  const what = first.kinds.map((kind) => WHAT[kind].toLowerCase()).join(', ') || 'its construction'
  const state = first.status === 'REFUSED' ? 'the notified body refused the change: a new type examination is needed' : first.status === 'NOTIFIED' ? "the notified body's answer is not recorded yet" : 'compliance has not decided whether the notified body must be told'
  return `Revision ${first.revision} changes the type certificate ${first.certificateNumber} approved (${what}): ${state}, so its class label is held (Reg. (EU) 2016/425 Annex V 7.2).`
}

// ---- decisions -------------------------------------------------------------------------------------------------------------------

export const DECISION_REFUSALS = ['NOT_OPEN', 'NOT_NOTIFIED', 'ANSWER_FILE', 'ANSWER_DAY', 'REASON'] as const
export type DecisionRefusalCode = (typeof DECISION_REFUSALS)[number]

export interface DecisionRefusal {
  readonly code: DecisionRefusalCode
  readonly message: string
}

/** Told the notified body / not needed: only an OPEN review. */
export function openRefusal(status: string): DecisionRefusal | null {
  return status === 'OPEN' ? null : { code: 'NOT_OPEN', message: `The review is ${status}: only an open review is sent to the notified body or decided as not needed.` }
}

/** Not needed: the reason is required (the database holds it too). */
export function reasonRefusal(reason: string | null | undefined): DecisionRefusal | null {
  const text = (reason ?? '').trim()
  if (text === '') return { code: 'REASON', message: 'Say why the change does not touch the approved type: the reason is kept with the technical file.' }
  if (text.length > NOTE_MAX) return { code: 'REASON', message: `A reason has at most ${NOTE_MAX} characters.` }
  return null
}

/** The notified body's answer: a NOTIFIED review, its letter on file, answered on a day between the telling and today. */
export function answerRefusal(input: { readonly status: string; readonly hasAnswerFile: boolean; readonly answeredOn: BusinessDate; readonly notifiedOn: BusinessDate | null; readonly today: BusinessDate }): DecisionRefusal | null {
  if (input.status !== 'NOTIFIED') return { code: 'NOT_NOTIFIED', message: `The review is ${input.status}: an answer is recorded once the notified body was told.` }
  if (!isBusinessDate(input.answeredOn) || daysBetween(input.today, input.answeredOn) > 0) return { code: 'ANSWER_DAY', message: `The answer's day is a day that has come (today is ${input.today}).` }
  if (input.notifiedOn !== null && daysBetween(input.notifiedOn, input.answeredOn) < 0) return { code: 'ANSWER_DAY', message: `The answer cannot come before the notified body was told (${input.notifiedOn}).` }
  if (!input.hasAnswerFile) return { code: 'ANSWER_FILE', message: "Upload the notified body's answer (its letter or the addition) on the review first." }
  return null
}
