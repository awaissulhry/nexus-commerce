/**
 * ADX G3-revisited — absolute bid ceilings, now that 10 rules are autonomous.
 *
 * Leaving these NULL was right when one rule acted. It is not right with ten, against
 * 78 of 82 campaigns holding no per-campaign bid protection at all.
 *
 * Headroom, not policy: each ceiling sits above that market's own observed peak base
 * bid, so nothing changes today. It exists to catch a runaway, not to steer.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const APPLY = process.argv.includes('--apply')

const peaks = await q(`
  SELECT c.marketplace, MAX(m."intendedValue"::int) AS peak_bid
  FROM "AdMutation" m
  JOIN "AdTarget" t ON t.id = m."entityId"
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE m.field='bid' AND m."createdAt" > now() - interval '90 days'
    AND m."intendedValue" ~ '^[0-9]+$' AND c."liveBidWritesEnabled"
  GROUP BY 1`)
const cpc = await q(`
  SELECT marketplace, ROUND((SUM("costMicros")/1000000.0/NULLIF(SUM(clicks),0)*100)::numeric,0) AS cpc_cents
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '30 days' GROUP BY 1`)
const cpcBy = new Map(cpc.map((r) => [String(r.marketplace), Number(r.cpc_cents ?? 0)]))
const peakBy = new Map(peaks.map((r) => [String(r.marketplace), Number(r.peak_bid ?? 0)]))
const markets = await q(`
  SELECT marketplace, COUNT(*) AS campaigns FROM "Campaign"
  WHERE "liveBidWritesEnabled" AND marketplace IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — absolute bid ceilings (headroom above observed peak)\n`)
const plan: Array<{ mkt: string; ceiling: number }> = []
for (const m of markets) {
  const mkt = String(m.marketplace)
  const peak = peakBy.get(mkt) ?? 0
  const observedCpc = cpcBy.get(mkt) ?? 0
  // 1.5x the higher of observed peak bid and observed CPC, floored at 60c so a market
  // with no bid history is never capped below what a click there actually costs.
  const ceiling = Math.max(60, Math.ceil((Math.max(peak, observedCpc) * 1.5) / 10) * 10)
  plan.push({ mkt, ceiling })
  console.log(`  ${mkt.padEnd(3)} peak=${String(peak || '—').padStart(4)}c  cpc=${String(observedCpc || '—').padStart(4)}c  ->  maxBidCents=${String(ceiling).padStart(4)}c   (${m.campaigns} campaigns)`)
}
if (APPLY) {
  for (const x of plan) {
    await p.campaign.updateMany({ where: { marketplace: x.mkt, liveBidWritesEnabled: true }, data: { maxBidCents: x.ceiling } })
  }
  const n = await p.campaign.count({ where: { liveBidWritesEnabled: true, maxBidCents: { not: null } } })
  console.log(`\n✅ ceilings set on ${n} allowlisted campaigns`)
  console.log(`REVERSAL: UPDATE "Campaign" SET "maxBidCents"=NULL WHERE "liveBidWritesEnabled";`)
}
await p.$disconnect()
