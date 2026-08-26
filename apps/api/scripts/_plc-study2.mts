/** PLC part 2 — the compounding risk, and multiplier vs performance. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const STRAT: Record<string, string> = {
  LEGACY_FOR_SALES: 'down only', AUTO_FOR_SALES: 'UP AND DOWN', MANUAL: 'fixed',
}
const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, biddingStrategy: true, dynamicBidding: true, liveBidWritesEnabled: true },
})
interface PB { placement: string; percentage: number }
const topOf = (c: (typeof camps)[number]) => {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  return (db.placementBidding ?? []).find((p) => p.placement === 'PLACEMENT_TOP')?.percentage ?? 0
}

console.log('\n── COMPOUNDING RISK: Top multiplier >100% on "up and down" bidding ──')
console.log('   (Amazon can add up to +100% on top of the modifier; the two multiply)')
const risky = camps.filter((c) => c.biddingStrategy === 'AUTO_FOR_SALES' && topOf(c) > 100)
const upDown = camps.filter((c) => c.biddingStrategy === 'AUTO_FOR_SALES')
console.log(`  campaigns on up-and-down bidding      : ${upDown.length}`)
console.log(`  ...of those with Top modifier >100%   : ${risky.length}`)
for (const c of risky) console.log(`    ${pad(c.name, 50)} [${c.marketplace}] ${c.status} top=+${topOf(c)}% gate=${c.liveBidWritesEnabled}`)
if (!risky.length) console.log('    none — the dangerous pairing does not currently exist')

console.log('\n── Top multiplier ≥100% on ANY strategy (the modifier alone doubles the bid) ──')
const heavy = camps.filter((c) => topOf(c) >= 100).sort((a, b) => topOf(b) - topOf(a))
console.log(`  ${heavy.length} campaigns`)
for (const c of heavy.slice(0, 15)) {
  console.log(`    ${pad(c.name, 48)} [${c.marketplace}] +${String(topOf(c)).padStart(3)}%  ${pad(STRAT[String(c.biddingStrategy)] ?? String(c.biddingStrategy), 12)} ${c.status} gate=${c.liveBidWritesEnabled}`)
}

console.log('\n── strategy × has-a-Top-modifier ──')
const grid = new Map<string, { n: number; withTop: number }>()
for (const c of camps) {
  const k = STRAT[String(c.biddingStrategy)] ?? String(c.biddingStrategy)
  const e = grid.get(k) ?? { n: 0, withTop: 0 }
  e.n++; if (topOf(c) > 0) e.withTop++
  grid.set(k, e)
}
for (const [k, v] of grid) console.log(`  ${pad(k, 14)} ${String(v.n).padStart(4)} campaigns · ${String(v.withTop).padStart(4)} carry a Top modifier`)
await prisma.$disconnect()
