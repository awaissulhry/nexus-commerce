/**
 * Read-only diagnosis of the failing ads writes that RDX/A3's Health column surfaced.
 *
 * The console now reports failed writes per schedule (20 / 24 / 80 in 24h on three schedules that
 * all displayed "Active"). This answers the next question: ONE cause or several, and which entities.
 *
 * Two delivery paths, so two sources — the same split the Health column reads:
 *   · AdMutation           — queued writes (bid suppression, base bid, resume)
 *   · AdvertisingActionLog — inline writes (placement bias), truthful since HX.1
 *
 * Nothing is written. Safe to run against prod.
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const since = new Date(Date.now() - 24 * 3600 * 1000)
const short = (s: string | null | undefined, n = 160) => (s ? s.replace(/\s+/g, ' ').slice(0, n) : '(none)')

console.log(`\n=== FAILED ads writes since ${since.toISOString()} ===\n`)

// ── 1. Queued path ────────────────────────────────────────────────────────────
const muts = await p.adMutation.findMany({
  where: { state: 'FAILED', updatedAt: { gte: since } },
  select: { entityType: true, entityId: true, field: true, actor: true, attempts: true, lastError: true, intendedValue: true, previousValue: true, updatedAt: true },
  orderBy: { updatedAt: 'desc' },
})
console.log(`AdMutation FAILED: ${muts.length}`)

const byError = new Map<string, { n: number; actors: Set<string>; fields: Set<string>; sample: string }>()
for (const m of muts) {
  const k = short(m.lastError, 90)
  const e = byError.get(k) ?? { n: 0, actors: new Set(), fields: new Set(), sample: `${m.entityType} ${m.entityId} ${m.field} ${m.previousValue}→${m.intendedValue}` }
  e.n++; e.actors.add(m.actor ?? '(null)'); e.fields.add(m.field)
  byError.set(k, e)
}
for (const [err, e] of [...byError.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n  [${e.n}×] ${err}`)
  console.log(`      fields: ${[...e.fields].join(', ')}`)
  console.log(`      actors: ${[...e.actors].slice(0, 3).join(', ')}${e.actors.size > 3 ? ` +${e.actors.size - 3}` : ''}`)
  console.log(`      sample: ${e.sample}`)
}

// ── 2. Inline path (placement writes) ─────────────────────────────────────────
const logs = await p.advertisingActionLog.findMany({
  where: { amazonResponseStatus: 'FAILED', createdAt: { gte: since } },
  select: { actionType: true, entityType: true, entityId: true, userId: true, payloadAfter: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\n\nAdvertisingActionLog FAILED: ${logs.length}`)
const byLogErr = new Map<string, { n: number; actions: Set<string>; entities: Set<string> }>()
for (const l of logs) {
  const err = short((l.payloadAfter as { error?: string } | null)?.error, 110)
  const e = byLogErr.get(err) ?? { n: 0, actions: new Set(), entities: new Set() }
  e.n++; e.actions.add(l.actionType); e.entities.add(l.entityId)
  byLogErr.set(err, e)
}
for (const [err, e] of [...byLogErr.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n  [${e.n}×] ${err}`)
  console.log(`      actions: ${[...e.actions].join(', ')} · ${e.entities.size} distinct entities`)
}

// ── 3. Blame by schedule, resolved to names ───────────────────────────────────
const actorCount = new Map<string, number>()
for (const m of muts) if (m.actor) actorCount.set(m.actor, (actorCount.get(m.actor) ?? 0) + 1)
for (const l of logs) if (l.userId) actorCount.set(l.userId, (actorCount.get(l.userId) ?? 0) + 1)

const schedIds = [...actorCount.keys()].filter((a) => a.startsWith('automation:rank-defend-')).map((a) => a.slice('automation:rank-defend-'.length))
const scheds = schedIds.length
  ? await p.adSchedule.findMany({ where: { id: { in: schedIds } }, select: { id: true, campaignId: true, name: true, group: { select: { name: true } } } })
  : []
const nameOf = new Map(scheds.map((s) => [s.id, s.group?.name ?? s.name]))

console.log('\n\n=== By actor ===')
for (const [actor, n] of [...actorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const id = actor.startsWith('automation:rank-defend-') ? actor.slice('automation:rank-defend-'.length) : null
  console.log(`  ${String(n).padStart(4)}×  ${actor}${id && nameOf.has(id) ? `   → ${nameOf.get(id)}` : ''}`)
}

// ── 4. Are the failing campaigns even write-gated open? ────────────────────────
const campIds = [...new Set(scheds.map((s) => s.campaignId))]
if (campIds.length) {
  const camps = await p.campaign.findMany({
    where: { id: { in: campIds } },
    select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true, lastSyncStatus: true, lastSyncError: true },
  })
  console.log('\n\n=== Campaigns behind the failures ===')
  for (const c of camps) {
    console.log(`  ${c.name.slice(0, 42).padEnd(42)} ${c.marketplace ?? '--'} ${c.status.padEnd(9)} liveWrites=${c.liveBidWritesEnabled ? 'ON ' : 'OFF'} lastSync=${c.lastSyncStatus ?? '-'}`)
    if (c.lastSyncError) console.log(`      lastSyncError: ${short(c.lastSyncError, 140)}`)
  }
}

await p.$disconnect()
