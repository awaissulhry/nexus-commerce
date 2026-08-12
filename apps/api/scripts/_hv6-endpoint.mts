/** HV.6 — the actors payload, proven. READ-ONLY. */
import '../src/env.js'
const { getHarvestActors } = await import('../src/services/advertising/harvest-actors.service.js')
const { default: prisma } = await import('../src/db.js')
const pad=(s:string,n:number)=>(s.length>n?`${s.slice(0,n-1)}…`:s.padEnd(n))
let fail=0
const ck=(l:string,ok:boolean,d='')=>{ if(!ok) fail++; console.log(`  ${ok?'✅':'🔴'} ${pad(l,60)} ${d}`) }

console.log('\n═══ HV.6 — the actors, proven ═══\n')
const p = await getHarvestActors({ market: 'all' })
console.log(`account dial: ${p.accountDial.level} (halted=${p.accountDial.halted})`)
console.log(`reach: ${p.reach.writable} of ${p.reach.campaigns} writable · ${p.reach.unreachable} unreachable`)
console.log(`window since ${p.window.since?.slice(0,10)}\n`)
for (const a of p.actors) {
  console.log(`── [${a.type}] ${a.name}`)
  console.log(`   level=${a.level} ceiling=${a.ceiling} writes=${a.writes} wrote=${a.wrote} landed=${a.landed ?? '—'}`)
  console.log(`   outcomes: acted=${a.outcomes.acted} proposed=${a.outcomes.proposed} refused=${a.outcomes.refused}${a.outcomes.refusedIsHistorical?' (historical)':' 🔴 LIVE'} failed=${a.outcomes.failed}`)
  if (a.heldBy) console.log(`   heldBy: ${a.heldBy.flag} ${a.heldBy.effect}`)
  if (a.registryDisagrees) console.log(`   🔴 registry says ${a.registryDisagrees.says}`)
  console.log(`   stated: ${a.stated ?? '(nothing)'}`)
  for (const e of a.executed) console.log(`   executed: ${e.text}  [${e.source}]`)
  for (const g of a.gaps) console.log(`   gap: ${g.title} — ${g.affected ?? '—'} ${g.affectedLabel ?? ''} → ${g.defersTo}`)
  console.log('')
}
console.log('─── checks ───')
// 1 · the four words are never merged and never negative
for (const a of p.actors) ck(`${a.name.slice(0,28)}: four words are non-negative`, [a.outcomes.acted,a.outcomes.proposed,a.outcomes.refused,a.outcomes.failed].every((n)=>n>=0 && Number.isFinite(n)))
// 2 · no actor renders a live cap
ck('no actor renders a live daily cap', p.actors.every((a)=>a.outcomes.refusedIsHistorical))
// 3 · levels are one of the four words
const FOUR = new Set(['OFF','OBSERVE','PROPOSE','AUTO'])
ck('every level is one of the four words', p.actors.every((a)=>FOUR.has(a.level)))
ck('every ceiling is one of the four words', p.actors.every((a)=>FOUR.has(a.ceiling)))
ck('no level exceeds its ceiling', p.actors.every((a)=>['OFF','OBSERVE','PROPOSE','AUTO'].indexOf(a.level) <= ['OFF','OBSERVE','PROPOSE','AUTO'].indexOf(a.ceiling)))
// 4 · every rule with a creating action is present
const acts = new Set(['promote_to_exact','harvest_and_negate','add_negative_exact','add_negative_phrase','sync_negatives_across_campaigns'])
const all: any[] = await prisma.automationRule.findMany({ where: { domain: 'advertising' } })
const expect = all.filter((r)=>((Array.isArray(r.actions)?r.actions:[]) as any[]).some((a)=>acts.has(a?.type)))
ck('every creating rule is on the list', p.actors.filter((a)=>a.type==='rule').length === expect.length, `${p.actors.filter((a)=>a.type==='rule').length} vs ${expect.length}`)
ck('the engine and the operator are on the list', p.actors.some((a)=>a.type==='engine') && p.actors.some((a)=>a.type==='operator'))
// 5 · resolveAutonomy is the ONLY source of a level
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')
const prot = await prisma.adKeywordProtection.count()
let lvlOk = true, ceilOk = true
for (const r of expect) {
  const row = p.actors.find((a)=>a.id===r.id); if(!row) continue
  if (row.level !== resolveAutonomy(r)) lvlOk = false
  const at = ((Array.isArray(r.actions)?r.actions:[]) as any[]).map((a)=>a?.type).filter(Boolean)
  if (row.ceiling !== graduationCeiling({ actionTypes: at, hasKeywordProtections: prot>0 }).maxLevel) ceilOk = false
}
ck('every rule level equals resolveAutonomy(rule)', lvlOk)
ck('every rule ceiling equals graduationCeiling(...)', ceilOk)
// 6 · writes are counted from the audit log, and landed ≤ wrote
ck('landed never exceeds wrote', p.actors.every((a)=>a.landed==null || a.landed<=a.wrote))
const engine = p.actors.find((a)=>a.type==='engine')!
const audit = await prisma.advertisingActionLog.count({ where: { actionType: { in: ['create_keyword','create_negative'] }, userId: 'automation:auto-harvest' } })
ck('the engine’s write count equals the audit log', engine.wrote === audit, `${engine.wrote} vs ${audit}`)
// 7 · not one RULE has ever written
ck('no rule has ever created a keyword or a negative', p.actors.filter((a)=>a.type==='rule').every((a)=>a.wrote===0))
// 8 · conflicts render nothing, with a reason
ck('conflicts are unavailable and say why', p.conflicts.available === false && p.conflicts.why.length > 80)
// 9 · the latent gaps state their zero rather than implying it
ck('the adapter gap states 0 affected, not null', p.latent.find((g)=>g.id==='adapter-metric-drop')?.affected === 0)
// 10 · the auto-targeting victim count is real
const at2 = await prisma.amazonAdsSearchTerm.count({ where: { matchType: { in: ['TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'] } } })
const g = p.actors.flatMap((a)=>a.gaps).find((x)=>x.id==='auto-targeting-blind-spot')
ck('the auto-targeting blind spot count is measured', g?.affected === at2, `${g?.affected} vs ${at2}`)
ck('NULL match types really are zero', await prisma.amazonAdsSearchTerm.count({ where: { matchType: null } }) === 0)
// 11 · reach uses ONE denominator
ck('reach: writable + unreachable = campaigns', p.reach.writable + p.reach.unreachable === p.reach.campaigns)
// 12 · a market scope changes the denominator
const it = await getHarvestActors({ market: 'IT' })
ck('a market scope narrows the denominator', it.reach.campaigns < p.reach.campaigns, `IT=${it.reach.campaigns} all=${p.reach.campaigns}`)
// 13 · the engine is held by a named flag, and the flag is not a mode
ck('the engine names the flag holding it', engine.heldBy?.flag === 'NEXUS_ADS_AUTO_HARVEST_ARMED')
ck('the engine level is PROPOSE while the flag is unset', engine.heldBy?.set === false && engine.level === 'PROPOSE')

console.log(`\n${fail===0?'✅ all checks passed':`🔴 ${fail} FAILED`}\n`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
