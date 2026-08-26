// NAF.AI (approval inbox) probe — what the approval system actually is
// today: who decides, what expires, what risk tiers exist, and whether the
// new AC.7 control-audit table is live.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const all = await prisma.agentApproval.findMany({
  select: {
    id: true, agentRunId: true, toolName: true, riskTier: true, status: true,
    reason: true, requestedAt: true, decidedBy: true, decidedAt: true,
    expiresAt: true, args: true, preview: true,
  },
  orderBy: { requestedAt: 'desc' },
})
console.log('TOTAL approvals:', all.length)

const by = <T,>(rows: T[], k: (r: T) => string) => {
  const m = new Map<string, number>()
  for (const r of rows) m.set(k(r), (m.get(k(r)) ?? 0) + 1)
  return JSON.stringify([...m.entries()])
}
console.log('by status:', by(all, (a) => a.status))
console.log('by riskTier:', by(all, (a) => a.riskTier))
console.log('by tool:', by(all, (a) => a.toolName))
console.log('decidedBy set:', all.filter((a) => a.decidedBy).length, '/', all.length)
console.log('has expiresAt:', all.filter((a) => a.expiresAt).length, '/', all.length)
console.log('expired but still pending:', all.filter((a) => a.status === 'pending' && a.expiresAt && a.expiresAt < new Date()).length)
console.log('reason given on rejects:', all.filter((a) => a.status === 'rejected' && a.reason).length, '/', all.filter((a) => a.status === 'rejected').length)

const withPreview = all.filter((a) => a.preview)
console.log('has preview payload:', withPreview.length, '/', all.length)
if (withPreview[0]) console.log('  sample preview:', JSON.stringify(withPreview[0].preview).slice(0, 220))
console.log('sample args:', JSON.stringify(all[0]?.args).slice(0, 220))

// decision latency
const decided = all.filter((a) => a.decidedAt)
if (decided.length) {
  const mins = decided.map((a) => (a.decidedAt!.getTime() - a.requestedAt.getTime()) / 60000)
  mins.sort((x, y) => x - y)
  console.log('decision latency mins — min/median/max:', mins[0]?.toFixed(1), mins[Math.floor(mins.length / 2)]?.toFixed(1), mins[mins.length - 1]?.toFixed(1))
}

// AC.7 — is the control audit live?
try {
  const n = await prisma.agentControlAudit.count()
  console.log('AgentControlAudit rows:', n, '(TABLE LIVE)')
  const recent = await prisma.agentControlAudit.findMany({
    select: { charterKey: true, action: true, actor: true, note: true, createdAt: true },
    orderBy: { createdAt: 'desc' }, take: 5,
  })
  for (const r of recent) console.log(`   ${r.createdAt.toISOString().slice(0,16)} ${r.action} ${r.charterKey} by=${r.actor ?? '—'}`)
} catch (e) {
  console.log('AgentControlAudit: NOT AVAILABLE —', e instanceof Error ? e.message.slice(0, 90) : e)
}

// exemplars — the "precedent" the UI promises
try {
  const n = await prisma.agentExemplar.count()
  console.log('AgentExemplar rows:', n)
} catch (e) {
  console.log('AgentExemplar: n/a —', e instanceof Error ? e.message.slice(0, 60) : e)
}

await prisma.$disconnect()
