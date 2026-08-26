/**
 * BUD.1 — call the service the way the route will, before the route exists.
 *
 * A typecheck cannot tell me the census reconciles with the grid, that a state chip returns the
 * rows it advertises, or that the cursor is the shape the client will compare. READ-ONLY.
 */
import '../src/env.js'
const {
  getBudgetGrid, getBudgetCursorForRequest, BUD_STATES,
} = await import('../src/services/advertising/budget-grid.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const base = {
  market: 'all', product: null, portfolio: null, campaign: null,
  status: 'enabled' as const, state: null, q: null, windowDays: 7,
  sort: null, dir: 'desc' as const, limit: 5000,
}

// ── 1 · the default view ──────────────────────────────────────────────────────────────────────
const g = await getBudgetGrid({ ...base, view: 'campaigns' })
console.log(`\n── census (market=all, status=enabled, 7d) ──`)
console.log(JSON.stringify(g.census, null, 1))
console.log(`  scope: ${g.scope.campaigns ?? 'all'} of ${g.scope.total} · applied=[${g.scope.applied}] contradiction=${g.scope.contradiction}`)
console.log(`  rows=${g.rows.length} total=${g.total} truncated=${g.truncated}`)
console.log(`  cursor: ${JSON.stringify(g.cursor)}`)
console.log(`  freshness: ${JSON.stringify(g.freshness)}`)

// ── 2 · does every census number reconcile with a filter? ─────────────────────────────────────
console.log(`\n── every clickable census number must reproduce itself ──`)
type Row = { atFloor: boolean; gateOpen: boolean; dailyBudgetCents: number; name: string; writes24h: number; reachedByRuleIds: string[]; utilization7d: number | null; lastMovedBy: string | null; delta7dCents: number }
const checks: Array<[string, number, Promise<number>]> = [
  ['at-floor', g.census.atFloor, getBudgetGrid({ ...base, view: 'campaigns', state: 'at-floor' }).then((r) => r.total)],
  ['cuttable', g.census.cuttable, getBudgetGrid({ ...base, view: 'campaigns', state: 'cuttable' }).then((r) => r.total)],
  ['gate-denied', g.census.gateDenied, getBudgetGrid({ ...base, view: 'campaigns', state: 'gate-denied' }).then((r) => r.total)],
  ['moved-24h', g.census.moved24h, getBudgetGrid({ ...base, view: 'campaigns', state: 'moved-24h' }).then((r) => r.total)],
]
let bad = 0
for (const [label, claimed, p] of checks) {
  const got = await p
  const ok = claimed === got
  if (!ok) bad++
  console.log(`  ${pad(label, 14)} census=${pad(String(claimed), 5)} filter returns=${pad(String(got), 5)} ${ok ? '✓' : '🔴 MISMATCH'}`)
}

// ── 3 · the facet counts must match the same filters ──────────────────────────────────────────
console.log(`\n── facets ──`)
for (const f of g.facets.state) console.log(`  ${pad(f.value, 14)} ${f.count}`)
console.log(`  markets: ${g.facets.market.map((m) => `${m.value}=${m.count}`).join(' ')}`)

// ── 4 · sample campaign rows ──────────────────────────────────────────────────────────────────
console.log(`\n── top 8 campaign rows by budget ──`)
for (const r of (g.rows as unknown as Row[]).slice(0, 8)) {
  const u = r.utilization7d == null ? '—' : `${(r.utilization7d * 100).toFixed(0)}%`
  console.log(`  ${pad(r.name, 34)} ${pad(eur(r.dailyBudgetCents), 9)} util7d=${pad(u, 6)} floor=${r.atFloor ? 'Y' : 'n'} gate=${r.gateOpen ? 'open' : 'CLOSED'} w24=${r.writes24h} rules=${r.reachedByRuleIds.length} Δ7d=${eur(r.delta7dCents)} by=${r.lastMovedBy ?? '—'}`)
}

// ── 5 · the rules view ────────────────────────────────────────────────────────────────────────
const rv = await getBudgetGrid({ ...base, view: 'rules' })
console.log(`\n── rules view (${rv.total} rows) ──`)
type RRow = { name: string; level: string; acts: boolean; percent: number | null; trigger: string; executions7d: number; succeeded7d: number; dryRun7d: number; wrote7d: number; refused7d: number; failed7d: number; canStillMove: number; alreadyAtFloor: number; scopeText: string; actionTypes: string[]; conditionsText: string; maxExecutionsPerDay: number | null }
for (const r of rv.rows as unknown as RRow[]) {
  console.log(`  ${pad(r.name, 40)} ${pad(r.level, 8)} ${pad(r.percent == null ? '—' : `${r.percent}%`, 6)} ${pad(r.trigger, 28)} cap=${pad(String(r.maxExecutionsPerDay ?? '—'), 4)} scope=${r.scopeText}`)
  console.log(`      7d: exec=${r.executions7d} success=${r.succeeded7d} dryRun=${r.dryRun7d} wrote=${r.wrote7d} refused=${r.refused7d} failed=${r.failed7d}`)
  console.log(`      reach: canStillMove=${r.canStillMove} alreadyAtFloor=${r.alreadyAtFloor} · actions=[${r.actionTypes}] · ${r.conditionsText}`)
}
console.log(`  cursor(rules): ${JSON.stringify(rv.cursor)}`)

// ── 6 · the cursor endpoint agrees with the payload's cursor ──────────────────────────────────
const cc = await getBudgetCursorForRequest({ market: 'all', product: null, portfolio: null, campaign: null, view: 'campaigns', status: 'enabled' })
const cr = await getBudgetCursorForRequest({ market: 'all', product: null, portfolio: null, campaign: null, view: 'rules', status: 'enabled' })
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)
console.log(`\n── cursor: payload vs endpoint ──`)
console.log(`  campaigns  payload=${JSON.stringify(g.cursor)}`)
console.log(`             endpoint=${JSON.stringify(cc)}  ${same(g.cursor, cc) ? '✓ identical' : '🔴 DIFFERENT — the banner would be permanently on'}`)
console.log(`  rules      payload=${JSON.stringify(rv.cursor)}`)
console.log(`             endpoint=${JSON.stringify(cr)}  ${same(rv.cursor, cr) ? '✓ identical' : '🔴 DIFFERENT'}`)
if (!same(g.cursor, cc) || !same(rv.cursor, cr)) bad++

// ── 7 · scope edge cases must not throw ───────────────────────────────────────────────────────
console.log(`\n── edge cases ──`)
const edges: Array<[string, Record<string, unknown>]> = [
  ['portfolio + campaign together (campaign must win)', { portfolio: 'ZZZ', campaign: (g.rows as unknown as Array<{ id: string }>)[0]?.id ?? null }],
  ['a garbage campaign id', { campaign: 'not-a-real-id' }],
  ['a garbage portfolio', { portfolio: 'not-a-real-portfolio' }],
  ['a garbage product', { product: 'not-a-real-product' }],
  ['market=DE', { market: 'DE' }],
  ['status=all', { status: 'all' }],
]
for (const [label, patch] of edges) {
  try {
    const r = await getBudgetGrid({ ...base, view: 'campaigns', ...patch } as Parameters<typeof getBudgetGrid>[0])
    console.log(`  ${pad(label, 50)} rows=${pad(String(r.total), 5)} campaigns=${pad(String(r.scope.campaigns ?? 'all'), 5)} contradiction=${r.scope.contradiction ?? '—'}`)
  } catch (e) {
    bad++
    console.log(`  ${pad(label, 50)} 🔴 THREW: ${(e as Error).message}`)
  }
}

// ── 8 · every state chip returns only rows that match it ──────────────────────────────────────
console.log(`\n── a chip must never advertise a row it will not return ──`)
for (const s of BUD_STATES) {
  const r = await getBudgetGrid({ ...base, view: 'campaigns', state: s })
  const claimed = g.facets.state.find((f) => f.value === s)?.count ?? -1
  const ok = claimed === r.total
  if (!ok) bad++
  console.log(`  ${pad(s, 14)} facet=${pad(String(claimed), 5)} returns=${pad(String(r.total), 5)} ${ok ? '✓' : '🔴'}`)
}

console.log(`\n${bad === 0 ? '✅ all checks passed' : `🔴 ${bad} check(s) failed`}`)
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
