/** CAP — what the two writing rules actually did to the account, and what a cap would have stopped. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: { in: ['Campaign ACOS rebalance (cut + scale)', 'Trim budget on weak ACOS'] } },
  select: { id: true, name: true, maxExecutionsPerDay: true, autonomyLevel: true },
})

say('═══ WHAT THE TWO WRITING RULES DID ═══\n')
for (const r of rules) {
  const logs = await prisma.$queryRaw<Array<{ entityid: string; n: bigint; before: string; after: string; last: Date }>>`
    SELECT "entityId" AS entityid, COUNT(*)::bigint AS n,
           (ARRAY_AGG("payloadBefore"::text ORDER BY "createdAt" ASC))[1] AS before,
           (ARRAY_AGG("payloadAfter"::text ORDER BY "createdAt" DESC))[1] AS after,
           MAX("createdAt") AS last
    FROM "AdvertisingActionLog" WHERE "userId" = ${`automation:${r.id}`}
    GROUP BY 1 ORDER BY 2 DESC LIMIT 6`
  const totals = await prisma.$queryRaw<Array<{ n: bigint; entities: bigint }>>`
    SELECT COUNT(*)::bigint AS n, COUNT(DISTINCT "entityId")::bigint AS entities
    FROM "AdvertisingActionLog" WHERE "userId" = ${`automation:${r.id}`}`
  say(`  ${r.name} [${r.autonomyLevel}] cap=${r.maxExecutionsPerDay} ROWS/day`)
  say(`    ${int(totals[0].n)} writes across ${int(totals[0].entities)} distinct campaigns  →  ${(Number(totals[0].n) / Number(totals[0].entities)).toFixed(1)} writes per campaign`)
  for (const l of logs) {
    say(`      ${l.entityid.slice(0, 26)}  ×${String(int(l.n)).padStart(3)}   first-before ${l.before.slice(0, 60)}`)
    say(`      ${' '.repeat(26)}        last-after   ${l.after.slice(0, 60)}`)
  }
}

// ── where did the budgets end up? ──
say('\n═══ THE RESULT: CAMPAIGN DAILY BUDGETS TODAY ═══\n')
const buckets = await prisma.$queryRaw<Array<{ b: string; n: bigint }>>`
  SELECT CASE
    WHEN "dailyBudget" <= 1 THEN 'at or below €1.00 (the floor)'
    WHEN "dailyBudget" <= 2 THEN '€1.01 – €2.00'
    WHEN "dailyBudget" <= 5 THEN '€2.01 – €5.00'
    WHEN "dailyBudget" <= 20 THEN '€5.01 – €20.00'
    ELSE 'above €20.00' END AS b, COUNT(*)::bigint AS n
  FROM "Campaign" WHERE status = 'ENABLED' GROUP BY 1 ORDER BY 2 DESC`
const tot = buckets.reduce((s, b) => s + Number(b.n), 0)
for (const b of buckets) say(`  ${b.b.padEnd(32)} ${String(int(b.n)).padStart(5)}  ${((Number(b.n) / tot) * 100).toFixed(1)}%`)
say(`  ${'(all ENABLED campaigns)'.padEnd(32)} ${String(int(tot)).padStart(5)}`)

// ── the ratchet: budgets touched by these two rules, then and now ──
const ids = rules.map((r) => `automation:${r.id}`)
const touched = await prisma.$queryRaw<Array<{ n: bigint; atfloor: bigint }>>`
  SELECT COUNT(DISTINCT c.id)::bigint AS n,
         COUNT(DISTINCT c.id) FILTER (WHERE c."dailyBudget" <= 1)::bigint AS atfloor
  FROM "Campaign" c
  WHERE c.id IN (SELECT DISTINCT "entityId" FROM "AdvertisingActionLog" WHERE "userId" = ANY(${ids}))`
say(`\n  🔴 campaigns these two rules wrote to: ${int(touched[0].n)} — of which ${int(touched[0].atfloor)} now sit at or below the €1.00 floor`)

// ── notification projection under candidate caps ──
say('\n═══ NOTIFICATION PROJECTION ═══\n')
const enabled = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, maxExecutionsPerDay: true, autonomyLevel: true },
})
const users = await prisma.userProfile.count()
say(`  userProfile rows every notifyAutomation call fans out to: ${int(Math.min(users, 100))}\n`)
say(`  rule                                        ROWS/24h  NOTIFS/24h   under cap=RUNS(96/day)   under cap=1 RUN/day`)
let a = 0, b = 0, c = 0
for (const r of enabled) {
  const rows = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: new Date(Date.now() - 86400_000) } } })
  const notif = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COALESCE(SUM(COALESCE((x->'output'->>'notified')::int, 0)), 0)::bigint AS n
    FROM "AutomationRuleExecution" e CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) x
    WHERE e."ruleId" = ${r.id} AND e."startedAt" >= NOW() - INTERVAL '24 hours'`
  const per = rows ? Number(notif[0].n) / rows : 0
  const at96 = Math.min(rows, 96) * per
  const at1 = Math.min(rows, 9) * per // one logical run = up to 9 marketplace contexts
  a += Number(notif[0].n); b += at96; c += at1
  if (rows === 0) continue
  say(`  ${r.name.slice(0, 42).padEnd(43)} ${String(int(rows)).padStart(8)} ${String(int(notif[0].n)).padStart(11)} ${String(int(Math.round(at96))).padStart(22)} ${String(int(Math.round(at1))).padStart(21)}`)
}
say(`  ${'TOTAL'.padEnd(43)} ${''.padStart(8)} ${String(int(a)).padStart(11)} ${String(int(Math.round(b))).padStart(22)} ${String(int(Math.round(c))).padStart(21)}`)

process.stdout.write('\n<<<CAP-DAMAGE>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
