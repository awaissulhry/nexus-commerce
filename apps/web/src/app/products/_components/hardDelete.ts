import { z } from 'zod'

export type HardDeleteChannelAction = 'none' | 'unpublish' | 'delete'

export interface PreflightWarnings {
  confirmPhrase?: string | null
  refusal?: string | null
  channelListings: Array<{ productId: string; channel: string; marketplace: string | null; externalListingId: string }>
  openOrders: Array<{ productId: string; orderId: string; channelOrderId: string; channel: string; status: string }>
  activeBundles: Array<{ productId: string; bundleId: string; role: 'master' | 'component' }>
  fbaInventory: Array<{ productId: string; marketplaceId: string; fulfillmentCenterId: string; quantity: number; condition: string }>
}

const s = z.string()
const preflightSchema: z.ZodType<PreflightWarnings> = z.object({
  channelListings: z.array(z.object({ productId: s, channel: s, marketplace: s.nullable(), externalListingId: s })),
  openOrders: z.array(z.object({ productId: s, orderId: s, channelOrderId: s, channel: s, status: s })),
  activeBundles: z.array(z.object({ productId: s, bundleId: s, role: z.enum(['master', 'component']) })),
  fbaInventory: z.array(z.object({ productId: s, marketplaceId: s, fulfillmentCenterId: s, quantity: z.number(), condition: s })),
  confirmPhrase: s.nullable().optional(), refusal: s.nullable().optional(),
})
export function parseHardDeletePreflight(raw: unknown): PreflightWarnings {
  const result = preflightSchema.safeParse(raw)
  if (!result.success) throw new Error('The preflight response is incomplete. Reload before deleting.')
  return result.data
}

/** The typed acknowledgement names one real target (D19), with no normalisation. */
export function hardDeleteConfirmation(input: {
  productIds: readonly string[]
  products: readonly { id: string; sku: string }[]
  preflight: PreflightWarnings | null
  loading: boolean
  error: string | null
  busy: boolean
  typed: string
}): { phrase: string | null; reason: string | null; armed: boolean } {
  const product = input.productIds.length === 1
    ? input.products.find(p => p.id === input.productIds[0])
    : undefined
  const sku = product?.sku && product.sku.trim() !== '' ? product.sku : null
  const phrase = input.preflight && Object.prototype.hasOwnProperty.call(input.preflight, 'confirmPhrase') ? input.preflight.confirmPhrase ?? null : sku
  const reason = input.error != null ? `The check failed: ${input.error}. Permanent deletion is blocked.`
    : input.loading ? 'Checking the selected product…'
      : input.preflight == null ? 'The check has not returned a result.'
        : input.productIds.length !== 1 ? 'Select one product at a time for permanent deletion.'
          : input.preflight.refusal != null ? input.preflight.refusal
            : phrase == null ? 'The selected product’s SKU could not be read. Reload before deleting.'
              : phrase !== sku ? 'The selected SKU and preflight target do not match. Reload before deleting.'
            : input.busy ? 'Permanent deletion is in progress.'
              : input.typed !== phrase ? `Type ${phrase} exactly to confirm.` : null
  return { phrase, reason, armed: reason === null }
}

/**
 * 🔴 PLAN Step 1.2 — read the bulk-hard-delete response, which can now succeed PARTLY.
 *
 * The API refuses any product whose live listing the chosen action would leave selling, and
 * returns per-row `outcomes` (15.10 — "487 deleted · 13 refused", never one throw on row 14).
 * Before this existed, the caller ignored the body and announced `product.deleted` for every
 * selected id: with a refusal in play that is a claim that a deletion happened when it did not.
 *
 * Kept here, beside the other pure hard-delete rules, so it can be tested as logic rather than
 * asserted as the text of a component.
 *
 * An older API build returns no `outcomes` key. That is NOT "nothing was deleted" — it is "this
 * build does not say", so the previous behaviour is kept for it. A measurement that was never
 * taken must not read as a measurement of zero.
 */
export interface HardDeleteOutcome {
  productId: string
  sku: string | null
  outcome: 'deleted' | 'refused'
  reasons: string[]
}

export function interpretHardDeleteOutcomes(
  raw: unknown,
  selectedIds: readonly string[],
): { deletedIds: string[]; refused: HardDeleteOutcome[]; reported: boolean } {
  const outcomes = (raw as { outcomes?: unknown } | null | undefined)?.outcomes
  if (!Array.isArray(outcomes)) return { deletedIds: [...selectedIds], refused: [], reported: false }

  const parsed = outcomes.filter((row): row is HardDeleteOutcome =>
    !!row && typeof row === 'object'
    && typeof (row as HardDeleteOutcome).productId === 'string'
    && ((row as HardDeleteOutcome).outcome === 'deleted' || (row as HardDeleteOutcome).outcome === 'refused'))

  return {
    deletedIds: parsed.filter(row => row.outcome === 'deleted').map(row => row.productId),
    refused: parsed.filter(row => row.outcome === 'refused'),
    reported: true,
  }
}

/** One line per refused product, for the operator. Never empty when a refusal exists. */
export function hardDeleteRefusalLines(refused: readonly HardDeleteOutcome[]): string {
  return refused
    .map(row => `${row.sku ?? row.productId}: ${row.reasons.length ? row.reasons.join(' ') : 'Refused; no reason was given.'}`)
    .join('\n')
}
