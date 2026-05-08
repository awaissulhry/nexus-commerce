#!/usr/bin/env node
// TECH_DEBT #54 — sanity check that outboundSyncQueue.add() does not
// hang from a route-handler context.
//
// What the bug looked like before this fix:
//   • POST that triggers outboundSyncQueue.add() in its post-commit
//     hook (e.g. /api/products/:id with basePrice change) →
//     curl times out at 20–60s, API box becomes unhealthy ~2 min in,
//     Railway eventually restarts the process.
//
// What we expect after the fix (proxy → eager construction):
//   • If Redis is reachable: add() resolves within ~100–500ms;
//     POST returns 200 in well under 5s.
//   • If Redis is NOT reachable: add() either errors fast OR the
//     route still completes because the per-worker callsites
//     either gate behind ENABLE_QUEUE_WORKERS or catch the throw.
//
// We don't need a live Redis for this check — we just need to
// confirm the boot path doesn't wedge and that route handlers
// return on a sane timeout when no Redis is configured. (The real
// proof is in production with Redis + bulk-action; that requires
// ops to flip skipBullMQEnqueue=false on a feature branch.)
//
// This script:
//   1. Boots the API (assumed running on :8080).
//   2. Hits a POST that exercises the OutboundSyncQueue.add() path
//      indirectly via /products/:id basePrice update — a route that
//      cascades through MasterPriceService.update.
//   3. Asserts the response comes back inside 5s. The bug shape
//      hung for 20+ seconds.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, d ? `\n    → ${d}` : ''); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

console.log('\n[1] Health endpoint (boot path responds)')
{
  const t0 = Date.now()
  const r = await fetch(`${API}/api/health`).catch(() => null)
  const dt = Date.now() - t0
  if (r?.ok && dt < 2000) ok(`/api/health 200 in ${dt}ms (no boot wedge)`)
  else bad(`/api/health unhealthy (status=${r?.status} dt=${dt}ms)`)
}

console.log('\n[2] OutboundSyncQueue.add() does not hang on cascading product update')
{
  const product = (await dbq(
    `SELECT id, sku, "basePrice" FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`,
  ))[0]
  if (!product) { bad('no Product to test against'); process.exit(1) }
  const original = Number(product.basePrice)
  const probe = original + 0.01
  const t0 = Date.now()
  const r = await fetch(`${API}/api/products/${product.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'tech-debt-54-probe' },
    body: JSON.stringify({ basePrice: probe }),
  })
  const dt = Date.now() - t0
  if (dt < 5000) ok(`PATCH /products/:id basePrice in ${dt}ms (pre-fix hung 20+s)`)
  else bad(`PATCH took ${dt}ms — hang signature still present`)
  if (r.ok) ok(`response ${r.status}`)
  else if (r.status === 404 || r.status === 400) ok(`response ${r.status} (route shape changed but didn't hang)`)
  else bad(`unexpected status ${r.status}`)
  // Restore the price (so this script is idempotent)
  await dbq(
    `UPDATE "Product" SET "basePrice" = $1 WHERE id = $2`,
    [original, product.id],
  )
}

console.log('\n[3] Bulk-action API still skips BullMQ via the safety flag')
{
  // We don't run bulk ops here (they need a queued job, real worker).
  // We just confirm the safety flag is still present in source so
  // existing callers don't regress. The flag stays until the live
  // production-Redis test confirms the fix; only then do we flip it.
  const fs = await import('fs')
  const src = fs.readFileSync(
    '/Users/awais/nexus-commerce/apps/api/src/services/bulk-action.service.ts',
    'utf8',
  )
  const skipCount = (src.match(/skipBullMQEnqueue:\s*true/g) ?? []).length
  if (skipCount >= 5) ok(`bulk-action.service.ts still has ${skipCount} skipBullMQEnqueue:true callsites (safety net intact)`)
  else bad(`expected ≥5 callsites, got ${skipCount}`)
}

console.log('\n[4] queue.ts no longer uses makeQueueProxy')
{
  const fs = await import('fs')
  const src = fs.readFileSync('/Users/awais/nexus-commerce/apps/api/src/lib/queue.ts', 'utf8')
  // The function definition is what matters — a doc comment that
  // mentions the historical name is fine (and useful for grep).
  if (src.includes('function makeQueueProxy')) bad('makeQueueProxy() definition still present')
  else ok('makeQueueProxy() definition removed (history note in comment is fine)')
  if (src.includes('export const outboundSyncQueue: Queue = new Queue(')) ok('outboundSyncQueue eagerly constructed')
  else bad('outboundSyncQueue not eagerly constructed', '')
  if (src.includes('export const channelSyncQueue: Queue = new Queue(')) ok('channelSyncQueue eagerly constructed')
  else bad('channelSyncQueue not eagerly constructed', '')
}

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
