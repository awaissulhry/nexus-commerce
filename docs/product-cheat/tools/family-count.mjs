// Step 2.4b — count live parent products with no product family, and what could be proposed.
// READ ONLY: one `BEGIN READ ONLY` transaction, rolled back. Nothing is written.
// Default target: production (root .env). `--local`: the local catalogue (apps/api/.env), as a dry run.
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

const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 30000 })
await c.connect()
const out = {}
try {
  await c.query('BEGIN READ ONLY')
  out.role = (await c.query(`SELECT current_user AS user, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
  out.readOnly = (await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only
  out.workspaces = (await c.query(`SELECT id, name, "isLegacy" AS legacy FROM "Workspace" ORDER BY "createdAt"`)).rows
  // Positive control: row security can make "could not see" look like "nothing there".
  out.productRowsVisible = (await c.query(`SELECT count(*)::int AS n FROM "Product"`)).rows[0].n
  out.parents = (await c.query(`
    SELECT p."workspaceId" AS ws, count(*)::int AS live_parents,
      count(*) FILTER (WHERE p."familyId" IS NULL)::int AS no_family,
      count(*) FILTER (WHERE p."familyId" IS NULL AND EXISTS (
        SELECT 1 FROM "ChannelListing" l JOIN "Product" x ON x.id = l."productId" WHERE x.id = p.id OR x."parentId" = p.id))::int AS no_family_listed,
      count(*) FILTER (WHERE p."productType" IS NULL)::int AS no_product_type
    FROM "Product" p WHERE p."deletedAt" IS NULL AND p."parentId" IS NULL GROUP BY 1 ORDER BY 1`)).rows
  out.families = (await c.query(`
    SELECT f."workspaceId" AS ws, f.id, f.code, f.label, count(p.id)::int AS parents,
      (SELECT count(*)::int FROM "FamilyAttribute" a WHERE a."familyId" = f.id) AS attributes
    FROM "ProductFamily" f LEFT JOIN "Product" p ON p."familyId" = f.id AND p."deletedAt" IS NULL AND p."parentId" IS NULL
    GROUP BY 1, 2, 3, 4 ORDER BY 1, parents DESC`)).rows
  out.byType = (await c.query(`
    SELECT p."workspaceId" AS ws, coalesce(p."productType", '(none)') AS product_type,
      count(*) FILTER (WHERE p."familyId" IS NULL)::int AS without_family,
      count(*) FILTER (WHERE p."familyId" IS NOT NULL)::int AS with_family,
      (array_agg(p.sku ORDER BY p.sku) FILTER (WHERE p."familyId" IS NULL))[1:4] AS sample_skus
    FROM "Product" p WHERE p."deletedAt" IS NULL AND p."parentId" IS NULL GROUP BY 1, 2 ORDER BY 1, 3 DESC`)).rows
  out.typeToFamily = (await c.query(`
    SELECT p."workspaceId" AS ws, p."productType" AS product_type, f.code, f.label, count(*)::int AS parents
    FROM "Product" p JOIN "ProductFamily" f ON f.id = p."familyId"
    WHERE p."deletedAt" IS NULL AND p."parentId" IS NULL GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, parents DESC`)).rows
  await c.query('ROLLBACK')
} finally {
  await c.end()
}
console.log('SUMMARY ' + JSON.stringify({ role: out.role, readOnly: out.readOnly, productRowsVisible: out.productRowsVisible, workspaces: out.workspaces, parents: out.parents }))
for (const f of out.families) console.log('FAMILY ' + JSON.stringify(f))
for (const t of out.byType) console.log('TYPE ' + JSON.stringify(t))
for (const m of out.typeToFamily) console.log('TYPEFAM ' + JSON.stringify(m))
