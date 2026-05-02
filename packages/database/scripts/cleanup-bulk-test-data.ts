/**
 * Removes every Product row marked as a performance-test seed.
 * Safe to run; only deletes where importSource = 'PERFORMANCE_TEST'.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const result = await prisma.product.deleteMany({
    where: { importSource: 'PERFORMANCE_TEST' },
  })
  console.log(`Deleted ${result.count} test products.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
