/**
 * ACR.3 — apply the GALE consolidation. OPERATOR-APPROVED 2026-08-05 ("I approve").
 *
 * For each (term × match) carried by 2+ enabled GALE campaigns in IT, the champion keeps its
 * bid and every LOSER's targets are bid to the 5¢ floor — the house suppression pattern
 * (reversible, no status change, delivery effectively stops) rather than archive, so a wrong
 * champion costs one bid restore, not a rebuild.
 *
 * Safety properties:
 *   · Champion rule = the engine's own ordering (lowest ACOS → highest spend → traffic), the
 *     same one pickChampion and rank-self-competition share, so this can never disagree with
 *     what automation does every 15 minutes.
 *   · Every write goes through updateAdTargetWithSync — gated, audited, evidenced, queued.
 *   · One changeSetId tags the whole batch: revertible as a unit (AX-IE.6).
 *   · Dry run by default; --apply to execute.
 *
 * Usage: npx tsx scripts/_acr3-consolidate-apply.mts [--apply]
 */
import '../src/env.js'

const APPLY = process.argv.includes('--apply')
const CHANGE_SET = 'acr3-gale-consolidation-20260805'
const FLOOR_CENTS = 5

const { default: prisma } = await import('../src/db.js')

interface Row {
  term: string; match: string; campaign_id: string; campaign: string; target_ids: string[]
  impressions: bigint; clicks: bigint; spend_c: bigint; sales_c: bigint
}
const rows = await prisma.$queryRawUnsafe<Row[]>(`
  SELECT LOWER(t."expressionValue") AS term,
         REPLACE(t."expressionType", '_', '') AS match,
         c.id AS campaign_id, c.name AS campaign,
         ARRAY_AGG(DISTINCT t.id) AS target_ids,
         COALESCE(SUM(d.impressions),0) AS impressions,
         COALESCE(SUM(d.clicks),0) AS clicks,
         COALESCE(SUM(d."costMicros")/10000,0) AS spend_c,
         COALESCE(SUM(d."sales7dCents"),0) AS sales_c
  FROM "AdTarget" t
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  LEFT JOIN "AmazonAdsDailyPerformance" d
    ON d."entityType"='AD_TARGET' AND d."entityId"=t."externalTargetId"
   AND d.date > now() - interval '30 days'
  WHERE UPPER(c.name) LIKE '%GALE%' AND c.marketplace='IT' AND c.status='ENABLED'
    AND t.kind='KEYWORD' AND t."isNegative"=false AND t.status='ENABLED'
    AND COALESCE(t."bidCents",0) > ${FLOOR_CENTS}
    -- A target with no external id never existed on Amazon: it cannot serve, cannot spend,
    -- and a bid write for it is correctly CANCELLED as local-only. 26 SKAG rows were exactly
    -- this shape; counting them kept the dry run reporting work that does not exist.
    AND t."externalTargetId" IS NOT NULL
  GROUP BY 1,2,3,4`)

const byKey = new Map<string, Row[]>()
for (const r of rows) {
  const k = `${r.term}|${r.match}`
  const arr = byKey.get(k) ?? []
  arr.push(r)
  byKey.set(k, arr)
}

const acos = (r: Row) => (Number(r.sales_c) > 0 ? Number(r.spend_c) / Number(r.sales_c) : null)
const rank = (r: Row): [number, number, number] =>
  [acos(r) ?? Number.POSITIVE_INFINITY, -Number(r.spend_c), -Number(r.impressions)]

interface Retire { term: string; match: string; campaign: string; targetIds: string[]; champion: string; championWhy: string }
const retires: Retire[] = []
for (const [key, group] of byKey) {
  if (group.length < 2) continue
  const sorted = [...group].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  })
  const champ = sorted[0]
  const a = acos(champ)
  const why = a != null
    ? `ACOS ${(a * 100).toFixed(0)}% on €${(Number(champ.spend_c) / 100).toFixed(2)}`
    : Number(champ.spend_c) > 0
      ? `most spend (€${(Number(champ.spend_c) / 100).toFixed(2)}), no sales yet`
      : `most traffic (${champ.impressions} impr)`
  const [term, match] = key.split('|')
  for (const loser of sorted.slice(1)) {
    retires.push({ term, match, campaign: loser.campaign, targetIds: loser.target_ids, champion: champ.campaign, championWhy: why })
  }
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — GALE IT consolidation (changeSet ${CHANGE_SET})`)
console.log(`${byKey.size} (term × match) keys · ${retires.length} losing claims · ${retires.reduce((a, r) => a + r.targetIds.length, 0)} targets to floor at ${FLOOR_CENTS}¢\n`)
for (const r of retires) {
  console.log(`  "${r.term}" [${r.match}]`)
  console.log(`     floor ${r.targetIds.length} target(s) in ${r.campaign}`)
  console.log(`     champion stays: ${r.champion} (${r.championWhy})`)
}

if (!APPLY) { await prisma.$disconnect(); console.log('\nNothing changed. Re-run with --apply.\n'); process.exit(0) }

const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
let ok = 0, blocked = 0, failed = 0
for (const r of retires) {
  for (const tid of r.targetIds) {
    try {
      const res = await updateAdTargetWithSync({
        adTargetId: tid,
        patch: { bidCents: FLOOR_CENTS },
        actor: 'user:operator-acr3-consolidation',
        reason: `Consolidation (operator-approved): "${r.term}" [${r.match}] championed by ${r.champion} — ${r.championWhy}`,
        evidence: {
          metric: 'consolidation_champion',
          observed: r.championWhy,
          threshold: 'lowest ACOS → highest spend → traffic (engine ordering)',
          windowDays: 30,
        } as never,
        applyImmediately: true,
        changeSetId: CHANGE_SET,
      })
      if (res.ok) ok += 1
      else { blocked += 1; console.log(`  ! ${r.term} @ ${r.campaign}: ${res.error ?? 'not ok'}`) }
    } catch (e) {
      failed += 1
      console.log(`  !! ${r.term} @ ${r.campaign}: ${(e as Error).message.slice(0, 120)}`)
    }
  }
}
console.log(`\napplied=${ok} blocked=${blocked} failed=${failed}  (revert as one unit via changeSet ${CHANGE_SET})\n`)
await prisma.$disconnect()
