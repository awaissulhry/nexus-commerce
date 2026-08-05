/**
 * ACR — post-deploy verification. READ-ONLY.
 *
 * Confirms on prod, against the DB rather than a log line:
 *   1. the ACR.0.3 migration actually applied (column default is SUGGEST)
 *   2. the halt state is what we think it is
 *   3. the gate is now REFUSING writes — the whole point of ACR.0.7
 *
 * (3) is the one that matters. Deploying a stop button and not checking that it
 * stops anything would repeat the exact failure this work exists to fix.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr-verify-deploy.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[]) => rows.length
  ? rows.forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`)

h('1. Did the ACR.0.3 migration apply? (column default should be SUGGEST)')
show(await q(`
  SELECT column_name, column_default
  FROM information_schema.columns
  WHERE table_name = 'AdsAutomationState' AND column_name = 'autonomy'
`))
show(await q(`
  SELECT migration_name, finished_at::text AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM _prisma_migrations WHERE migration_name LIKE '%acr0%' ORDER BY finished_at DESC LIMIT 3
`))

h('2. Current halt state')
show(await q(`
  SELECT autonomy, halted, "haltedBy", "haltedAt"::text AS since,
         "maxActionsPerHour", LEFT("haltReason", 60) AS reason
  FROM "AdsAutomationState" WHERE id = 'singleton'
`))

h('3. THE PROOF — are writes actually being refused since the deploy?')
console.log('  Deploy completed 2026-08-05 10:08 UTC. AdMutation rows written AFTER that,')
console.log('  by actor, and how many reached APPLIED vs were stopped:')
show(await q(`
  SELECT actor,
         COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE state = 'APPLIED')::int AS applied,
         COUNT(*) FILTER (WHERE state = 'FAILED')::int  AS failed,
         COUNT(*) FILTER (WHERE state = 'PENDING')::int AS pending
  FROM "AdMutation"
  WHERE "createdAt" > timestamp '2026-08-05 10:08:00'
  GROUP BY actor ORDER BY rows DESC LIMIT 10
`))
console.log('\n  Before the fix, rank-defend applied ~21 bid changes every 15 min WHILE HALTED.')
console.log('  applied=0 for rank-defend after the deploy is the fix working.')

h('4. Control-room endpoint sanity — engines resolve without error')
const { getEngineLevers } = await import('../src/services/advertising/ads-control-room.service.js')
const { levers, global } = await getEngineLevers()
console.log(`  levers=${levers.length}  autonomy=${global.autonomy}  halted=${global.halted}`)
console.log(`  modes: ${levers.map((l) => `${l.key}=${l.mode}`).join(' ')}`)

await p.$disconnect()
console.log('\nDone — read-only.\n')
process.exit(0)
