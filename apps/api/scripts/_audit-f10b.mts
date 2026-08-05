const { default: prisma } = await import('../src/db.js');
const q = (s: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(s);

const a = await q(`SELECT count(*)::int n FROM "ChannelListing" WHERE "platformAttributes"::text LIKE '%[object Object]%'`);
console.log('PA_OBJOBJ', JSON.stringify(a));
const b = await q(`SELECT count(*)::int n FROM "ChannelListing" WHERE "flatFileSnapshot"::text LIKE '%[object Object]%'`);
console.log('SNAP_OBJOBJ', JSON.stringify(b));
const c = await q(`SELECT count(*)::int n FROM "Product" WHERE "categoryAttributes"::text LIKE '%[object Object]%' OR "variantAttributes"::text LIKE '%[object Object]%'`);
console.log('PRODUCT_OBJOBJ', JSON.stringify(c));
const d = await q(`SELECT count(*)::int n FROM "Product" WHERE "variationTheme" LIKE '%object Object%'`);
console.log('THEME_OBJOBJ', JSON.stringify(d));

// every distinct aspect_* key in snapshots, with counts, to see the whole ghost surface
const keys = await q(`
  SELECT k, count(*)::int n, count(*) FILTER (WHERE (cl."flatFileSnapshot"->>k) = '') AS empties
  FROM "ChannelListing" cl, LATERAL jsonb_object_keys(cl."flatFileSnapshot") k
  WHERE jsonb_typeof(cl."flatFileSnapshot")='object' AND k LIKE 'aspect_%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 80
`);
console.log('SNAP_ASPECT_KEYS', JSON.stringify(keys));

// the one offender in full
const one = await q(`
  SELECT cl.id, cl.region, p.sku, p."variationTheme", cl."flatFileSnapshot"->>'aspect_Variantattributes' AS v,
         jsonb_typeof(cl."flatFileSnapshot"->'aspect_Variantattributes') AS t
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl."flatFileSnapshot" ? 'aspect_Variantattributes'
`);
console.log('OFFENDER', JSON.stringify(one));

// itemSpecifics keys distribution (any weird ones)
const spec = await q(`
  SELECT k, count(*)::int n FROM "ChannelListing" cl,
  LATERAL jsonb_object_keys(cl."platformAttributes"->'itemSpecifics') k
  WHERE jsonb_typeof(cl."platformAttributes"->'itemSpecifics')='object'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 60
`);
console.log('SPEC_KEYS', JSON.stringify(spec));
await prisma.$disconnect();
