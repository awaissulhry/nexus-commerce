/**
 * E1 (Etsy publisher, 2026-10-05) — the Etsy review names EVERY problem it finds, once, per SKU, with the sheet's column
 * label instead of an internal key, the way the eBay review does (`studio-publication-ebay-problems.ts`).
 *
 * The builder hands every problem to a collector and keeps going; only a problem that leaves nothing to build stops it,
 * and only after the rest are noted. Notes block nothing: the review shows them as warnings.
 */
import type { StudioPublishIssue } from '@nexus/shared/studio-publication'

type Where = { productId?: string; sku?: string; field?: string }

/** The sheet's labels (channel-specs/etsy.ts), plus the change lines that group several columns. */
const LABELS: Readonly<Record<string, string>> = {
  title: 'Title', description: 'Description', tags: 'Tags', materials: 'Materials', taxonomy_id: 'Category', who_made: 'Who made it',
  when_made: 'When made', is_supply: 'Craft supply', type: 'Listing type', shop_section_id: 'Shop section', shipping_profile_id: 'Shipping profile',
  return_policy_id: 'Return policy', item_weight: 'Item weight', item_weight_unit: 'Weight unit', item_length: 'Item length', item_width: 'Item width',
  item_height: 'Item height', item_dimensions_unit: 'Dimension unit', is_taxable: 'Taxable', should_auto_renew: 'Automatic renewal',
  production_partner_ids: 'Production partner IDs', styles: 'Styles', readiness_state_id: 'Processing profile', price: 'Price', quantity: 'Quantity',
  sku: 'Seller SKU',
  // Change lines only: Etsy takes these columns together, as one change.
  classification: 'Who made, when made, craft supply', item_dimensions: 'Item size', inventory: 'Variations, SKUs and processing profile',
}

/** The column label the sheet shows for an Etsy listing field (`taxonomy_id` → "Category"); an unknown key is itself. */
export const etsyFieldLabel = (key: string): string => LABELS[key] ?? key

const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** "SKU: message" for a reader that sees only the text (a refused submit, a log). */
const sentence = (issue: StudioPublishIssue) => issue.sku && !issue.message.startsWith(`${issue.sku}:`) ? `${issue.sku}: ${issue.message}` : issue.message

/**
 * An Etsy sentence written for a write that was refused (`etsy/listing-content.ts`, `etsy/inventory.ts`) ends in "nothing was
 * sent"; in a review nothing is being sent yet, so the tail is dropped (the sentence keeps its full stop).
 */
export const stripNothingSent = (text: string): string => text.replace(/;\s*nothing was sent\.\s*$/i, '.').replace(/\s+Nothing was sent\.\s*$/, '').trim()

/** A builder message that starts with the SKU; the review shows the SKU in its own column. */
const stripSku = (message: string, sku?: string) => sku && message.startsWith(`${sku}: `) ? message.slice(sku.length + 2) : message

/** Every problem one Etsy review found. `message` keeps the one-line form, so a reader that only logs it still can. */
export class EtsyPublicationProblems extends Error {
  readonly issues: StudioPublishIssue[]
  /** Review notes found on the way (they block nothing). */
  readonly notes: string[]
  constructor(issues: StudioPublishIssue[], notes: string[] = []) {
    super(issues.map(sentence).join('\n'))
    this.name = 'EtsyPublicationProblems'
    this.issues = issues
    this.notes = notes
  }
}

export interface EtsyProblems {
  readonly issues: StudioPublishIssue[]
  /** Review notes that block nothing. */
  readonly notes: string[]
  /** A blocking problem, once per SKU and message. */
  add(message: string, where?: Where): void
  /** A note; with `where.sku` it reads "SKU: message". Said once. */
  note(message: string, where?: Where): void
  /** Run one check; a refusal it throws becomes one named problem and the review goes on. */
  attempt<T>(step: () => T, where?: Where): T | undefined
  throwIfAny(): void
}

export function etsyProblems(): EtsyProblems {
  const issues: StudioPublishIssue[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  const add = (message: string, where: Where = {}) => {
    const key = JSON.stringify([where.sku ?? '', message])
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ ...where, severity: 'error', message })
  }
  return {
    issues, notes, add,
    note(message, where) {
      const text = where?.sku ? `${where.sku}: ${message}` : message
      if (!notes.includes(text)) notes.push(text)
    },
    attempt(step, where) {
      try { return step() } catch (error) {
        if (error instanceof EtsyPublicationProblems) for (const issue of error.issues) add(issue.message, issue)
        else add(stripNothingSent(stripSku(textOf(error), where?.sku)), where)
        return undefined
      }
    },
    throwIfAny() { if (issues.length) throw new EtsyPublicationProblems([...issues], [...notes]) },
  }
}
