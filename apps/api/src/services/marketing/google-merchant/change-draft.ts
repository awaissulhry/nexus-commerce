/**
 * Google Ads programme 2, G12 (2026-10-16) — what every Merchant Center change is before it is sent: the ONE Merchant API
 * call (the Merchant API has no batch for these and no check), what a person reads before approving (a sentence, from →
 * to lines, counts, warnings, what spends money or changes the price buyers see), the facts it stands on (checked again
 * when it runs) and what it replaced and wrote (for undo). Built from a request and the live state, without any call: pure.
 */
import type { MerchantCallSpec } from './client.js'

export interface MerchantChangeDraft {
  /** ONE plain sentence of what it does. */
  summary: string
  /** from → to, as a person reads it (at most 20 lines; google-ads/change-draft.ts changeLines). */
  changes: Record<string, { from: unknown; to: unknown }>
  totals: Record<string, number>
  /** Sentences a person reads before approving (not about money). */
  warnings: string[]
  /**
   * What can cost money, each a full sentence starting "SPENDS MONEY:" (a product that can show in Shopping ads again) or
   * "CHANGES THE PRICE BUYERS SEE:" (a promotion). The person decides each; Claude never runs one alone.
   */
  spendsMoney: string[]
  call: MerchantCallSpec
  /** The live facts the change stands on: when they moved, the approved change is not sent. */
  stands: unknown
  /** What it replaces and what it writes (AgentChange; undo reads them). Never null. */
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/** Where a change is refused before anything is read further or sent, in a sentence. */
export type MerchantDraftResult = MerchantChangeDraft | { refusal: string }

export const NOT_NEXUS_DATA_SOURCE = (id: string) =>
  `Data source ${id} is not one Nexus made for this business. Nexus writes products and promotions only into a supplemental `
  + 'or promotion data source it made itself (set-google-merchant-data-sources), and never edits or deletes the primary '
  + 'feed that Shopify\'s Google channel (or anything else) owns. Nothing was changed.'

/** A value as a person reads it in a from → to line. */
export const shownValue = (v: unknown): unknown => (v === undefined || v === null ? '(none)' : Array.isArray(v) ? v.join(', ') : v)
