/**
 * Phase 5 stress-test seeder.
 * Brings the Product table up to TARGET rows by inserting batched
 * test rows with importSource: 'PERFORMANCE_TEST'. Idempotent
 * (skipDuplicates on the SKU unique).
 *
 * Usage:
 *   DATABASE_URL=<prod-or-dev> npx tsx packages/database/scripts/seed-bulk-test-data.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TARGET = parseInt(process.env.TARGET ?? '10000', 10)
const BRANDS = ['Xavia Racing', 'Test Brand A', 'Test Brand B', 'Performance Test']
const STATUSES = ['ACTIVE', 'DRAFT', 'INACTIVE']
const CHANNELS: string[][] = [['AMAZON'], ['EBAY'], ['AMAZON', 'EBAY'], []]

async function main() {
  const existing = await prisma.product.count()
  const needed = TARGET - existing

  if (needed <= 0) {
    console.log(`Already have ${existing} products; target ${TARGET} met.`)
    return
  }

  console.log(`Seeding ${needed} test rows to reach ${TARGET}...`)

  const BATCH = 500
  let totalInserted = 0
  for (let i = 0; i < needed; i += BATCH) {
    const chunk = Math.min(BATCH, needed - i)
    const data = Array.from({ length: chunk }, (_, idx) => {
      const num = existing + i + idx
      return {
        sku: `TEST-${String(num).padStart(6, '0')}`,
        name: `Performance Test Product ${num} - ${BRANDS[num % 4]} Edition`,
        basePrice: parseFloat((10 + (num % 100) * 1.5).toFixed(2)),
        costPrice: parseFloat((5 + (num % 50) * 0.8).toFixed(2)),
        minMargin: 0.2,
        totalStock: num % 200,
        lowStockThreshold: 10,
        brand: BRANDS[num % 4],
        manufacturer: BRANDS[num % 4],
        upc: `${1000000000 + num}`,
        status: STATUSES[num % 3],
        syncChannels: CHANNELS[num % 4],
        isParent: false,
        amazonAsin: num % 3 === 0 ? `B0TEST${String(num).padStart(5, '0')}` : null,
        importSource: 'PERFORMANCE_TEST',
      }
    })

    const result = await prisma.product.createMany({
      data,
      skipDuplicates: true,
    })
    totalInserted += result.count
    console.log(`  +${result.count} (cumulative: ${totalInserted}/${needed})`)
  }

  const total = await prisma.product.count()
  console.log(`Done. Inserted ${totalInserted}; DB total: ${total}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
