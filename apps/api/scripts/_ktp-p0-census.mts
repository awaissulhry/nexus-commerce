import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out: any = {}

// ── 1. Is KeywordRank populated at all? ────────────────────────────────
const total = await prisma.keywordRank.count()
out.keywordRank_totalRows = total
if (total) {
  const byMkt = await prisma.keywordRank.groupBy({ by: ['marketplace'], _count: { _all: true } })
  out.byMarketplace = byMkt.map(m => ({ mkt: m.marketplace, rows: m._count._all }))
  const bySrc = await prisma.keywordRank.groupBy({ by: ['source'], _count: { _all: true } })
  out.bySource = bySrc.map(s => ({ source: s.source, rows: s._count._all }))
  const agg = await prisma.keywordRank.aggregate({ _min: { capturedAt: true, createdAt: true }, _max: { capturedAt: true, createdAt: true } })
  out.capturedAt = { min: agg._min.capturedAt, max: agg._max.capturedAt }
  out.createdAt = { min: agg._min.createdAt, max: agg._max.createdAt }
  const nulls = await prisma.$queryRawUnsafe<any[]>(`
    SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE "organicRank" IS NULL)::int AS organic_null,
           count(*) FILTER (WHERE "sponsoredRank" IS NULL)::int AS sponsored_null,
           count(*) FILTER (WHERE "searchVolume" IS NULL)::int AS volume_null,
           count(*) FILTER (WHERE "asin" IS NULL)::int AS asin_null,
           count(DISTINCT lower(trim("keyword")))::int AS distinct_kw_lower,
           count(DISTINCT "keyword")::int AS distinct_kw_raw,
           count(DISTINCT "asin")::int AS distinct_asin,
           count(DISTINCT date_trunc('day',"capturedAt"))::int AS distinct_days
    FROM "KeywordRank"`)
  out.nullProfile = nulls[0]
  // distinct (kw,mkt) pairs, and how many have >1 row (a prior exists)
  const pairs = await prisma.$queryRawUnsafe<any[]>(`
    SELECT count(*)::int AS pairs,
           count(*) FILTER (WHERE n > 1)::int AS pairs_with_prior,
           count(*) FILTER (WHERE n = 1)::int AS pairs_single_row,
           count(*) FILTER (WHERE asins > 1)::int AS pairs_multi_asin
    FROM (SELECT lower(trim("keyword")) k, "marketplace" m, count(*)::int n,
                 count(DISTINCT "asin")::int asins
          FROM "KeywordRank" GROUP BY 1,2) t`)
  out.pairProfile = pairs[0]
}

// ── 2. The target population the context builder walks ─────────────────
const posKw = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
out.positiveKeywordTargets_total = posKw
out.contextBuilder_take = 3000
out.truncatedByTake = posKw > 3000 ? posKw - 3000 : 0

// ── 3. KT rules on prod ────────────────────────────────────────────────
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, createdAt: true },
})
out.advertisingRules_total = rules.length
const ktRules = rules.filter(r => {
  const a = (r.actions as any[]) ?? []
  return r.trigger === 'KEYWORD_RANK_BID' || a.some(x => x?.type === 'keyword-tracker')
})
out.ktRules = ktRules.map(r => ({ id: r.id, name: r.name, enabled: r.enabled, level: r.autonomyLevel, trigger: r.trigger }))
out.triggerHistogram = Object.entries(rules.reduce((m: any, r) => { m[r.trigger] = (m[r.trigger] ?? 0) + 1; return m }, {}))

await prisma.$disconnect()
console.log(JSON.stringify(out, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 1))
