/**
 * NAF.SB.AS — READ-ONLY ground truth for the Assignments page.
 *
 * Answers: what does the fleet actually have in production that an
 * "assignment" could point at? Every query below is a read (count /
 * groupBy / findMany). No create, update, upsert, delete or $executeRaw.
 *
 * Env trap (reference_scripts_env_trap): '../src/env.js' must be the FIRST
 * import, before db.js is ever resolved — hence the dynamic import of db.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const trunc = (v: unknown, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s == null) return 'null'
  return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s
}
const h = (t: string) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`)

// ───────────────────────────── 1. AgentRun ─────────────────────────────
h('1. AgentRun')
const runTotal = await prisma.agentRun.count()
console.log(`AgentRun total rows: ${runTotal}`)

const byMode = await prisma.agentRun.groupBy({ by: ['mode'], _count: { _all: true } })
console.log('\nby mode:')
for (const r of byMode.sort((a, b) => b._count._all - a._count._all))
  console.log(`  ${String(r.mode ?? 'NULL(non-fleet)').padEnd(20)} ${r._count._all}`)

const byTrigger = await prisma.agentRun.groupBy({ by: ['trigger'], _count: { _all: true } })
console.log('\nby trigger:')
for (const r of byTrigger.sort((a, b) => b._count._all - a._count._all))
  console.log(`  ${String(r.trigger).padEnd(20)} ${r._count._all}`)

const byKey = await prisma.agentRun.groupBy({ by: ['agentKey'], _count: { _all: true } })
console.log('\nby agentKey:')
for (const r of byKey.sort((a, b) => b._count._all - a._count._all))
  console.log(`  ${String(r.agentKey).padEnd(34)} ${r._count._all}`)

const byStatus = await prisma.agentRun.groupBy({ by: ['status'], _count: { _all: true } })
console.log('\nby status:')
for (const r of byStatus) console.log(`  ${String(r.status).padEnd(20)} ${r._count._all}`)

// entityType/entityId occupancy across ALL runs
const withEntity = await prisma.agentRun.count({ where: { entityId: { not: null } } })
const withEntityType = await prisma.agentRun.count({ where: { entityType: { not: null } } })
console.log(`\nruns with entityId NOT NULL:   ${withEntity} / ${runTotal}`)
console.log(`runs with entityType NOT NULL: ${withEntityType} / ${runTotal}`)
const etypes = await prisma.agentRun.groupBy({ by: ['entityType'], _count: { _all: true } })
console.log('entityType values: ' + etypes.map((e) => `${e.entityType ?? 'NULL'}=${e._count._all}`).join(', '))

// ── mode='ask' deep dive ──
h("1b. AgentRun WHERE mode='ask'")
const askCount = await prisma.agentRun.count({ where: { mode: 'ask' } })
console.log(`mode='ask' rows: ${askCount}`)
const asks = await prisma.agentRun.findMany({
  where: { mode: 'ask' },
  orderBy: { createdAt: 'desc' },
  select: {
    id: true, agentKey: true, trigger: true, status: true, ok: true,
    entityType: true, entityId: true, createdAt: true, endedAt: true,
    model: true, provider: true, costUSD: true, userId: true,
    findingCount: true, workflowKey: true, charterVersion: true,
    input: true, output: true,
  },
})
console.log('\nall ask runs (one line each):')
for (const a of asks)
  console.log(`  ${a.createdAt.toISOString()}  ${a.agentKey.padEnd(28)} trig=${a.trigger} status=${a.status} ok=${a.ok} entityType=${a.entityType ?? 'NULL'} entityId=${a.entityId ?? 'NULL'} findings=${a.findingCount} cost=$${a.costUSD} model=${a.model ?? '-'} user=${a.userId ?? 'NULL'}`)

console.log('\nask input/output JSON — up to 3 samples (truncated):')
for (const a of asks.slice(0, 3)) {
  console.log(`\n  --- run ${a.id} (${a.agentKey}, ${a.createdAt.toISOString()}) ---`)
  console.log(`  input  keys: ${a.input && typeof a.input === 'object' ? Object.keys(a.input as object).join(', ') : '(none)'}`)
  console.log(`  input  : ${trunc(a.input, 700)}`)
  console.log(`  output keys: ${a.output && typeof a.output === 'object' ? Object.keys(a.output as object).join(', ') : '(none)'}`)
  console.log(`  output : ${trunc(a.output, 700)}`)
}

// Do any runs at all carry a target entity, by mode?
const entityByMode = await prisma.agentRun.groupBy({
  by: ['mode'], _count: { _all: true }, where: { entityId: { not: null } },
})
console.log('\nruns carrying entityId, by mode: ' + (entityByMode.length ? entityByMode.map((e) => `${e.mode ?? 'NULL'}=${e._count._all}`).join(', ') : '(none — no run of any mode has an entityId)'))

// Also: what does a NON-ask fleet run's input look like, for contrast?
const otherFleet = await prisma.agentRun.findMany({
  where: { mode: { notIn: ['ask'], not: null } },
  orderBy: { createdAt: 'desc' }, take: 3,
  select: { id: true, mode: true, agentKey: true, createdAt: true, input: true, output: true },
})
console.log('\nfor contrast — 3 most recent NON-ask fleet runs:')
for (const r of otherFleet) {
  console.log(`  --- ${r.mode} · ${r.agentKey} · ${r.createdAt.toISOString()} ---`)
  console.log(`  input : ${trunc(r.input, 400)}`)
  console.log(`  output: ${trunc(r.output, 400)}`)
}

// ─────────────────────────── 2. AgentFinding ───────────────────────────
h('2. AgentFinding')
const findingTotal = await prisma.agentFinding.count()
console.log(`AgentFinding total rows: ${findingTotal}`)
const fByCharter = await prisma.agentFinding.groupBy({ by: ['charterKey'], _count: { _all: true } })
console.log('by charterKey: ' + (fByCharter.length ? fByCharter.map((f) => `${f.charterKey}=${f._count._all}`).join(', ') : '(none)'))
const fByEntityType = await prisma.agentFinding.groupBy({ by: ['entityType'], _count: { _all: true } })
console.log('by entityType: ' + (fByEntityType.length ? fByEntityType.map((f) => `${f.entityType}=${f._count._all}`).join(', ') : '(none)'))
const fByStatus = await prisma.agentFinding.groupBy({ by: ['status'], _count: { _all: true } })
console.log('by status: ' + (fByStatus.length ? fByStatus.map((f) => `${f.status}=${f._count._all}`).join(', ') : '(none)'))
const fBySeverity = await prisma.agentFinding.groupBy({ by: ['severity'], _count: { _all: true } })
console.log('by severity: ' + (fBySeverity.length ? fBySeverity.map((f) => `${f.severity}=${f._count._all}`).join(', ') : '(none)'))

const fSamples = await prisma.agentFinding.findMany({ orderBy: { createdAt: 'desc' }, take: 3 })
console.log(`\n3 sample AgentFinding rows (full field list from the row itself):`)
if (!fSamples.length) console.log('  (table is EMPTY — no rows to sample)')
for (const f of fSamples) {
  console.log(`\n  --- finding ${f.id} ---`)
  for (const [k, v] of Object.entries(f)) console.log(`    ${k.padEnd(16)} = ${trunc(v, 300)}`)
}

// ── 2b. do finding entityIds RESOLVE to real rows? ──
h('2b. AgentFinding.entityId — is it a real FK or free text?')
const allFindings = await prisma.agentFinding.findMany({
  select: { entityType: true, entityId: true, entityName: true, marketplace: true, kind: true },
})
const byType = new Map<string, string[]>()
for (const f of allFindings) {
  const a = byType.get(f.entityType) ?? []
  a.push(f.entityId)
  byType.set(f.entityType, a)
}
for (const [t, ids] of byType) {
  const uniq = [...new Set(ids)]
  console.log(`\n  ${t}: ${ids.length} findings, ${uniq.length} distinct entityId`)
  console.log(`    sample ids: ${uniq.slice(0, 5).map((i) => JSON.stringify(i)).join(', ')}`)
  if (t === 'AD_TARGET') {
    const hit = await prisma.adTarget.findMany({ where: { id: { in: uniq } }, select: { id: true, expressionValue: true, kind: true, adGroup: { select: { campaign: { select: { name: true, marketplace: true } } } } } })
    console.log(`    resolve against AdTarget.id → ${hit.length}/${uniq.length} MATCH`)
    for (const x of hit.slice(0, 3)) console.log(`      ${x.id} = ${x.kind} "${x.expressionValue}" in ${x.adGroup?.campaign?.marketplace}/${x.adGroup?.campaign?.name}`)
  }
  if (t === 'ASIN') {
    const hit = await prisma.productReadCache.findMany({ where: { asin: { in: uniq.map((u) => u.toUpperCase()) } }, select: { asin: true, name: true } })
    console.log(`    resolve against ProductReadCache.asin (uppercased) → ${hit.length}/${uniq.length} MATCH: ${hit.map((x) => x.asin).join(', ')}`)
    const hit2 = await prisma.adProductAd.findMany({ where: { asin: { in: uniq.map((u) => u.toUpperCase()) } }, select: { asin: true } })
    console.log(`    resolve against AdProductAd.asin (uppercased)     → ${hit2.length}/${uniq.length} MATCH (i.e. is it OUR advertised ASIN, or a competitor's?)`)
  }
}
console.log(`\n  findings with entityName NOT NULL: ${allFindings.filter((f) => f.entityName).length} / ${allFindings.length}`)
console.log(`  findings with marketplace NOT NULL: ${allFindings.filter((f) => f.marketplace).length} / ${allFindings.length}`)
const mk = await prisma.agentFinding.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log('  marketplace values: ' + mk.map((m) => `${m.marketplace ?? 'NULL'}=${m._count._all}`).join(', '))
const pt = await prisma.agentFinding.groupBy({ by: ['proposedTool'], _count: { _all: true } })
console.log('  proposedTool values: ' + pt.map((p) => `${p.proposedTool ?? 'NULL'}=${p._count._all}`).join(', '))
// one non-AD_TARGET sample of each type, to see how the target is named
for (const t of ['SEARCH_TERM', 'COMPONENT', 'ACCOUNT', 'ASIN']) {
  const s = await prisma.agentFinding.findFirst({ where: { entityType: t } })
  if (!s) continue
  console.log(`\n  --- ${t} sample (${s.id}) ---`)
  console.log(`    entityId    = ${JSON.stringify(s.entityId)}`)
  console.log(`    entityName  = ${JSON.stringify(s.entityName)}`)
  console.log(`    kind        = ${s.kind}  marketplace=${s.marketplace ?? 'NULL'}`)
  console.log(`    dedupeKey   = ${s.dedupeKey}`)
  console.log(`    observation = ${trunc(s.observation, 500)}`)
}

// ──────────────────── 3. AgentApproval / AgentPlan ─────────────────────
h('3. AgentApproval / AgentPlan')
const apprTotal = await prisma.agentApproval.count()
console.log(`AgentApproval total rows: ${apprTotal}`)
if (apprTotal) {
  const aByStatus = await prisma.agentApproval.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('by status: ' + aByStatus.map((a) => `${a.status}=${a._count._all}`).join(', '))
  const aByTool = await prisma.agentApproval.groupBy({ by: ['toolName'], _count: { _all: true } })
  console.log('by toolName: ' + aByTool.map((a) => `${a.toolName}=${a._count._all}`).join(', '))
  const aS = await prisma.agentApproval.findMany({ orderBy: { requestedAt: 'desc' }, take: 3 })
  for (const a of aS) {
    console.log(`\n  --- approval ${a.id} ---`)
    for (const [k, v] of Object.entries(a)) console.log(`    ${k.padEnd(14)} = ${trunc(v, 300)}`)
  }
}

const planTotal = await prisma.agentPlan.count()
console.log(`\nAgentPlan total rows: ${planTotal}`)
if (planTotal) {
  const pByStatus = await prisma.agentPlan.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('by status: ' + pByStatus.map((p) => `${p.status}=${p._count._all}`).join(', '))
  const pByCharter = await prisma.agentPlan.groupBy({ by: ['charterKey'], _count: { _all: true } })
  console.log('by charterKey: ' + pByCharter.map((p) => `${p.charterKey}=${p._count._all}`).join(', '))
  const pS = await prisma.agentPlan.findMany({ orderBy: { createdAt: 'desc' }, take: 3 })
  for (const p of pS) {
    console.log(`\n  --- plan ${p.id} ---`)
    for (const [k, v] of Object.entries(p)) console.log(`    ${k.padEnd(14)} = ${trunc(v, 500)}`)
  }
}

// other fleet tables that an assignment might live next to
for (const [name, fn] of [
  ['AgentStrategy', () => prisma.agentStrategy.count()],
  ['AgentStep', () => prisma.agentStep.count()],
  ['AgentObservation', () => prisma.agentObservation.count()],
  ['AgentExemplar', () => prisma.agentExemplar.count()],
  ['AgentScorecard', () => prisma.agentScorecard.count()],
  ['AgentShadowGrade', () => prisma.agentShadowGrade.count()],
  ['AgentControlAudit', () => prisma.agentControlAudit.count()],
  ['AgentEvalRun', () => prisma.agentEvalRun.count()],
  ['AgentCharterRevision', () => prisma.agentCharterRevision.count()],
  ['AgentFleetState', () => prisma.agentFleetState.count()],
  ['AgentDefinition', () => prisma.agentDefinition.count()],
  ['AgentMemory', () => prisma.agentMemory.count()],
] as [string, () => Promise<number>][]) {
  console.log(`${name.padEnd(24)} ${await fn()}`)
}

// ───────────────────── 4. the entity universe ──────────────────────────
h('4. Entity universe an assignment could point at')
const campTotal = await prisma.campaign.count()
console.log(`Campaign total: ${campTotal}`)
const cByMkt = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log('  by marketplace: ' + cByMkt.map((c) => `${c.marketplace ?? 'NULL'}=${c._count._all}`).join(', '))
const cByStatus = await prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } })
console.log('  by status: ' + cByStatus.map((c) => `${c.status}=${c._count._all}`).join(', '))
const cByType = await prisma.campaign.groupBy({ by: ['type'], _count: { _all: true } })
console.log('  by type: ' + cByType.map((c) => `${c.type}=${c._count._all}`).join(', '))
const cByMktStatus = await prisma.campaign.groupBy({ by: ['marketplace', 'status'], _count: { _all: true } })
console.log('  marketplace × status:')
for (const c of cByMktStatus.sort((a, b) => b._count._all - a._count._all))
  console.log(`    ${String(c.marketplace ?? 'NULL').padEnd(6)} ${String(c.status).padEnd(9)} ${c._count._all}`)
console.log(`  with externalCampaignId (real on Amazon): ${await prisma.campaign.count({ where: { externalCampaignId: { not: null } } })}`)
console.log(`  bid-suppressed right now:                 ${await prisma.campaign.count({ where: { bidsSuppressedAt: { not: null } } })}`)
console.log(`  with a portfolioId:                       ${await prisma.campaign.count({ where: { portfolioId: { not: null } } })}`)

const portTotal = await prisma.amazonAdsPortfolio.count()
console.log(`\nAmazonAdsPortfolio total: ${portTotal}`)
const pByState = await prisma.amazonAdsPortfolio.groupBy({ by: ['state'], _count: { _all: true } })
console.log('  by state: ' + pByState.map((p) => `${p.state ?? 'NULL'}=${p._count._all}`).join(', '))
const pByProfile = await prisma.amazonAdsPortfolio.groupBy({ by: ['profileId'], _count: { _all: true } })
console.log('  by profileId: ' + pByProfile.map((p) => `${p.profileId}=${p._count._all}`).join(', '))

const agTotal = await prisma.adGroup.count()
console.log(`\nAdGroup total: ${agTotal}`)
const agByStatus = await prisma.adGroup.groupBy({ by: ['status'], _count: { _all: true } })
console.log('  by status: ' + agByStatus.map((a) => `${a.status}=${a._count._all}`).join(', '))
console.log(`  orphaned (gone on Amazon): ${await prisma.adGroup.count({ where: { orphanedAt: { not: null } } })}`)

const atTotal = await prisma.adTarget.count()
console.log(`\nAdTarget total: ${atTotal}`)
const atByKind = await prisma.adTarget.groupBy({ by: ['kind'], _count: { _all: true } })
console.log('  by kind: ' + atByKind.map((a) => `${a.kind}=${a._count._all}`).join(', '))
const atByNeg = await prisma.adTarget.groupBy({ by: ['isNegative'], _count: { _all: true } })
console.log('  by isNegative: ' + atByNeg.map((a) => `${a.isNegative}=${a._count._all}`).join(', '))
const atKindNeg = await prisma.adTarget.groupBy({ by: ['kind', 'isNegative'], _count: { _all: true } })
console.log('  kind × isNegative:')
for (const a of atKindNeg.sort((x, y) => y._count._all - x._count._all))
  console.log(`    ${a.kind.padEnd(10)} isNegative=${String(a.isNegative).padEnd(5)} ${a._count._all}`)
const atByStatus = await prisma.adTarget.groupBy({ by: ['status'], _count: { _all: true } })
console.log('  by status: ' + atByStatus.map((a) => `${a.status}=${a._count._all}`).join(', '))
console.log(`  orphaned: ${await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })}`)
// negativeLevel — the OTHER negativity signal
const atNegLevel = await prisma.adTarget.groupBy({ by: ['negativeLevel'], _count: { _all: true } })
console.log('  by negativeLevel: ' + atNegLevel.map((a) => `${a.negativeLevel ?? 'NULL'}=${a._count._all}`).join(', '))
// the documented trap: negatives stored with expressionType EXACT/PHRASE
const atExprNeg = await prisma.adTarget.groupBy({
  by: ['expressionType'], _count: { _all: true }, where: { isNegative: true },
})
console.log('  expressionType of NEGATIVE rows: ' + atExprNeg.map((a) => `${a.expressionType}=${a._count._all}`).join(', '))

const paTotal = await prisma.adProductAd.count()
console.log(`\nAdProductAd (advertised ASIN/SKU rows) total: ${paTotal}`)
console.log(`  distinct ASINs advertised: ${(await prisma.adProductAd.findMany({ where: { asin: { not: null } }, select: { asin: true }, distinct: ['asin'] })).length}`)
console.log(`  linked to a local Product: ${await prisma.adProductAd.count({ where: { productId: { not: null } } })}`)

console.log(`\nProduct total: ${await prisma.product.count()}`)
console.log(`  with amazonAsin: ${await prisma.product.count({ where: { amazonAsin: { not: null } } })}`)
const prcTotal = await prisma.productReadCache.count()
console.log(`ProductReadCache rows: ${prcTotal}`)
for (const key of ['AMAZON_IT', 'AMAZON_DE', 'AMAZON_FR', 'AMAZON_ES']) {
  const n = await prisma.productReadCache.count({ where: { rollupChannelKeys: { has: key } } })
  console.log(`  advertisable on ${key}: ${n}`)
}

// ───────────────────────── 5. AgentCharter ─────────────────────────────
h('5. AgentCharter')
const charterTotal = await prisma.agentCharter.count()
console.log(`AgentCharter total rows: ${charterTotal}`)
const chInstances = await prisma.agentCharter.count({ where: { templateKey: { not: null } } })
console.log(`  templateKey NOT NULL (W.8 instances): ${chInstances}`)
console.log(`  templateKey NULL (code charters):     ${charterTotal - chInstances}`)
const charters = await prisma.agentCharter.findMany({
  orderBy: [{ tier: 'asc' }, { key: 'asc' }],
  select: {
    key: true, version: true, tier: true, domain: true, name: true, enabled: true,
    autonomyLevel: true, autonomyCap: true, cadence: true, templateKey: true,
    scopeMarketplaces: true, scopeCampaignIds: true, scopePortfolioIds: true,
    pausedUntil: true, dailyBudgetUSD: true, createdBy: true, createdAt: true,
  },
})
for (const c of charters)
  console.log(`  ${c.key.padEnd(30)} v${c.version} ${c.tier.padEnd(11)} ${c.domain.padEnd(12)} enabled=${String(c.enabled).padEnd(5)} lvl=${c.autonomyLevel.padEnd(8)} cap=${c.autonomyCap.padEnd(8)} tmpl=${c.templateKey ?? '-'} mkts=[${c.scopeMarketplaces.join('|')}] camps=${c.scopeCampaignIds.length} ports=${c.scopePortfolioIds.length} cadence=${c.cadence ?? '-'} by=${c.createdBy ?? '-'}`)

// Do ANY charters carry a scope today? That is the closest thing to an
// existing "assignment" in the system.
console.log(`\ncharters with non-empty scopeCampaignIds:  ${charters.filter((c) => c.scopeCampaignIds.length).length}`)
console.log(`charters with non-empty scopePortfolioIds: ${charters.filter((c) => c.scopePortfolioIds.length).length}`)
console.log(`charters with non-empty scopeMarketplaces: ${charters.filter((c) => c.scopeMarketplaces.length).length}`)

// ────────────────── 6. AgentWorkflow / Revision ────────────────────────
h('6. AgentWorkflow / AgentWorkflowRevision')
const wfTotal = await prisma.agentWorkflow.count()
console.log(`AgentWorkflow total rows: ${wfTotal}`)
const wfByKind = await prisma.agentWorkflow.groupBy({ by: ['kind'], _count: { _all: true } })
console.log('  by kind: ' + (wfByKind.length ? wfByKind.map((w) => `${w.kind}=${w._count._all}`).join(', ') : '(none)'))
const wfs = await prisma.agentWorkflow.findMany({ orderBy: { createdAt: 'asc' } })
for (const w of wfs)
  console.log(`  ${w.key.padEnd(28)} kind=${w.kind.padEnd(8)} enabled=${w.enabled} createdBy=${w.createdBy ?? '-'} "${w.name}"`)

const revTotal = await prisma.agentWorkflowRevision.count()
console.log(`\nAgentWorkflowRevision total rows: ${revTotal}`)
const revs = await prisma.agentWorkflowRevision.findMany({ orderBy: [{ workflowKey: 'asc' }, { revision: 'asc' }] })
for (const r of revs)
  console.log(`  ${r.workflowKey.padEnd(28)} rev${r.revision} active=${r.activatedAt ? r.activatedAt.toISOString() : 'no'} superseded=${r.supersededAt ? 'yes' : 'no'} author=${r.author ?? '-'} note="${trunc(r.note, 60)}"`)
console.log('\nactive revision definitions (contract v1 — this is where steps/targets live):')
for (const r of revs.filter((x) => x.activatedAt && !x.supersededAt))
  console.log(`  ${r.workflowKey} rev${r.revision}: ${trunc(r.definition, 900)}`)

// runs stamped with a workflow
console.log(`\nAgentRun rows carrying workflowKey: ${await prisma.agentRun.count({ where: { workflowKey: { not: null } } })}`)
const runWf = await prisma.agentRun.groupBy({ by: ['workflowKey'], _count: { _all: true }, where: { workflowKey: { not: null } } })
console.log('  by workflowKey: ' + (runWf.length ? runWf.map((r) => `${r.workflowKey}=${r._count._all}`).join(', ') : '(none)'))

await prisma.$disconnect()
