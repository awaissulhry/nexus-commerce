/** CAP — exploratory. What is in a trigger context, and what does one execution row stand for? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: number | bigint) => Number(n).toLocaleString('en-IE')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: {
    id: true, name: true, trigger: true, autonomyLevel: true, dryRun: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    actions: true, createdAt: true, updatedAt: true,
  },
  orderBy: { name: 'asc' },
})
console.log(`enabled advertising rules: ${rules.length}\n`)
for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? (r.actions as unknown[]) : []).map((a) => String((a as { type?: string })?.type))
  const scope = [r.scopeMarketplace && `mkt=${r.scopeMarketplace}`, r.scopePortfolioId && 'portfolio', r.scopeCampaignId && 'campaign', r.scopeProductId && 'product'].filter(Boolean).join(' ') || 'ACCOUNT-WIDE'
  console.log(`${r.name}`)
  console.log(`   trigger=${r.trigger} level=${r.autonomyLevel} dryRun=${r.dryRun} cap=${r.maxExecutionsPerDay} maxValue=${r.maxValueCentsEur ?? '—'} maxDaily=${r.maxDailyAdSpendCentsEur ?? '—'}`)
  console.log(`   scope=${scope}  actions=[${acts.join(', ')}]  created=${r.createdAt.toISOString().slice(0, 10)} updated=${r.updatedAt.toISOString().slice(0, 10)}`)
}

// ── what does one row stand for? distinct top-level triggerData keys per trigger ──
console.log(`\n── triggerData top-level keys, per trigger (last 24h) ──`)
const keyRows = await prisma.$queryRaw<Array<{ trigger: string; k: string; n: bigint }>>`
  SELECT r."trigger" AS trigger, jsonb_object_keys(e."triggerData"::jsonb) AS k, COUNT(*)::bigint AS n
  FROM "AutomationRuleExecution" e
  JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."startedAt" >= NOW() - INTERVAL '24 hours' AND r.domain = 'advertising'
  GROUP BY 1, 2 ORDER BY 1, 3 DESC`
const byTrig = new Map<string, string[]>()
for (const k of keyRows) { const a = byTrig.get(k.trigger) ?? []; a.push(`${k.k}(${int(k.n)})`); byTrig.set(k.trigger, a) }
for (const [t, ks] of byTrig) console.log(`  ${t.padEnd(30)} ${ks.join(' ')}`)

// ── ticks: how many distinct 15-minute buckets did the evaluator write in? ──
const ticks = await prisma.$queryRaw<Array<{ buckets: bigint; rows: bigint; firstAt: Date; lastAt: Date }>>`
  SELECT COUNT(DISTINCT date_trunc('hour', "startedAt") + (FLOOR(EXTRACT(MINUTE FROM "startedAt") / 15) * INTERVAL '15 minutes'))::bigint AS buckets,
         COUNT(*)::bigint AS rows, MIN("startedAt") AS "firstAt", MAX("startedAt") AS "lastAt"
  FROM "AutomationRuleExecution" WHERE "startedAt" >= NOW() - INTERVAL '24 hours'`
console.log(`\n── the tick, account-wide, last 24h ──`)
console.log(`  distinct 15-min buckets with rows: ${int(ticks[0].buckets)} (a full day of a */15 cron is 96)`)
console.log(`  rows: ${int(ticks[0].rows)}  first ${ticks[0].firstAt.toISOString()}  last ${ticks[0].lastAt.toISOString()}`)

// ── active marketplaces = the SCHEDULE fan-out ──
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
console.log(`  active ads connections (SCHEDULE contexts per tick): ${new Set(conns.map((c) => c.marketplace)).size} — ${[...new Set(conns.map((c) => c.marketplace))].join(', ')}`)

// ── does AdvertisingActionLog join back to a rule? ──
const logJoin = await prisma.$queryRaw<Array<{ scope: string; n: bigint }>>`
  SELECT CASE WHEN l."executionId" IS NULL THEN 'no executionId (human or non-rule)' ELSE 'has executionId' END AS scope, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" l WHERE l."createdAt" >= NOW() - INTERVAL '24 hours' GROUP BY 1`
console.log(`\n── AdvertisingActionLog, last 24h ──`)
for (const l of logJoin) console.log(`  ${l.scope.padEnd(38)} ${int(l.n)}`)
const st = await prisma.$queryRaw<Array<{ s: string | null; n: bigint }>>`
  SELECT "amazonResponseStatus" AS s, COUNT(*)::bigint AS n FROM "AdvertisingActionLog"
  WHERE "createdAt" >= NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC`
for (const l of st) console.log(`  amazonResponseStatus=${String(l.s).padEnd(12)} ${int(l.n)}`)

await prisma.$disconnect()
