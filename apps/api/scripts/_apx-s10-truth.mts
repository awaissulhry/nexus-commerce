/**
 * NAF.AQ-S10R — ground truth for the record and precedent, measured rather
 * than assumed. Read-only: every statement below is a SELECT.
 *
 * Prisma is queried directly instead of importing `approval-inbox.service.ts`,
 * which pulls in `tool-registry` and hangs on Redis in a script context. The
 * queries here are copied from that file so the numbers are the ones the page
 * actually renders — where a query differs, that is a finding, not a bug in
 * this probe.
 *
 * Usage: npx tsx scripts/_apx-s10-truth.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']
const DECIDED_STATUSES = ['approved', 'executed', 'rejected', 'executing', 'superseded']

const line = (s: string) => console.log(s)
const h = (s: string) => console.log(`\n═══ ${s}`)

h('1 · the two universes: what "waiting" counts vs what "decided" counts')
const waiting = await prisma.agentApproval.count({
  where: {
    status: { in: ['pending', 'scheduled'] },
    toolName: { in: FLEET_TOOLS },
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }],
  },
})
const decided = await prisma.agentApproval.count({ where: { status: { in: DECIDED_STATUSES } } })
const decidedFleet = await prisma.agentApproval.count({
  where: { status: { in: DECIDED_STATUSES }, toolName: { in: FLEET_TOOLS } },
})
const expired = await prisma.agentApproval.count({ where: { status: 'expired' } })
line(`waiting (fleet tools only):        ${waiting}`)
line(`decided (ALL tools, status only):  ${decided}`)
line(`  ...of which are fleet tools:     ${decidedFleet}`)
line(`expired:                           ${expired}`)
line(`→ the record shows ${decided - decidedFleet} rows the queue would never have shown.`)

h('2 · who produced the decided rows')
const rows = await prisma.agentApproval.findMany({
  where: { status: { in: DECIDED_STATUSES } },
  select: {
    id: true,
    toolName: true,
    status: true,
    riskTier: true,
    decidedBy: true,
    decidedAt: true,
    requestedAt: true,
    reason: true,
    agentRunId: true,
  },
})
const runs = await prisma.agentRun.findMany({
  where: { id: { in: [...new Set(rows.map((r) => r.agentRunId))] } },
  select: { id: true, agentKey: true, mode: true, userId: true, trigger: true },
})
const runById = new Map(runs.map((r) => [r.id, r]))
const tally = (xs: (string | null)[]) => {
  const m: Record<string, number> = {}
  for (const x of xs) m[String(x)] = (m[String(x)] ?? 0) + 1
  return m
}
line(`producing runs:      ${runs.length}`)
line(`by agentKey:         ${JSON.stringify(tally(runs.map((r) => r.agentKey)))}`)
line(`by run.mode:         ${JSON.stringify(tally(runs.map((r) => r.mode)))}   ← null = NOT a fleet run`)
line(`by run.userId:       ${JSON.stringify(tally(runs.map((r) => r.userId)))}`)
line(`by tool:             ${JSON.stringify(tally(rows.map((r) => r.toolName)))}`)
line(`by status:           ${JSON.stringify(tally(rows.map((r) => r.status)))}`)
line(`by riskTier:         ${JSON.stringify(tally(rows.map((r) => r.riskTier)))}`)

h('3 · attribution and reasons')
const noDecider = rows.filter((r) => !r.decidedBy).length
line(`decidedBy null:      ${noDecider} / ${rows.length}`)
const reasons = rows.map((r) => r.reason).filter(Boolean) as string[]
line(`rows with a reason:  ${reasons.length} / ${rows.length}`)
line(`distinct reasons:    ${JSON.stringify([...new Set(reasons)])}`)
const scriptish = reasons.filter((r) => /^acp\d|verify|cleanup|test/i.test(r)).length
line(`reasons that look like script markers: ${scriptish} / ${reasons.length}`)

h('4 · decision latency (the number a "how fast you decide" stat would use)')
const lat = rows
  .filter((r) => r.decidedAt)
  .map((r) => (r.decidedAt!.getTime() - r.requestedAt.getTime()) / 1000)
  .sort((a, b) => a - b)
if (lat.length) {
  const med = lat[Math.floor(lat.length / 2)]
  line(`n=${lat.length}  min=${lat[0].toFixed(1)}s  median=${med.toFixed(1)}s  max=${lat[lat.length - 1].toFixed(1)}s`)
  line(`under 5s: ${lat.filter((x) => x < 5).length} / ${lat.length}`)
} else line('no decided row carries decidedAt')

h('5 · trackRecords() — AP.8, the anti-automation-bias signal')
const trRows = await prisma.agentApproval.findMany({
  where: { status: { in: ['approved', 'executed', 'rejected'] } },
  select: { toolName: true, status: true, agentRunId: true },
})
const trKeys = new Map<string, number>()
for (const r of trRows) {
  const k = `${runById.get(r.agentRunId)?.agentKey ?? 'unknown'}::${r.toolName}`
  trKeys.set(k, (trKeys.get(k) ?? 0) + 1)
}
line(`keys it would build:  ${JSON.stringify([...trKeys.entries()])}`)
const fleetKeys = [...trKeys.keys()].filter((k) => FLEET_TOOLS.some((t) => k.endsWith(`::${t}`)))
line(`keys a FLEET card could look up (charterKey::fleetTool): ${fleetKeys.length}`)
line('→ a card looks up `${charterKey}::${toolName}`; charterKey is null on every pre-fleet row.')

h('6 · precedent')
const ex = await prisma.agentExemplar.count()
const exActive = await prisma.agentExemplar.count({ where: { active: true } })
line(`AgentExemplar rows: ${ex}   active: ${exActive}`)

h('7 · superseded, and every status the record can render')
line(`statuses present in the table: ${JSON.stringify(tally((await prisma.agentApproval.findMany({ select: { status: true } })).map((r) => r.status)))}`)
line(`DECIDED_STATUSES the UI can render: ${JSON.stringify(DECIDED_STATUSES)}`)
line('→ any status in the second list but not the first has never rendered in production.')

h('8 · truncation')
line(`decided rows: ${decided} — listInbox takes min(limit,200), client asks 100.`)
line(`→ truncation copy is unexercised at this volume.`)

await prisma.$disconnect()
