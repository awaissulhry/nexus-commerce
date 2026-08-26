/**
 * NEG.3 — preflight. READ-ONLY. Nothing here writes, and nothing here calls Amazon.
 *
 * Five questions that decide the shape of the retirement path, all answered from production data
 * rather than from the study's prose:
 *
 *   1. Is the orphan trap still latent? (`orphanedAt = 0` across all negatives — if it is not, a
 *      write has already gone to the wrong endpoint and the damage is done.)
 *   2. Has a negative EVER had a state pushed to it? (0 `AD_ENTITY_STATE_UPDATE` logs on a
 *      negative would mean the routing bug has never fired, which is why it is still latent.)
 *   3. 🔴 Does Amazon report any negative as PAUSED? Our mirror takes `status` straight from
 *      Amazon's own state on every ingest, so a single PAUSED negative is proof from our own
 *      account that the state is valid for this entity — and that a REVERSIBLE way to stop
 *      blocking a term exists, which the study's §4.0 does not consider.
 *   4. The three removal populations: at-Amazon ad-group, at-Amazon campaign, local-only.
 *   5. The candidates for each verification stage, chosen by the data instead of by me.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.3 — preflight ═══\n')

// ── 1 · is the trap still latent? ─────────────────────────────────────────────────────────────
h('1 · The orphan trap — still latent?')
const orphaned = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
const orphanedAll = await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })
console.log(`  negatives with orphanedAt set: ${int(orphaned)}   ${orphaned === 0 ? '✓ latent — no write has gone to the wrong endpoint yet' : '🔴 ALREADY FIRED'}`)
console.log(`  ALL targets with orphanedAt set: ${int(orphanedAll)} (positives included — the DL.3 population)`)

// ── 2 · has a state ever been pushed to a negative? ───────────────────────────────────────────
h('2 · Has any negative ever had a state pushed to it?')
const negIds = (await prisma.adTarget.findMany({ where: { isNegative: true }, select: { id: true } })).map((n) => n.id)
const stateLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE' },
  select: { entityId: true, createdAt: true, amazonResponseStatus: true },
})
const onNeg = stateLogs.filter((l) => l.entityId && negIds.includes(l.entityId))
console.log(`  AD_ENTITY_STATE_UPDATE logs, all entities: ${int(stateLogs.length)}`)
console.log(`  …of those on a NEGATIVE: ${int(onNeg.length)}   ${onNeg.length === 0 ? '✓ never — which is exactly why the trap is latent' : '🔴 one has fired'}`)
// `entityId` lives inside the JSON payload, not as a column (the worker reads `payload.entityId`),
// so this is filtered in JS rather than by Prisma.
const negIdSet = new Set(negIds)
const queueRows = await prisma.outboundSyncQueue.findMany({ select: { payload: true, syncStatus: true }, take: 5000, orderBy: { createdAt: 'desc' } })
const adTargetRows = queueRows.filter((r) => (r.payload as { entityType?: string } | null)?.entityType === 'AD_TARGET')
const negQueue = adTargetRows.filter((r) => negIdSet.has(String((r.payload as { entityId?: string }).entityId ?? '')))
console.log(`  OutboundSyncQueue rows (last 5,000): ${int(queueRows.length)} · of those AD_TARGET: ${int(adTargetRows.length)}`)
console.log(`  …of those for a NEGATIVE: ${int(negQueue.length)}   ${negQueue.length === 0 ? '✓ no negative has ever been enqueued for an outbound write' : '🔴 one has'}`)

// ── 3 · 🔴 the state vocabulary, from our own mirror ──────────────────────────────────────────
h('3 · 🔴 Does Amazon report a negative as PAUSED? (the reversible-removal question)')
const byStatus = await prisma.adTarget.groupBy({ by: ['status'], where: { isNegative: true }, _count: { _all: true } })
console.log(`  negatives by status: ${byStatus.map((r) => `${r.status}=${int(r._count._all)}`).join(' · ')}`)
const pausedNeg = byStatus.find((r) => String(r.status) === 'PAUSED')?._count._all ?? 0
// The mirror writes `status` from Amazon's own state on every v1 ingest
// (`ads-v1-sync.service.ts:620` → STATE_TO_PRISMA[normalizeStateV1(r.state)]), so this is Amazon's
// vocabulary, not ours.
console.log(pausedNeg > 0
  ? `  🔴 ${int(pausedNeg)} negatives are PAUSED at Amazon — PAUSED is valid for this entity, proven by our own mirror.`
  : `  no negative is currently PAUSED. That is not proof PAUSED is invalid — only that none is paused today.`)
const pausedPos = await prisma.adTarget.count({ where: { isNegative: false, status: 'PAUSED' } })
console.log(`  (for contrast, PAUSED positives: ${int(pausedPos)})`)

// ── 4 · the three removal populations ─────────────────────────────────────────────────────────
h('4 · The three removal paths, sized')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, negativeLevel: true, status: true,
    externalTargetId: true, createdAt: true, updatedAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, externalCampaignId: true } } } },
  },
})
const atAmazonAg = negs.filter((n) => n.externalTargetId && n.negativeLevel !== 'CAMPAIGN')
const atAmazonCamp = negs.filter((n) => n.externalTargetId && n.negativeLevel === 'CAMPAIGN')
const localOnly = negs.filter((n) => !n.externalTargetId)
const archived = negs.filter((n) => String(n.status) === 'ARCHIVED')
console.log(`  (a) at Amazon, ad-group scope : ${int(atAmazonAg.length)}`)
console.log(`  (b) at Amazon, campaign scope: ${int(atAmazonCamp.length)}   ${atAmazonCamp.length === 0 ? '← path (b) has no subject in this account' : ''}`)
console.log(`  (c) local-only (no Amazon id): ${int(localOnly.length)}   — campaign-level ${int(localOnly.filter((n) => n.negativeLevel === 'CAMPAIGN').length)} · ad-group ${int(localOnly.filter((n) => n.negativeLevel !== 'CAMPAIGN').length)}`)
console.log(`  already ARCHIVED (not ours to remove): ${int(archived.length)}`)

// ── 5 · stage candidates, chosen by the data ──────────────────────────────────────────────────
h('5 · Verification candidates')
// Stage 1 — a local-only row. Prefer one whose term is negated elsewhere too, so removing it
// cannot be the last thing blocking a term.
const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }
const s1 = localOnly
  .filter((n) => String(n.status) === 'ENABLED')
  .filter((n) => (byTerm.get(normaliseNegTerm(n.expressionValue)) ?? []).length > 3)
  .sort((a, b) => (byTerm.get(normaliseNegTerm(b.expressionValue))!.length) - (byTerm.get(normaliseNegTerm(a.expressionValue))!.length))[0]
console.log(`  STAGE 1 (local-only, no Amazon call possible):`)
if (s1) console.log(`    id=${s1.id} 「${s1.expressionValue}」 ${s1.negativeLevel} · campaign "${s1.adGroup?.campaign?.name}" (${s1.adGroup?.campaign?.status}) · term negated in ${byTerm.get(normaliseNegTerm(s1.expressionValue))!.length} rows total`)

// Stage 2 — a negative in a PAUSED campaign, at Amazon, whose term has no traffic and no orders.
const since120 = new Date(Date.now() - 120 * 86400_000)
const perTerm = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: since120 } },
  _sum: { impressions: true, orders7d: true },
})
const traffic = new Map(perTerm.map((r) => [normaliseNegTerm(r.query), { impr: r._sum.impressions ?? 0, orders: r._sum.orders7d ?? 0 }]))
const s2 = atAmazonAg
  .filter((n) => String(n.status) === 'ENABLED')
  .filter((n) => n.adGroup?.campaign?.status === 'PAUSED')
  .filter((n) => { const t = traffic.get(normaliseNegTerm(n.expressionValue)); return !t || (t.impr === 0 && t.orders === 0) })
  .filter((n) => (byTerm.get(normaliseNegTerm(n.expressionValue)) ?? []).length > 1)[0]
console.log(`  STAGE 2 (at Amazon, PAUSED campaign, term dark for 120d, not the last negation of its term):`)
if (s2) console.log(`    id=${s2.id} ext=${s2.externalTargetId} 「${s2.expressionValue}」 · ag "${s2.adGroup?.name}" (ext ${s2.adGroup?.externalAdGroupId}) · campaign "${s2.adGroup?.campaign?.name}" (${s2.adGroup?.campaign?.status})`)
else console.log(`    none found`)
console.log(`  eligible stage-2 subjects in total: ${int(atAmazonAg.filter((n) => String(n.status) === 'ENABLED' && n.adGroup?.campaign?.status === 'PAUSED').length)}`)

// Stage 4 — the smallest real term, for bulk.
const small = [...byTerm.entries()].filter(([, r]) => r.length >= 2 && r.length <= 5).sort((a, b) => a[1].length - b[1].length)
console.log(`  STAGE 4 (bulk) — terms in the 2–5 row band: ${int(small.length)}; smallest examples:`)
for (const [t, r] of small.slice(0, 3)) console.log(`    「${t}」 ${r.length} rows · ${r.filter((x) => x.externalTargetId).length} at Amazon · ${new Set(r.map((x) => x.adGroup?.campaign?.id)).size} campaigns`)

h('6 · The 62 archived rows — what we actually know about them')
const arch = archived.slice(0, 3)
for (const a of arch) console.log(`  「${a.expressionValue}」 status=${a.status} updatedAt=${a.updatedAt.toISOString().slice(0, 10)} createdAt=${a.createdAt.toISOString().slice(0, 10)} ext=${a.externalTargetId ? 'yes' : 'no'}`)
const archUpdatedDays = new Set(archived.map((a) => a.updatedAt.toISOString().slice(0, 10)))
console.log(`  distinct updatedAt days across all ${int(archived.length)} archived rows: ${archUpdatedDays.size} → ${[...archUpdatedDays].join(', ')}`)
console.log(`  🔴 updatedAt is the last INGEST tick, not the retirement date. There is no retiredAt today.`)

await prisma.$disconnect()
