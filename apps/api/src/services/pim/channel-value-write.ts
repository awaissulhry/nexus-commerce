/**
 * Atomic override merge shared by the grid writer and disposable database tests.
 *
 * UPDATE only: it merges into the listing that exists on the coordinate and creates none. The product sheet starts a
 * missing listing first, through `ensureDraftListings` (`draft-listing.service.ts`), the one place a draft is decided.
 * A coordinate with no row is left untouched (0 rows).
 */
export const writeChannelOverrideMerge = <T>(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: any[]) => T },
  e: { productId: string; channel: string; marketplace: string; aliasKey: string; patch: Record<string, unknown>; remove: string[] },
  connectionId: string | null,
) =>
  db.$executeRaw`
  UPDATE "ChannelListing" SET
    "overrideData" = (COALESCE("overrideData", '{}'::jsonb) || ${JSON.stringify(e.patch)}::jsonb) - ${e.remove}::text[],
    "version" = "version" + 1,
    "updatedAt" = now()
  WHERE "productId" = ${e.productId} AND "channel" = ${e.channel} AND "marketplace" = ${e.marketplace}
    AND "aliasKey" = ${e.aliasKey} AND "channelConnectionId" IS NOT DISTINCT FROM ${connectionId}
  `
