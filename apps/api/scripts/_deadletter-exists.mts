/**
 * Step 1 — do these 27 targets still exist on Amazon?
 *
 * A live Ads API call is impossible off-prod: ads credentials cannot be decrypted locally
 * (decryptSecret fails with "Unsupported state or unable to authenticate data", which looks like an
 * Amazon auth error and isn't). So this uses the two strongest LOCAL proxies for "Amazon still
 * knows about this entity", both of which are populated BY Amazon:
 *
 *   1. SYNC FRESHNESS — ads-sync upserts every target Amazon returns, bumping updatedAt. A target
 *      Amazon stopped returning goes stale while its siblings keep moving.
 *   2. AMAZON'S OWN REPORTING — AmazonAdsDailyPerformance rows keyed on the external target id.
 *      Amazon does not report performance for an entity it does not have.
 *
 * Agreement between the two is conclusive enough to act on. Read-only.
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const since = new Date(Date.now() - 24 * 3600 * 1000)

const failing = await p.adMutation.findMany({
  where: { state: 'FAILED', entityType: 'AD_TARGET', updatedAt: { gte: since } },
  select: { entityId: true },
})
const failIds = [...new Set(failing.map((f) => f.entityId))]

const targets = await p.adTarget.findMany({
  where: { id: { in: failIds } },
  select: { id: true, externalTargetId: true, kind: true, expressionValue: true, updatedAt: true, adGroupId: true, adGroup: { select: { name: true, campaign: { select: { name: true } } } } },
})
const agIds = [...new Set(targets.map((t) => t.adGroupId))]

// Siblings in the same ad groups that are NOT failing — the control group.
const siblings = await p.adTarget.findMany({
  where: { adGroupId: { in: agIds }, id: { notIn: failIds } },
  select: { id: true, externalTargetId: true, updatedAt: true, adGroupId: true },
})

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')
console.log('\n=== 1. SYNC FRESHNESS — failing targets vs their siblings ===\n')
for (const agId of agIds) {
  const f = targets.filter((t) => t.adGroupId === agId)
  const s = siblings.filter((t) => t.adGroupId === agId)
  const newest = (rows: { updatedAt: Date }[]) => (rows.length ? fmt(rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).updatedAt) : '—')
  const label = `${f[0]?.adGroup?.campaign?.name ?? '?'} / ${f[0]?.adGroup?.name ?? '?'}`
  console.log(`  ${label.slice(0, 52)}`)
  console.log(`      failing (${String(f.length).padStart(2)}): newest updatedAt ${newest(f)}`)
  console.log(`      others  (${String(s.length).padStart(2)}): newest updatedAt ${newest(s)}`)
}

// ── 2. Does Amazon report performance for these external ids? ────────────────
const extIds = targets.map((t) => t.externalTargetId).filter(Boolean) as string[]
const sibExt = siblings.map((t) => t.externalTargetId).filter(Boolean) as string[]
const win = new Date(Date.now() - 30 * 24 * 3600 * 1000)

const seen = async (ids: string[]) => {
  if (!ids.length) return { rows: 0, distinct: 0, last: null as string | null }
  const r = await p.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'AD_TARGET', entityId: { in: ids }, date: { gte: win } },
    _count: { _all: true }, _max: { date: true },
  })
  const d = await p.amazonAdsDailyPerformance.findMany({
    where: { entityType: 'AD_TARGET', entityId: { in: ids }, date: { gte: win } },
    select: { entityId: true }, distinct: ['entityId'],
  })
  return { rows: r._count._all, distinct: d.length, last: r._max.date ? r._max.date.toISOString().slice(0, 10) : null }
}

const f = await seen(extIds)
const s = await seen(sibExt)
console.log('\n=== 2. AMAZON REPORTING (AmazonAdsDailyPerformance, last 30d) ===\n')
console.log(`  FAILING targets : ${f.distinct}/${extIds.length} appear in Amazon's reports · ${f.rows} rows · last ${f.last ?? 'never'}`)
console.log(`  SIBLING targets : ${s.distinct}/${sibExt.length} appear in Amazon's reports · ${s.rows} rows · last ${s.last ?? 'never'}`)

// Per-target detail so the two populations can be told apart.
console.log('\n=== 3. Per failing target ===\n')
for (const t of targets) {
  const n = t.externalTargetId
    ? await p.amazonAdsDailyPerformance.count({ where: { entityType: 'AD_TARGET', entityId: t.externalTargetId, date: { gte: win } } })
    : 0
  console.log(
    `  ${(t.kind + (t.expressionValue ? ` ${t.expressionValue}` : '')).slice(0, 22).padEnd(23)}` +
    `ext=${String(t.externalTargetId ?? 'NULL').slice(0, 14).padEnd(15)}` +
    `synced ${fmt(t.updatedAt)}   amazon-report-rows=${n}   ${(t.adGroup?.campaign?.name ?? '').slice(0, 20)}`,
  )
}

const verdict = f.distinct === 0 && s.distinct > 0
console.log(`\n=== VERDICT ===\n  ${verdict
  ? 'Amazon reports NOTHING for any failing target while their siblings report normally.\n  → These entities are GONE from Amazon. The local rows are stale; the ids are not wrong.'
  : 'Mixed signal — read the per-target rows above before acting.'}\n`)

await p.$disconnect()
