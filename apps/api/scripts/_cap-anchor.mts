/**
 * CAP — the anchors a proposed limit has to respect: what the account absorbs, what each
 * rule has ever actually written, and what the PROPOSE rules really produce. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, maxExecutionsPerDay: true },
})
const byActor = new Map(rules.map((r) => [`automation:${r.id}`, r]))

// ── 1 · every actor that has written to Amazon in 60 days, grouped ──────────
say('═══ 1 · WHO WRITES TO AMAZON (60 days) ═══\n')
const actors = await prisma.$queryRaw<Array<{ actor: string | null; n: bigint; ok: bigint; first: Date; last: Date }>>`
  SELECT "userId" AS actor, COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE "amazonResponseStatus" = 'SUCCESS')::bigint AS ok,
         MIN("createdAt") AS first, MAX("createdAt") AS last
  FROM "AdvertisingActionLog" WHERE "createdAt" >= NOW() - INTERVAL '60 days' GROUP BY 1`
let rankDefend = 0, rankDefendActors = 0, ruleWrites = 0, otherAuto = 0, human = 0, nullActor = 0
// 🔴 keyed by ACTOR id, never by name: two rules share the name "Trim budget on weak ACOS"
// (one AUTO enabled, one PROPOSE disabled) and a name lookup silently picks whichever comes first.
const perRule: Array<{ id: string; name: string; n: bigint; ok: bigint; last: Date }> = []
for (const a of actors) {
  const id = String(a.actor)
  if (id.startsWith('automation:rank-defend-')) { rankDefend += Number(a.n); rankDefendActors++ }
  else if (byActor.has(id)) { ruleWrites += Number(a.n); perRule.push({ id: byActor.get(id)!.id, name: byActor.get(id)!.name, n: a.n, ok: a.ok, last: a.last }) }
  else if (id.startsWith('automation:')) otherAuto += Number(a.n)
  else if (a.actor == null || id === 'null') nullActor += Number(a.n)
  else human += Number(a.n)
}
const total = actors.reduce((s, a) => s + Number(a.n), 0)
say(`  total Amazon-bound writes, 60d                     ${int(total)}`)
say(`  ├─ ad-rank-defend (${rankDefendActors} per-plan actors) ${' '.repeat(Math.max(0, 15 - String(rankDefendActors).length))}${int(rankDefend)}  ${((rankDefend / total) * 100).toFixed(1)}%  🔴 NOT a rule; carries no maxExecutionsPerDay`)
say(`  ├─ other automation actors (crons)                 ${int(otherAuto)}  ${((otherAuto / total) * 100).toFixed(1)}%`)
say(`  ├─ AutomationRule actors                           ${int(ruleWrites)}  ${((ruleWrites / total) * 100).toFixed(1)}%  ← everything a cap can govern`)
say(`  ├─ human / user:*                                  ${int(human)}  ${((human / total) * 100).toFixed(1)}%`)
say(`  └─ no actor recorded (null)                        ${int(nullActor)}  ${((nullActor / total) * 100).toFixed(1)}%`)

say(`\n  every AutomationRule that has EVER reached Amazon in 60 days:`)
perRule.sort((a, b) => Number(b.n) - Number(a.n))
for (const p of perRule) say(`    ${p.name.padEnd(44)} ${String(int(p.n)).padStart(6)} writes  (${int(p.ok)} SUCCESS)  last ${p.last.toISOString().slice(0, 16)}`)
const silent = rules.filter((r) => r.enabled && !perRule.some((p) => p.id === r.id))
say(`\n  🔴 enabled rules that have NEVER reached Amazon in 60 days: ${silent.length} of ${rules.filter((r) => r.enabled).length}`)
for (const s of silent) say(`    ${s.name.padEnd(44)} [${s.autonomyLevel}]`)

// ── 2 · the one rule that does write: when, and how much per day ────────────
say('\n═══ 2 · THE WRITING RULES, DAY BY DAY (last 14 days) ═══\n')
for (const p of perRule) {
  const r = rules.find((x) => x.id === p.id)!
  const daily = await prisma.$queryRaw<Array<{ d: Date; n: bigint }>>`
    SELECT date_trunc('day', "createdAt") AS d, COUNT(*)::bigint AS n
    FROM "AdvertisingActionLog" WHERE "userId" = ${`automation:${r.id}`} AND "createdAt" >= NOW() - INTERVAL '14 days'
    GROUP BY 1 ORDER BY 1`
  say(`  ${p.name}  [${r.autonomyLevel}] cap=${r.maxExecutionsPerDay} ROWS/day`)
  say(`    ${daily.map((x) => `${x.d.toISOString().slice(5, 10)}:${x.n}`).join('  ') || '(no writes in 14d)'}`)
  const peak = daily.reduce((m, x) => Math.max(m, Number(x.n)), 0)
  say(`    peak WRITES in one day: ${int(peak)}   ← the number a cap in WRITES would have to clear`)
}

// ── 3 · what the account spends, so a cap can be anchored in money ──────────
say('\n═══ 3 · WHAT THE ACCOUNT SPENDS ═══\n')
const spend = await prisma.$queryRaw<Array<{ d: Date; cents: bigint }>>`
  SELECT date_trunc('day', date) AS d, (SUM("costMicros") / 10000)::bigint AS cents
  FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'CAMPAIGN' AND date >= NOW() - INTERVAL '14 days'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 10`
for (const s of spend) say(`  ${s.d.toISOString().slice(0, 10)}   ${eur(Number(s.cents))}`)
const avg = spend.length ? spend.reduce((a, s) => a + Number(s.cents), 0) / spend.length : 0
say(`  mean daily spend over ${spend.length} days: ${eur(avg)}  →  ${eur(avg / 24)}/hour`)

// ── 4 · what PROPOSE rules actually produce: suggestions, not writes ─────────
say('\n═══ 4 · WHAT PROPOSE ACTUALLY PRODUCES ═══\n')
const sugg = await prisma.$queryRaw<Array<{ ruleId: string; n: bigint; open: bigint; last: Date }>>`
  SELECT "ruleId", COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE status = 'pending')::bigint AS open,
         MAX("createdAt") AS last
  FROM "AdsRuleSuggestion" GROUP BY 1 ORDER BY 2 DESC`
if (!sugg.length) say('  (no AdsRuleSuggestion rows at all)')
for (const s of sugg) {
  const r = rules.find((x) => x.id === s.ruleId)
  say(`  ${(r?.name ?? s.ruleId).padEnd(44)} ${String(int(s.n)).padStart(6)} suggestions  (${int(s.open)} open)  last ${s.last.toISOString().slice(0, 16)}`)
}
const sTot = await prisma.adsRuleSuggestion.count()
say(`  total AdsRuleSuggestion rows: ${int(sTot)}   ← the reviewable artifact ${int(38428)} notifications/day are announcing`)

// ── 5 · does the euro cap (maxDailyAdSpendCentsEur) ever bind? ───────────────
say('\n═══ 5 · THE OTHER CAP — maxDailyAdSpendCentsEur, in EUROS ═══\n')
const spendCapHits = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" e
  CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) a
  WHERE e."startedAt" >= NOW() - INTERVAL '60 days' AND a->>'error' LIKE 'DAILY_AD_SPEND_CAP_EXCEEDED%'`
const valueCapHits = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" e
  CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) a
  WHERE e."startedAt" >= NOW() - INTERVAL '60 days' AND a->>'error' = 'VALUE_CAP_EXCEEDED'`
say(`  DAILY_AD_SPEND_CAP_EXCEEDED refusals in 60d (the EURO cap, and it works): ${int(spendCapHits[0].n)}`)
say(`  VALUE_CAP_EXCEEDED refusals in 60d (per-execution value cap):            ${int(valueCapHits[0].n)}`)

// ── 6 · the 100%-failing primary actions, over 7 days not 1 ─────────────────
say('\n═══ 6 · ACTIONS THAT FAIL EVERY TIME (7 days, per rule) ═══\n')
for (const r of rules.filter((x) => x.enabled)) {
  const a = await prisma.$queryRaw<Array<{ atype: string; ok: bigint; failed: bigint; err: string | null }>>`
    SELECT a->>'type' AS atype,
           COUNT(*) FILTER (WHERE (a->>'ok')::boolean)::bigint AS ok,
           COUNT(*) FILTER (WHERE NOT (a->>'ok')::boolean)::bigint AS failed,
           (ARRAY_AGG(LEFT(a->>'error', 80) ORDER BY a->>'error'))[1] AS err
    FROM "AutomationRuleExecution" e
    CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) a
    WHERE e."ruleId" = ${r.id} AND e."startedAt" >= NOW() - INTERVAL '7 days'
    GROUP BY 1`
  for (const x of a) {
    if (Number(x.failed) > 0 && Number(x.ok) === 0) {
      say(`  🔴 ${r.name.padEnd(42)} ${x.atype.padEnd(22)} 0 ok / ${String(int(x.failed)).padStart(7)} failed in 7d — ${x.err ?? ''}`)
    }
  }
}

process.stdout.write('\n<<<CAP-ANCHOR>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
