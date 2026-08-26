/**
 * AR page — READ-ONLY. The exact row count at each of the four grains, and what an
 * aggregate row would carry. These are the numbers AR.S0's verification section asserts.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const num = (v: unknown) => Number(v ?? 0)

const camps = await prisma.campaign.findMany({
  select: {
    id: true, name: true, marketplace: true, status: true, portfolioId: true,
    dailyBudget: true, liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true,
    pinBids: true, pinBudget: true, pinPlacement: true, deliveryStatus: true,
  },
})
type C = (typeof camps)[number]
const N = camps.length
const agg = (g: C[]) => ({
  n: g.length,
  managed: g.filter((c) => c.liveBidWritesEnabled).length,
  bounded: g.filter((c) => c.minBidCents != null || c.maxBidCents != null).length,
  pinned: g.filter((c) => c.pinBids || c.pinBudget || c.pinPlacement).length,
  live: g.filter((c) => c.status === 'ENABLED').length,
  delivering: g.filter((c) => c.deliveryStatus === 'DELIVERING').length,
  budget: g.reduce((a, c) => a + num(c.dailyBudget), 0),
})
const line = (label: string, g: C[]) => {
  const a = agg(g)
  console.log(`   ${pad(label, 30)} n=${String(a.n).padStart(3)} live=${String(a.live).padStart(3)} managed=${String(a.managed).padStart(3)} bounded=${String(a.bounded).padStart(3)} pinned=${a.pinned} deliv=${String(a.delivering).padStart(3)} €${a.budget.toFixed(2)}/d`)
}

console.log(`\n═══ grain row counts — ${N} campaigns ═══`)

// ── grain: market ────────────────────────────────────────────────────────────
console.log('\n── grain = MARKET ──')
const markets = [...new Set(camps.map((c) => c.marketplace ?? '«null»'))].sort()
for (const m of markets) line(m, camps.filter((c) => (c.marketplace ?? '«null»') === m))
console.log(`   ROWS AT THIS GRAIN: ${markets.length}`)

// ── grain: portfolio ─────────────────────────────────────────────────────────
console.log('\n── grain = PORTFOLIO ──')
const pf = await prisma.$queryRawUnsafe<Array<{ externalPortfolioId: string; name: string }>>(
  `SELECT "externalPortfolioId", "name" FROM "AdPortfolio"`,
).catch(() => null)
const pfNames = new Map((pf ?? []).map((p) => [p.externalPortfolioId, p.name]))
console.log(`   AdPortfolio rows in DB: ${pf == null ? 'READ FAILED (not a zero)' : pf.length}`)
const pfIds = [...new Set(camps.map((c) => c.portfolioId).filter(Boolean))] as string[]
for (const id of pfIds.sort()) line(`${pfNames.get(id) ?? id}`, camps.filter((c) => c.portfolioId === id))
const noPf = camps.filter((c) => !c.portfolioId)
line('«No portfolio»', noPf)
console.log(`   distinct portfolios ON campaigns: ${pfIds.length} · campaigns with none: ${noPf.length} (${((noPf.length / N) * 100).toFixed(1)}%)`)
console.log(`   ROWS AT THIS GRAIN: ${pfIds.length} + 1 ("No portfolio") = ${pfIds.length + 1}`)
if (pf) {
  const empty = pf.filter((p) => !pfIds.includes(p.externalPortfolioId))
  console.log(`   portfolios that exist but hold NO campaign: ${empty.length}${empty.length ? ` — ${empty.map((p) => p.name).join(', ')}` : ''}`)
}

// ── grain: product line ──────────────────────────────────────────────────────
console.log('\n── grain = PRODUCT LINE (Product.parentId) ──')
const ads = await prisma.adProductAd.findMany({ select: { productId: true, adGroup: { select: { campaignId: true } } } })
const prodIds = [...new Set(ads.map((a) => a.productId).filter(Boolean))] as string[]
const prods = await prisma.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, parentId: true, sku: true, name: true } })
const parentOf = new Map(prods.map((p) => [p.id, p.parentId]))
const parentIds = [...new Set(prods.map((p) => p.parentId).filter(Boolean))] as string[]
const parents = await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true, name: true } })
const parentName = new Map(parents.map((p) => [p.id, p.sku || p.name]))
console.log(`   advertised productIds: ${prodIds.length} · resolved in Product: ${prods.length} · UNCATALOGUED: ${prodIds.length - prods.length}`)
console.log(`   distinct parents (lines): ${parentIds.length}`)
const campsByLine = new Map<string, Set<string>>()
let campsNoLine = new Set(camps.map((c) => c.id))
for (const a of ads) {
  const cid = a.adGroup?.campaignId
  if (!cid || !a.productId) continue
  const parent = parentOf.get(a.productId)
  const key = parent ?? (parentOf.has(a.productId) ? '«no parent»' : '«uncatalogued»')
  if (!campsByLine.has(key)) campsByLine.set(key, new Set())
  campsByLine.get(key)!.add(cid)
  campsNoLine.delete(cid)
}
const byId = new Map(camps.map((c) => [c.id, c]))
for (const [k, set] of [...campsByLine].sort((a, b) => b[1].size - a[1].size)) {
  line(parentName.get(k) ?? k, [...set].map((i) => byId.get(i)).filter(Boolean) as C[])
}
line('«campaigns advertising nothing»', [...campsNoLine].map((i) => byId.get(i)).filter(Boolean) as C[])
console.log(`   ROWS AT THIS GRAIN: ${campsByLine.size} + 1 (campaigns with no product ad) = ${campsByLine.size + 1}`)
console.log(`   🔴 a campaign can appear under MORE THAN ONE line — Σ per-line campaigns = ${[...campsByLine.values()].reduce((a, s) => a + s.size, 0)} vs ${N} campaigns`)

// ── grain: campaign ──────────────────────────────────────────────────────────
console.log(`\n── grain = CAMPAIGN ──\n   ROWS AT THIS GRAIN: ${N}`)
const a = agg(camps)
console.log(`   totals: live ${a.live} · managed ${a.managed} · bounded ${a.bounded} · pinned ${a.pinned} · delivering ${a.delivering} · €${a.budget.toFixed(2)}/day`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
