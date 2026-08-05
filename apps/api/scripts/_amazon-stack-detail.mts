/** READ-ONLY follow-up detail for the Amazon stack entitlement audit. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

L('══ BRAND ANALYTICS SQP — freshness + coverage ════════════════════════')
try {
  const rows = await p.$queryRawUnsafe(`SELECT "marketplace","reportPeriod","startDate"::text AS sd, COUNT(*)::int AS n, MAX("ingestedAt")::text AS last FROM "SearchQueryPerformance" GROUP BY 1,2,3 ORDER BY 3 DESC LIMIT 10`)
  for (const r of rows as any[]) L(`  ${r.marketplace}  ${r.reportPeriod}  period ${String(r.sd).slice(0, 10)}  ${String(r.n).padStart(5)} rows  ingested ${String(r.last).slice(0, 19)}`)
} catch (e) { L(`  ⚠️ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }

L('')
L('══ MARKETING STREAM — is the hourly feed genuinely live? ═════════════')
try {
  const rows = await p.$queryRawUnsafe(`SELECT "date"::text AS d, COUNT(*)::int AS n, COUNT(DISTINCT "hour")::int AS hrs, MIN("createdAt")::text AS first_seen, MAX("createdAt")::text AS last_seen FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 1 DESC LIMIT 12`)
  L(`  ${'date'.padEnd(12)} ${'rows'.padStart(6)} ${'hrs'.padStart(4)}  first ingest        last ingest`)
  for (const r of rows as any[]) L(`  ${String(r.d).padEnd(12)} ${String(r.n).padStart(6)} ${String(r.hrs).padStart(4)}  ${String(r.first_seen).slice(0, 19)}  ${String(r.last_seen).slice(0, 19)}`)
  const prod = await p.$queryRawUnsafe(`SELECT "adProduct", COUNT(*)::int AS n FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
  L(`  by adProduct: ${(prod as any[]).map((r) => `${r.adProduct}=${r.n}`).join('  ')}`)
} catch (e) { L(`  ⚠️ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }

L('')
L('══ EXPORTS API v1 — job outcomes ════════════════════════════════════')
try {
  const rows = await p.$queryRawUnsafe(`SELECT "resource","status", COUNT(*)::int AS n, MAX("createdAt")::text AS last FROM "AmazonAdsExportJob" GROUP BY 1,2 ORDER BY 1,2`)
  for (const r of rows as any[]) L(`  ${String(r.resource).padEnd(12)} ${String(r.status).padEnd(12)} ${String(r.n).padStart(6)}  last ${String(r.last).slice(0, 19)}`)
  const err = await p.$queryRawUnsafe(`SELECT "errorMessage", COUNT(*)::int AS n FROM "AmazonAdsExportJob" WHERE "errorMessage" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)
  for (const r of err as any[]) L(`  ⚠️ err ×${r.n}: ${String(r.errorMessage).slice(0, 120)}`)
} catch (e) { L(`  ⚠️ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }

L('')
L('══ REPORTING v3 — which report types succeed ════════════════════════')
try {
  const rows = await p.$queryRawUnsafe(`SELECT "adProduct","reportTypeId","status", COUNT(*)::int AS n, MAX("createdAt")::text AS last FROM "AmazonAdsReportJob" GROUP BY 1,2,3 ORDER BY 1,2,3`)
  for (const r of rows as any[]) L(`  ${String(r.adProduct).padEnd(20)} ${String(r.reportTypeId).padEnd(22)} ${String(r.status).padEnd(11)} ${String(r.n).padStart(5)}  last ${String(r.last).slice(0, 19)}`)
  const err = await p.$queryRawUnsafe(`SELECT "errorMessage", COUNT(*)::int AS n FROM "AmazonAdsReportJob" WHERE "errorMessage" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)
  for (const r of err as any[]) L(`  ⚠️ err ×${r.n}: ${String(r.errorMessage).slice(0, 120)}`)
} catch (e) { L(`  ⚠️ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }

L('')
L('══ ADS CONNECTION + PROFILES ════════════════════════════════════════')
try {
  const c = await p.$queryRawUnsafe(`SELECT "profileId","marketplace","region","mode","isActive","writesEnabledAt"::text,"lastVerifiedAt"::text,"lastError" FROM "AmazonAdsConnection"`)
  for (const r of c as any[]) L(`  profile=${r.profileId} mkt=${r.marketplace} region=${r.region} mode=${r.mode} active=${r.isActive} writesEnabled=${r.writesEnabledAt ?? 'NULL'} lastErr=${String(r.lastError ?? '-').slice(0, 60)}`)
  const pr = await p.$queryRawUnsafe(`SELECT * FROM "AmazonAdsProfile" LIMIT 20`)
  L(`  AmazonAdsProfile rows: ${(pr as any[]).length}`)
  for (const r of pr as any[]) L(`    ${JSON.stringify(r).slice(0, 200)}`)
} catch (e) { L(`  ⚠️ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }

await prisma.$disconnect()
