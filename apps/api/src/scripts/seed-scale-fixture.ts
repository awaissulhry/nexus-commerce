/**
 * PLAN 15.11 (b) — the SCALE FIXTURE.
 *
 * A seeded business at 1,000 and 10,000 products, which the sheet read and the sweeps run against.
 * 15.13 ranks it #2 and says why: *"Everything else is a guess without it."* It is also the
 * POSITIVE CONTROL this plan's measurement rules demand — a sweep that passes on 37 families has
 * not been shown capable of failing.
 *
 *   npx tsx apps/api/src/scripts/seed-scale-fixture.ts --prepare        # once, on a fresh database
 *   npx tsx apps/api/src/scripts/seed-scale-fixture.ts --products 1000
 *   npx tsx apps/api/src/scripts/seed-scale-fixture.ts --products 10000
 *   npx tsx apps/api/src/scripts/seed-scale-fixture.ts --wipe
 *
 * 🔴 `--prepare` IS NOT OPTIONAL, and the reason is a finding of its own.
 * `bootstrap-fresh-database.mjs` (Step 0.4) builds the schema from `baseline.sql`, which carries
 * **0 policies and 0 GRANTs** — measured. A database built by it has no row-level security, no
 * grants for `nexus_workspace_runtime` (the role `workspace-adapter.js:11` switches to on every
 * query), no `Workspace` row and no `ChannelListing.variationExcluded`. Against such a database
 * the app fails with *permission denied for table Product*, and if the grants alone were added it
 * would run with **no business isolation at all** and every measurement would be a per-row filter
 * cheaper than production's. `--prepare` applies exactly what the disposable test database applies
 * (`test-support/concurrent-database.ts:52-55`), so the fixture measures production's shape.
 *
 * 🔴 WHAT THIS FIXTURE PINS, stated so nobody has to guess later. A fixture pins every dimension it
 * does not vary, and the arm that would have failed is the one never run:
 *   · COORDINATES — three by default (`--coordinates`). The readiness sweep's cost is per
 *     destination, so this number is a multiplier on every sweep measurement.
 *   · FAMILY SIZE — five rows per family root (`--family-size`). The sweep works per ROOT, so
 *     products-per-family decides how many sweeps 10,000 products means.
 *   · REQUIREMENTS — each family carries all four of Step 2.1's arms: required-everywhere,
 *     required-on-AMAZON, required-on-EBAY, not-required. A fixture with only the first cannot
 *     show Step 2.1 working or failing.
 *   · FILL — two thirds of the required attributes carry a value, so readiness is neither 0% nor
 *     100% everywhere. A fixture that is uniformly complete cannot show completeness moving.
 *
 * 🔴 SAFETY. Loopback hosts only, and it refuses a database holding products it did not create.
 * Every row it writes carries `importSource = 'SCALE_FIXTURE'` (products) or a `SCALE-` code
 * prefix, so `--wipe` removes exactly what this wrote and nothing else.
 */
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const MARK = 'SCALE_FIXTURE'
const PREFIX = 'SCALE-'

// ── arguments ──────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)

const PRODUCTS = Number(flag('products') ?? 1000)
const FAMILY_SIZE = Number(flag('family-size') ?? 5)
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID
const COORDINATES = (flag('coordinates') ?? 'AMAZON:DE,AMAZON:IT,EBAY:DE')
  .split(',')
  .map((pair) => {
    const [channel, market] = pair.split(':')
    return { channel: channel.toUpperCase(), market: market.toUpperCase() }
  })
const WIPE = has('wipe')
const PREPARE = has('prepare')

// ── deterministic pseudo-random, so two runs seed the same catalogue ──
let rngState = 0x5ca1e000
const rnd = () => {
  rngState = (rngState * 1664525 + 1013904223) >>> 0
  return rngState / 0xffffffff
}
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length]

// ── the catalogue's vocabulary ─────────────────────────────────────
const PRODUCT_TYPES = ['OUTERWEAR', 'LUGGAGE', 'HELMET', 'GLOVES', 'BOOTS', 'ELECTRONICS'] as const
const BRANDS = ['Alvara', 'Northcut', 'Peregrine', 'Solvig'] as const
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const
const COLOURS = ['Black', 'Sand', 'Olive', 'Slate', 'Crimson'] as const

/**
 * The twelve attributes, and their requirement arm. `channels: []` with `required: true` means
 * required EVERYWHERE — `schema.prisma:706-714`'s documented semantics, the ones Step 2.1 exists
 * to stop `family-sheet-schema.ts` discarding.
 */
const ATTRIBUTES: Array<{ code: string; label: string; type: string; required: boolean; channels: string[] }> = [
  { code: 'material', label: 'Material', type: 'TEXT', required: true, channels: [] },
  { code: 'care_instructions', label: 'Care instructions', type: 'TEXT', required: true, channels: [] },
  { code: 'country_of_origin', label: 'Country of origin', type: 'TEXT', required: true, channels: [] },
  { code: 'browse_node', label: 'Browse node', type: 'TEXT', required: true, channels: ['AMAZON'] },
  { code: 'search_terms', label: 'Search terms', type: 'TEXT', required: true, channels: ['AMAZON'] },
  { code: 'item_type_keyword', label: 'Item type keyword', type: 'TEXT', required: true, channels: ['AMAZON'] },
  { code: 'ebay_category', label: 'eBay category', type: 'TEXT', required: true, channels: ['EBAY'] },
  { code: 'condition_note', label: 'Condition note', type: 'TEXT', required: true, channels: ['EBAY'] },
  { code: 'season', label: 'Season', type: 'TEXT', required: false, channels: [] },
  { code: 'collection', label: 'Collection', type: 'TEXT', required: false, channels: [] },
  { code: 'warranty_months', label: 'Warranty (months)', type: 'NUMBER', required: false, channels: [] },
  { code: 'lining', label: 'Lining', type: 'TEXT', required: false, channels: [] },
]

// ── guards ─────────────────────────────────────────────────────────
function refuseRemoteTarget() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    console.error(`\n❌ REFUSED: the scale fixture writes tens of thousands of rows. Host "${host}" is not local.\n`)
    process.exit(1)
  }
  return host
}

async function refuseForeignCatalogue() {
  const [{ n }] = (await prisma.$queryRawUnsafe(
    `select count(*)::int as n from "Product" where "importSource" is distinct from '${MARK}'`,
  )) as Array<{ n: number }>
  if (n > 0) {
    console.error(`\n❌ REFUSED: this database holds ${n} product(s) the fixture did not create.`)
    console.error('   The fixture only ever writes and removes its own rows. Use an empty database.\n')
    process.exit(1)
  }
}

/**
 * Preparation is DBA work and runs UNDER the application: the app's client refuses a `Workspace`
 * write (`workspace_scope_immutable`) and switches role on every query. The disposable test
 * database uses a plain pool for the same reason.
 */
async function withAdminClient<T>(work: (query: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> {
  const pg = await import('pg')
  const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return await work(async (sql) => (await client.query(sql)).rows)
  } finally {
    await client.end()
  }
}

const countPolicies = (query: (sql: string) => Promise<Array<Record<string, unknown>>>) =>
  query(`select count(*)::int as policies from pg_policies`).then((rows) => Number(rows[0].policies))

/**
 * 🔴 Refuse to MEASURE a database that is not shaped like production. A database with no policies
 * runs every query without a per-row filter, so its numbers would be cheaper than production's and
 * would look like good news. A fixture that measures the wrong shape is worse than no fixture.
 */
async function refuseUnpreparedDatabase() {
  const policies = await withAdminClient(countPolicies)
  if (policies === 0) {
    console.error('\n❌ REFUSED: this database has 0 row-level-security policies.')
    console.error('   Production has 444. Measuring here would time a query with no per-row filter.')
    console.error('   Run with --prepare first.\n')
    process.exit(1)
  }
  return policies
}

/** Exactly what `test-support/concurrent-database.ts:52-55` applies to a disposable database. */
async function prepare() {
  const { workspacePolicySql } = await import('../../../../packages/database/scripts/workspace-policies.mjs')
  await withAdminClient(async (query) => {
    await query(`ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false`)
    await query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
       VALUES ('${WORKSPACE}', 'Scale fixture business', 'active', true, 'scale-fixture', 'scale-fixture', CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO NOTHING`)
    await query(workspacePolicySql())
    const policies = await countPolicies(query)
    const rls = Number((await query(
      `select count(*)::int as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity`,
    ))[0].rls)
    console.log(`[scale] prepared — ${policies} policies on ${rls} tables, workspace "${WORKSPACE}" active`)
    if (policies === 0) { console.error('❌ prepare wrote no policies'); process.exit(1) }
  })
}

// ── wipe ───────────────────────────────────────────────────────────
async function wipe() {
  // Products cascade to ChannelListing and ReadinessIndex; the definitions go by their code prefix.
  const products = await prisma.$executeRawUnsafe(`delete from "Product" where "importSource" = '${MARK}'`)
  const families = await prisma.$executeRawUnsafe(`delete from "ProductFamily" where code like '${PREFIX}%'`)
  const attrs = await prisma.$executeRawUnsafe(`delete from "CustomAttribute" where code like '${PREFIX}%'`)
  const groups = await prisma.$executeRawUnsafe(`delete from "AttributeGroup" where code like '${PREFIX}%'`)
  const conns = await prisma.$executeRawUnsafe(`delete from "ChannelConnection" where "accountLabel" like '${PREFIX}%'`)
  console.log(`[scale] wiped — products ${products}, families ${families}, attributes ${attrs}, groups ${groups}, connections ${conns}`)
}

// ── the seed ───────────────────────────────────────────────────────
async function seedDefinitions() {
  // Marketplaces. Only the coordinates the fixture uses, and ACTIVE — an inactive market is
  // invisible to `coordinatesFor()`, so seeding one would silently shrink every sweep.
  const LANGUAGE: Record<string, string> = { DE: 'de', IT: 'it', FR: 'fr', ES: 'es', UK: 'en', US: 'en', GLOBAL: 'en' }
  for (const { channel, market } of COORDINATES) {
    // `findFirst` + create, not `upsert`: the compound unique carries `workspaceId`, which the
    // scoped client supplies at execution and a caller cannot name here.
    const found = await prisma.marketplace.findFirst({ where: { channel, code: market } })
    if (found) { await prisma.marketplace.update({ where: { id: found.id }, data: { isActive: true } }); continue }
    await prisma.marketplace.create({
      data: {
        channel, code: market, name: `${channel} ${market}`, region: market === 'US' ? 'NA' : 'EU',
        currency: market === 'UK' ? 'GBP' : market === 'US' ? 'USD' : 'EUR',
        language: LANGUAGE[market] ?? 'en', isActive: true,
      },
    })
  }

  // 🔴 One ACTIVE connection per channel. Without it `readiness-index.service.ts:78` throws
  // "No active account for this destination", every channel row is written `absent`, and the sweep
  // measures a fraction of its real work. This is the fixture's most important row.
  const connections = new Map<string, string>()
  for (const channel of [...new Set(COORDINATES.map((c) => c.channel))]) {
    const label = `${PREFIX}${channel}`
    const found = await prisma.channelConnection.findFirst({ where: { accountLabel: label } })
    const row = found ?? (await prisma.channelConnection.create({
      data: { channelType: channel, accountLabel: label, displayName: `Scale fixture ${channel}`, isActive: true },
    }))
    connections.set(channel, row.id)
  }

  // One group, twelve attributes.
  const groupCode = `${PREFIX}core`
  const group = (await prisma.attributeGroup.findFirst({ where: { code: groupCode } }))
    ?? (await prisma.attributeGroup.create({ data: { code: groupCode, label: 'Scale fixture core' } }))
  const attributeIds = new Map<string, string>()
  for (const a of ATTRIBUTES) {
    const code = `${PREFIX}${a.code}`
    const row = (await prisma.customAttribute.findFirst({ where: { code } }))
      ?? (await prisma.customAttribute.create({ data: { code, label: a.label, type: a.type, groupId: group.id } }))
    attributeIds.set(a.code, row.id)
  }

  // One family per product type, each carrying all four requirement arms.
  const familyIds: string[] = []
  for (const productType of PRODUCT_TYPES) {
    const code = `${PREFIX}${productType.toLowerCase()}`
    const family = (await prisma.productFamily.findFirst({ where: { code } }))
      ?? (await prisma.productFamily.create({ data: { code, label: `Scale ${productType}` } }))
    familyIds.push(family.id)
    for (const [i, a] of ATTRIBUTES.entries()) {
      const attributeId = attributeIds.get(a.code)!
      const existing = await prisma.familyAttribute.findFirst({ where: { familyId: family.id, attributeId } })
      if (existing) continue
      await prisma.familyAttribute.create({
        data: { familyId: family.id, attributeId, required: a.required, channels: a.channels, sortOrder: i },
      })
    }
  }
  return { familyIds, connections }
}

/**
 * A cuid-shaped id, generated here so a whole family and its listings can go in two `createMany`
 * calls. One `create` per row measured 5 products/second — 33 minutes at 10,000, which makes
 * re-seeding a decision rather than a habit, and a fixture nobody re-runs stops being a fixture.
 */
let idCounter = 0
const newId = () => `c${Date.now().toString(36)}${(idCounter++).toString(36).padStart(5, '0')}${Math.floor(rnd() * 0x7fffffff).toString(36).padStart(6, '0')}`.slice(0, 25)

async function seedProducts(familyIds: string[], connections: Map<string, string>) {
  const existing = await prisma.product.count({ where: { importSource: MARK } })
  const needed = PRODUCTS - existing
  if (needed <= 0) {
    console.log(`[scale] products already at ${existing} (target ${PRODUCTS}) — nothing to add`)
    return { added: 0, listings: 0 }
  }

  const roots = Math.ceil(needed / FAMILY_SIZE)
  const ROOTS_PER_BATCH = 100
  let added = 0
  let listings = 0
  const started = Date.now()

  for (let batchStart = 0; batchStart < roots && added < needed; batchStart += ROOTS_PER_BATCH) {
    const products: Array<Record<string, unknown>> = []
    const listingRows: Array<Record<string, unknown>> = []

    for (let r = batchStart; r < Math.min(batchStart + ROOTS_PER_BATCH, roots) && added + products.length < needed; r++) {
      const n = existing + r
      const productType = PRODUCT_TYPES[n % PRODUCT_TYPES.length]
      const familyId = familyIds[n % familyIds.length]
      const brand = pick(BRANDS)

      // Two thirds of the required attributes carry a value, so readiness is neither 0 nor 100.
      const filled: Record<string, string> = {}
      for (const [i, a] of ATTRIBUTES.entries()) if (i % 3 !== 2) filled[a.code] = `${a.label} ${n}`

      const base = {
        familyId, productType, brand, manufacturer: brand, status: 'ACTIVE', importSource: MARK,
        bulletPoints: [`${brand} ${productType.toLowerCase()}`, 'Second bullet', 'Third bullet'],
        keywords: [productType.toLowerCase(), brand.toLowerCase()],
        syncChannels: [...new Set(COORDINATES.map((c) => c.channel))],
      }

      const rootId = newId()
      const rootPrice = Number((19 + (n % 180) * 1.5).toFixed(2))
      products.push({
        ...base, id: rootId, sku: `${PREFIX}${String(n).padStart(6, '0')}`,
        name: `${brand} ${productType} ${n}`, basePrice: rootPrice, totalStock: n % 250,
        isParent: true, variationTheme: 'SizeColor',
        description: `<p>${brand} ${productType.toLowerCase()} ${n}. Scale fixture body copy.</p>`,
        categoryAttributes: filled,
      })
      const inFamily: Array<{ id: string; price: number }> = [{ id: rootId, price: rootPrice }]

      for (let c = 0; c < FAMILY_SIZE - 1 && added + products.length < needed; c++) {
        const childId = newId()
        const childPrice = Number((rootPrice + c).toFixed(2))
        products.push({
          ...base, id: childId, sku: `${PREFIX}${String(n).padStart(6, '0')}-${c}`,
          name: `${brand} ${productType} ${n} · ${SIZES[c % SIZES.length]} ${COLOURS[c % COLOURS.length]}`,
          basePrice: childPrice, totalStock: (n + c) % 250, parentId: rootId,
          categoryAttributes: { ...filled, apparel_size: SIZES[c % SIZES.length], color: COLOURS[c % COLOURS.length] },
        })
        inFamily.push({ id: childId, price: childPrice })
      }

      for (const p of inFamily) for (const { channel, market } of COORDINATES) {
        listingRows.push({
          productId: p.id, channel, region: market, marketplace: market, channelMarket: `${channel}_${market}`,
          channelConnectionId: connections.get(channel)!, listingStatus: 'ACTIVE',
          price: p.price, quantity: 25, version: 1,
          masterBulletPoints: [], bulletPointsOverride: [], validationErrors: [],
        })
      }
    }

    if (!products.length) break
    added += (await prisma.product.createMany({ data: products as never, skipDuplicates: true })).count
    listings += (await prisma.channelListing.createMany({ data: listingRows as never, skipDuplicates: true })).count
    const rate = added / Math.max(0.001, (Date.now() - started) / 1000)
    process.stdout.write(`\r[scale] ${added}/${needed} products · ${listings} listings · ${rate.toFixed(0)}/s   `)
  }
  process.stdout.write('\n')
  return { added, listings }
}

// ── main ───────────────────────────────────────────────────────────
// Wrapped rather than top-level: `tsconfig.json` does not allow a top-level await here.
async function main() {
const host = refuseRemoteTarget()
const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>
console.log(`[scale] host ${host}  database ${database}  workspace ${WORKSPACE}`)

await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
  if (PREPARE) { await prepare(); return }
  if (WIPE) { await wipe(); return }
  const policies = await refuseUnpreparedDatabase()
  await refuseForeignCatalogue()
  console.log(`[scale] ${policies} row-level-security policies in place`)
  console.log(`[scale] target ${PRODUCTS} products · ${FAMILY_SIZE} per family · coordinates ${COORDINATES.map(c => `${c.channel}·${c.market}`).join(', ')}`)
  const { familyIds, connections } = await seedDefinitions()
  const { added, listings } = await seedProducts(familyIds, connections)

  const totals = {
    products: await prisma.product.count({ where: { importSource: MARK } }),
    roots: await prisma.product.count({ where: { importSource: MARK, parentId: null } }),
    listings: await prisma.channelListing.count(),
    families: familyIds.length,
  }
  console.log(`[scale] added ${added} products, ${listings} listings`)
  console.log(`[scale] TOTAL — ${totals.products} products (${totals.roots} family roots) · ${totals.listings} listings · ${totals.families} families`)
})
}

main().catch((error) => { console.error(error); process.exit(1) })
process.exit(0)
