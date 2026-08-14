/**
 * CAP.8 §2/§3 — does the row cap actually stop anything, and how would we know? READ-ONLY.
 *
 * 🔴 The window is the whole question. The cap counts `startedAt >= UTC midnight`, and the counter
 * was armed at 18:35 UTC on 2026-08-14 — 18.6 hours INTO that day, by which point every rule had
 * already blown past its new cap on rows written while nothing was enforcing. So a rolling "last
 * 24h" figure right now is mostly pre-arming rows and cannot distinguish "the cap is broken" from
 * "the cap was switched on late in the day". Three windows are printed side by side.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')
let fail = 0
const ck = (l: string, c: boolean, d = '') => { if (!c) fail++; say(`  ${c ? '✓' : '🔴'} ${l}${d ? ` — ${d}` : ''}`) }

/** When the null-safe counter went live on prod (build 94de80aa healthy at 18:36:45Z). */
const ARMED = new Date('2026-08-14T18:35:00Z')
const now = new Date()
const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
const rolling24 = new Date(now.getTime() - 86400_000)

say(`now ${now.toISOString()}`)
say(`UTC day started ${dayStart.toISOString()} — ${((now.getTime() - dayStart.getTime()) / 3600_000).toFixed(1)}h in`)
say(`counter armed  ${ARMED.toISOString()} — ${((now.getTime() - ARMED.getTime()) / 3600_000).toFixed(1)}h ago`)
say(`🔴 the caps reset at 00:00 UTC, in ${((dayStart.getTime() + 86400_000 - now.getTime()) / 3600_000).toFixed(1)}h — that is the first CLEAN day\n`)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, autonomyLevel: true, maxExecutionsPerDay: true, maxWritesPerDay: true },
})

say('  rule                                        level    cap  ROLLING-24h  TODAY(00:00→)  SINCE-ARMED  verdict')
const rows: Array<{ name: string; cap: number | null; lvl: string; r24: number; today: number; since: number; last: Date | null }> = []
for (const r of rules) {
  // per rule, never a shared page
  const [r24, today, since, last] = await Promise.all([
    prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: rolling24 } } }),
    prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart } } }),
    prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: ARMED } } }),
    prisma.automationRuleExecution.findFirst({ where: { ruleId: r.id }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
  ])
  rows.push({ name: r.name, cap: r.maxExecutionsPerDay, lvl: String(r.autonomyLevel), r24, today, since, last: last?.startedAt ?? null })
}
rows.sort((a, b) => b.r24 - a.r24)
for (const r of rows) {
  const verdict = r.cap == null ? 'EXEMPT'
    : r.since === 0 ? '✓ silent since armed'
      : r.today <= r.cap ? '✓ within cap today'
        : '🔴 WROTE PAST ITS CAP AFTER ARMING'
  say(`  ${r.name.slice(0, 42).padEnd(43)} ${r.lvl.padEnd(8)} ${String(r.cap ?? 'null').padStart(4)}  ${String(int(r.r24)).padStart(11)}  ${String(int(r.today)).padStart(13)}  ${String(int(r.since)).padStart(11)}  ${verdict}`)
}

// ── the only honest test available before midnight ──────────────────────────────────────────────
say('\n── §3 · did ANY capped rule write after the counter was armed? ──')
const offenders = rows.filter((r) => r.cap != null && r.today > r.cap && r.since > 0)
const capped = rows.filter((r) => r.cap != null)
const silent = capped.filter((r) => r.since === 0)
say(`  capped rules: ${capped.length} · silent since arming: ${silent.length} · wrote since arming: ${capped.length - silent.length}`)
for (const r of capped.filter((x) => x.since > 0)) say(`    ${r.name.padEnd(43)} ${int(r.since)} rows since arming (cap ${r.cap}, today ${int(r.today)})`)
ck('no capped rule wrote past its cap after arming', offenders.length === 0,
  offenders.length ? offenders.map((o) => `${o.name}: today ${int(o.today)} > cap ${o.cap}`).join(' · ') : 'every over-cap row predates 18:35 UTC')

// ── §3(b) — is the check gated on autonomy? measured, not read ──────────────────────────────────
say('\n── §3(b) · does the cap bind PROPOSE rules, or only writers? ──')
const proposeCapped = capped.filter((r) => r.lvl === 'PROPOSE')
const proposeSilent = proposeCapped.filter((r) => r.since === 0)
say(`  PROPOSE rules carrying a row cap: ${proposeCapped.length} · silent since arming: ${proposeSilent.length}`)
for (const r of proposeCapped) say(`    ${r.name.padEnd(43)} today ${String(int(r.today)).padStart(6)} / cap ${String(r.cap).padStart(4)} · since armed ${int(r.since)}`)
ck('🔴 PROPOSE rules ARE capped — the check is not gated on autonomy level',
  proposeCapped.length > 0 && proposeSilent.length === proposeCapped.length,
  `${proposeSilent.length} of ${proposeCapped.length} stopped dead at arming`)

// ── the account-level shape, hour by hour ───────────────────────────────────────────────────────
say('\n── executions per hour, today (UTC) ──')
const hourly = await prisma.$queryRaw<Array<{ h: Date; n: bigint }>>`
  SELECT date_trunc('hour', "startedAt") AS h, COUNT(*)::bigint AS n
  FROM "AutomationRuleExecution" WHERE "startedAt" >= ${dayStart} GROUP BY 1 ORDER BY 1`
for (const h of hourly) {
  const hh = h.h.toISOString().slice(11, 16)
  const bar = '█'.repeat(Math.min(60, Math.round(Number(h.n) / 40)))
  say(`  ${hh}  ${String(int(h.n)).padStart(6)}  ${bar}${hh === '18:00' ? '   ← counter armed 18:35' : ''}`)
}

// ── notifications, and whether the dedupe deploy has had time to show ───────────────────────────
say('\n── notifications per hour, today (UTC) ──')
const nHourly = await prisma.$queryRaw<Array<{ h: Date; n: bigint }>>`
  SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::bigint AS n
  FROM "Notification" WHERE "createdAt" >= ${dayStart} GROUP BY 1 ORDER BY 1`
for (const h of nHourly) {
  const hh = h.h.toISOString().slice(11, 16)
  say(`  ${hh}  ${String(int(h.n)).padStart(6)}  ${'█'.repeat(Math.min(60, Math.round(Number(h.n) / 40)))}`)
}

const [n24, nPrior] = await Promise.all([
  prisma.notification.count({ where: { createdAt: { gte: rolling24 } } }),
  prisma.notification.count({ where: { createdAt: { gte: new Date(rolling24.getTime() - 86400_000), lt: rolling24 } } }),
])
say(`\n  notifications rolling-24h ${int(n24)} · prior 24h ${int(nPrior)} · change ${(((n24 - nPrior) / (nPrior || 1)) * 100).toFixed(1)}%`)
say(`  🔴 both windows are dominated by PRE-ARMING hours; the dedupe only deployed with build 37998bd1.`)

// ── refusals are invisible BY DESIGN — restate it with the number ───────────────────────────────
const capRows = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: dayStart }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
const writeCapRows = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: dayStart }, errorMessage: 'WRITE_CAP_REACHED' } })
say(`\n── the asymmetry CAP.8 is about ──`)
say(`  DAILY_CAP_EXCEEDED rows today: ${int(capRows)}  ← a ROW-cap refusal writes NO row (ADX.1). Invisible by design.`)
say(`  WRITE_CAP_REACHED rows today:  ${int(writeCapRows)}  ← a WRITE-cap demotion DOES leave a row (step 6).`)
ck('the row cap leaves no durable evidence of a refusal', capRows === 0,
  'this is the gap: the only proof a row cap fired is the ABSENCE of rows above it')

say(fail === 0 ? '\n✓ all assertions passed' : `\n🔴 ${fail} FAILED`)
process.stdout.write('\n<<<CAP8-OBSERVE>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
