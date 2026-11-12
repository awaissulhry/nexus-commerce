import type { Issue } from '../../core/errors'

/**
 * A customer's requirements (B-W2b-290; SAL-014; design sales.customers record › Requirements "Customer requirements":
 * packing, labelling, hangtag, document and routing-guide rules, "Applies to (all orders / some styles)", "Shown on:
 * order · pick & pack screen · shipping checklist", "Attachment (routing guide)"), pure. The rows are factory-db's
 * CustomerRequirement (B-W2b-279): written in force, fixed once written; a change ends the old one and writes the new one
 * that supersedes it, in one command; ended once, with when, by whom and why. The history is the rows.
 *
 *   kind        PACKING · DOCUMENT · LABEL · QUALITY · SHIPPING · INVOICING · OTHER
 *   words       the rule in words, 1 to 2000 characters
 *   appliesAt   where it is shown, one or more of QUOTE · ORDER · PACKING · SHIPMENT · INVOICE, each once
 *   styleIds    the styles it is for (at most 200, each once); none: every style
 *   companyId   the company it is for; null: every company (a party of one company: only that one)
 *
 * Where a requirement applies (`appliesTo`): in force, for the record's company (or every company), at the record's
 * stage, and for one of the record's styles when it names styles. A quote shows QUOTE, an order ORDER, a shipment its
 * PACKING (the pick & pack screen) and SHIPMENT (the shipping checklist) ones, an invoice INVOICE.
 */

export const REQUIREMENT_KINDS = ['PACKING', 'DOCUMENT', 'LABEL', 'QUALITY', 'SHIPPING', 'INVOICING', 'OTHER'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]
export const REQUIREMENT_STAGES = ['QUOTE', 'ORDER', 'PACKING', 'SHIPMENT', 'INVOICE'] as const
export type RequirementStage = (typeof REQUIREMENT_STAGES)[number]

export const REQUIREMENT_LIMITS = Object.freeze({ words: 2000, endReason: 500, styles: 200 })

/** The records that show requirements, and the stages each shows. */
export const RECORD_STAGES = Object.freeze({
  Quote: ['QUOTE'],
  SalesOrder: ['ORDER'],
  Shipment: ['PACKING', 'SHIPMENT'],
  Invoice: ['INVOICE'],
} as const satisfies Readonly<Record<string, readonly RequirementStage[]>>)
export type RequirementRecordType = keyof typeof RECORD_STAGES
export const REQUIREMENT_RECORD_TYPES = Object.keys(RECORD_STAGES) as RequirementRecordType[]

/** Where a stage is shown, in the design's words. */
export const STAGE_WORDS: Readonly<Record<RequirementStage, { readonly en: string; readonly it: string }>> = Object.freeze({
  QUOTE: { en: 'the quote', it: "l'offerta" },
  ORDER: { en: 'the order', it: "l'ordine" },
  PACKING: { en: 'the pick & pack screen', it: 'la preparazione e imballo' },
  SHIPMENT: { en: 'the shipping checklist', it: 'la lista di spedizione' },
  INVOICE: { en: 'the invoice', it: 'la fattura' },
})

/** "Shown on: the order · the pick & pack screen" in one language. */
export function shownOn(stages: readonly RequirementStage[], language: 'en' | 'it'): string {
  return REQUIREMENT_STAGES.filter((stage) => stages.includes(stage))
    .map((stage) => STAGE_WORDS[stage][language])
    .join(' · ')
}

export interface RequirementInput {
  readonly kind: RequirementKind
  readonly words: string
  readonly appliesAt: readonly RequirementStage[]
  readonly styleIds?: readonly string[] | undefined
}

/** One line, trimmed; inner runs of spaces kept as typed (the words are the customer's rule). */
const clean = (value: string): string => value.trim()

/** The requirement as it is stored: words trimmed, the stages in their order, the styles each once. */
export function normaliseRequirement(input: RequirementInput): { kind: RequirementKind; words: string; appliesAt: RequirementStage[]; styleIds: string[] } {
  return {
    kind: input.kind,
    words: clean(input.words),
    appliesAt: REQUIREMENT_STAGES.filter((stage) => input.appliesAt.includes(stage)),
    styleIds: [...new Set(input.styleIds ?? [])],
  }
}

/** Every rule of a requirement the database also holds, in words; paths are field names. */
export function requirementProblems(input: RequirementInput): Issue[] {
  const issues: Issue[] = []
  const words = clean(input.words)
  if (words === '') issues.push({ path: 'words', message: 'Say the rule in words.' })
  else if (words.length > REQUIREMENT_LIMITS.words) issues.push({ path: 'words', message: `At most ${REQUIREMENT_LIMITS.words} characters.` })
  if (input.appliesAt.length === 0) issues.push({ path: 'appliesAt', message: 'Say where it is shown: the quote, the order, the pick & pack screen, the shipping checklist or the invoice.' })
  else if (new Set(input.appliesAt).size !== input.appliesAt.length) issues.push({ path: 'appliesAt', message: 'Each place once.' })
  const styles = input.styleIds ?? []
  if (styles.length > REQUIREMENT_LIMITS.styles) issues.push({ path: 'styleIds', message: `At most ${REQUIREMENT_LIMITS.styles} styles; none means every style.` })
  else if (new Set(styles).size !== styles.length) issues.push({ path: 'styleIds', message: 'Each style once.' })
  return issues
}

/** Why a requirement is ended, when given: up to 500 characters. */
export function endReasonProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim()
  return text.length > REQUIREMENT_LIMITS.endReason ? `At most ${REQUIREMENT_LIMITS.endReason} characters.` : null
}

export interface RequirementFacts {
  readonly active: boolean
  readonly companyId: string | null
  readonly appliesAt: readonly RequirementStage[]
  readonly styleIds: readonly string[]
}

export interface RequirementPlace {
  /** The record's company. */
  readonly companyId: string
  /** The stages the record shows. */
  readonly stages: readonly RequirementStage[]
  /** The record's styles (its lines'); empty: the record names none yet. */
  readonly styleIds: readonly string[]
}

/** Does this requirement apply on a record of this company, at these stages, for these styles? */
export function appliesTo(requirement: RequirementFacts, place: RequirementPlace): boolean {
  if (!requirement.active) return false
  if (requirement.companyId !== null && requirement.companyId !== place.companyId) return false
  if (!requirement.appliesAt.some((stage) => place.stages.includes(stage))) return false
  if (requirement.styleIds.length === 0) return true
  return requirement.styleIds.some((styleId) => place.styleIds.includes(styleId))
}

/** The changes of a requirement its event names (party.requirement_changed): ADDED, REPLACED (the new one), ENDED. */
export const REQUIREMENT_CHANGES = ['ADDED', 'REPLACED', 'ENDED'] as const
