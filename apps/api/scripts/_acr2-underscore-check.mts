/**
 * ACR.2.4b — is "EXACT and _EXACT coexist as two vocabularies" true, or was that the same
 * negativity-filter contamination? And do the three champion rules agree on live data?
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('1. do POSITIVE targets ever use the _EXACT / _PHRASE spelling?')
show(await q(`SELECT t."isNegative", t."expressionType", COUNT(*)::int AS targets
  FROM "AdTarget" t WHERE t.kind='KEYWORD' AND t."expressionType" LIKE '\\_%'
  GROUP BY 1,2 ORDER BY 1,2`))

h('2. the campaign I cited this morning — GALE BROAD IT, split by negativity')
show(await q(`SELECT t."isNegative", t."expressionType", COUNT(*)::int AS targets
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.name = 'GALE BROAD IT' AND t.kind='KEYWORD'
  GROUP BY 1,2 ORDER BY 1,2`))

h('3. negativeLevel — is _EXACT the AD-GROUP negative spelling?')
show(await q(`SELECT COALESCE(t."negativeLevel",'(null)') AS level, t."expressionType", COUNT(*)::int AS targets
  FROM "AdTarget" t WHERE t.kind='KEYWORD' AND t."isNegative" = true
  GROUP BY 1,2 ORDER BY 1,3 DESC`), 12)

await p.$disconnect()
