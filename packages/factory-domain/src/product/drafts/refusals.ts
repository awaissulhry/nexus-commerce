import type { RevisionStatus } from '../styles/revisions'

/**
 * The designer's right on a product draft (owb-pd1 1.4; S4 settle 6; base settle 5; plan.md § 5 D R40 "the designer makes the
 * product draft, the owner releases it"). Pure. product.drafts.edit is accepted where product.styles.manage or product.bom.manage
 * is asked for these acts only, and only while the revision written is DRAFT (a style-level field: while the style's newest
 * revision is DRAFT, or it has none yet):
 *
 *   allowed   New product (no SKUs made with it), Start revision n (a new DRAFT, also as a copy of the frozen one), style facts,
 *             BOM lines (sizes and colours too), the size table (the measurement spec of a DRAFT revision), how to measure (a
 *             point's how-to words only), protectors, gallery pictures and their callouts
 *   refused   release, archive, reactivate, duplicate, every price or cost field, routes and operations, departments, size
 *             scales, colourways and SKUs (their routes keep asking product.styles.manage / product.bom.manage /
 *             product.routing.manage: a plain 403 there)
 *
 * The API sends the English words with the code at `refusal/<code>`; the web shows its own words for the code.
 */

/** A revision's status, or null: the product has no revision yet (a new product). */
export type DraftState = RevisionStatus | null

/** The designer writes while the revision written is a draft (or the product has none yet). */
export const designerMayWrite = (state: DraftState): boolean => state === null || state === 'DRAFT'

export const DRAFT_EDIT_REFUSAL_CODES = ['DRAFT_ONLY', 'SKUS_NOT_HERE', 'HOW_TO_ONLY'] as const
export type DraftEditRefusal = (typeof DRAFT_EDIT_REFUSAL_CODES)[number]

/** DRAFT_ONLY is a 409 (the state of the revision), the other two a 403 (not this person's to do). */
export const DRAFT_EDIT_REFUSALS: Readonly<Record<DraftEditRefusal, { readonly en: string; readonly it: string }>> = Object.freeze({
  DRAFT_ONLY: {
    en: 'A designer changes a draft only: this revision is released. Start a new revision first.',
    it: 'Il designer cambia solo una bozza: questa revisione è rilasciata. Avvia prima una nuova revisione.',
  },
  SKUS_NOT_HERE: {
    en: 'The SKUs are made by the person who keeps the products: make the product without them.',
    it: 'Gli SKU li crea chi gestisce i prodotti: crea il prodotto senza SKU.',
  },
  HOW_TO_ONLY: {
    en: 'A designer changes only how a point is measured here (its how-to words).',
    it: 'Qui il designer cambia solo come si misura un punto (le sue istruzioni).',
  },
})
