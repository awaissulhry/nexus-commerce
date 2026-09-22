// Step 2.6 / D-D — where does a child's size and colour live, and do the stores agree?
// READ ONLY: one `BEGIN READ ONLY` transaction, rolled back. Nothing is written.
// Default target: production (root .env), run by the Owner. `--local`: the local catalogue (apps/api/.env).
//
// Stores counted, per business:
//   vr — Product.categoryAttributes.variations on the child (the variation bag most builders read first)
//   va — Product.variantAttributes on the child            (the variation-axis store)
//   ca — Product.categoryAttributes size/colour keys        (the sheet's attr_size / attr_color cells)
//   pv — the legacy ProductVariation table
//   eb — ChannelListing.platformAttributes.itemSpecifics on the child's eBay listing (per market)
//   az — ChannelListing.platformAttributes.attributes size/color on the child's Amazon listing
//        (a read-back of what Amazon holds; colour is in the market's language, so "differ" there
//        is mostly translation, not conflict)
// Axis keys are folded as apps/api/src/services/pim/variant-attribute-keys.ts does
// (Colore/Farbe/Couleur → color, Taglia/Taille/Talla/Größe → size).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const dotenv = require('dotenv')

const local = process.argv.includes('--local')
const env = dotenv.parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, 'db:', url.pathname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }

const canon = (k) => `(CASE regexp_replace(lower(${k}), '[[:space:]_-]', '', 'g')
  WHEN 'colore' THEN 'color' WHEN 'colour' THEN 'color' WHEN 'farbe' THEN 'color' WHEN 'couleur' THEN 'color'
  WHEN 'taglia' THEN 'size' WHEN 'taille' THEN 'size' WHEN 'talla' THEN 'size' WHEN 'größe' THEN 'size' WHEN 'groesse' THEN 'size'
  ELSE regexp_replace(lower(${k}), '[[:space:]_-]', '', 'g') END)`
const scalar = (v) => `(CASE jsonb_typeof(${v}) WHEN 'array' THEN ${v}->>0 ELSE ${v} #>> '{}' END)`
const obj = (v) => `(CASE WHEN jsonb_typeof(${v}::jsonb) = 'object' THEN ${v}::jsonb ELSE '{}'::jsonb END)`

// One row per (child, store, market, axis) with a non-empty value.
const VALUES = `
  WITH kids AS (SELECT p.id, p."workspaceId" AS ws, p."parentId", p."variantAttributes", p."categoryAttributes"
    FROM "Product" p WHERE p."deletedAt" IS NULL AND p."parentId" IS NOT NULL),
  v AS (
    SELECT k.ws, k.id, k."parentId", 'va' AS store, '' AS market, ${canon('e.key')} AS axis, ${scalar('e.value')} AS val
      FROM kids k, jsonb_each(${obj('k."variantAttributes"')}) e
    UNION ALL SELECT k.ws, k.id, k."parentId", 'vr', '', ${canon('e.key')}, ${scalar('e.value')}
      FROM kids k, jsonb_each(${obj(`(k."categoryAttributes"::jsonb -> 'variations')`)}) e
    UNION ALL SELECT k.ws, k.id, k."parentId", 'ca', '', ${canon('e.key')}, ${scalar('e.value')}
      FROM kids k, jsonb_each(${obj('k."categoryAttributes"')}) e
    UNION ALL SELECT k.ws, k.id, k."parentId", 'eb', l.marketplace, ${canon('e.key')}, ${scalar('e.value')}
      FROM kids k JOIN "ChannelListing" l ON l."productId" = k.id AND l.channel = 'EBAY',
      jsonb_each(${obj(`(l."platformAttributes"::jsonb -> 'itemSpecifics')`)}) e
    UNION ALL SELECT k.ws, k.id, k."parentId", 'az', l.marketplace, e.key, (e.value -> 0 ->> 'value')
      FROM kids k JOIN "ChannelListing" l ON l."productId" = k.id AND l.channel = 'AMAZON',
      jsonb_each(${obj(`(l."platformAttributes"::jsonb -> 'attributes')`)}) e
      WHERE e.key IN ('size', 'color') AND jsonb_typeof(e.value) = 'array')
  SELECT * FROM v WHERE axis IN ('size', 'color') AND nullif(btrim(val), '') IS NOT NULL`

const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 60000 })
await c.connect()
const q = async (s) => (await c.query(s)).rows
const out = {}
try {
  await c.query('BEGIN READ ONLY')
  out.role = (await q(`SELECT current_user AS user, rolbypassrls FROM pg_roles WHERE rolname = current_user`))[0]
  out.readOnly = (await q(`SHOW transaction_read_only`))[0].transaction_read_only
  out.workspaces = await q(`SELECT id, name FROM "Workspace" ORDER BY "createdAt"`)
  // Positive control: row security can make "could not see" look like "nothing there".
  out.children = await q(`SELECT "workspaceId" AS ws, count(*)::int AS live_children, count(DISTINCT "parentId")::int AS parents
    FROM "Product" WHERE "deletedAt" IS NULL AND "parentId" IS NOT NULL GROUP BY 1 ORDER BY 1`)
  // 1 — how many children each store covers, per axis (and per market for listings)
  out.coverage = await q(`SELECT ws, store, market, axis, count(DISTINCT id)::int AS children FROM (${VALUES}) x GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`)
  // 2 — the key spellings stored on the child, before folding
  out.spellings = await q(`
    SELECT p."workspaceId" AS ws, 'va' AS store, e.key, count(*)::int AS n FROM "Product" p, jsonb_each(${obj('p."variantAttributes"')}) e
      WHERE p."deletedAt" IS NULL AND p."parentId" IS NOT NULL GROUP BY 1, 2, 3
    UNION ALL
    SELECT p."workspaceId", 'vr', e.key, count(*)::int FROM "Product" p, jsonb_each(${obj(`(p."categoryAttributes"::jsonb -> 'variations')`)}) e
      WHERE p."deletedAt" IS NULL AND p."parentId" IS NOT NULL GROUP BY 1, 2, 3
    UNION ALL
    SELECT p."workspaceId", 'ca', e.key, count(*)::int FROM "Product" p, jsonb_each(${obj('p."categoryAttributes"')}) e
      WHERE p."deletedAt" IS NULL AND p."parentId" IS NOT NULL AND ${canon('e.key')} IN ('size', 'color') GROUP BY 1, 2, 3
    ORDER BY 1, 2, 4 DESC`)
  // 3 — the legacy table
  out.productVariation = await q(`SELECT "workspaceId" AS ws, count(*)::int AS rows,
    count(*) FILTER (WHERE "variationAttributes" IS NOT NULL AND "variationAttributes"::text NOT IN ('{}', 'null'))::int AS with_values
    FROM "ProductVariation" GROUP BY 1`)
  // 4 — agreement: each product-side base store (vr, va) against every other store, per axis and market
  out.agreement = await q(`WITH x AS (${VALUES}),
    b AS (SELECT store AS base, id, axis, min(lower(btrim(val))) AS v FROM x WHERE store IN ('vr', 'va') GROUP BY 1, 2, 3),
    o AS (SELECT ws, id, store, market, axis, min(lower(btrim(val))) AS v FROM x GROUP BY 1, 2, 3, 4, 5),
    bases AS (SELECT unnest(ARRAY['vr', 'va']) AS base)
    SELECT o.ws, bases.base, o.store, o.market, o.axis,
      count(*) FILTER (WHERE b.v IS NULL)::int AS other_only,
      count(*) FILTER (WHERE b.v = o.v)::int AS same,
      count(*) FILTER (WHERE b.v IS NOT NULL AND b.v <> o.v)::int AS differ,
      (array_agg((SELECT pp.sku FROM "Product" pp WHERE pp.id = o.id) || ': ' || bases.base || '=' || b.v || ' vs ' || o.v)
        FILTER (WHERE b.v IS NOT NULL AND b.v <> o.v))[1:4] AS sample
    FROM o CROSS JOIN bases LEFT JOIN b ON b.base = bases.base AND b.id = o.id AND b.axis = o.axis
    WHERE o.store <> bases.base GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`)
  // 4b — children whose only value for an axis is in ONE store (who would lose it if that store went)
  out.onlyHere = await q(`WITH x AS (${VALUES}), s AS (SELECT ws, id, axis, array_agg(DISTINCT store ORDER BY store) AS stores FROM x GROUP BY 1, 2, 3)
    SELECT ws, axis, array_to_string(stores, '+') AS stores, count(*)::int AS children FROM s GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`)
  // 5 — two children of one parent with the same (size, colour) in one store. A missing axis (∅)
  // or a third axis (body type) makes a group that is partial data, not a real collision.
  out.collisions = await q(`WITH x AS (${VALUES}),
    t AS (SELECT ws, "parentId", id, store, market,
            max(lower(btrim(val))) FILTER (WHERE axis = 'size') AS size, max(lower(btrim(val))) FILTER (WHERE axis = 'color') AS color
          FROM x GROUP BY 1, 2, 3, 4, 5)
    SELECT ws, store, market, count(*)::int AS groups, sum(n)::int AS children,
      count(*) FILTER (WHERE size IS NOT NULL AND color IS NOT NULL)::int AS groups_with_both_axes,
      (array_agg((SELECT pp.sku FROM "Product" pp WHERE pp.id = g."parentId") || ' ' || coalesce(size, '∅') || '/' || coalesce(color, '∅') || ' x' || n))[1:6] AS sample
    FROM (SELECT ws, "parentId", store, market, size, color, count(*)::int AS n FROM t
          WHERE size IS NOT NULL OR color IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6 HAVING count(*) > 1) g
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
  // 6 — junk: a key named variantAttributes inside variantAttributes or variations (a stringified object)
  out.junk = await q(`SELECT "workspaceId" AS ws, count(*)::int AS n, (array_agg(sku))[1:4] AS sample FROM "Product"
    WHERE "deletedAt" IS NULL AND (${obj('"variantAttributes"')} ? 'variantAttributes'
      OR ${obj(`("categoryAttributes"::jsonb -> 'variations')`)} ? 'variantAttributes') GROUP BY 1`)
  // 7 — parents that declare axes, and how many of their children hold no value in va
  out.declared = await q(`SELECT pa."workspaceId" AS ws, count(DISTINCT pa.id)::int AS parents_with_axes, count(k.id)::int AS children,
    count(k.id) FILTER (WHERE k."variantAttributes" IS NULL OR k."variantAttributes"::text IN ('{}', 'null'))::int AS children_without_va,
    count(k.id) FILTER (WHERE ${obj(`(k."categoryAttributes"::jsonb -> 'variations')`)} = '{}'::jsonb)::int AS children_without_vr
    FROM "Product" pa JOIN "Product" k ON k."parentId" = pa.id AND k."deletedAt" IS NULL
    WHERE pa."deletedAt" IS NULL AND cardinality(pa."variationAxes") > 0 GROUP BY 1 ORDER BY 1`)
  await c.query('ROLLBACK')
} finally {
  await c.end()
}
console.log('SUMMARY ' + JSON.stringify({ role: out.role, readOnly: out.readOnly, workspaces: out.workspaces, children: out.children, productVariation: out.productVariation, junk: out.junk }))
for (const [k, rows] of Object.entries(out)) {
  if (['role', 'readOnly', 'workspaces', 'children', 'productVariation', 'junk'].includes(k)) continue
  for (const r of rows) console.log(k.toUpperCase() + ' ' + JSON.stringify(r))
}
