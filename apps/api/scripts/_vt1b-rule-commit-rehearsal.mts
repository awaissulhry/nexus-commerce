/**
 * VT.1b — the rule COMMIT rehearsed end to end on the LOCAL Docker DB: PUT (dryRun) → PUT (commit) → review →
 * activate → 8 s read-back → RESTORE BY VALUE of the whole `schemaMapping`.
 *
 *   cd apps/api && npx tsx scripts/_vt1b-rule-commit-rehearsal.mts <DATABASE_URL> [API_BASE]
 *
 * Announced in the ledger before it runs. Coordinate: AMAZON·IT, category AUTO_ACCESSORY (the XAVIA family's product
 * type — 18 products, never OUTERWEAR/GALE's live coordinates). The rule now lands at the TOP-LEVEL
 * `variationsByProductType.AUTO_ACCESSORY`, so the capture and the restore are of the WHOLE document rather than one
 * overlay: a restore narrower than the write is a restore that can leave half of it behind.
 */
const url = process.argv[2]
if (!url || url.includes('neon.tech')) { console.error('local DATABASE_URL required; Neon is read-only for this lane'); process.exit(2) }
const API = process.argv[3] ?? 'http://127.0.0.1:8091'
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = any>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const CAT = 'AUTO_ACCESSORY'

const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log(`DB discriminator: GALE-JACKET Product.version = ${gale!.version} (local 59 / Neon prod 51)`)

const mk = (await q<{ id: string }>(`SELECT id FROM "Marketplace" WHERE channel='AMAZON' AND code='IT' LIMIT 1`))[0]!
const whole = async () => (await q<{ md5: string; keys: number; hasRule: boolean; rule: unknown; version: number }>(
  `SELECT md5("schemaMapping"::text) AS md5,
          (SELECT count(*)::int FROM jsonb_object_keys("schemaMapping")) AS keys,
          ("schemaMapping" -> 'variationsByProductType') ? $2 AS "hasRule",
          "schemaMapping" -> 'variationsByProductType' -> $2 AS rule,
          ("schemaMapping" ->> 'version')::int AS version
     FROM "Marketplace" WHERE id = $1`, mk.id, CAT))[0]!
const captured = (await q<{ doc: unknown }>(`SELECT "schemaMapping" AS doc FROM "Marketplace" WHERE id = $1`, mk.id))[0]!.doc

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${API}/api/pim/channel-mapping${path}`, init)
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) as any } } catch { return { status: res.status, body: text as any } }
}
const view = async () => (await api(`/AMAZON/IT/variations/${CAT}`)).body
const fields = async () => {
  const r = await api(`/AMAZON/IT/fields?productType=${CAT}`)
  return { mappingVersion: r.body?.mappingVersion, mapped: r.body?.counts?.mapped, coverage: r.body?.counts?.coveragePct, warnings: (r.body?.mappingWarnings ?? []).length }
}

const before = await whole()
const beforeView = await view()
const beforeFields = await fields()
console.log(`\nBEFORE  document md5 ${before.md5} · ${before.keys} top-level keys · hasRule ${before.hasRule} · version ${before.version}`)
console.log(`BEFORE  view source=${beforeView.source} ruleLabel=${j(beforeView.ruleLabel)} counts=${j(beforeView.counts)} token=${String(beforeView.expectedToken).slice(0, 12)}`)
console.log(`BEFORE  fields ${j(beforeFields)}`)

const RULE = {
  theme: 'COLOR',
  axes: [{ axisKey: 'color', target: 'color', order: 0, included: true }],
  collisions: { resolver: 'exclude', foldInto: null, foldSeparator: ' / ' },
  split: { mode: 'one', axisKey: null },
  label: 'VT.1b commit rehearsal',
}
console.log(`\nPREDICTION: dryRun answers follow=${beforeView.counts.follow} wouldCollide=0; the commit returns 202 + a jobId;`)
console.log(`  after activation the view reads source='rule', ruleLabel='${RULE.label}', and the FIELD rules are untouched`)
console.log(`  (mappingVersion ${beforeFields.mappingVersion}, mapped ${beforeFields.mapped}, coverage ${beforeFields.coverage}).`)

const dry = await api(`/AMAZON/IT/variations/${CAT}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ expectedToken: beforeView.expectedToken, dryRun: true, rule: RULE }),
})
console.log(`\nDRY RUN  ${dry.status} ${j(dry.body)}`)

const commit = await api(`/AMAZON/IT/variations/${CAT}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ expectedToken: beforeView.expectedToken, dryRun: false, rule: RULE }),
})
console.log(`COMMIT   ${commit.status} ${j(commit.body)}`)
const jobId = commit.body?.jobId as string | undefined
if (!jobId) { console.error('no jobId — stopping before any activation'); await p.$disconnect(); process.exit(1) }

// the review has to finish scanning before it can be activated
let review: any = null
for (let attempt = 0; attempt < 20; attempt++) {
  await sleep(1000)
  review = (await api(`/impact/${jobId}`)).body
  if (review?.state !== 'MAPPING_SCANNING') break
}
console.log(`REVIEW   state=${review?.state} counts=${j(review?.counts)} variationChange=${j(review?.variationChange)}`)

const activated = await api(`/impact/${jobId}/activate`, { method: 'POST' })
console.log(`ACTIVATE ${activated.status} ${j(activated.body)}`)

await sleep(8500)
const after = await whole()
const afterView = await view()
const afterFields = await fields()
console.log(`\nREAD-BACK ≥8 s  document md5 ${after.md5} · ${after.keys} top-level keys · hasRule ${after.hasRule} · version ${after.version}`)
console.log(`READ-BACK ≥8 s  stored rule ${j(after.rule)}`)
console.log(`READ-BACK ≥8 s  view source=${afterView.source} ruleLabel=${j(afterView.ruleLabel)} theme=${j(afterView.theme?.code)} counts=${j(afterView.counts)}`)
console.log(`READ-BACK ≥8 s  fields ${j(afterFields)}`)
console.log(`VERDICT  rule stored at the canonical home: ${after.hasRule === true}`)
console.log(`VERDICT  the view now reads it as a RULE: ${afterView.source === 'rule' && afterView.ruleLabel === RULE.label}`)
console.log(`VERDICT  FIELD rules untouched: ${afterFields.mapped === beforeFields.mapped && afterFields.coverage === beforeFields.coverage}`)
console.log(`VERDICT  mapping version bumped by the write: ${after.version === before.version + 1} (${before.version} → ${after.version})`)

// ── RESTORE BY VALUE — the whole document, from the captured bytes ────────────────────────────────
await p.$executeRawUnsafe(`UPDATE "Marketplace" SET "schemaMapping" = $2::jsonb WHERE id = $1`, mk.id, JSON.stringify(captured))
await sleep(8500)
const restored = await whole()
const restoredView = await view()
const restoredFields = await fields()
console.log(`\nRESTORED  document md5 ${restored.md5} · ${restored.keys} keys · hasRule ${restored.hasRule} · version ${restored.version}`)
console.log(`RESTORED  view source=${restoredView.source} counts=${j(restoredView.counts)} token=${String(restoredView.expectedToken).slice(0, 12)}`)
console.log(`VERDICT  document byte-identical to BEFORE: ${restored.md5 === before.md5}`)
console.log(`VERDICT  view identical to BEFORE: ${j(restoredView) === j(beforeView)}`)
console.log(`VERDICT  fields identical to BEFORE: ${j(restoredFields) === j(beforeFields)}`)
await p.$disconnect()
