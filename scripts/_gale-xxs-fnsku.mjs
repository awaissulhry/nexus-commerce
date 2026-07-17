// Pull real FNSKUs from Amazon FBA Inventory API for the XXS + XS Gale SKUs
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const { getInventoryFnskus } = await import('../apps/api/dist/services/fba-inbound.service.js')

const skus = [
  'GALE-JACKET-BLACK-MEN-XXS',
  'GALE-JACKET-YELLOW-MEN-XXS',
  'GALE-JACKET-BLACK-MEN-XS',
  'GALE-JACKET-YELLOW-MEN-XS',
]

console.log('Querying FBA Inventory API for FNSKUs...')
const result = await getInventoryFnskus(skus)

for (const sku of skus) {
  const fnsku = result[sku]
  console.log(`  ${sku.padEnd(36)} FNSKU: ${fnsku ?? '(not in FBA inventory)'}`)
}
console.log('\nFull result:', JSON.stringify(result, null, 2))
