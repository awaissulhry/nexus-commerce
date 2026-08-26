/** SYNC.2 — can every local campaign row actually RECEIVE a state update? */
import prisma from '../src/db.js'

console.log('=== Duplicate externalCampaignId (settings sync uses findFirst -> only ONE row updated) ===')
const dupes = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "externalCampaignId", COUNT(*)::int AS n,
         array_agg(status ORDER BY "createdAt") AS statuses,
         array_agg("adProduct" ORDER BY "createdAt") AS products,
         array_agg(marketplace ORDER BY "createdAt") AS markets,
         array_agg(("settingsSyncedAt" IS NOT NULL) ORDER BY "createdAt") AS synced
  FROM "Campaign" WHERE "externalCampaignId" IS NOT NULL
  GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 40`)
if (!dupes.length) console.log('  (none - externalCampaignId is unique)')
for (const d of dupes) console.log(`  ${d.externalCampaignId} n=${d.n} statuses=${JSON.stringify(d.statuses)} products=${JSON.stringify(d.products)} markets=${JSON.stringify(d.markets)} synced=${JSON.stringify(d.synced)}`)

console.log('\n=== Campaigns with NO externalCampaignId (sync can never match them) ===')
const orphan = await prisma.$queryRawUnsafe<any[]>(`
  SELECT status, "adProduct", COUNT(*)::int AS n FROM "Campaign"
  WHERE "externalCampaignId" IS NULL GROUP BY 1,2 ORDER BY 3 DESC`)
if (!orphan.length) console.log('  (none)')
for (const r of orphan) console.log(`  ${String(r.status).padEnd(9)} ${String(r.adProduct).padEnd(20)} n=${r.n}`)

console.log('\n=== Total rows the Ad Manager grid can render (no status filter, limit 200/500) ===')
const tot = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS all_rows,
         COUNT(*) FILTER (WHERE status='ENABLED')::int AS enabled,
         COUNT(*) FILTER (WHERE status='PAUSED')::int AS paused,
         COUNT(*) FILTER (WHERE status='ARCHIVED')::int AS archived
  FROM "Campaign"`)
console.log(' ', JSON.stringify(tot[0]))

console.log('\n=== ENABLED campaigns: how each got its status, by ad product + sync freshness ===')
const en = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "adProduct", marketplace, COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE "settingsSyncedAt" IS NULL)::int AS never_v3_synced,
         COUNT(*) FILTER (WHERE "externalCampaignId" IS NULL)::int AS no_ext_id
  FROM "Campaign" WHERE status='ENABLED' GROUP BY 1,2 ORDER BY 3 DESC`)
for (const r of en) console.log(`  ${String(r.adProduct).padEnd(20)} ${String(r.marketplace).padEnd(6)} enabled=${String(r.n).padStart(4)} neverV3=${String(r.never_v3_synced).padStart(4)} noExtId=${String(r.no_ext_id).padStart(4)}`)

console.log('\n=== AmazonAdsConnection profiles (the sync loops over these) ===')
const conns = await prisma.amazonAdsConnection.findMany({ select: { profileId: true, region: true, marketplace: true, mode: true, writesEnabledAt: true, lastError: true } })
for (const c of conns as any[]) console.log(`  profile=${c.profileId} region=${c.region} marketplace=${c.marketplace} mode=${c.mode} writesEnabledAt=${c.writesEnabledAt ? "yes" : "no"} lastError=${(c.lastError ?? "-").slice(0,60)}`)

console.log('\n=== Campaign.marketplace values vs connection marketplaces ===')
const mk = await prisma.$queryRawUnsafe<any[]>(`SELECT marketplace, COUNT(*)::int AS n FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
for (const r of mk) console.log(`  ${String(r.marketplace).padEnd(16)} n=${r.n}`)

await prisma.$disconnect()
