/**
 * PLC-P6 — run every placement starter through the REAL preview engine.
 *
 * The phase's own bar: "each starter run through the P2 preview returns a non-empty, correct match
 * set". A starter that matches nothing is a template that teaches an operator the tab is broken.
 *
 * Each draft is built exactly as the builder builds it (`previewActions`/`previewConditions`), and
 * the script ALSO asserts each starter's literals still appear in RuleBuilder.tsx — so if a starter
 * is edited and this file is not, the check fails instead of silently testing a ghost.
 */
import '../src/env.js'
import { readFileSync } from 'node:fs'
const { default: prisma } = await import('../src/db.js')
const { previewPlacementRule } = await import('../src/services/advertising/ads-rule-preview.service.js')

const SRC = readFileSync(new URL('../../web/src/app/marketing/ads/rules-automation/_shared/RuleBuilder.tsx', import.meta.url), 'utf8')

interface Cond { metric: string; op: string; value: string }
const STARTERS: Array<{ name: string; windowDays?: number; conds: Cond[]; op: string; value: string; lane: string }> = [
  { name: 'Stop overpaying Rest of Search on zero-sale clicks',
    conds: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '20' }],
    op: 'decPct', value: '30', lane: 'ros' },
  { name: 'Back proven converters where the rank engine won’t undo it', windowDays: 30,
    conds: [{ metric: 'ACOS', op: 'lte', value: '25' }, { metric: 'Orders', op: 'gte', value: '2' }],
    op: 'set', value: '25', lane: 'pdp' },
  { name: 'Stop paying for a placement that is seen and ignored',
    conds: [{ metric: 'CTR', op: 'lte', value: '0.3' }, { metric: 'Impressions', op: 'gte', value: '500' }],
    op: 'set', value: '0', lane: 'ros' },
]
const LANE_ENUM: Record<string, string> = { tos: 'PLACEMENT_TOP', pdp: 'PLACEMENT_PRODUCT_PAGE', ros: 'PLACEMENT_REST_OF_SEARCH' }

// every ENABLED campaign, the way "Add All" fills the picker
const picked = (await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true } })).map((c) => ({ id: c.id }))

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => { console.log(`  ${ok ? '✓' : '✗'} ${n} — ${d}`); ok ? pass++ : fail++ }

for (const s of STARTERS) {
  console.log(`\n── "${s.name}" ──`)
  check('still present in RuleBuilder.tsx', SRC.includes(s.name), 'literal found')
  for (const c of s.conds) {
    const lit = `{ metric: '${c.metric}', op: '${c.op}', value: '${c.value}' }`
    check(`criterion ${c.metric} ${c.op} ${c.value} unchanged`, SRC.includes(lit), lit)
  }
  check('lane + action unchanged', SRC.includes(`action: { op: '${s.op}', value: '${s.value}', placeTarget: '${s.lane}' }`), `${s.op} ${s.value}% on ${s.lane}`)

  const out = await previewPlacementRule({
    actions: [{ type: 'placement', campaigns: picked, placeFloor: 0, placeCeiling: 900, ...(s.windowDays ? { windowDays: s.windowDays } : {}) }],
    conditions: [{ match: 'all', action: { op: s.op, value: s.value, placeTarget: s.lane }, conditions: s.conds }],
    scopeMarketplace: null,
  })
  check('the engine can translate it at all', out.ok === true, `ok=${out.ok}${out.error ? ` (${out.error})` : ''}`)
  check('it reads the window the starter chose', out.windowDays === (s.windowDays ?? 7), `${out.windowDays} days`)
  check('🔴 it MATCHES something today', out.matched > 0, `${out.matched} of ${out.inScope} in scope match`)
  check('every row targets the lane the starter names', out.rows.every((r) => r.placement === LANE_ENUM[s.lane]), `${out.rows.length} rows on ${LANE_ENUM[s.lane]}`)
  const moving = out.rows.filter((r) => !r.clamped).length
  check('at least one row actually CHANGES a value', moving > 0, `${moving} of ${out.rows.length} rows move; ${out.rows.length - moving} sit at a guardrail`)
  if (out.rows.length) {
    const ex = out.rows[0]
    console.log(`      e.g. ${ex.campaign}: ${ex.currentPct}% → ${ex.proposedPct}% (${ex.placementLabel})${ex.governed ? ' · engine-managed' : ''}`)
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
