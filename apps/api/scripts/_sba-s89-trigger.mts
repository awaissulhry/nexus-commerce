/**
 * NAF.SB.ACT — have the deferred sections' triggers fired?
 *
 * S8 and S9 were deferred with NAMED data triggers rather than "later", so the
 * question "is there anything left to build on this page" has a factual answer
 * instead of an opinion. This asks the database for it.
 *
 *   S8  the control-audit lane — build it the first time an operator moves a
 *       dial. `AgentControlAudit` exists, held zero rows, and CANNOT be
 *       backfilled: nothing else records what a control was before it changed.
 *
 *   S9  compare two runs — when one worker has >= 10 runs across >= 2 charter
 *       revisions. Fewer than two revisions and there is nothing to compare
 *       ACROSS; that is the whole point of the section.
 *
 * Read-only. No writes, no API boot (a local API runs every cron against
 * production Neon), no tool-registry import (it opens Redis at load).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const auditRows = await prisma.agentControlAudit.count()
const auditRecent = auditRows
  ? await prisma.agentControlAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { charterKey: true, action: true, actor: true, createdAt: true },
    })
  : []

// Fleet runs only: `mode` NOT NULL is what marks one.
const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: { agentKey: true, charterRevisionId: true, mode: true },
})

const byWorker = new Map<string, { total: number; revs: Set<string>; preview: number }>()
for (const r of runs) {
  const e = byWorker.get(r.agentKey) ?? { total: 0, revs: new Set<string>(), preview: 0 }
  e.total++
  if (r.mode === 'preview') e.preview++
  if (r.charterRevisionId) e.revs.add(r.charterRevisionId)
  byWorker.set(r.agentKey, e)
}

const table = [...byWorker.entries()]
  .map(([k, v]) => ({
    worker: k,
    runs: v.total,
    real: v.total - v.preview,
    revisions: v.revs.size,
    qualifies: v.total >= 10 && v.revs.size >= 2,
  }))
  .sort((a, b) => b.runs - a.runs)

const charterRevs = await prisma.agentCharterRevision.groupBy({
  by: ['charterKey'],
  _count: { _all: true },
})

console.log(JSON.stringify({
  S8_controlAudit: {
    rows: auditRows,
    triggerFired: auditRows > 0,
    recent: auditRecent,
  },
  S9_compareRuns: {
    triggerFired: table.some((t) => t.qualifies),
    qualifyingWorkers: table.filter((t) => t.qualifies),
    perWorker: table,
    runsCarryingARevisionId: runs.filter((r) => r.charterRevisionId).length,
    totalFleetRuns: runs.length,
  },
  charterRevisionsPerCharter: charterRevs
    .map((c) => ({ charterKey: c.charterKey, revisions: c._count._all }))
    .sort((a, b) => b.revisions - a.revisions),
}, null, 2))

await prisma.$disconnect()
