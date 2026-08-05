const { default: prisma } = await import('../src/db.js');
const q = (s: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(s);
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
const r = await q(`
  SELECT p.sku, cl.marketplace, cl.region, cl."listingStatus", cl."externalListingId",
         (cl."platformAttributes"->'itemSpecifics') ? 'variantAttributes' AS spec_has_phantom,
         cl."flatFileSnapshot" ? 'aspect_variantAttributes' AS snap_has_phantom
  FROM "Product" p JOIN "ChannelListing" cl ON cl."productId" = p.id
  WHERE p.sku IN ('GALE-JACKET-BLACK-MEN-XXS','GALE-JACKET-YELLOW-MEN-XXS') AND cl.channel='EBAY'
`);
console.log('CHILD_LISTINGS', J(r));
const m = await q(`
  SELECT m."parentSku", m.sku, m.marketplace, m.status, m."itemId"
  FROM "SharedListingMembership" m
  WHERE m.sku IN ('GALE-JACKET-BLACK-MEN-XXS','GALE-JACKET-YELLOW-MEN-XXS')
`);
console.log('MEMBERSHIPS', J(m));
await prisma.$disconnect();
