const { default: prisma } = await import('../src/db.js');
const q = (s: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(s);
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

const p2 = await q(`
  SELECT id, sku, "parentId" IS NOT NULL AS is_child, "isParent", "variationTheme",
         left("categoryAttributes"::text, 900) AS cat, left("variantAttributes"::text, 600) AS va
  FROM "Product"
  WHERE "categoryAttributes"::text LIKE '%[object Object]%' OR "variantAttributes"::text LIKE '%[object Object]%'
`);
console.log('OBJOBJ_PRODUCTS', J(p2));

const keys = await q(`
  SELECT k, count(*)::int n
  FROM "ChannelListing" cl, LATERAL jsonb_object_keys(cl."flatFileSnapshot") k
  WHERE jsonb_typeof(cl."flatFileSnapshot")='object' AND k LIKE 'aspect_%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 100
`);
console.log('SNAP_ASPECT_KEYS', J(keys));

const one = await q(`
  SELECT cl.id, cl.region, p.sku, p."variationTheme",
         cl."flatFileSnapshot"->>'aspect_Variantattributes' AS v,
         jsonb_typeof(cl."flatFileSnapshot"->'aspect_Variantattributes') AS t
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl."flatFileSnapshot" ? 'aspect_Variantattributes'
`);
console.log('OFFENDER', J(one));
await prisma.$disconnect();
