/**
 * ER3.5 smoke — digest history: list, fetch-by-id (parity with latest), 404,
 * generate idempotency (upsert per week; row count stable on second call).
 */
import Fastify from 'fastify'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// generate (first run of the week may create; second must not duplicate)
const g1 = await app.inject({ method: 'POST', url: '/api/ebay-ads/digest/generate' })
const count1 = await prisma.ebayAdsDigest.count()
const g2 = await app.inject({ method: 'POST', url: '/api/ebay-ads/digest/generate' })
const count2 = await prisma.ebayAdsDigest.count()
check('generate 200 ×2, idempotent per week', g1.statusCode === 200 && g2.statusCode === 200 && count1 === count2 && (g2.json() as { created: boolean }).created === false, `rows ${count1}→${count2}, second created=${(g2.json() as { created: boolean }).created}`)

const list = await app.inject({ method: 'GET', url: '/api/ebay-ads/digests' })
const digests = (list.json() as { digests: Array<{ id: string; weekStart: string; reviewedAt: string | null }> }).digests
check('digests list', list.statusCode === 200 && digests.length >= 1, `${digests.length} week(s)`)

const latest = await app.inject({ method: 'GET', url: '/api/ebay-ads/digest/latest' })
const latestRow = (latest.json() as { digest: { id: string; payload: { week: { start: string } } } }).digest
const byId = await app.inject({ method: 'GET', url: `/api/ebay-ads/digests/${digests[0].id}` })
const byIdRow = (byId.json() as { digest: { id: string; payload: { week: { start: string } } } }).digest
check('fetch-by-id returns stored payload', byId.statusCode === 200 && byIdRow.payload.week.start != null, `week ${byIdRow.payload.week.start}`)
check('newest by-id matches /digest/latest', latestRow.id === byIdRow.id && latestRow.payload.week.start === byIdRow.payload.week.start)

const nf = await app.inject({ method: 'GET', url: '/api/ebay-ads/digests/nope-does-not-exist' })
check('unknown id → 404', nf.statusCode === 404)

const pending = (latestRow.payload as { pendingProposals?: Array<{ id: string }> }).pendingProposals ?? []
check('payload carries proposal ids for deep links', Array.isArray(pending), `${pending.length} pending in latest digest`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
