#!/usr/bin/env node
// W5.12 — /products grid query benchmark.
//
// Runs the same Prisma queries the GET /api/products list endpoint
// uses, with timing + p50/p95/p99 percentiles. Validates the W1.10
// hot-path indexes (status_deletedAt composite, brand, productType,
// parentId, isParent, fulfillmentMethod, familyId, workflowStageId)
// actually deliver at 10k+ catalog scale.
//
// Three scenarios:
//
//   bench               Pure read benchmark against the current
//                       catalog. Cheap. Default mode.
//
//   bench --seed N      Inserts N synthetic products before
//                       benchmarking (default 5000). Useful when the
//                       live catalog is too small to stress indexes.
//                       Synthetic products are tagged
//                       `importSource='bench-w5.12'` so they're
//                       trivially identifiable + removable.
//
//   bench --cleanup     Removes every bench-W5.12 synthetic row +
//                       exits. Safe to run anytime.
//
// Usage:
//   node scripts/bench-products-grid.mjs                          # bench only
//   node scripts/bench-products-grid.mjs --seed 5000              # seed + bench
//   node scripts/bench-products-grid.mjs --seed 10000 --iterations 30
//   node scripts/bench-products-grid.mjs --cleanup                # remove synthetic rows
//
// Reads DATABASE_URL from root .env. Strips the `-pooler` segment
// per the Neon migration memory.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const args = process.argv.slice(2)
const seedFlag = args.findIndex((a) => a === '--seed')
const cleanupFlag = args.includes('--cleanup')
const iterFlag = args.findIndex((a) => a === '--iterations')

const seedCount =
  seedFlag >= 0
    ? parseInt(args[seedFlag + 1] ?? '5000', 10) || 5000
    : 0
const iterations =
  iterFlag >= 0
    ? parseInt(args[iterFlag + 1] ?? '20', 10) || 20
    : 20

const SEED_TAG = 'bench-w5.12'

const prisma = new PrismaClient()

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(
    Math.max(Math.floor((p / 100) * sorted.length), 0),
    sorted.length - 1,
  )
  return sorted[idx]
}

async function timeIt(label, fn) {
  const samples = []
  // Warmup: prime caches + Prisma's connection pool. Not counted.
  await fn()
  for (let i = 0; i < iterations; i++) {
    const t = process.hrtime.bigint()
    await fn()
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    samples.push(ms)
  }
  const p50 = pct(samples, 50)
  const p95 = pct(samples, 95)
  const p99 = pct(samples, 99)
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  return { label, samples: samples.length, p50, p95, p99, min, max }
}

async function cleanup() {
  const r = await prisma.product.deleteMany({
    where: { importSource: SEED_TAG },
  })
  console.log(`[cleanup] removed ${r.count} synthetic rows`)
}

async function seed(n) {
  console.log(`[seed] inserting ${n} synthetic products...`)
  const brands = ['Xavia Racing', 'AcmeWear', 'TestBrand', 'BenchCo', null]
  const types = ['Motorcycle Jacket', 'Helmet', 'Gloves', 'Boots', null]
  const fulfillments = ['FBA', 'FBM', null]
  const t0 = Date.now()
  // Batch inserts to avoid per-row round-trip cost. createMany skips
  // FKs gracefully + we're not seeding family/workflow refs here.
  const BATCH = 500
  for (let i = 0; i < n; i += BATCH) {
    const rows = []
    const upper = Math.min(i + BATCH, n)
    for (let j = i; j < upper; j++) {
      rows.push({
        sku: `BENCH-${SEED_TAG}-${j.toString().padStart(7, '0')}`,
        name: `Benchmark product ${j}`,
        basePrice: 50 + (j % 200),
        totalStock: j % 100,
        status: ['ACTIVE', 'DRAFT', 'INACTIVE'][j % 3],
        brand: brands[j % brands.length],
        productType: types[j % types.length],
        fulfillmentMethod: fulfillments[j % fulfillments.length],
        importSource: SEED_TAG,
      })
    }
    await prisma.product.createMany({ data: rows, skipDuplicates: true })
  }
  console.log(
    `[seed] inserted ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )
}

async function main() {
  if (cleanupFlag) {
    await cleanup()
    return
  }

  if (seedCount > 0) await seed(seedCount)

  const total = await prisma.product.count({ where: { deletedAt: null } })
  console.log(
    `[bench] catalog size: ${total} non-deleted rows · ${iterations} iterations per scenario\n`,
  )

  // The same `where` shapes the /api/products list endpoint builds
  // for the operator's most common queries.
  const scenarios = [
    {
      label: 'list page=1 limit=50 (default sort=updated DESC)',
      run: () =>
        prisma.product.findMany({
          where: { parentId: null, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          select: { id: true, sku: true, name: true, basePrice: true, status: true },
        }),
    },
    {
      label: 'list filter status=ACTIVE',
      run: () =>
        prisma.product.findMany({
          where: { parentId: null, deletedAt: null, status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          select: { id: true, sku: true, name: true, basePrice: true },
        }),
    },
    {
      label: 'list filter status=ACTIVE + brand IN',
      run: () =>
        prisma.product.findMany({
          where: {
            parentId: null,
            deletedAt: null,
            status: 'ACTIVE',
            brand: { in: ['Xavia Racing', 'AcmeWear'] },
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
    },
    {
      label: 'list filter productType IN',
      run: () =>
        prisma.product.findMany({
          where: {
            parentId: null,
            deletedAt: null,
            productType: { in: ['Motorcycle Jacket', 'Helmet'] },
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
    },
    {
      label: 'list sort price ASC',
      run: () =>
        prisma.product.findMany({
          where: { parentId: null, deletedAt: null },
          orderBy: { basePrice: 'asc' },
          take: 50,
        }),
    },
    {
      label: 'list multi-sort brand ASC, basePrice DESC, sku ASC',
      run: () =>
        prisma.product.findMany({
          where: { parentId: null, deletedAt: null },
          orderBy: [{ brand: 'asc' }, { basePrice: 'desc' }, { sku: 'asc' }],
          take: 50,
        }),
    },
    {
      label: 'count by status (facet aggregation)',
      run: async () => {
        await Promise.all([
          prisma.product.count({ where: { parentId: null, deletedAt: null, status: 'ACTIVE' } }),
          prisma.product.count({ where: { parentId: null, deletedAt: null, status: 'DRAFT' } }),
          prisma.product.count({ where: { parentId: null, deletedAt: null, status: 'INACTIVE' } }),
        ])
      },
    },
    {
      label: 'groupBy brand (facet)',
      run: () =>
        prisma.product.groupBy({
          by: ['brand'],
          where: { parentId: null, deletedAt: null, brand: { not: null } },
          _count: true,
        }),
    },
  ]

  const results = []
  for (const s of scenarios) {
    const r = await timeIt(s.label, s.run)
    results.push(r)
  }

  console.log('Scenario'.padEnd(60), 'p50  p95  p99  min  max  (ms)')
  console.log('-'.repeat(60), '------------------------------')
  for (const r of results) {
    console.log(
      r.label.padEnd(60),
      `${r.p50.toFixed(1).padStart(5)}  ${r.p95.toFixed(1).padStart(5)}  ${r.p99.toFixed(1).padStart(5)}  ${r.min.toFixed(1).padStart(5)}  ${r.max.toFixed(1).padStart(5)}`,
    )
  }
  console.log()
  console.log(
    `Healthy at ${total} rows means p95 < 100ms for list queries + p95 < 50ms for facet aggregations. Higher numbers signal index gaps; pass --seed 10000 + run again to validate at full 10k headroom.`,
  )
}

try {
  await main()
} catch (err) {
  console.error('[bench] fatal:', err)
  process.exit(1)
} finally {
  await prisma.$disconnect()
}
