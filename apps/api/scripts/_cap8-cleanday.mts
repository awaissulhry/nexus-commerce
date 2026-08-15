/**
 * CAP.8 — the clean-day test. READ-ONLY.
 *
 * The 2026-08-14 proof rested on rules that were ALREADY over their caps when the counter came on
 * at 18:35 UTC, so it could only show they stopped. The honest test is a full UTC day that began
 * with the counter armed: each capped rule should climb to EXACTLY its cap and stop.
 *
 * 🔴 `rows < cap` is NOT the cap working. It means the rule's trigger stopped producing contexts —
 * a different condition entirely, and reading it as success is the same mistake as reading a rule
 * going quiet as a rule starting to work (`_neg7-rules.mts`, WH §7). The three states are reported
 * apart, and a day with no data at all FAILS rather than passing vacuously.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')
let fail = 0
const ck = (l: string, c: boolean, d = '') => { if (!c) fail++; say(`  ${c ? '✓' : '🔴'} ${l}${d ? ` — ${d}` : ''}`) }

const ARMED = new Date('2026-08-14T18:35:00Z')
const now = new Date()
const dayOf = (d: string) => ({ from: new Date(`${d}T00:00:00Z`), to: new Date(`${d}T23:59:59.999Z`) })

/** Every full UTC day that began with the counter already armed. */
const days: string[] = []
for (let t = new Date(Date.UTC(ARMED.getUTCFullYear(), ARMED.getUTCMonth(), ARMED.getUTCDate() + 1)); t < now; t.setUTCDate(t.getUTCDate() + 1)) {
  days.push(t.toISOString().slice(0, 10))
}
const todayStr = now.toISOString().slice(0, 10)
const cleanDays = days.filter((d) => d !== todayStr)

say(`now ${now.toISOString()}`)
say(`counter armed ${ARMED.toISOString()}`)
say(`full UTC days that began armed: ${cleanDays.length ? cleanDays.join(', ') : '(none yet)'}${days.includes(todayStr) ? ` · today ${todayStr} is partial` : ''}\n`)
if (cleanDays.length === 0) { say('🔴 no complete clean day yet — nothing to assert'); fail++ }

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, autonomyLevel: true, maxExecutionsPerDay: true, maxWritesPerDay: true },
})

for (const d of [...cleanDays, ...(days.includes(todayStr) ? [todayStr] : [])]) {
  const { from, to } = dayOf(d)
  const partial = d === todayStr
  say(`── ${d}${partial ? '  (PARTIAL — today, not asserted)' : '  (full clean day)'} ──`)
  say('  rule                                        level    cap   rows    writes  state')
  let atCap = 0, under = 0, over = 0, total = 0
  for (const r of rules) {
    const [rows, writes] = await Promise.all([
      prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: from, lte: to } } }),
      prisma.advertisingActionLog.count({ where: { userId: `automation:${r.id}`, createdAt: { gte: from, lte: to } } }),
    ])
    total += rows
    const cap = r.maxExecutionsPerDay
    let state: string
    if (cap == null) state = 'EXEMPT'
    else if (rows > cap) { state = '🔴 OVER CAP'; if (!partial) over++ }
    else if (rows === cap) { state = '✅ AT CAP — the cap held it'; if (!partial) atCap++ }
    else { state = 'under cap — trigger ran dry, NOT the cap'; if (!partial) under++ }
    say(`  ${r.name.slice(0, 42).padEnd(43)} ${String(r.autonomyLevel).padEnd(8)} ${String(cap ?? 'null').padStart(4)} ${String(int(rows)).padStart(6)} ${String(int(writes)).padStart(9)}  ${state}`)
  }
  say(`  day total rows: ${int(total)}`)
  if (!partial) {
    say(`  → at cap ${atCap} · under cap ${under} · OVER cap ${over}`)
    ck(`${d}: no rule exceeded its row cap`, over === 0)
    ck(`${d}: the day produced data at all (a silent account would pass vacuously)`, total > 0, `${int(total)} rows`)
  }
  say('')
}

// ── the before/after that matters, per full day ────────────────────────────────────────────────
say('── account totals per UTC day ──')
const daily = await prisma.$queryRaw<Array<{ d: Date; rows: bigint }>>`
  SELECT date_trunc('day', "startedAt") AS d, COUNT(*)::bigint AS rows
  FROM "AutomationRuleExecution" WHERE "startedAt" >= NOW() - INTERVAL '8 days' GROUP BY 1 ORDER BY 1`
const nDaily = await prisma.$queryRaw<Array<{ d: Date; n: bigint }>>`
  SELECT date_trunc('day', "createdAt") AS d, COUNT(*)::bigint AS n
  FROM "Notification" WHERE "createdAt" >= NOW() - INTERVAL '8 days' GROUP BY 1 ORDER BY 1`
const nBy = new Map(nDaily.map((x) => [x.d.toISOString().slice(0, 10), Number(x.n)]))
say('  day          execution rows   notifications')
for (const x of daily) {
  const k = x.d.toISOString().slice(0, 10)
  const mark = k === '2026-08-14' ? '   ← armed 18:35 UTC' : (k > '2026-08-14' ? '   ← clean day' : '')
  say(`  ${k}   ${String(int(x.rows)).padStart(14)}   ${String(int(nBy.get(k) ?? 0)).padStart(13)}${mark}`)
}

const pre = daily.filter((x) => x.d.toISOString().slice(0, 10) < '2026-08-14').map((x) => Number(x.rows))
const post = daily.filter((x) => x.d.toISOString().slice(0, 10) > '2026-08-14' && x.d.toISOString().slice(0, 10) !== todayStr).map((x) => Number(x.rows))
if (pre.length && post.length) {
  const avgPre = pre.reduce((a, b) => a + b, 0) / pre.length
  const avgPost = post.reduce((a, b) => a + b, 0) / post.length
  say(`\n  mean rows/day BEFORE arming: ${int(Math.round(avgPre))} · AFTER (full clean days): ${int(Math.round(avgPost))} · ${(((avgPost - avgPre) / avgPre) * 100).toFixed(1)}%`)
  ck('the account writes materially fewer execution rows on a clean day', avgPost < avgPre * 0.5, `${int(Math.round(avgPre))} → ${int(Math.round(avgPost))}`)
}

// ── refusal visibility: still the CAP.8 gap ────────────────────────────────────────────────────
const capRows = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: ARMED }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
const writeCapRows = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: ARMED }, errorMessage: 'WRITE_CAP_REACHED' } })
say(`\n── refusal visibility since arming ──`)
say(`  DAILY_CAP_EXCEEDED rows: ${int(capRows)}   ← a ROW-cap refusal writes no row (ADX.1)`)
say(`  WRITE_CAP_REACHED rows:  ${int(writeCapRows)}   ← a WRITE-cap demotion does`)
say(`  🔴 CAP.8's question stands: the row cap has now demonstrably fired thousands of times and has`)
say(`     left no durable trace of doing so. Its only evidence is the absence above.`)

say(fail === 0 ? '\n✓ all assertions passed' : `\n🔴 ${fail} FAILED`)
process.stdout.write('\n<<<CAP8-CLEANDAY>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
