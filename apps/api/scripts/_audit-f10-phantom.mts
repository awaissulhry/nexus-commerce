const { default: prisma } = await import('../src/db.js');

// 1) ChannelListing.platformAttributes.itemSpecifics keys matching variantattributes
const inSpecifics = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT cl.id, cl.region, p.sku, k AS spec_key,
         jsonb_typeof(cl."platformAttributes"->'itemSpecifics'->k) AS val_type,
         left((cl."platformAttributes"->'itemSpecifics'->>k), 60) AS val
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId",
  LATERAL jsonb_object_keys(cl."platformAttributes"->'itemSpecifics') k
  WHERE jsonb_typeof(cl."platformAttributes"->'itemSpecifics') = 'object'
    AND lower(k) LIKE '%variantattributes%'
  LIMIT 100
`);
console.log('A_ITEMSPECIFICS_KEYS', inSpecifics.length, JSON.stringify(inSpecifics.slice(0,10)));

// 2) flatFileSnapshot aspect_* keys
const inSnap = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT cl.id, cl.region, p.sku, k AS snap_key,
         jsonb_typeof(cl."flatFileSnapshot"->k) AS val_type,
         left((cl."flatFileSnapshot"->>k), 60) AS val
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId",
  LATERAL jsonb_object_keys(cl."flatFileSnapshot") k
  WHERE jsonb_typeof(cl."flatFileSnapshot") = 'object'
    AND lower(k) LIKE '%variantattributes%'
  LIMIT 200
`);
console.log('B_SNAPSHOT_KEYS', inSnap.length, JSON.stringify(inSnap.slice(0,15)));

// 3) Any "[object Object]" literal anywhere in flatFileSnapshot
const objObjSnap = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT cl.region, p.sku, k AS snap_key, count(*)::int AS n
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId",
  LATERAL jsonb_each_text(cl."flatFileSnapshot") AS e(k, v)
  WHERE jsonb_typeof(cl."flatFileSnapshot") = 'object'
    AND e.v = '[object Object]'
  GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 50
`);
console.log('C_OBJOBJ_SNAPSHOT', objObjSnap.length, JSON.stringify(objObjSnap));

// 4) "[object Object]" in platformAttributes.itemSpecifics
const objObjSpec = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT cl.region, k AS spec_key, count(*)::int AS n
  FROM "ChannelListing" cl,
  LATERAL jsonb_each_text(cl."platformAttributes"->'itemSpecifics') AS e(k, v)
  WHERE jsonb_typeof(cl."platformAttributes"->'itemSpecifics') = 'object'
    AND e.v = '[object Object]'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 50
`);
console.log('D_OBJOBJ_SPECIFICS', objObjSpec.length, JSON.stringify(objObjSpec));

// 5) Product.variantAttributes / categoryAttributes.variations containing a nested object value
const prodNested = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT p.sku, k, jsonb_typeof(p."variantAttributes"->k) AS t
  FROM "Product" p, LATERAL jsonb_object_keys(p."variantAttributes") k
  WHERE jsonb_typeof(p."variantAttributes") = 'object'
    AND jsonb_typeof(p."variantAttributes"->k) IN ('object','array')
  LIMIT 50
`);
console.log('E_PRODUCT_VARIANTATTRS_NESTED', prodNested.length, JSON.stringify(prodNested.slice(0,20)));

const catNested = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT p.sku, k, jsonb_typeof(p."categoryAttributes"->'variations'->k) AS t
  FROM "Product" p, LATERAL jsonb_object_keys(p."categoryAttributes"->'variations') k
  WHERE jsonb_typeof(p."categoryAttributes"->'variations') = 'object'
    AND jsonb_typeof(p."categoryAttributes"->'variations'->k) IN ('object','array')
  LIMIT 50
`);
console.log('F_PRODUCT_CATVARS_NESTED', catNested.length, JSON.stringify(catNested.slice(0,20)));

await prisma.$disconnect();
