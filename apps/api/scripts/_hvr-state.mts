/** HV-REBUILD — read-only census of the harvest surface as it stands today. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const HV = ['promote_to_exact', 'harvest_and_negate', 'keyword-harvesting']
const L: string[] = []
const p = (s: string) => L.push(s)

const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, trigger: true, conditions: true, actions: true, autonomyLevel: true, maxExecutionsPerDay: true } })
const mine = rules.filter((r) => ((r.actions as any[]) ?? []).some((a) => HV.includes(String(a?.type))))
p(`\n═══ advertising rules ${rules.length} · harvest rules ${mine.length} ═══`)
for (const r of mine) {
  const acts = (r.actions as any[]) ?? []
  const a = acts.find((x) => HV.includes(String(x?.type)))
  const maps = Array.isArray(a?.mappings) ? a.mappings : []
  const conds = (r.conditions as any[]) ?? []
  const nested = conds.length > 0 && conds[0] && typeof conds[0] === 'object' && 'conditions' in conds[0]
  p(`\n  · ${r.name}`)
  p(`      shape=${String(a?.type) === 'keyword-harvesting' ? 'BUILDER' : 'ENGINE'} action=${a?.type} trigger=${r.trigger} enabled=${r.enabled} level=${r.autonomyLevel ?? '—'} cap/day=${r.maxExecutionsPerDay ?? '—'}`)
  p(`      actions=[${acts.map((x: any) => x?.type).join(', ')}]  conditions=${conds.length}${nested ? ' nested' : ' flat'} ${JSON.stringify(conds).slice(0,140)}`)
  p(`      params: minOrders=${a?.minOrders ?? '—'} windowDays=${a?.windowDays ?? '—'} minSpendCents=${a?.minSpendCents ?? '—'} bid=${a?.graduationBidEur ?? a?.bidEur ?? '—'} negateInSource=${a?.negateInSource ?? '—'} control=${a?.control ?? '—'}`)
  p(`      mappings=${maps.length} groups=${maps.flatMap((m:any)=>m?.groups??[]).length} sources=${(a?.sources ?? []).length} destinations=${a?.destinations ? Object.keys(a.destinations).length : 0}`)
}

const camps = await prisma.$queryRaw<Array<{tt:string|null;st:string|null;n:bigint}>>`SELECT "targetingType"::text tt, status::text st, COUNT(*) n FROM "Campaign" GROUP BY 1,2 ORDER BY 3 DESC`
p(`\n═══ campaigns by targetingType/status ═══`); for (const c of camps) p(`   ${c.tt ?? '—'} / ${c.st ?? '—'}: ${c.n}`)

const agByRole = await prisma.$queryRaw<Array<{role:string;n:bigint}>>`
  SELECT CASE WHEN c."targetingType"='AUTO' THEN 'AUTO(campaign)'
              WHEN g.name ~* 'exact' THEN 'EXACT' WHEN g.name ~* 'phrase' THEN 'PHRASE'
              WHEN g.name ~* 'broad' THEN 'BROAD' WHEN g.name ~* 'auto' THEN 'AUTO(name)' ELSE 'unnamed' END AS role,
         COUNT(*) n FROM "AdGroup" g JOIN "Campaign" c ON c.id=g."campaignId" GROUP BY 1 ORDER BY 2 DESC`
p(`\n═══ ad groups by inferred role (total ${await prisma.adGroup.count()}) ═══`); for (const r of agByRole) p(`   ${r.role}: ${r.n}`)

const st = await prisma.$queryRaw<Array<{n:bigint;mind:Date;maxd:Date}>>`SELECT COUNT(*) n, MIN(date) mind, MAX(date) maxd FROM "AmazonAdsSearchTerm"`
p(`\n═══ AmazonAdsSearchTerm ${st[0].n} rows · ${st[0].mind?.toISOString().slice(0,10)} → ${st[0].maxd?.toISOString().slice(0,10)} (age ${Math.round((Date.now()-new Date(st[0].maxd).getTime())/864e5)}d) ═══`)
for (const win of [14,30,60]) {
  const r = await prisma.$queryRaw<Array<{ge1:bigint;ge2:bigint;ge3:bigint}>>`
    SELECT COUNT(*) FILTER (WHERE o>=1) ge1, COUNT(*) FILTER (WHERE o>=2) ge2, COUNT(*) FILTER (WHERE o>=3) ge3 FROM (
      SELECT query, SUM(orders7d)::int o FROM "AmazonAdsSearchTerm" WHERE date >= (CURRENT_DATE - ${win}::int) GROUP BY 1) t`
  p(`   ${win}d distinct queries: ≥1 order ${r[0].ge1} · ≥2 ${r[0].ge2} · ≥3 ${r[0].ge3}`)
}
const mt = await prisma.$queryRaw<Array<{mt:string|null;tt:string|null;n:bigint;o:bigint}>>`
  SELECT s."matchType"::text mt, c."targetingType"::text tt, COUNT(*) n, SUM(s.orders7d) o
  FROM "AmazonAdsSearchTerm" s LEFT JOIN "Campaign" c ON c.id=s."campaignId"
  WHERE s.date >= (CURRENT_DATE - 60) GROUP BY 1,2 ORDER BY 3 DESC`
p(`\n═══ 60d search terms by matchType × campaign targetingType (D6 blind spot) ═══`)
for (const r of mt) p(`   ${r.tt ?? '—'} / ${r.mt ?? 'NULL'}: rows ${r.n} orders ${r.o ?? 0}`)

const sug = await prisma.$queryRaw<Array<{s:string;a:string;n:bigint}>>`
  SELECT status::text s, COALESCE(("proposedAction"->>'type'),'—') a, COUNT(*) n FROM "AdsRuleSuggestion" GROUP BY 1,2 ORDER BY 3 DESC`
p(`\n═══ AdsRuleSuggestion by status × action ═══`); for (const s of sug) p(`   ${s.s} / ${s.a}: ${s.n}`)

const pol = await prisma.adsHarvestPolicy.findMany().catch(()=>[] as any[])
const dst = await prisma.adsHarvestDestination.findMany().catch(()=>[] as any[])
p(`\n═══ AdsHarvestPolicy ${pol.length} rows · AdsHarvestDestination ${dst.length} rows ═══`)
for (const r of pol) p(`   policy ${r.scopeGrain}/${r.scopeId ?? '*'} kind=${r.kind} minOrders=${r.minOrders} minClicks=${r.minClicks} maxAcos=${r.maxAcosPct} win=${r.windowDays}`)
for (const r of dst) p(`   dest ${r.scopeGrain}/${r.scopeId ?? '*'} ${r.matchType} → ag=${r.adGroupId} negateAtSource=${r.negateAtSource}`)

const cr = await prisma.$queryRaw<Array<{name:string;n:bigint;last:Date;st:string}>>`
  SELECT "jobName"::text name, COUNT(*) n, MAX("startedAt") last, (ARRAY_AGG(status::text ORDER BY "startedAt" DESC))[1] st
  FROM "CronRun" WHERE "jobName" ILIKE '%harvest%' GROUP BY 1`
p(`\n═══ harvest cron runs ═══`); for (const c of cr) p(`   ${c.name}: ${c.n} runs · last ${c.last?.toISOString()} · ${c.st}`)

console.log(L.join('\n'))
await prisma.$disconnect()
