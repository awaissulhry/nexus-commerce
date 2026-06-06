/* RG.1 smoke — pure rank-grid model. Run: node_modules/.bin/tsx scripts/rank-grid-smoke.ts */
import { compileRankGrid, gridFromWindows, emptyRankGrid, describeRankGrid, rankGridCounts, type RankWin } from '../apps/web/src/app/marketing/ads-console/rank/rank-grid-model.ts'

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg) } }
const norm = (w: RankWin[]) => JSON.stringify(w.map(x => ({ d: [...x.days].sort((a, b) => a - b), s: x.startHour, e: x.endHour, t: x.targetKey })).sort((a, b) => a.d[0] - b.d[0] || a.s - b.s))

// 1) Round-trip: windows → grid → windows is stable (modulo grouping/order).
const w1: RankWin[] = [
  { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'own-top' },
  { days: [6, 0], startHour: 10, endHour: 14, targetKey: 'defend-top' },
]
const rt = compileRankGrid(gridFromWindows(w1))
ok(norm(rt) === norm(w1), `round-trip stable\n     got ${norm(rt)}\n     exp ${norm(w1)}`)

// 2) Baseline ('') cells emit no window.
const g2 = emptyRankGrid()
g2[1][9] = 'own-top'; g2[1][10] = 'own-top' // Mon 09–11 only
const c2 = compileRankGrid(g2)
ok(c2.length === 1 && c2[0].startHour === 9 && c2[0].endHour === 11 && c2[0].days.join() === '1', `single Mon 09–11 window, rest baseline (got ${norm(c2)})`)

// 3) Identical day-rows merge into one multi-day window.
const g3 = emptyRankGrid()
for (const d of [1, 2, 3]) for (let h = 20; h < 23; h++) g3[d][h] = 'own-top'
const c3 = compileRankGrid(g3)
ok(c3.length === 1 && c3[0].days.join() === '1,2,3', `Mon–Wed merge into one window (got ${norm(c3)})`)

// 4) Adjacent different targets become two windows, not one.
const g4 = emptyRankGrid()
g4[1][8] = 'defend-top'; g4[1][9] = 'own-top'
const c4 = compileRankGrid(g4)
ok(c4.length === 2, `two adjacent targets → two windows (got ${c4.length})`)

// 5) endHour=24 round-trips (full-evening-to-midnight).
const w5: RankWin[] = [{ days: [5], startHour: 20, endHour: 24, targetKey: 'own-top-allout' }]
const c5 = compileRankGrid(gridFromWindows(w5))
ok(norm(c5) === norm(w5), `endHour=24 survives (got ${norm(c5)})`)

// 6) Counts + describe sanity.
const cnt = rankGridCounts(g3)
ok(cnt['own-top'] === 9, `9 own-top hours counted (got ${cnt['own-top']})`)
const desc = describeRankGrid(g3, k => k === 'own-top' ? 'Own Top' : k, 'Baseline')
ok(desc.some(l => l.includes('Mon–Wed') && l.includes('Own Top 20–23')), `describe says Mon–Wed Own Top 20–23 (got ${JSON.stringify(desc)})`)

console.log(`\nRG.1 smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
