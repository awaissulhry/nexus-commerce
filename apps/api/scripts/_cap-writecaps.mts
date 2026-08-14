/**
 * CAP step 6 — set `maxWritesPerDay`, the cap in the unit damage is measured in.
 *
 * Sizes from `docs/2026-08-14-cap-sizing.md` §6.1. Requires --apply to write; without it, prints
 * the plan. Snapshots every affected row first, reads every change back.
 *
 * 🔴 What this does NOT do: clear `maxValueCentsEur = 0` on `Reduce bids on ACOS spike`. That
 * un-blocks a dormant AUTO rule into a live writer, which is a different act from bounding one.
 * The bound now exists, so it is a clean decision to make — but it is the operator's, not a side
 * effect of setting caps.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')
const L: string[] = []
const say = (s = '') => L.push(s)

/** §6.1 — writes/day. Only rules that can reach Amazon get one; a notify-only rule gets null. */
const WRITE_CAPS: Record<string, number> = {
  'Campaign ACOS rebalance (cut + scale)': 6,   // 3 campaigns ever touched; 2 moves/day each
  'Trim budget on weak ACOS': 8,                // 4 campaigns; €100→€1 would have stopped at ≈€39
  'Retail guard': 20,                           // protective: exempt from the ROW cap, bounded here
  'Reduce bids on ACOS spike': 30,              // bounded now; still blocked by maxValueCentsEur=0
  'Target ACOS setter (from profit)': 50,       // applied:0 for 60d — binds nothing, bounds it later
  'Profit-native bid optimisation': 50,
  'Weekend budget boost': 50,
  'ACoS convergence (proportional correction)': 50,
}

const targets = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true, name: { in: Object.keys(WRITE_CAPS) } },
  select: {
    id: true, name: true, autonomyLevel: true, dryRun: true, enabled: true,
    maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
  },
})
const found = new Set(targets.map((t) => t.name))
const missing = Object.keys(WRITE_CAPS).filter((n) => !found.has(n))
if (missing.length) { console.error(`🔴 REFUSING: no enabled rule named — ${missing.join(' · ')}`); process.exit(1) }
const dupe = targets.filter((t, i) => targets.findIndex((x) => x.name === t.name) !== i)
if (dupe.length) { console.error(`🔴 REFUSING: duplicate names — ${dupe.map((d) => d.name).join(' · ')}`); process.exit(1) }

say('── SNAPSHOT ──')
for (const t of targets) say(`  ${JSON.stringify(t)}`)

say('\n── PLAN ──')
say('  rule                                        level    ROW cap   WRITE cap now → after   writes today')
const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
for (const t of targets) {
  const today = await prisma.advertisingActionLog.count({ where: { userId: `automation:${t.id}`, createdAt: { gte: dayStart } } })
  say(`  ${t.name.slice(0, 42).padEnd(43)} ${String(t.autonomyLevel).padEnd(8)} ${String(t.maxExecutionsPerDay ?? 'null').padStart(7)}   ${String(t.maxWritesPerDay ?? 'null').padStart(4)} → ${String(WRITE_CAPS[t.name]).padEnd(4)}  ${String(today).padStart(11)}`)
}

if (!APPLY) {
  say('\n  DRY RUN — nothing written. Re-run with --apply.')
  process.stdout.write('\n<<<CAP-WRITECAPS>>>\n' + L.join('\n') + '\n')
  await prisma.$disconnect(); process.exit(0)
}

say('\n── APPLYING ──')
for (const t of targets) {
  await prisma.automationRule.update({ where: { id: t.id }, data: { maxWritesPerDay: WRITE_CAPS[t.name] } })
  say(`  ✓ ${t.name.padEnd(43)} maxWritesPerDay → ${WRITE_CAPS[t.name]}`)
}

say('\n── READ BACK ──')
let bad = 0
// 🔴 Read back BY ID, not by name. Two rules are named `Trim budget on weak ACOS` — one AUTO and
// enabled, one PROPOSE and disabled (see the sizing doc §7.4). A name-keyed read-back matches the
// disabled twin, finds maxWritesPerDay=null on it, and reports a failure that did not happen. The
// first run of this script did exactly that. A probe that invents failures is worse than none.
const after = await prisma.automationRule.findMany({
  where: { id: { in: targets.map((t) => t.id) } },
  select: { id: true, name: true, maxWritesPerDay: true, maxExecutionsPerDay: true, enabled: true },
})
const wantById = new Map(targets.map((t) => [t.id, WRITE_CAPS[t.name]]))
for (const a of after) {
  const ok = a.maxWritesPerDay === wantById.get(a.id)
  if (!ok) bad++
  say(`  ${ok ? '✓' : '🔴'} ${a.name.padEnd(43)} writes=${a.maxWritesPerDay ?? 'null'}  rows=${a.maxExecutionsPerDay ?? 'null'}  enabled=${a.enabled}`)
}
if (after.length !== targets.length) { bad++; say(`  🔴 read back ${after.length} rows, updated ${targets.length}`) }

// Nothing else may have picked up a write cap by accident — again by id, for the same reason.
const strays = await prisma.automationRule.findMany({
  where: { maxWritesPerDay: { not: null }, id: { notIn: targets.map((t) => t.id) } },
  select: { name: true, maxWritesPerDay: true },
})
say(strays.length === 0
  ? `  ✓ no other rule carries a write cap`
  : `  🔴 unexpected write caps: ${strays.map((s) => `${s.name}=${s.maxWritesPerDay}`).join(' · ')}`)
if (strays.length) bad++

say(`\n  🔴 Reduce bids on ACOS spike still carries maxValueCentsEur = ${targets.find((t) => t.name === 'Reduce bids on ACOS spike')?.maxValueCentsEur} —`)
say(`     it remains 100% inert. Clearing that is a separate decision, now that a write bound exists.`)

process.stdout.write('\n<<<CAP-WRITECAPS>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(bad === 0 ? 0 : 1)
