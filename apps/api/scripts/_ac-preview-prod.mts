// AC.2/AC.3 verification on prod: a preview run against real evidence that
// must write NOTHING, then the revision store proved end to end.
import '../src/env.js'
const { executeCharter } = await import('../src/services/agent-fleet/agent-executor.js')
const { createRevision, activateRevision, getActiveRevision, revertToCode } = await import(
  '../src/services/agent-fleet/charter-revisions.service.js'
)
const { bustCharterCache, resolveCharter } = await import('../src/services/agent-fleet/charter-registry.js')
const { default: prisma } = await import('../src/db.js')

const KEY = 'amazon-negative-miner'
const findingsBefore = await prisma.agentFinding.count({ where: { charterKey: KEY } })

const r = await executeCharter(KEY, { trigger: 'manual', mode: 'ask', preview: true })
console.log('PREVIEW:', JSON.stringify({
  ok: r.ok, findings: r.previewFindings?.length ?? 0, cost: r.costUSD,
  inTok: r.inputTokens, outTok: r.outputTokens, validationError: r.validationError?.slice(0, 200),
}))
const findingsAfter = await prisma.agentFinding.count({ where: { charterKey: KEY } })
console.log(`FINDINGS: before=${findingsBefore} after=${findingsAfter} → wrote ${findingsAfter - findingsBefore}`)
if (r.previewFindings?.length) {
  console.log('would have reported:', JSON.stringify((r.previewFindings as Array<Record<string, unknown>>).slice(0, 2).map(f => `${f.kind}:${f.entityId}`)))
}

// revision round trip: create → activate → prompt in force → revert
const rev = await createRevision({
  charterKey: KEY,
  systemPrompt: 'VERIFICATION REVISION — do not leave active.',
  note: 'AC verification round trip',
  author: 'verification',
})
await activateRevision(KEY, rev.id)
bustCharterCache()
const withRev = await resolveCharter(KEY)
console.log('AFTER ACTIVATE — prompt in force starts:', JSON.stringify(withRev!.systemPrompt.slice(0, 40)), 'revision:', withRev!.activeRevisionNumber)
await revertToCode(KEY)
bustCharterCache()
const back = await resolveCharter(KEY)
console.log('AFTER REVERT — prompt in force starts:', JSON.stringify(back!.systemPrompt.slice(0, 40)), 'revision:', back!.activeRevisionNumber ?? 'code')
console.log('active revision now:', (await getActiveRevision(KEY))?.id ?? 'none (code charter)')
await prisma.$disconnect()
