#!/usr/bin/env node
// OX.15 — /orders list query benchmark.
//
// Runs the Prisma query that GET /api/orders uses, with timing for
// p50/p95/p99. The OX.4 rebuild added several joins (items.product,
// items.product.images take:1, routingDecisions, fiscalInvoice,
// shipments.items) — this validates they don't blow up at scale.
//
// Reads DATABASE_URL from root .env. Strips the `-pooler` segment
// per the Neon migration memory.
//
// Usage:
//   node scripts/bench-orders-list.mjs                  # 20 iterations, pageSize=50
//   node scripts/bench-orders-list.mjs --page-size 500  # max page size
//   node scripts/bench-orders-list.mjs --iterations 30

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const args = process.argv.slice(2)
const psFlag = args.findIndex((a) => a === '--page-size')
const itFlag = args.findIndex((a) => a === '--iterations')

const pageSize = psFlag >= 0 ? parseInt(args[psFlag + 1] ?? '50', 10) || 50 : 50
const iterations = itFlag >= 0 ? parseInt(args[itFlag + 1] ?? '20', 10) || 20 : 20

const dbUrl = process.env.DATABASE_URL?.replace('-pooler', '')
if (!dbUrl) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

const where = { deletedAt: null }

async function runOnce() {
  const t0 = Date.now()
  await prisma.order.findMany({
    where,
    orderBy: { purchaseDate: 'desc' },
    take: pageSize,
    include: {
      items: {
        select: {
          id: true,
          sku: true,
          quantity: true,
          price: true,
          productId: true,
          product: {
            select: {
              id: true,
              name: true,
              amazonAsin: true,
              images: { select: { url: true }, take: 1, orderBy: { sortOrder: 'asc' } },
            },
          },
        },
      },
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      reviewRequests: { select: { id: true, channel: true, status: true, sentAt: true, scheduledFor: true } },
      _count: { select: { items: true, shipments: true, returns: true, financialTransactions: true } },
    },
  })
  return Date.now() - t0
}

async function totalOrders() {
  return prisma.order.count({ where })
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.floor((p / 100) * sorted.length)
  return sorted[Math.min(idx, sorted.length - 1)]
}

const total = await totalOrders()
console.log(`[bench-orders-list] DB has ${total.toLocaleString()} orders (deletedAt IS NULL)`)
console.log(`[bench-orders-list] running ${iterations} iterations, pageSize=${pageSize}…`)

// Warm-up
await runOnce()

const samples = []
for (let i = 0; i < iterations; i++) {
  const ms = await runOnce()
  samples.push(ms)
  process.stdout.write('.')
}
process.stdout.write('\n')

console.log(`p50:  ${pct(samples, 50)}ms`)
console.log(`p95:  ${pct(samples, 95)}ms`)
console.log(`p99:  ${pct(samples, 99)}ms`)
console.log(`min:  ${Math.min(...samples)}ms · max: ${Math.max(...samples)}ms`)
console.log(`mean: ${Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)}ms`)

await prisma.$disconnect()
