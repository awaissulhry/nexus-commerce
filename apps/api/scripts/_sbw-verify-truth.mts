/**
 * NAF.SB.W — the numbers the Workers page CLAIMS, computed independently from
 * the database. If the page and this disagree, the page is lying.
 * Read-only.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { listCharters } = await import('../src/services/agent-fleet/charter-registry.js')

const charters = await listCharters()
const DAY = 864e5
const since = new Date(Date.now() - 7 * DAY)
const midnight = new Date(); midnight.setHours(0, 0, 0, 0)

const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } }, orderBy: { createdAt: 'desc' }, take: 100,
  select: { agentKey: true, status: true, ok: true, costUSD: true, createdAt: true,
            errorMessage: true, haltedReason: true, findingCount: true },
})
const openFindings = await prisma.agentFinding.groupBy({
  by: ['charterKey'], where: { status: 'open' }, _count: { _all: true },
})
const cards = await prisma.agentScorecard.findMany({
  orderBy: { periodEnd: 'desc' }, select: { charterKey: true, grade: true, promotionEligible: true },
})

const DIAG = (c: { diagnostic?: boolean; key: string }) => c.diagnostic === true || c.key === 'fleet-selftest'
const business = charters.filter((c) => !DIAG(c))
const live = (c: typeof charters[number]) =>
  c.enabled && c.autonomyLevel !== 'OFF' && !(c.pausedUntil && new Date(c.pausedUntil) > new Date())

const fCount = (k: string) => openFindings.find((f) => f.charterKey === k)?._count._all ?? 0
const cost7 = (keys: string[]) => runs
  .filter((r) => keys.includes(r.agentKey) && r.createdAt >= since)
  .reduce((s, r) => s + Number(r.costUSD), 0)
const costToday = (keys: string[]) => runs
  .filter((r) => keys.includes(r.agentKey) && r.createdAt >= midnight)
  .reduce((s, r) => s + Number(r.costUSD), 0)

// "needs attention" — the same union the page derives
const attention = charters.filter((c) => {
  if (c.degraded) return true
  if (c.provisioned === false) return true
  if (c.pausedUntil && new Date(c.pausedUntil) > new Date()) return true
  if (!live(c)) return false
  const mine = runs.filter((r) => r.agentKey === c.key)
  if (mine.length === 0) return true
  const last = mine[0]!
  return !last.ok && last.status !== 'running'
})

const bizKeys = business.map((c) => c.key)
console.log(JSON.stringify({
  TILES: {
    workers: charters.length,
    switchedOn: charters.filter(live).length,
    needsAttention: attention.length,
    needsAttentionKeys: attention.map((c) => c.key),
    earnedAPromotion: charters.filter((c) => cards.find((s) => s.charterKey === c.key)?.promotionEligible).length,
    openFindings_businessOnly: bizKeys.reduce((s, k) => s + fCount(k), 0),
    spent7d_businessOnly: Number(cost7(bizKeys).toFixed(4)),
    spentToday_businessOnly: Number(costToday(bizKeys).toFixed(4)),
  },
  FOOTNOTE_diagnostics: charters.filter(DIAG).map((c) => ({
    key: c.key, findings: fCount(c.key), cost7d: Number(cost7([c.key]).toFixed(4)),
  })),
  VIEWS: { all: charters.length, live: charters.filter(live).length, attention: attention.length },
  SAFETY: {
    anyNotOff: charters.filter((c) => c.enabled || c.autonomyLevel !== 'OFF').map((c) => c.key),
    unprovisioned: charters.filter((c) => c.provisioned === false).map((c) => c.key),
  },
}, null, 1))
await prisma.$disconnect()
