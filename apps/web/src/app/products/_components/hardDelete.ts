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
