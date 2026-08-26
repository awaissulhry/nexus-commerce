/** AR — Apply Rules tab study. READ-ONLY. What each of the five columns actually governs. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

const camps = await prisma.campaign.findMany({
  select: {
    id: true, name: true, marketplace: true, status: true, dynamicBidding: true,
    targetAcosPct: true, minBidCents: true, maxBidCents: true,
    pinBids: true, pinBudget: true, pinPlacement: true, liveBidWritesEnabled: true,
    biddingStrategy: true, portfolioId: true,
  },
})
const db = (c: (typeof camps)[number]) => (c.dynamicBidding ?? {}) as { targetAcos?: number; bidAutomation?: boolean; placementBidding?: unknown[]; cpcCeiling?: unknown; maxBidChangePct?: number }
const live = camps.filter((c) => c.status === 'ENABLED')

console.log(`\n═══ AR — Apply Rules: ${camps.length} campaigns (${live.length} ENABLED) ═══\n`)

// ── the five columns, measured ────────────────────────────────────────────────
const withTarget = camps.filter((c) => db(c).targetAcos != null)
const withAutomation = camps.filter((c) => db(c).bidAutomation === true)
console.log('── column 1: "Bid Rule" (bidAlgorithm) ──')
console.log('   no column, no field, no endpoint anywhere. Renders local useState. Always "Target ACOS".')

console.log('\n── column 2: "Target ACoS" → dynamicBidding.targetAcos (a FRACTION) ──')
console.log(`   campaigns with a target set : ${int(withTarget.length)} of ${camps.length}`)
console.log(`   campaigns with NO target    : ${int(camps.length - withTarget.length)}  ← the grid renders 30.00% for every one of these`)
const vals = withTarget.map((c) => db(c).targetAcos!).sort((a, b) => a - b)
if (vals.length) {
  const at = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))]
  console.log(`   values: min ${(at(0) * 100).toFixed(0)}% · median ${(at(0.5) * 100).toFixed(0)}% · max ${(at(1) * 100).toFixed(0)}%`)
  const byVal = new Map<string, number>()
  for (const v of vals) byVal.set(`${(v * 100).toFixed(0)}%`, (byVal.get(`${(v * 100).toFixed(0)}%`) ?? 0) + 1)
  console.log(`   distribution: ${[...byVal].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(' · ')}`)
  const absurd = withTarget.filter((c) => db(c).targetAcos! > 1)
  if (absurd.length) { console.log(`   🔴 targets above 100% ACoS: ${absurd.length}`); for (const c of absurd.slice(0, 5)) console.log(`        ${pad(c.name, 44)} ${(db(c).targetAcos! * 100).toFixed(0)}%`) }
}
console.log(`   the dead duplicate column Campaign.targetAcosPct is set on: ${camps.filter((c) => c.targetAcosPct != null).length}`)

console.log('\n── column 3: "Min/Max Bid" → Campaign.minBidCents / maxBidCents (REAL, write-gate enforced) ──')
console.log(`   minBidCents set : ${camps.filter((c) => c.minBidCents != null).length} of ${camps.length}`)
console.log(`   maxBidCents set : ${camps.filter((c) => c.maxBidCents != null).length} of ${camps.length}`)
console.log(`   ← the grid writes NEITHER; it edits local useState over two enforced columns`)

console.log('\n── column 4: "Bid Automation" → dynamicBidding.bidAutomation ──')
console.log(`   ON  : ${int(withAutomation.length)} of ${camps.length}   (ENABLED campaigns: ${live.filter((c) => db(c).bidAutomation === true).length} of ${live.length})`)

console.log('\n── column 5: "Budget Rule" ──')
console.log('   hard-coded <span>None</span> for all ' + camps.length + ' campaigns. No field, no endpoint.')

// ── what the page COULD show and does not ─────────────────────────────────────
console.log('\n── enforced per-campaign controls with NO UI on this page ──')
console.log(`   liveBidWritesEnabled (the write gate)  : ${camps.filter((c) => c.liveBidWritesEnabled).length} open / ${camps.length}`)
console.log(`   pinBids / pinBudget / pinPlacement     : ${camps.filter((c) => c.pinBids).length} / ${camps.filter((c) => c.pinBudget).length} / ${camps.filter((c) => c.pinPlacement).length}`)
console.log(`   placement multipliers set              : ${camps.filter((c) => Array.isArray(db(c).placementBidding) && (db(c).placementBidding as unknown[]).length > 0).length}`)
console.log(`   cpcCeiling configured                  : ${camps.filter((c) => db(c).cpcCeiling != null).length}`)
console.log(`   maxBidChangePct configured             : ${camps.filter((c) => db(c).maxBidChangePct != null).length}`)
console.log(`   carries a portfolio                    : ${camps.filter((c) => c.portfolioId).length}`)

// ── the filters the grid offers vs the account ────────────────────────────────
const byMkt = new Map<string, number>(); const byStatus = new Map<string, number>()
for (const c of camps) { byMkt.set(String(c.marketplace), (byMkt.get(String(c.marketplace)) ?? 0) + 1); byStatus.set(String(c.status), (byStatus.get(String(c.status)) ?? 0) + 1) }
console.log(`\n── the grid's population ──`)
console.log(`   by market : ${[...byMkt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`   by status : ${[...byStatus].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`   default filter is Status=Enabled, so the grid opens on ${live.length} rows of ${camps.length}`)
await prisma.$disconnect()
