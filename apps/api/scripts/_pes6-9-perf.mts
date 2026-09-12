/** PES.6 — measure the catalogue cache against the numbers PES.5 reported (§9.5). */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../.env', import.meta.url).pathname })
const { getFieldCatalogue, clearFieldCatalogueCache } = await import('../src/services/pim/mapping/field-catalogue.service.js')
const { default: prisma } = await import('../src/db.js')

let queries = 0
prisma.$on('query' as never, () => { queries++ })

const runs: Array<[string, number, number]> = []
for (const label of ['cold', 'warm 1', 'warm 2', 'warm 3']) {
  if (label === 'cold') clearFieldCatalogueCache()
  const q0 = queries
  const t = Date.now()
  const c = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
  runs.push([label, Date.now() - t, queries - q0])
  if (label === 'cold') console.log(`  (${c.counts.total} fields, ${c.counts.mapped} mapped, schema ${c.schema.source})`)
}
for (const [l, ms, q] of runs) console.log(`${l.padEnd(8)} ${String(ms).padStart(5)}ms  ${q} queries`)

// eBay for contrast — the coordinate PES.5 measured at 544ms.
clearFieldCatalogueCache()
const t2 = Date.now()
await getFieldCatalogue({ channel: 'EBAY', marketplace: 'IT' })
console.log(`EBAY IT  ${Date.now() - t2}ms (no Amazon blob to walk)`)
await prisma.$disconnect()
process.exit(0)
