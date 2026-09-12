/** Atomic override merge shared by the grid writer and disposable database tests. */
export const writeChannelOverrideMerge = <T>(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: any[]) => T },
  e: { productId: string; channel: string; marketplace: string; aliasKey: string; patch: Record<string, unknown>; remove: string[] },
  connectionId: string | null,
) =>
  db.$executeRaw`
  INSERT INTO "ChannelListing" (
    "id", "productId", "channel", "marketplace", "channelMarket", "region",
    "aliasKey", "aliasId", "channelConnectionId", "overrideData",
    "listingStatus", "isPublished", "version", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, ${e.productId}, ${e.channel}, ${e.marketplace},
    ${`${e.channel}_${e.marketplace}`}, ${e.marketplace},
    ${e.aliasKey}, ${e.aliasKey || null}, ${connectionId}, ${JSON.stringify(e.patch)}::jsonb,
    'DRAFT', false, 1, now(), now()
  )
  ON CONFLICT ("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey")
  DO UPDATE SET
    "overrideData" = (COALESCE("ChannelListing"."overrideData", '{}'::jsonb) || ${JSON.stringify(e.patch)}::jsonb) - ${e.remove}::text[],
    "version" = "ChannelListing"."version" + 1,
    "updatedAt" = now()
  `
