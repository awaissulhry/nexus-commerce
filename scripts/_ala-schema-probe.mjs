#!/usr/bin/env node
// READ-ONLY — Phase 0a instrumentation for the Amazon Listing Accuracy (ALA) engagement.
// Quantifies how often each audited gap actually appears in our cached Amazon schemas
// + our real suppression history. No writes. Reads DATABASE_URL from packages/database/.env
// via Prisma (the URL never leaves Prisma's process env).
//
// Run from repo root:  node scripts/_ala-schema-probe.mjs
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// Root .env carries the prod Neon DATABASE_URL (packages/database/.env is a
// localhost placeholder in this checkout). Read-only queries only.
config({ path: join(here, '..', '.env') })

const prisma = new PrismaClient()

// Recursively tally how many times each interesting JSON-Schema key appears anywhere
// in a schema document, and whether a property's subtree contains a given key.
const KEYS = [
  'maxUtf8ByteLength',
  'minUtf8ByteLength',
  'maxLength',
  'enum',
  'enumDeprecated',
  '$lifecycle',
  'replacedBy',
  'allOf',
]

function tally(node, counts) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const x of node) tally(x, counts)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    if (KEYS.includes(k)) counts[k] = (counts[k] ?? 0) + 1
    tally(v, counts)
  }
}

// Does this subtree contain `key` anywhere?
function subtreeHas(node, key) {
  if (node == null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((x) => subtreeHas(x, key))
  for (const [k, v] of Object.entries(node)) {
    if (k === key) return true
    if (subtreeHas(v, key)) return true
  }
  return false
}

function analyzeSchema(def) {
  const counts = {}
  tally(def, counts)

  const props = def?.properties && typeof def.properties === 'object' ? def.properties : {}
  const propNames = Object.keys(props)

  const attrsWithByteLimit = propNames.filter((p) => subtreeHas(props[p], 'maxUtf8ByteLength'))
  const attrsWithMaxLength = propNames.filter((p) => subtreeHas(props[p], 'maxLength'))
  // Attributes that constrain length by CHARACTERS only (maxLength) and NOT by bytes —
  // the exact surface where char-vs-byte counting diverges for multi-byte IT/DE/FR text.
  const charOnly = attrsWithMaxLength.filter((p) => !subtreeHas(props[p], 'maxUtf8ByteLength'))

  // Root-level conditional requirements (Amazon puts if/then required-field logic in a
  // top-level allOf). Count the rules and how many actually drive `required`.
  const rootAllOf = Array.isArray(def?.allOf) ? def.allOf : []
  const rootAllOfDrivingRequired = rootAllOf.filter((r) => subtreeHas(r, 'required')).length

  const topRequired = Array.isArray(def?.required) ? def.required.length : 0

  return {
    propCount: propNames.length,
    topRequired,
    counts,
    byteLimitAttrs: attrsWithByteLimit,
    byteLimitCount: counts.maxUtf8ByteLength ?? 0,
    charOnlyAttrs: charOnly,
    rootAllOf: rootAllOf.length,
    rootAllOfDrivingRequired,
    enumDeprecated: counts.enumDeprecated ?? 0,
    lifecycle: counts.$lifecycle ?? 0,
  }
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

async function main() {
  const now = Date.now()
  console.log('═══ ALA Phase 0a — Amazon schema + suppression probe ═══\n')

  // ---- 1. Cached Amazon schema inventory ----
  const schemas = await prisma.categorySchema.findMany({
    where: { channel: 'AMAZON' },
    select: {
      productType: true,
      marketplace: true,
      schemaVersion: true,
      schemaDefinition: true,
      fetchedAt: true,
      expiresAt: true,
      isActive: true,
    },
    orderBy: [{ productType: 'asc' }, { marketplace: 'asc' }],
  })

  console.log(`AMAZON CategorySchema rows cached: ${schemas.length}`)
  if (schemas.length === 0) {
    console.log('  (none cached yet — schemas are fetched lazily when a product type is opened)')
  }

  const agg = {
    schemas: schemas.length,
    expired: 0,
    withByteLimits: 0,
    withRootAllOf: 0,
    withDeprecatedEnums: 0,
    withLifecycle: 0,
    totalByteLimitAttrs: 0,
    totalCharOnlyAttrs: 0,
    totalRootAllOf: 0,
  }
  const charOnlySamples = new Set()

  console.log(
    '\n' +
      pad('productType', 22) +
      pad('mkt', 5) +
      pad('version', 14) +
      pad('age(h)', 8) +
      pad('props', 7) +
      pad('req', 5) +
      pad('byteLim', 9) +
      pad('charOnly', 10) +
      pad('allOf', 7) +
      pad('depEnum', 8),
  )
  console.log('─'.repeat(101))

  for (const s of schemas) {
    let a
    try {
      a = analyzeSchema(s.schemaDefinition)
    } catch (err) {
      console.log(pad(s.productType, 22) + 'ANALYZE ERROR: ' + (err?.message ?? err))
      continue
    }
    const ageH = ((now - new Date(s.fetchedAt).getTime()) / 3_600_000).toFixed(1)
    const expired = new Date(s.expiresAt).getTime() < now
    if (expired) agg.expired++
    if (a.byteLimitCount > 0) agg.withByteLimits++
    if (a.rootAllOf > 0) agg.withRootAllOf++
    if (a.enumDeprecated > 0) agg.withDeprecatedEnums++
    if (a.lifecycle > 0) agg.withLifecycle++
    agg.totalByteLimitAttrs += a.byteLimitAttrs.length
    agg.totalCharOnlyAttrs += a.charOnlyAttrs.length
    agg.totalRootAllOf += a.rootAllOf
    a.charOnlyAttrs.forEach((p) => charOnlySamples.add(p))

    console.log(
      pad(s.productType, 22) +
        pad(s.marketplace ?? '—', 5) +
        pad(s.schemaVersion, 14) +
        pad(ageH + (expired ? '*' : ''), 8) +
        pad(a.propCount, 7) +
        pad(a.topRequired, 5) +
        pad(a.byteLimitAttrs.length, 9) +
        pad(a.charOnlyAttrs.length, 10) +
        pad(`${a.rootAllOf}/${a.rootAllOfDrivingRequired}`, 7) +
        pad(a.enumDeprecated, 8),
    )
  }

  console.log('\n── Schema aggregate ──')
  console.log(`  schemas analysed:                 ${agg.schemas}`)
  console.log(`  expired (past 24h TTL, *):        ${agg.expired}`)
  console.log(`  schemas with ≥1 byte-limit attr:  ${agg.withByteLimits}  → P0 byte-length gap surface`)
  console.log(`  total byte-limited attributes:    ${agg.totalByteLimitAttrs}`)
  console.log(`  attrs char-limited but NOT byte:  ${agg.totalCharOnlyAttrs}  (where char≈byte; lower risk)`)
  console.log(`  schemas with root allOf rules:    ${agg.withRootAllOf}  → P1 conditional-required gap surface`)
  console.log(`  total root allOf rules:           ${agg.totalRootAllOf}`)
  console.log(`  schemas with deprecated enums:    ${agg.withDeprecatedEnums}  → P2 deprecation gap surface`)
  console.log(`  schemas with $lifecycle blocks:   ${agg.withLifecycle}`)
  if (charOnlySamples.size) {
    console.log(
      `  sample byte-limited attrs:        ${[...charOnlySamples].slice(0, 12).join(', ')}`,
    )
  }

  // ---- 2. Real suppression / error history ----
  console.log('\n── AmazonSuppression history (real error signal) ──')
  const supTotal = await prisma.amazonSuppression.count()
  const supOpen = await prisma.amazonSuppression.count({ where: { resolvedAt: null } })
  console.log(`  total suppression rows:           ${supTotal}  (open: ${supOpen}, resolved: ${supTotal - supOpen})`)

  if (supTotal > 0) {
    const bySeverity = await prisma.amazonSuppression.groupBy({
      by: ['severity'],
      _count: { _all: true },
    })
    console.log('  by severity: ' + bySeverity.map((r) => `${r.severity}=${r._count._all}`).join('  '))

    const bySource = await prisma.amazonSuppression.groupBy({
      by: ['source'],
      _count: { _all: true },
    })
    console.log('  by source:   ' + bySource.map((r) => `${r.source}=${r._count._all}`).join('  '))

    const byReason = await prisma.amazonSuppression.groupBy({
      by: ['reasonCode'],
      _count: { _all: true },
      orderBy: { _count: { reasonCode: 'desc' } },
      take: 10,
    })
    console.log('  top reason codes (the failing-attribute signal we currently lose detail on):')
    for (const r of byReason) {
      console.log(`    ${pad(r.reasonCode ?? '(null)', 28)} ${r._count._all}`)
    }
  }

  console.log('\n═══ done ═══')
}

main()
  .catch((e) => {
    console.error('PROBE ERROR:', e?.message ?? e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
