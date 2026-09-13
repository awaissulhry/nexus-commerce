/**
 * VT.1b / R-VT-2 — the live rehearsal of the exact arm VT.3 measured, on the LOCAL Docker DB only.
 *
 *   cd apps/api && npx tsx scripts/_vt1b-rvt2-rehearsal.mts <DATABASE_URL> [API_BASE]
 *
 * Announced in the ledger before it runs. Coordinate: Marketplace AMAZON·IT, key
 * `schemaMapping.byProductType.AUTO_ACCESSORY.variations` — the XAVIA family's own product type, never OUTERWEAR
 * (GALE's live coordinates). The write is ADDITIVE (one new key inside that overlay), read back after ≥ 8 s, and
 * RESTORED BY VALUE from the captured bytes — never by deleting the key I added, so a partial write cannot leave the
 * overlay half-undone (VT.3's recipe, and its recorded `\copy` failure is why the restore below is a parameterised
 * UPDATE of the whole overlay).
 */
const url = process.argv[2]
if (!url || url.includes('neon.tech')) { console.error('local DATABASE_URL required; Neon is read-only for this lane'); process.exit(2) }
const API = process.argv[3] ?? 'http://127.0.0.1:8091'
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = any>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log(`DB discriminator: GALE-JACKET Product.version = ${gale!.version} (local 59 / Neon prod 51)`)
const apiProbe = await (await fetch(`${API}/api/products?search=GALE-JACKET&limit=60`)).json() as { products: Array<{ sku: string; version: number }> }
console.log(`API ${API}: GALE-JACKET version = ${apiProbe.products.find(x => x.sku === 'GALE-JACKET')?.version}`)

const CAT = 'AUTO_ACCESSORY'
const mk = (await q<{ id: string; updatedAt: Date }>(
  `SELECT id, "updatedAt" FROM "Marketplace" WHERE channel='AMAZON' AND code='IT' LIMIT 1`))[0]
if (!mk) { console.error('AMAZON/IT marketplace row not found'); process.exit(1) }

const overlayState = async () => (await q<{ md5: string; keys: number; without: string; updatedAt: Date; hasKey: boolean }>(
  `SELECT md5(("schemaMapping"->'byProductType'->$2)::text) AS md5,
          (SELECT count(*)::int FROM jsonb_object_keys("schemaMapping"->'byProductType'->$2)) AS keys,
          md5((("schemaMapping"->'byProductType'->$2) - 'variations')::text) AS without,
          "updatedAt" AS "updatedAt",
          ("schemaMapping"->'byProductType'->$2) ? 'variations' AS "hasKey"
     FROM "Marketplace" WHERE id = $1`, mk.id, CAT))[0]!

const apiRead = async () => {
  const res = await fetch(`${API}/api/pim/channel-mapping/AMAZON/IT/fields?productType=${CAT}`)
  const body = await res.json() as any
  return {
    status: res.status,
    mappingVersion: body?.mappingVersion,
    token: String(body?.mappingToken ?? '(ABSENT)').slice(0, 12),
    counts: body?.counts,
    warnings: Array.isArray(body?.mappingWarnings) ? body.mappingWarnings.length : undefined,
  }
}

// ── BEFORE, captured by value ────────────────────────────────────────────────────────────────────
const before = await overlayState()
const beforeBytes = (await q<{ overlay: unknown }>(
  `SELECT "schemaMapping"->'byProductType'->$2 AS overlay FROM "Marketplace" WHERE id = $1`, mk.id, CAT))[0]!.overlay
const beforeApi = await apiRead()
console.log(`\nBEFORE  overlay md5 ${before.md5} · ${before.keys} keys · hasVariations ${before.hasKey} · updatedAt ${before.updatedAt.toISOString()}`)
console.log(`BEFORE  API ${j(beforeApi)}`)

const RULE = {
  theme: 'COLOR_NAME/SIZE_NAME',
  axes: [{ axisKey: 'color', target: 'color', order: 0, included: true }],
  collisions: { resolver: 'fold', foldInto: 'color', foldSeparator: ' / ' },
  split: { mode: 'one', axisKey: null },
  label: 'VT.1b rehearsal',
}
console.log(`\nPREDICTION before the write: overlay keys ${before.keys} → ${before.keys + 1}; md5(overlay - 'variations') UNCHANGED (${before.without});`)
console.log(`  updatedAt UNCHANGED; and the API answer STAYS mappingVersion ${beforeApi.mappingVersion}, counts ${j(beforeApi.counts)} — that is the fix.`)

// ── the write: additive, one key ─────────────────────────────────────────────────────────────────
await p.$executeRawUnsafe(
  `UPDATE "Marketplace" SET "schemaMapping" = jsonb_set("schemaMapping", ARRAY['byProductType', $2, 'variations'], $3::jsonb, true) WHERE id = $1`,
  mk.id, CAT, JSON.stringify(RULE))
console.log('\nwrite issued (jsonb_set, additive)')

await sleep(8500)
const after = await overlayState()
const afterApi = await apiRead()
console.log(`READ-BACK ≥8 s  overlay md5 ${after.md5} · ${after.keys} keys · hasVariations ${after.hasKey} · md5(overlay-'variations') ${after.without} · updatedAt ${after.updatedAt.toISOString()}`)
console.log(`READ-BACK ≥8 s  API ${j(afterApi)}`)
console.log(`VERDICT  key added: ${after.keys === before.keys + 1 && after.hasKey}`)
console.log(`VERDICT  nothing existing moved: ${after.without === before.without}`)
console.log(`VERDICT  mappingVersion HELD at ${beforeApi.mappingVersion}: ${afterApi.mappingVersion === beforeApi.mappingVersion}`)
console.log(`VERDICT  counts identical: ${j(afterApi.counts) === j(beforeApi.counts)}`)
// The token hashes the WHOLE mapping, so adding a key MUST move it. Asserting "identical" here would be the wrong
// claim; asserting it MOVED is the real one, and it is also the positive control that the token is being read at all.
console.log(`VERDICT  token MOVED while the key was present (it hashes the whole mapping): ${afterApi.token !== beforeApi.token} (${beforeApi.token} → ${afterApi.token})`)

// ── restore BY VALUE ─────────────────────────────────────────────────────────────────────────────
await p.$executeRawUnsafe(
  `UPDATE "Marketplace" SET "schemaMapping" = jsonb_set("schemaMapping", ARRAY['byProductType', $2], $3::jsonb, true) WHERE id = $1`,
  mk.id, CAT, JSON.stringify(beforeBytes))
await sleep(8500)
const restored = await overlayState()
const restoredApi = await apiRead()
console.log(`\nRESTORED  overlay md5 ${restored.md5} · ${restored.keys} keys · hasVariations ${restored.hasKey} · updatedAt ${restored.updatedAt.toISOString()}`)
console.log(`RESTORED  API ${j(restoredApi)}`)
console.log(`VERDICT  overlay byte-identical to BEFORE: ${restored.md5 === before.md5 && restored.keys === before.keys && restored.hasKey === false}`)
console.log(`VERDICT  API identical to BEFORE (token included): ${j(restoredApi) === j(beforeApi)}`)
await p.$disconnect()
