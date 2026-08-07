import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const appr = await prisma.agentApproval.findMany({
  orderBy: { requestedAt: 'desc' }, take: 20,
  select: { id: true, status: true, decidedBy: true, decidedAt: true, requestedAt: true, toolName: true },
})
console.log('APPROVALS', appr.length)
for (const a of appr) console.log(' ', a.status.padEnd(9), 'by=' + String(a.decidedBy), 'at=' + (a.decidedAt?.toISOString().slice(0,16) ?? 'null'), a.toolName)

const revs = await prisma.agentCharterRevision.findMany({
  select: { charterKey: true, revision: true, author: true, note: true, createdAt: true, activatedAt: true },
})
console.log('\nREVISIONS', revs.length)
for (const r of revs) console.log(' ', r.charterKey, 'rev' + r.revision, 'author=' + String(r.author), 'activated=' + String(r.activatedAt?.toISOString().slice(0,16)), '|', r.note?.slice(0, 50))

const audits = await prisma.agentControlAudit.count()
console.log('\nAUDIT ROWS', audits)

// Does the writer actually work? Insert and immediately delete a probe row.
try {
  const probe = await prisma.agentControlAudit.create({
    data: { charterKey: '__probe__', action: 'policy', note: 'SB.W.4 write probe', actor: 'diagnostic' },
  })
  console.log('WRITE PROBE: ok, id', probe.id)
  await prisma.agentControlAudit.delete({ where: { id: probe.id } })
  console.log('WRITE PROBE: cleaned up')
} catch (e) {
  console.log('WRITE PROBE FAILED:', String(e).slice(0, 300))
}
await prisma.$disconnect()
