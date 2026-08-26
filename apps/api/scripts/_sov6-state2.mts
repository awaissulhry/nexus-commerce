/**
 * SOV — is the newest SQP week still FILLING, or frozen below the gate's threshold? READ-ONLY.
 *
 * The feed recovered: a 2026-08-02 period now exists in all four markets. But the completeness
 * gate still renders 2026-07-19, because 08-02 holds 259 IT rows against a threshold near 328.
 * So the page shows a 28-day-old week while a 14-day-old one sits in the table, rejected.
 *
 * Whether that self-corrects depends on one thing: is 08-02 still growing?
 *   · still filling  → the gate is right to wait, and the page needs to SAY it is waiting
 *   · frozen         → the gate will reject 08-02 forever and the page is stuck at 07-19
 *
 * `ingestedAt` / `updatedAt` answer it directly.
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date) => d.toISOString().slice(0, 10)
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

console.log('\n═══ is the newest week still filling? ═══\n')

for (const period of ['2026-08-02', '2026-07-26', '2026-07-19']) {
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { startDate: new Date(`${period}T00:00:00.000Z`) },
    select: { marketplace: true, ingestedAt: true, updatedAt: true, asin: true },
  })
  if (!rows.length) { console.log(`${period} — no rows`); continue }
  const ing = rows.map((r) => +r.ingestedAt).sort((a, b) => a - b)
  const upd = rows.map((r) => +r.updatedAt).sort((a, b) => a - b)
  const asins = new Set(rows.map((r) => r.asin))
  console.log(`── period ${period} · ${int(rows.length)} rows · ${asins.size} distinct ASINs ──`)
  console.log(`   first ingested ${stamp(new Date(ing[0]))} · last ingested ${stamp(new Date(ing[ing.length - 1]))}`)
  console.log(`   last updated   ${stamp(new Date(upd[upd.length - 1]))}`)
  const byDay = new Map<string, number>()
  for (const r of rows) byDay.set(day(r.ingestedAt), (byDay.get(day(r.ingestedAt)) ?? 0) + 1)
  console.log(`   rows first written per day: ${[...byDay.entries()].sort().map(([d, n]) => `${d}=${n}`).join(' · ')}`)
  const mk = new Map<string, number>()
  for (const r of rows) mk.set(r.marketplace, (mk.get(r.marketplace) ?? 0) + 1)
  console.log(`   by market: ${[...mk.entries()].sort().map(([m, n]) => `${m} ${n}`).join(' · ')}\n`)
}

// Did the last few nightly runs write anything at all?
const runs = await prisma.cronRun.findMany({ where: { jobName: { contains: 'sqp' } }, orderBy: { startedAt: 'desc' }, take: 10, select: { jobName: true, startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
console.log(`── the last ${runs.length} sqp cron runs ──`)
for (const r of runs) {
  const mins = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 60000) : null
  console.log(`  ${stamp(r.startedAt)} ${pad(r.jobName, 22)} ${pad(r.status, 8)} ${pad(mins == null ? '—' : `${mins}m`, 6)} ${r.outputSummary ?? ''}${r.errorMessage ? ` ERR:${r.errorMessage}` : ''}`)
}

// What the gate's baseline would need 08-02 to reach, per market.
console.log(`\n── the threshold 2026-08-02 has to clear, per market ──`)
const all = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'startDate'], _count: { _all: true } })
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }
for (const mk of ['IT', 'DE', 'ES', 'FR']) {
  const ps = all.filter((a) => a.marketplace === mk).sort((a, b) => +b.startDate - +a.startDate)
  const baseline = median(ps.slice(0, 12).map((p) => p._count._all))
  const threshold = 0.5 * baseline
  const aug2 = ps.find((p) => day(p.startDate) === '2026-08-02')?._count._all ?? 0
  const jul19 = ps.find((p) => day(p.startDate) === '2026-07-19')?._count._all ?? 0
  console.log(`  ${pad(mk, 4)} baseline(12) ${pad(int(baseline), 6)} · threshold ${pad(int(Math.round(threshold)), 6)} · 08-02 has ${pad(int(aug2), 6)} (${aug2 >= threshold ? 'PASSES' : `short by ${int(Math.ceil(threshold - aug2))}`}) · 07-19 has ${int(jul19)}`)
}

await prisma.$disconnect()
console.log('\n═══ end ═══\n')
