/**
 * ACR.0.2d — the ToS-IS error text, from what prod already persisted. READ-ONLY, instant.
 *
 * Every outbound channel call writes an OutboundApiCallLog row, and failures are also
 * fingerprinted into SyncLogErrorGroup with a sampleMessage. So the nine nightly ToS-IS
 * failures have very likely been recorded verbatim all along — no need to re-issue a live
 * report and wait on Amazon's async generation.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr02-error-log.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return console.log('  (none)')
  for (const r of rows) console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('\n    '))
}
const h = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`)

h('1. SyncLogErrorGroup — fingerprinted failures mentioning reports/ads')
show(await q(`
  SELECT operation, "errorType", "errorCode", count,
         "lastSeen"::text AS last_seen, LEFT("sampleMessage", 400) AS sample
  FROM "SyncLogErrorGroup"
  WHERE operation ILIKE '%report%' OR operation ILIKE '%ads%' OR "sampleMessage" ILIKE '%topOfSearch%'
  ORDER BY "lastSeen" DESC
  LIMIT 12
`))

h('2. OutboundApiCallLog — recent FAILED ads calls (the nightly 02:30 window)')
show(await q(`
  SELECT operation, "statusCode", "errorCode", "errorType",
         COUNT(*)::int AS hits,
         MAX("createdAt")::text AS last_at,
         LEFT(MAX("errorMessage"), 400) AS sample
  FROM "OutboundApiCallLog"
  WHERE success = false
    AND "createdAt" > now() - interval '10 days'
    AND (operation ILIKE '%report%' OR operation ILIKE '%ads%' OR endpoint ILIKE '%reporting%')
  GROUP BY operation, "statusCode", "errorCode", "errorType"
  ORDER BY hits DESC
  LIMIT 15
`))

h('3. Anything at all logged around the 02:30 ToS-IS runs')
show(await q(`
  SELECT date_trunc('day', "createdAt")::date::text AS day,
         operation, "statusCode", success, COUNT(*)::int AS calls,
         LEFT(MAX("errorMessage"), 300) AS sample
  FROM "OutboundApiCallLog"
  WHERE "createdAt" > now() - interval '10 days'
    AND EXTRACT(hour FROM "createdAt") = 2
  GROUP BY 1, operation, "statusCode", success
  ORDER BY day DESC, calls DESC
  LIMIT 20
`))

await p.$disconnect()
console.log('\nDone — read-only.\n')
