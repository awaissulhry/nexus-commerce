/**
 * D-PLC-2 — does the real arming check refuse the real fixture rule? Read-only: it calls the
 * checker directly and writes nothing.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { checkPlacementAutoAllowed } = await import('../src/services/advertising/ads-placement-autonomy.js')
const { producedActionTypes } = await import('../src/services/advertising/ads-rule-adapter.service.js')

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => { console.log(`  ${ok ? '✓' : '✗'} ${n} — ${d}`); ok ? pass++ : fail++ }

const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, actions: true, conditions: true } })
const plc = rules.find((r) => (r.actions as Array<{ type?: string }>)?.[0]?.type === 'placement')
if (!plc) { console.log('no placement rule on prod'); process.exit(1) }
console.log(`fixture: "${plc.name}"`)
const types = producedActionTypes(plc)
console.log(`produces: ${JSON.stringify(types)}\n`)

const auto = await checkPlacementAutoAllowed(plc, 'AUTO', types)
const propose = await checkPlacementAutoAllowed(plc, 'PROPOSE', types)
console.log(`AUTO verdict: blocked=${auto.blocked}${auto.blocked ? `\n  → ${auto.message}` : ''}\n`)

// the fixture targets Top of Search on GALE BROAD IT, which is NOT governed → must be allowed
check('the fixture is allowed at AUTO (its one campaign is ungoverned)', auto.blocked === false, `governed overlap: ${auto.governed.length}`)
check('PROPOSE is never blocked', propose.blocked === false, 'by construction')

// now the counterfactual: the same rule pointed at a GOVERNED campaign
const governed = await prisma.adSchedule.findFirst({ where: { enabled: true }, select: { campaignId: true } })
const gc = await prisma.campaign.findUnique({ where: { id: governed!.campaignId }, select: { name: true } })
const a0 = { ...(plc.actions as Array<Record<string, unknown>>)[0] }
const contested = { ...plc, actions: [{ ...a0, campaigns: [{ id: governed!.campaignId }] }] }
const v = await checkPlacementAutoAllowed(contested, 'AUTO', types)
check('🔴 the SAME rule on a governed campaign is REFUSED at AUTO', v.blocked === true, `"${gc?.name}"`)
if (v.blocked) console.log(`  → ${v.message}\n`)

// and the exception: switch its lane to Product Pages, same governed campaign
const pdp = { ...contested, conditions: (plc.conditions as Array<Record<string, unknown>>).map((g) => ({ ...g, action: { ...(g.action as object), placeTarget: 'pdp' } })) }
const vp = await checkPlacementAutoAllowed(pdp, 'AUTO', types)
check('🔴 the same rule on Product Pages is ALLOWED — the engine does not contest that lane', vp.blocked === false, 'exception holds')

// an empty picker reaches the whole account, so it must be refused too
const wide = { ...plc, actions: [{ ...a0, campaigns: [] }] }
const vw = await checkPlacementAutoAllowed(wide, 'AUTO', types)
check('an EMPTY picker is refused — an empty allowlist means the whole account', vw.blocked === true, `${vw.governed.length} governed campaigns in reach`)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
