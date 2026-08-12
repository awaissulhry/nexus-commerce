/**
 * HV page study — the auto-harvest ENGINE. READ-ONLY.
 *
 * `ads-auto-harvest` logs `grad=14/14 neg=8/8 dryRun=false` every night. The prior study said the
 * engine "reports nothing left to harvest". This measures what it is actually doing:
 *   1. the global automation state that gates it (the ONLY gate it has)
 *   2. create_keyword / negative writes by writer × month — is anything still being written?
 *   3. exactly which 14 terms it graduates, and whether each already exists
 *   4. the 23 harvest suggestions in the queue
 *   5. write-gate posture for the campaigns the candidates live in
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const now = Date.now()

console.log('\n═══ HV page — the auto-harvest engine ═══\n')

// ── 1. the only gate ──────────────────────────────────────────────────────────
console.log('═══ 1 · what gates ads-auto-harvest ═══\n')
try {
  const { getAutomationState } = await import('../src/services/advertising/ads-automation-state.service.js')
  const st = await getAutomationState()
  console.log(`getAutomationState(): ${JSON.stringify(st)}`)
  console.log(`  effectivelyStopped=${st.effectivelyStopped} → ${st.effectivelyStopped ? 'SKIPS' : 'RUNS'}`)
  console.log(`  autonomy=${st.autonomy} → ${st.autonomy === 'SUGGEST' ? 'proposes only' : 'APPLIES LIVE (dryRun=false)'}`)
} catch (e) { console.log(`could not read automation state: ${(e as Error).message}`) }

// the per-rule ceiling the SAME actions carry
try {
  const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')
  for (const acts of [['promote_to_exact'], ['harvest_and_negate']]) {
    const r = graduationCeiling(acts as never)
    console.log(`\ngraduationCeiling(${JSON.stringify(acts)}) = ${JSON.stringify(r)}`)
  }
} catch (e) { console.log(`ceiling: ${(e as Error).message}`) }

// ── 2. who is still writing keywords and negatives ────────────────────────────
console.log('\n\n═══ 2 · create_keyword + negative writes, by writer × month ═══\n')
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['create_keyword', 'create_negative_keyword', 'create_negative', 'create_target'] } },
  select: { actionType: true, userId: true, executionId: true, createdAt: true, amazonResponseStatus: true, entityId: true },
})
console.log(`AdvertisingActionLog rows for creation actions (all time): ${int(logs.length)}`)
const cell = new Map<string, number>()
for (const l of logs) {
  const who = l.executionId ? 'rule-execution' : (l.userId ?? '(no userId)')
  const k = `${l.actionType}|${who}|${l.createdAt.toISOString().slice(0, 7)}`
  cell.set(k, (cell.get(k) ?? 0) + 1)
}
console.log(`${pad('action', 26)} ${pad('writer', 30)} ${pad('month', 9)} rows`)
for (const [k, n] of [...cell.entries()].sort()) { const [a, w, m] = k.split('|'); console.log(`${pad(a, 26)} ${pad(w, 30)} ${pad(m, 9)} ${int(n)}`) }

const recent = logs.filter((l) => l.createdAt.getTime() > now - 14 * 86_400_000)
console.log(`\nin the last 14 days: ${recent.length} creation writes`)
const byW = new Map<string, number>()
for (const l of recent) byW.set(l.executionId ? 'rule-execution' : (l.userId ?? '(no userId)'), (byW.get(l.executionId ? 'rule-execution' : (l.userId ?? '(no userId)')) ?? 0) + 1)
console.log(`  writers: ${[...byW.entries()].map(([w, n]) => `${w}=${n}`).join(' · ')}`)

// ── 3. the exact 14 the engine graduates every night ──────────────────────────
console.log('\n\n═══ 3 · the terms the engine graduates every night ═══\n')
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const pv = await previewHarvest({})
console.log(`previewHarvest({}) — the engine's own call, verbatim:`)
console.log(`  windowDays=${pv.windowDays} · negatives=${pv.negatives.length} · graduations=${pv.graduations.length} · productNegatives=${pv.productNegatives.length} · productGraduations=${pv.productGraduations.length}`)

const ags = await prisma.adGroup.findMany({ select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { name: true, targetingType: true, marketplace: true, status: true } } } })
const agByExt = new Map(ags.filter((a) => a.externalAdGroupId).map((a) => [a.externalAdGroupId!, a]))
const pos = await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: false }, select: { adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true, bidCents: true } })
const posKey = new Map<string, { bidCents: number; ext: string | null }>()
for (const t of pos) posKey.set(`${t.adGroupId}|${t.expressionType.toUpperCase()}|${t.expressionValue.trim().toLowerCase()}`, { bidCents: t.bidCents, ext: t.externalTargetId })

console.log(`\n${pad('query', 40)} ${pad('ord', 4)} ${pad('clicks', 6)} ${pad('spend', 8)} ${pad('CPC', 7)} ${pad('already EXACT here?', 20)} source ad group`)
for (const g of pv.graduations) {
  const ag = agByExt.get(g.externalAdGroupId)
  const cpc = g.clicks > 0 ? g.costCents / g.clicks / 100 : 0
  const hit = ag ? posKey.get(`${ag.id}|EXACT|${g.query.trim().toLowerCase()}`) : undefined
  const state = hit ? `YES bid ${eur(hit.bidCents)}${hit.ext ? '' : ' (local only)'}` : 'no — genuinely new'
  console.log(`${pad(g.query, 40)} ${pad(String(g.orders), 4)} ${pad(String(g.clicks), 6)} ${pad(eur(g.costCents), 8)} ${pad(`€${cpc.toFixed(2)}`, 7)} ${pad(state, 20)} ${ag ? `${ag.campaign?.targetingType ?? '?'} ${ag.campaign?.name ?? ''} › ${ag.name}`.slice(0, 50) : '(no local ad group)'}`)
}
const genuinelyNew = pv.graduations.filter((g) => { const ag = agByExt.get(g.externalAdGroupId); return !(ag && posKey.has(`${ag.id}|EXACT|${g.query.trim().toLowerCase()}`)) }).length
console.log(`\ngenuinely new of ${pv.graduations.length}: ${genuinelyNew}`)

console.log(`\n${pad('negative candidate', 40)} ${pad('spend', 9)} ${pad('clicks', 6)} ${pad('impr', 8)} source campaign`)
for (const n of pv.negatives.slice(0, 12)) {
  const ag = agByExt.get(n.externalAdGroupId)
  console.log(`${pad(n.query, 40)} ${pad(eur(n.costCents), 9)} ${pad(String(n.clicks), 6)} ${pad(String(n.impressions), 8)} ${(ag?.campaign?.name ?? n.externalCampaignId).slice(0, 44)}`)
}
const negTotal = pv.negatives.reduce((s, n) => s + n.costCents, 0)
console.log(`\nnegative candidates: ${pv.negatives.length} · total wasted spend ${eur(negTotal)}`)

// what minOrders=1 would add
const pv1 = await previewHarvest({ minOrders: 1 })
const new1 = pv1.graduations.filter((g) => { const ag = agByExt.get(g.externalAdGroupId); return !(ag && posKey.has(`${ag.id}|EXACT|${g.query.trim().toLowerCase()}`)) })
console.log(`\npreviewHarvest({ minOrders: 1 }): ${pv1.graduations.length} graduations · ${new1.length} genuinely new`)
const salesOfNew = new1.reduce((s, g) => s + g.salesCents, 0)
const spendOfNew = new1.reduce((s, g) => s + g.costCents, 0)
console.log(`  those ${new1.length}: sales ${eur(salesOfNew)} · spend ${eur(spendOfNew)} · blended ACoS ${salesOfNew ? `${Math.round((spendOfNew / salesOfNew) * 100)}%` : 'n/a'}`)
console.log(`\n  top 10 genuinely-new at minOrders=1:`)
console.log(`  ${pad('query', 44)} ${pad('ord', 4)} ${pad('sales', 9)} ${pad('spend', 8)} ${pad('CPC', 7)} source`)
for (const g of [...new1].sort((a, b) => b.salesCents - a.salesCents).slice(0, 10)) {
  const ag = agByExt.get(g.externalAdGroupId)
  const cpc = g.clicks > 0 ? g.costCents / g.clicks / 100 : 0
  console.log(`  ${pad(g.query, 44)} ${pad(String(g.orders), 4)} ${pad(eur(g.salesCents), 9)} ${pad(eur(g.costCents), 8)} ${pad(`€${cpc.toFixed(2)}`, 7)} ${(ag ? `${ag.campaign?.targetingType} ${ag.campaign?.name}` : '?').slice(0, 40)}`)
}

// ── 4. the 23 harvest suggestions ─────────────────────────────────────────────
console.log('\n\n═══ 4 · the harvest suggestions in the queue ═══\n')
const sg = await prisma.adsRuleSuggestion.findMany({ orderBy: { createdAt: 'desc' }, select: { ruleName: true, status: true, createdAt: true, entityType: true, entityId: true, proposedAction: true, proposedKey: true, marketplace: true } })
const hv = sg.filter((s) => ['promote_to_exact', 'harvest_and_negate'].includes(String((s.proposedAction as { type?: unknown } | null)?.type ?? '')))
console.log(`${hv.length} harvest suggestions:`)
console.log(`${pad('rule', 32)} ${pad('status', 9)} ${pad('age', 5)} ${pad('key', 34)} proposed`)
for (const s of hv.slice(0, 25)) {
  const age = Math.floor((now - s.createdAt.getTime()) / 86_400_000)
  console.log(`${pad(s.ruleName ?? '?', 32)} ${pad(s.status, 9)} ${pad(`${age}d`, 5)} ${pad(s.proposedKey, 34)} ${JSON.stringify(s.proposedAction).slice(0, 90)}`)
}

// ── 5. can a graduation even reach Amazon? ────────────────────────────────────
console.log('\n\n═══ 5 · write-gate posture where the candidates live ═══\n')
const campNames = new Set(pv.graduations.map((g) => agByExt.get(g.externalAdGroupId)?.campaign?.name).filter(Boolean) as string[])
const camps = await prisma.campaign.findMany({ where: { name: { in: [...campNames] } }, select: { name: true, marketplace: true, status: true, externalCampaignId: true, minBidCents: true, maxBidCents: true, pinBids: true } })
console.log(`${pad('campaign', 46)} ${pad('mkt', 4)} ${pad('status', 9)} ${pad('minBid', 7)} ${pad('maxBid', 7)} pinned  external?`)
for (const c of camps) console.log(`${pad(c.name, 46)} ${pad(c.marketplace ?? '?', 4)} ${pad(String(c.status), 9)} ${pad(c.minBidCents != null ? eur(c.minBidCents) : '—', 7)} ${pad(c.maxBidCents != null ? eur(c.maxBidCents) : '—', 7)} ${pad(String(c.pinBids ?? false), 7)} ${c.externalCampaignId ? 'yes' : 'NO'}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
