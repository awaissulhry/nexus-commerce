/**
 * ACR Stage 5 — `/sb/keywords` answered 406 "No match for accept header", NOT 404.
 *
 * 406 means the PATH EXISTS and only content negotiation failed, which is a much stronger lead
 * than the 403s from the v4 paths. This walks Accept headers against the endpoint that already
 * told us it is there. READ-ONLY (GET only).
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sb-kw-accept.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true } })
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }

const ACCEPTS = [
  'application/vnd.sbkeyword.v3+json',
  'application/vnd.sbkeywordresource.v3+json',
  'application/vnd.sbkeyword.v4+json',
  'application/vnd.sbkeywordresource.v4+json',
  'application/vnd.sbkeywordsresponse.v3+json',
  'application/json',
  '*/*',
  undefined,
]

for (const accept of ACCEPTS) {
  try {
    const r = await liveCall<unknown>({ ...ctx, method: 'GET', path: '/sb/keywords', acceptHeader: accept })
    const s = JSON.stringify(r)
    console.log(`✔ ${String(accept).padEnd(46)} → ${s.slice(0, 260)}`)
  } catch (e: any) {
    const m = String(e?.message ?? e)
    // Distinguish the informative failures: 406 = path exists, wrong accept. 403/404 = elsewhere.
    const code = m.match(/→ (\d{3})/)?.[1] ?? '?'
    console.log(`✖ ${String(accept).padEnd(46)} → ${code} ${m.slice(m.indexOf('→') + 5, m.indexOf('→') + 120)}`)
  }
}
await prisma.$disconnect(); process.exit(0)
