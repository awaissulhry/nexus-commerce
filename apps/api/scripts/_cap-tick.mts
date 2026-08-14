/** CAP — exactly what the first tick under the armed counter wrote. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)

const since = new Date(process.argv[2] ?? '2026-08-14T18:44:00Z')
const rows = await prisma.$queryRaw<Array<{ name: string; cap: number | null; n: number; last: Date }>>`
  SELECT r.name, r."maxExecutionsPerDay" AS cap, COUNT(*)::int AS n, MAX(e."startedAt") AS last
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."startedAt" >= ${since} GROUP BY 1, 2 ORDER BY 3 DESC`
say(`rows written since ${since.toISOString()} — the first tick with the counter armed:`)
for (const x of rows) say(`  ${x.name.padEnd(44)} cap=${String(x.cap ?? 'null').padStart(5)}  rows=${String(x.n).padStart(4)}  last ${x.last.toISOString().slice(11, 19)}`)
if (!rows.length) say('  (none — no tick has fired in this window yet)')

const enabled = await prisma.automationRule.count({ where: { domain: 'advertising', enabled: true } })
const wrote = new Set(rows.map((r) => r.name))
say(`\n  enabled advertising rules: ${enabled} · rules that wrote in this window: ${wrote.size}`)
say(`  🔴 the ONLY rule expected to write is the one exempt from the row cap (Retail guard, cap=null);`)
say(`     every other rule was already past its new cap on pre-arming rows and must be silent until 00:00 UTC.`)

const exempt = rows.filter((r) => r.cap == null).map((r) => r.name)
const capped = rows.filter((r) => r.cap != null)
say(`\n  ✓ wrote and is EXEMPT: ${exempt.join(', ') || '(none)'}`)
say(capped.length === 0
  ? `  ✓ no capped rule wrote a single row — the counter is holding`
  : `  🔴 capped rules that STILL wrote: ${capped.map((c) => `${c.name} (cap ${c.cap}, ${c.n} rows)`).join(' · ')}`)

process.stdout.write('\n<<<CAP-TICK>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(capped.length === 0 ? 0 : 1)
