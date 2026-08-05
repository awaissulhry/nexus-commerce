/**
 * ADX G4 — protect the terms that are objectively yours.
 *
 * Brand and product-family names only. Those need no commercial judgement: nobody wants
 * their own model name negated. Generic terms — "giacca moto", "motorradjacke" — are NOT
 * seeded, because whether to protect a generic is a strategy call about which terms you
 * intend to own, and that is the operator's.
 *
 * CONTAINS, not prefix: Amazon returns "giacca moto xavia", where the brand is last.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

// Evidenced from the catalogue: Product.brand, and the family token in advertised
// product names. Generic English/Italian words that happen to be family names are still
// included — over-protection costs a manual negation, under-protection costs the brand.
const TERMS: Array<{ term: string; why: string }> = [
  { term: 'xavia',   why: 'Brand (257 products)' },
  { term: 'gale',    why: 'Family — 1,828 advertised products' },
  { term: 'moss',    why: 'Family — 400' },
  { term: 'aireon',  why: 'Family — 384' },
  { term: 'misano',  why: 'Family — 359' },
  { term: 'airmesh', why: 'Family — 324' },
  { term: 'air mesh', why: 'Family — spaced variant' },
  { term: 'x-tuta',  why: 'Family — 294' },
  { term: 'ventra',  why: 'Family — 204' },
  { term: 'regal',   why: 'Family — 192' },
]

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — brand/family protection (CONTAINS, all markets)\n`)
for (const t of TERMS) console.log(`  · *${t.term}*  — ${t.why}`)
console.log(`\n  ${TERMS.length} terms. Generic keywords deliberately NOT seeded.`)

if (APPLY) {
  let made = 0
  for (const t of TERMS) {
    const exists = await p.adKeywordProtection.findFirst({
      where: { mode: 'WHITELIST', term: t.term, marketplace: null, campaignId: null },
    })
    if (exists) continue
    await p.adKeywordProtection.create({
      data: {
        mode: 'WHITELIST', term: t.term, isPrefix: false, matchType: 'CONTAINS',
        reason: `${t.why} — never negate`, createdBy: 'adx:g4-seed',
      },
    })
    made++
  }
  console.log(`\n✅ ${made} created · total ${await p.adKeywordProtection.count()}`)
  console.log(`REVERSAL: DELETE FROM "AdKeywordProtection" WHERE "createdBy"='adx:g4-seed';`)
}
await p.$disconnect()
