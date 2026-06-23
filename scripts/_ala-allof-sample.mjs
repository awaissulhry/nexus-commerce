#!/usr/bin/env node
// READ-ONLY — dump the real allOf conditional-requirement shape from one cached
// Amazon schema, so the Phase 2 evaluator is modelled on actual data.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', '.env') })
const prisma = new PrismaClient()

const pt = process.argv[2] ?? 'HELMET'
const mkt = process.argv[3] ?? 'IT'

const row = await prisma.categorySchema.findFirst({
  where: { channel: 'AMAZON', productType: pt, marketplace: mkt },
  orderBy: { fetchedAt: 'desc' },
  select: { productType: true, marketplace: true, schemaDefinition: true },
})
if (!row) { console.log('no schema for', pt, mkt); await prisma.$disconnect(); process.exit(0) }

const def = row.schemaDefinition
const allOf = Array.isArray(def.allOf) ? def.allOf : []
console.log(`${pt}/${mkt} — top-level required: ${JSON.stringify(def.required)}`)
console.log(`allOf rules: ${allOf.length}\n`)

// Show the first few rules verbatim + a structural summary of the keys used.
const keysSeen = new Set()
function collectKeys(n, depth = 0) {
  if (n == null || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach((x) => collectKeys(x, depth)); return }
  for (const k of Object.keys(n)) { keysSeen.add(k); collectKeys(n[k], depth + 1) }
}
allOf.forEach((r) => collectKeys(r))
console.log('keys used across allOf rules:', [...keysSeen].sort().join(', '), '\n')

console.log('── first 3 rules verbatim ──')
console.log(JSON.stringify(allOf.slice(0, 3), null, 2).slice(0, 2600))

// Find a rule that references variation_theme (the classic value-dependent case).
const vt = allOf.find((r) => JSON.stringify(r).includes('variation_theme'))
if (vt) {
  console.log('\n── a rule referencing variation_theme ──')
  console.log(JSON.stringify(vt, null, 2).slice(0, 1800))
}

await prisma.$disconnect()
