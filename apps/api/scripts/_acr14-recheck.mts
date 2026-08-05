/** ACR.1.4 — recheck the three numbers I was about to put on a board. READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const h = (s: string) => console.log(`\n── ${s} ──`)

h('1. non-delivering enabled campaigns — count and list in ONE query')
console.log(await q(`SELECT COUNT(*)::int AS not_delivering,
  COUNT(*) FILTER (WHERE name LIKE 'ZZ_e2e%')::int AS e2e_artifacts
  FROM "Campaign" WHERE status='ENABLED' AND "deliveryStatus"='NOT_DELIVERING'`))
console.log(await q(`SELECT "deliveryStatus", COUNT(*)::int AS n FROM "Campaign"
  WHERE status='ENABLED' GROUP BY 1 ORDER BY 2 DESC`))

h('2. all-out: does the all-out rank target actually lack a CPC ceiling?')
console.log(await q(`SELECT key, name, "allOut", "maxCpcCents", "acosCapPct", "targetISPct", "biasPct", "maxBiasPct"
  FROM "RankTarget" ORDER BY "sortOrder"`))

h('3. which target key do the 22 all-out-window schedules actually resolve to?')
console.log(await q(`SELECT s."defaultTargetKey", COUNT(*)::int AS schedules
  FROM "AdSchedule" s WHERE s.enabled = true GROUP BY 1 ORDER BY 2 DESC`))
console.log(await q(`SELECT w->>'targetKey' AS window_target, COUNT(*)::int AS windows
  FROM "AdSchedule" s, jsonb_array_elements(s.windows::jsonb) w
  WHERE s.enabled = true GROUP BY 1 ORDER BY 2 DESC`).catch((e) => [{ error: String(e).slice(0, 120) }]))

h('4. pending suggestions — age distribution, so the headline is not one test row')
console.log(await q(`SELECT
    COUNT(*)::int AS pending,
    COUNT(*) FILTER (WHERE "createdAt" > now() - interval '48 hours')::int AS last_48h,
    COUNT(*) FILTER (WHERE "createdAt" < now() - interval '7 days')::int AS older_than_7d,
    MIN("createdAt")::text AS oldest
  FROM "AdsRuleSuggestion" WHERE status='pending'`))

h('5. failed ad mutations — is it still happening?')
console.log(await q(`SELECT DATE("createdAt")::text AS day, COUNT(*)::int AS failed
  FROM "AdMutation" WHERE state='FAILED' AND "createdAt" > now() - interval '14 days'
  GROUP BY 1 ORDER BY 1 DESC`))

await p.$disconnect()
