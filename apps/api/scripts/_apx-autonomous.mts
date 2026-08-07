/**
 * NAF.AQ — read-only probe: can a NON-fleet autonomous agent still mint an
 * approval today, and has it? These two agents call runOrQueueTool directly
 * (pricing-watchdog.ts:155, listing-quality-keeper.ts:201) and their tools DO
 * have executors — so unlike the fleet's propose-tools they can create a row
 * that would land in a view nobody can see.
 *
 * Contains ONLY findMany / count / groupBy. No create/update/delete/upsert.
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s: string) => console.log(s)

line('── AgentDefinition (the Control Center switch) ──')
const defs = await prisma.agentDefinition.findMany({
  select: { key: true, enabled: true, updatedAt: true },
  orderBy: { key: 'asc' },
})
if (defs.length === 0) line('  (no rows — isAgentScheduleEnabled returns FALSE for every key)')
for (const d of defs) {
  line(`  ${d.enabled ? 'ON ' : 'off'}  ${d.key}   (updated ${d.updatedAt.toISOString().slice(0, 16)})`)
}

line('')
line('── CronRun history for the two approval-minting agents ──')
for (const job of ['pricing-watchdog', 'listing-quality-keeper']) {
  const runs = await prisma.cronRun.findMany({
    where: { jobName: job },
    select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
    orderBy: { startedAt: 'desc' },
    take: 3,
  })
  const total = await prisma.cronRun.count({ where: { jobName: job } })
  line(`  ${job}: ${total} run(s) ever`)
  for (const r of runs) {
    line(
      `     ${r.startedAt.toISOString().slice(0, 16)} status=${r.status} ${r.outputSummary ?? r.errorMessage ?? ''}`,
    )
  }
}

line('')
line('── Approvals produced by those two agents ──')
const runs = await prisma.agentRun.findMany({
  where: { agentKey: { in: ['pricing-watchdog', 'listing-quality-keeper'] } },
  select: { id: true, agentKey: true, createdAt: true, trigger: true },
})
line(`  runs by those agents: ${runs.length}`)
const ids = runs.map((r) => r.id)
if (ids.length > 0) {
  const aps = await prisma.agentApproval.groupBy({
    by: ['status'],
    where: { agentRunId: { in: ids } },
    _count: true,
  })
  line(`  approvals from them, by status: ${JSON.stringify(aps.map((a) => [a.status, a._count]))}`)
  const newest = await prisma.agentApproval.findFirst({
    where: { agentRunId: { in: ids } },
    select: { requestedAt: true },
    orderBy: { requestedAt: 'desc' },
  })
  line(`  newest approval from them: ${newest?.requestedAt.toISOString() ?? 'none'}`)
}

line('')
line('── Any pending approval right now, ANY tool (what the sweep would expire) ──')
const pending = await prisma.agentApproval.findMany({
  where: { status: { in: ['pending', 'scheduled'] } },
  select: { toolName: true, status: true, requestedAt: true, expiresAt: true },
  orderBy: { requestedAt: 'desc' },
  take: 20,
})
line(`  pending/scheduled right now: ${pending.length}`)
for (const p of pending) {
  line(`     ${p.status} ${p.toolName} requested=${p.requestedAt.toISOString().slice(0, 16)} expires=${p.expiresAt?.toISOString().slice(0, 16) ?? 'never'}`)
}

await prisma.$disconnect()
