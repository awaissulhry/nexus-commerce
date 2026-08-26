/**
 * NEG.X action two — negate `protezioni` in the three approved campaigns.
 * Operator-approved 2026-08-14: "Top 3 campaigns".
 *
 * 🔴 IRREVERSIBLE AT AMAZON. A negative keyword can only be archived, never deleted.
 * Sequential, one campaign at a time, and it STOPS on the first gate refusal.
 */
import '../src/env.js'
const { negateGram } = await import('../src/services/advertising/negatives-ngrams.service.js')
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const APPROVED = ['GALE PHRASE IT', 'IT_Auto_Substitute', 'GALE | IT | Phrase | Category']
const ACTOR = 'user:cmr44sxfw0001nj00whzur39t'

const before = {
  negatives: await prisma.adTarget.count({ where: { isNegative: true } }),
  orphaned: await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
  logs: await prisma.advertisingActionLog.count({ where: { actionType: 'create_negative_keyword' } }),
}
console.log(`BEFORE  negatives ${before.negatives.toLocaleString('en-IE')} · orphaned ${before.orphaned} · create logs ${before.logs.toLocaleString('en-IE')}\n`)

const camps = await prisma.campaign.findMany({ where: { name: { in: APPROVED } }, select: { id: true, name: true } })
const ordered = APPROVED.map((n) => camps.find((c) => c.name === n)!).filter(Boolean)

let created = 0, alreadyExisted = 0, refused = 0, failed = 0, stopped = false
for (const c of ordered) {
  console.log(`─── ${c.name} ───────────────────────────────────────────`)
  const r = await negateGram({ gram: 'protezioni', market: 'all', campaign: c.id, window: 60, actor: ACTOR })
  if (!r.ok) {
    console.log(`  🔴 REFUSED BEFORE ANY WRITE: ${r.error} (${r.code}${r.blockedBy ? ` · ${r.blockedBy.join(', ')}` : ''})`)
    stopped = true; break
  }
  for (const o of r.outcomes) {
    console.log(`  ${o.outcome.toUpperCase().padEnd(16)} ${o.campaignName} › ${o.adGroupName}${o.reason ? ` — ${o.reason}` : ''}${o.externalNegativeKeywordId ? ` · amazon id ${o.externalNegativeKeywordId}` : ''}`)
  }
  created += r.summary.created; alreadyExisted += r.summary.alreadyExisted
  refused += r.summary.refused; failed += r.summary.failed
  // 🔴 stop on the FIRST gate refusal — do not keep writing into a refusing gate
  if (r.summary.refused > 0) {
    console.log(`  🔴 STOPPING: a write was refused by the gate. Reason above.`)
    stopped = true; break
  }
}

console.log(`\n─── SUMMARY ─────────────────────────────────────────────`)
console.log(`  created ${created} · already existed ${alreadyExisted} · refused ${refused} · failed ${failed}${stopped ? '  🔴 STOPPED EARLY' : ''}`)

const after = {
  negatives: await prisma.adTarget.count({ where: { isNegative: true } }),
  orphaned: await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
  logs: await prisma.advertisingActionLog.count({ where: { actionType: 'create_negative_keyword' } }),
}
console.log(`\nAFTER   negatives ${after.negatives.toLocaleString('en-IE')} (+${after.negatives - before.negatives}) · orphaned ${after.orphaned} · create logs ${after.logs.toLocaleString('en-IE')} (+${after.logs - before.logs})`)
console.log(`  🔴 orphaned must be 0: ${after.orphaned === 0 ? '✓ 0' : `🔴 ${after.orphaned} — THE ROUTING FIX HAS REGRESSED, STOP`}`)
console.log(`  🔴 every creation must carry a log: ${after.negatives - before.negatives === after.logs - before.logs ? '✓ counts match' : '🔴 MISMATCH'}`)

// prove the attribution and the evidence on the rows just written
const fresh = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_negative_keyword' }, orderBy: { createdAt: 'desc' }, take: created,
  select: { userId: true, evidence: true, entityId: true, amazonResponseStatus: true },
})
console.log(`\n  attribution on the ${fresh.length} new rows:`)
for (const f of fresh) {
  const ev = (f.evidence ?? {}) as { note?: string }
  console.log(`    user=${f.userId ?? '🔴 NULL'} · status=${f.amazonResponseStatus} · evidence=${ev.note ? `"${ev.note.slice(0, 90)}…"` : '🔴 NONE'}`)
}
await prisma.$disconnect()
