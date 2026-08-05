const { default: prisma } = await import('../src/db.js');
const q = (s: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(s);
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

// GALE family size
const fam = await q(`
  SELECT (SELECT count(*) FROM "Product" c WHERE c."parentId" = p.id)::int AS children, p.sku, p.id
  FROM "Product" p WHERE p.sku = 'GALE-JACKET'
`);
console.log('GALE_FAMILY', J(fam));

// ── DETECTION QUERY (deliverable) ───────────────────────────────────────────
// Every place the phantom axis / "[object Object]" residue lives, read-only.
const detect = await q(`
SELECT 'product.variantAttributes' AS site, p.id AS row_id, p.sku, k AS bad_key,
       (p."variantAttributes"->>k) AS bad_value
FROM "Product" p, LATERAL jsonb_object_keys(p."variantAttributes") k
WHERE jsonb_typeof(p."variantAttributes") = 'object'
  AND (lower(k) = 'variantattributes' OR (p."variantAttributes"->>k) = '[object Object]')
UNION ALL
SELECT 'product.categoryAttributes.variations', p.id, p.sku, k,
       (p."categoryAttributes"->'variations'->>k)
FROM "Product" p, LATERAL jsonb_object_keys(p."categoryAttributes"->'variations') k
WHERE jsonb_typeof(p."categoryAttributes"->'variations') = 'object'
  AND (lower(k) = 'variantattributes' OR (p."categoryAttributes"->'variations'->>k) = '[object Object]')
UNION ALL
SELECT 'listing.flatFileSnapshot', cl.id, p.sku, k, (cl."flatFileSnapshot"->>k)
FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId",
     LATERAL jsonb_object_keys(cl."flatFileSnapshot") k
WHERE jsonb_typeof(cl."flatFileSnapshot") = 'object'
  AND (lower(replace(k,'aspect_','')) = 'variantattributes' OR (cl."flatFileSnapshot"->>k) = '[object Object]')
UNION ALL
SELECT 'listing.platformAttributes.itemSpecifics', cl.id, p.sku, k,
       (cl."platformAttributes"->'itemSpecifics'->>k)
FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId",
     LATERAL jsonb_object_keys(cl."platformAttributes"->'itemSpecifics') k
WHERE jsonb_typeof(cl."platformAttributes"->'itemSpecifics') = 'object'
  AND (lower(k) = 'variantattributes' OR (cl."platformAttributes"->'itemSpecifics'->>k) = '[object Object]')
UNION ALL
SELECT 'membership.variationSpecifics', m.id, m."parentSku", k, (m."variationSpecifics"->>k)
FROM "SharedListingMembership" m, LATERAL jsonb_object_keys(m."variationSpecifics") k
WHERE jsonb_typeof(m."variationSpecifics") = 'object'
  AND (lower(k) = 'variantattributes' OR (m."variationSpecifics"->>k) = '[object Object]')
ORDER BY 1,3
`);
console.log('DETECT_TOTAL', detect.length);
console.log('DETECT', J(detect));
await prisma.$disconnect();
