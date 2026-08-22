import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
const out: any = {}
out.writeEnabled = (await q(`
  SELECT count(*)::int campaigns, count(*) FILTER (WHERE "liveBidWritesEnabled")::int live_write_enabled,
         count(*) FILTER (WHERE "bidsSuppressedAt" IS NOT NULL)::int suppressed_now
  FROM "Campaign"`))[0]
// The TRUE exposure: suppressed positive keyword targets that the write gate WOULD let through
out.trueExposure = (await q(`
  SELECT count(*)::int targets_in_write_enabled_campaigns,
         count(*) FILTER (WHERE t."bidCents" <= 3 OR t."suppressedFromBidCents" IS NOT NULL)::int suppressed_any,
         count(*) FILTER (WHERE t."bidCents" <= 3 AND t."suppressedFromBidCents" IS NULL)::int low_but_unflagged,
         count(*) FILTER (WHERE c."bidsSuppressedAt" IS NOT NULL)::int in_a_suppressed_campaign
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false AND c."liveBidWritesEnabled"=true`))[0]
await prisma.$disconnect()
console.log('===JSON===' + JSON.stringify(out, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
