/**
 * ACR Stage 5 — find the SB NEGATIVE keyword read endpoint. READ-ONLY.
 *
 * 7 SB ad-group negatives sit ARCHIVED locally, wiped by the same `/sp/*`-blind reconciler.
 * Verifying them needs the SB negative endpoint, which is not established. Positive SB keywords
 * turned out to live on the LEGACY path (`/sb/keywords`, `vnd.sbkeyword.v3+json`) rather than v4,
 * so the obvious sibling is tried first — and 406 is read as a LEAD (path exists, wrong Accept),
 * never as a dead end. That distinction is what found the positive endpoint.
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

const CANDIDATES: Array<{ path: string; accept?: string }> = [
  { path: '/sb/negativeKeywords', accept: 'application/vnd.sbnegativekeyword.v3+json' },
  { path: '/sb/negativeKeywords', accept: 'application/vnd.sbkeyword.v3+json' },
  { path: '/sb/negativeKeywords', accept: '*/*' },
  { path: '/sb/negativeKeywords' },
  { path: '/sb/keywords', accept: 'application/vnd.sbkeyword.v3+json' }, // control: known good
]

for (const c of CANDIDATES) {
  const label = `${c.path}  ${c.accept ?? '(no accept)'}`
  try {
    const r = await liveCall<unknown[]>({ ...ctx, method: 'GET', path: c.path, acceptHeader: c.accept })
    console.log(`✔ ${label.padEnd(62)} → ${Array.isArray(r) ? `${r.length} rows` : 'ok'} ${JSON.stringify(r).slice(0, 140)}`)
  } catch (e: any) {
    const m = String(e?.message ?? e)
    const code = m.match(/→ (\d{3})/)?.[1] ?? '?'
    console.log(`✖ ${label.padEnd(62)} → ${code}${code === '406' ? '  ← LEAD: path exists, wrong Accept' : ''}`)
  }
}
await prisma.$disconnect(); process.exit(0)
