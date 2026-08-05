/** Waits for the matchType migration to land, then seeds brand protections. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const TERMS: Array<[string,string]> = [
  ['xavia','Brand (257 products)'], ['gale','Family - 1,828 advertised products'],
  ['moss','Family - 400'], ['aireon','Family - 384'], ['misano','Family - 359'],
  ['airmesh','Family - 324'], ['air mesh','Family - spaced variant'],
  ['x-tuta','Family - 294'], ['ventra','Family - 204'], ['regal','Family - 192'],
]
for (let i=0;i<50;i++){
  const c = await q(`SELECT COUNT(*) AS n FROM information_schema.columns
    WHERE table_name='AdKeywordProtection' AND column_name='matchType'`)
  if (Number((c[0] as {n:unknown}).n) === 1) {
    let made = 0
    for (const [term, why] of TERMS) {
      const ex = await p.adKeywordProtection.findFirst({ where: { mode:'WHITELIST', term, marketplace:null, campaignId:null } })
      if (ex) continue
      await p.adKeywordProtection.create({ data: {
        mode:'WHITELIST', term, isPrefix:false, matchType:'CONTAINS',
        reason:`${why} - never negate`, createdBy:'adx:g4-seed' } })
      made++
    }
    console.log(`G4 SEEDED · created=${made} · total=${await p.adKeywordProtection.count()}`)
    await p.$disconnect(); process.exit(0)
  }
  await new Promise((r)=>setTimeout(r,30_000))
}
console.log('G4 TIMEOUT — matchType migration did not land in ~25 min')
await p.$disconnect()
