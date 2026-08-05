/**
 * Release the orphaned Prisma migrate advisory lock (72707369).
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma migrate deploy` takes a SESSION-scoped advisory lock. When it runs through the
 * Neon POOLER, pgbouncer hands it a pooled server connection; if the migrate process then
 * exits without releasing, the lock stays held by a server session pgbouncer keeps alive
 * and reuses for ordinary traffic. Nothing ever releases it, and every subsequent API boot
 * times out after 10s trying to acquire it — a self-sustaining crash loop.
 *
 * WHAT THIS DOES
 * --------------
 * Connects THROUGH the pooler and calls pg_advisory_unlock_all(), which releases only the
 * advisory locks held by the calling session. On any connection other than the orphan it
 * is a no-op. Nothing is terminated and no other session is affected. It retries until it
 * happens to land on the holding server connection, re-checking over the DIRECT endpoint.
 *
 * If this cannot land on the holder (pgbouncer keeps routing elsewhere), the fallback is
 * pg_terminate_backend on that pid — see the bottom of this file.
 *
 * Run:  npx tsx apps/api/scripts/_adv-lock-unlock.mts
 */
import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/apps/api/.env' })
config({ path: '/Users/awais/nexus-commerce/.env' })

const LOCK_ID = 72707369
const pooled = process.env.DATABASE_URL ?? ''
const direct = pooled.replace('-pooler', '')
if (!pooled) { console.error('DATABASE_URL not found'); process.exit(1) }

const { PrismaClient } = await import('@prisma/client')
const num = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

const dp = new PrismaClient({ datasources: { db: { url: direct } } })

const holders = async () =>
  num(
    await dp.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=${LOCK_ID} AND granted`,
    ),
  )[0].n

const detail = async () =>
  num(
    await dp.$queryRawUnsafe(`
      SELECT l.pid, a.state, a.application_name,
             date_trunc('second', now() - a.state_change)::text AS in_state
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype='advisory' AND l.objid=${LOCK_ID} AND l.granted`),
  )

console.log('holders before:', await holders())
console.log('detail:', JSON.stringify(await detail()))

for (let i = 0; i < 60 && (await holders()) > 0; i++) {
  const pc = new PrismaClient({ datasources: { db: { url: pooled } } })
  try {
    const r = num(
      await pc.$queryRawUnsafe(`
        SELECT pg_backend_pid() AS pid,
               (SELECT count(*)::int FROM pg_locks
                 WHERE locktype='advisory' AND objid=${LOCK_ID} AND pid=pg_backend_pid()) AS holds_it,
               pg_advisory_unlock_all() IS NOT NULL AS ran`),
    )[0]
    if (r.holds_it > 0) console.log(`  attempt ${i}: landed on holder pid ${r.pid} — released`)
  } catch (e) {
    console.log(`  attempt ${i}: ${(e as Error).message.split('\n')[0]}`)
  } finally {
    await pc.$disconnect()
  }
}

const after = await holders()
console.log('holders after:', after)

if (after === 0) {
  const got = num(await dp.$queryRawUnsafe(`SELECT pg_try_advisory_lock(${LOCK_ID}) AS got`))[0].got
  console.log('migrate deploy could now acquire the lock:', got)
  if (got) await dp.$queryRawUnsafe(`SELECT pg_advisory_unlock(${LOCK_ID})`)
  console.log('\n✅ Lock clear. Redeploy the API on Railway (or it will recover on its next restart).')
} else {
  console.log(`
❌ Still held. pgbouncer never routed us to the holding session.

FALLBACK — terminate the holding backend. It is an idle pooled connection, so pgbouncer
simply opens a new one; no transaction is lost. Run against the DIRECT endpoint:

  SELECT pg_terminate_backend(<pid from 'detail' above>);
`)
}

await dp.$disconnect()
