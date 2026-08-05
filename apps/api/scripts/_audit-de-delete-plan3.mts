/** READ-ONLY final probe: null-vs-empty-string, connection state, and the reusable IT baseline. */
const { default: prisma } = await import('../src/db.js')
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))

console.log('=== H. externalListingId: NULL vs empty-string on the DE rows (where-clause trap) ===')
const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT
    count(*)                                                     AS total,
    count(*) FILTER (WHERE "externalListingId" IS NULL)           AS is_null,
    count(*) FILTER (WHERE "externalListingId" = '')              AS is_empty,
    count(*) FILTER (WHERE coalesce("externalListingId",'') <> '') AS is_set,
    count(*) FILTER (WHERE "listingStatus" = 'DRAFT')             AS status_draft,
    count(*) FILTER (WHERE "listingStatus" = '')                  AS status_empty,
    count(*) FILTER (WHERE "listingStatus" IS NULL)               AS status_null
  FROM "ChannelListing" WHERE channel = 'EBAY' AND marketplace = 'DE'`)
console.log(J(rows))

console.log('\n=== H2. any eBay row where marketplace/channelMarket/region disagree? ===')
const dis = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT marketplace, "channelMarket", region, count(*)::int AS n
  FROM "ChannelListing" WHERE channel = 'EBAY'
  GROUP BY 1,2,3 ORDER BY 4 DESC`)
console.log(J(dis))
console.log('rows where the three keys are NOT mutually consistent:')
const bad = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT id, marketplace, "channelMarket", region FROM "ChannelListing"
  WHERE channel='EBAY' AND ("channelMarket" <> 'EBAY_' || marketplace OR region <> marketplace)`)
console.log(J(bad))

console.log('\n=== I. ChannelConnection rows (does a delist have credentials?) ===')
const cc = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT id, "channelType", marketplace, "managedBy", "isActive" FROM "ChannelConnection" ORDER BY "channelType"`)
console.log(J(cc))

console.log('\n=== J. AuditLog rows pointing at the DE ChannelListing ids (non-FK, will orphan) ===')
const deIds = (await prisma.channelListing.findMany({ where: { channel: 'EBAY', marketplace: 'DE' }, select: { id: true } })).map((r) => r.id)
const al = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT count(*)::bigint AS n FROM "AuditLog" WHERE "entityType"='ChannelListing' AND "entityId" = ANY($1::text[])`, deIds)
console.log('AuditLog:', Number(al[0].n))

console.log('\n=== K. THE VERIFICATION QUERY — run BEFORE and AFTER; every number must match ===')
const verify = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT
    (SELECT count(*)::int FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='IT')                                          AS it_rows,
    (SELECT count(*)::int FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='IT' AND coalesce("externalListingId",'')<>'') AS it_rows_with_itemid,
    (SELECT count(DISTINCT "externalListingId")::int FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='IT' AND coalesce("externalListingId",'')<>'') AS it_distinct_itemids,
    (SELECT md5(string_agg(DISTINCT "externalListingId", ',' ORDER BY "externalListingId")) FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='IT' AND coalesce("externalListingId",'')<>'') AS it_itemid_fingerprint,
    (SELECT count(*)::int FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='IT' AND "listingStatus"='ACTIVE')             AS it_active_rows,
    (SELECT count(*)::int FROM "SharedListingMembership" WHERE marketplace='IT')                                                    AS it_memberships,
    (SELECT count(*)::int FROM "SharedListingMembership" WHERE marketplace='IT' AND status='ACTIVE')                                AS it_memberships_active,
    (SELECT md5(string_agg(DISTINCT "itemId", ',' ORDER BY "itemId")) FROM "SharedListingMembership" WHERE marketplace='IT')         AS it_membership_itemid_fingerprint,
    (SELECT count(*)::int FROM "ChannelListing" WHERE channel='EBAY' AND marketplace='DE')                                          AS de_rows,
    (SELECT count(*)::int FROM "SharedListingMembership" WHERE marketplace<>'IT')                                                   AS non_it_memberships,
    (SELECT count(*)::int FROM "ChannelListing" WHERE channel='AMAZON')                                                             AS amazon_rows`)
console.log(J(verify))

console.log('\n=== K2. per-ItemID IT row census (the strongest before/after proof) ===')
const census = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "externalListingId" AS item_id, count(*)::int AS it_rows,
         (SELECT count(*)::int FROM "SharedListingMembership" m WHERE m."itemId" = cl."externalListingId" AND m.marketplace='IT') AS it_memberships
  FROM "ChannelListing" cl
  WHERE channel='EBAY' AND marketplace='IT' AND coalesce("externalListingId",'')<>''
  GROUP BY 1 ORDER BY 1`)
console.log(J(census))

await prisma.$disconnect()
