/**
 * CAP — step 5. Is the counter actually binding? READ-ONLY.
 *
 * 🔴 A cap refusal writes NO execution row (ADX.1) — only an ephemeral publishAdsExecution
 * event on a 50-entry, 5-minute in-process ring buffer. So the cap is NOT observable as new
 * DAILY_CAP_EXCEEDED rows; it is observable only as the ABSENCE of rows above the cap.
 * `docs/2026-08-14-cap-sizing.md` §9 step 5 said to expect refusal rows. That was wrong.
 *
 * The observable: rows-today per rule must stop at maxExecutionsPerDay. Caps are per UTC day,
 * so on the day the counter is armed most rules are already over and go silent until 00:00 UTC.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')

const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
const now = new Date()
const hoursIn = (now.getTime() - dayStart.getTime()) / 3_600_000
say(`UTC day started ${dayStart.toISOString()} — ${hoursIn.toFixed(1)}h in, ${(24 - hoursIn).toFixed(1)}h to the reset\n`)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, autonomyLevel: true, maxExecutionsPerDay: true },
})

say('  rule                                        level     cap(ROWS)  rows TODAY  last row (UTC)   state')
const out: Array<{ name: string; cap: number | null; today: number; last: Date | null; lvl: string }> = []
for (const r of rules) {
  // per rule, never a shared page
  const today = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart } } })
  const last = await prisma.automationRuleExecution.findFirst({
    where: { ruleId: r.id }, orderBy: { startedAt: 'desc' }, select: { startedAt: true },
  })
  out.push({ name: r.name, cap: r.maxExecutionsPerDay, today, last: last?.startedAt ?? null, lvl: String(r.autonomyLevel) })
}
out.sort((a, b) => b.today - a.today)
let over = 0, bound = 0
for (const r of out) {
  const minsSince = r.last ? (now.getTime() - r.last.getTime()) / 60_000 : Infinity
  const state = r.cap == null ? 'EXEMPT'
    : r.today > r.cap ? `🔴 OVER by ${int(r.today - r.cap)} (pre-arming rows)`
      : r.today === r.cap ? '✅ AT CAP — bound'
        : minsSince > 30 ? 'quiet' : 'under'
  if (r.cap != null && r.today > r.cap) over++
  if (r.cap != null && r.today === r.cap) bound++
  say(`  ${r.name.slice(0, 42).padEnd(43)} ${r.lvl.padEnd(8)} ${String(r.cap ?? 'null').padStart(8)}  ${String(int(r.today)).padStart(10)}  ${(r.last?.toISOString().slice(11, 19) ?? '—').padStart(14)}   ${state}`)
}
say(`\n  rules already OVER their new cap today (they will go silent until 00:00 UTC): ${over}`)
say(`  rules sitting exactly AT their cap (the counter is holding them): ${bound}`)

// the counter's own clause, re-run against live data
const [oldClause, newClause, capRows] = await Promise.all([
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: dayStart }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: dayStart }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: dayStart }, errorMessage: 'DAILY_CAP_EXCEEDED' } }),
])
say(`\n  today: OLD clause counts ${int(oldClause)} · NEW clause counts ${int(newClause)} · DAILY_CAP_EXCEEDED rows written today ${int(capRows)}`)
say(`  🔴 ${int(capRows)} is EXPECTED to stay 0: a cap refusal writes no row (ADX.1). The cap is visible as absence, not as refusals.`)

// notifications, the loudest symptom
const n = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "Notification" WHERE "createdAt" >= NOW() - INTERVAL '1 hour'`
const n24 = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "Notification" WHERE "createdAt" >= NOW() - INTERVAL '24 hours'`
say(`\n  notifications in the last hour: ${int(n[0].n)}  ·  last 24h: ${int(n24[0].n)}   (pre-arming baseline was ~1,730/hour, 41,466/24h)`)

process.stdout.write('\n<<<CAP-WATCH>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
