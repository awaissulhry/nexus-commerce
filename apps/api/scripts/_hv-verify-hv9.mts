/**
 * HV — independent verification of HV.9a/HV.9b, with the integrity incident first. READ-ONLY.
 *
 * The session reports "54 pushes made 6 keywords" and that it corrupted 54 rows of our record.
 * The only question that matters: is the record correct NOW, and is any AdTarget claiming an
 * Amazon object that belongs to a different row?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const now = Date.now()

console.log('\n═══ HV.9 verification ═══\n')

// ── 1 · 🔴 INTEGRITY: does any externalTargetId appear on more than one row? ──
console.log('── 1 · externalTargetId collisions (the corruption test) ──')
const collide = await prisma.$queryRawUnsafe<Array<{ ext: string; n: bigint; kinds: string; neg: string }>>(`
  select "externalTargetId" ext, count(*)::bigint n,
         string_agg(distinct kind, ',') kinds, string_agg(distinct "isNegative"::text, ',') neg
  from "AdTarget" where "externalTargetId" is not null
  group by 1 having count(*) > 1 order by 2 desc`)
console.log(`  externalTargetIds carried by >1 AdTarget row: ${collide.length}`)
if (collide.length) {
  const extra = collide.reduce((s, r) => s + Number(r.n) - 1, 0)
  console.log(`  🔴 redundant rows implicated: ${extra}`)
  for (const r of collide.slice(0, 12)) console.log(`     ${pad(r.ext, 20)} ×${r.n}  kind=${r.kinds} isNegative=${r.neg}`)
} else {
  console.log(`  ✅ none — every Amazon id belongs to exactly one row`)
}

// ── 2 · the engine's 218, re-counted ─────────────────────────────────────────
const engLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' }, select: { entityId: true },
})
const engIds = [...new Set(engLogs.map((l) => l.entityId))]
const eng = await prisma.adTarget.findMany({
  where: { id: { in: engIds } },
  select: { id: true, expressionValue: true, expressionType: true, externalTargetId: true, lastSyncStatus: true, lastSyncError: true,
    adGroup: { select: { name: true, campaign: { select: { name: true, targetingType: true, marketplace: true } } } } },
})
const atAmazon = eng.filter((t) => t.externalTargetId)
const localOnly = eng.filter((t) => !t.externalTargetId)
console.log(`\n── 2 · the engine's harvested keywords ──`)
console.log(`  total ${eng.length} = ${atAmazon.length} at Amazon + ${localOnly.length} local-only   [session said 218 = 12 + 206]`)

const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
const asin = localOnly.filter((t) => isAsin(t.expressionValue))
const autoCamp = localOnly.filter((t) => !isAsin(t.expressionValue) && t.adGroup?.campaign?.targetingType === 'AUTO')
const pushable = localOnly.filter((t) => !isAsin(t.expressionValue) && t.adGroup?.campaign?.targetingType !== 'AUTO')
console.log(`  local-only breakdown: ASIN-shaped ${asin.length} · under an AUTO campaign ${autoCamp.length} · pushable ${pushable.length}`)
console.log(`  [session said pushable 153, never-push 56 = 54 ASIN + 2 AUTO]`)

// duplicate-group membership among the local-only rows — the list that was pushed
const groups = new Map<string, number>()
for (const t of localOnly) {
  const k = `${t.adGroup?.campaign?.name ?? '?'}|${t.adGroup?.name ?? '?'}|${t.expressionType.toUpperCase()}|${t.expressionValue.trim().toLowerCase()}`
  groups.set(k, (groups.get(k) ?? 0) + 1)
}
const dupGroups = [...groups.entries()].filter(([, n]) => n > 1)
console.log(`  local-only rows sitting in a duplicate group: ${dupGroups.reduce((s, [, n]) => s + n, 0)} across ${dupGroups.length} groups`)
console.log(`  ⇒ a push list built from these WILL contain duplicates unless collapsed first`)

// ── 3 · the three proof writes ───────────────────────────────────────────────
console.log('\n── 3 · the proof writes ──')
for (const ext of ['170991074573585', '53955160123085', '48498817150724']) {
  const t = await prisma.adTarget.findFirst({
    where: { externalTargetId: ext },
    select: { expressionValue: true, expressionType: true, isNegative: true, negativeLevel: true, bidCents: true, status: true, createdAt: true,
      adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true } } } } },
  })
  if (!t) { console.log(`  🔴 ${ext} — NOT FOUND in AdTarget`); continue }
  console.log(`  ${pad(ext, 18)} ${pad(t.expressionValue, 30)} ${pad(t.expressionType, 16)} ${t.isNegative ? `NEG/${t.negativeLevel}` : `pos ${eur(t.bidCents)}`} → ${t.adGroup?.campaign?.name} › ${t.adGroup?.name}`)
}

// ── 4 · what landed today ────────────────────────────────────────────────────
const since = new Date('2026-08-13T00:00:00Z')
const newT = await prisma.adTarget.count({ where: { createdAt: { gte: since } } })
const newLogs = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { createdAt: { gte: since } }, _count: { _all: true },
})
console.log(`\n── 4 · today ──`)
console.log(`  new AdTarget rows: ${newT}`)
console.log(`  audit rows by action: ${newLogs.map((r) => `${r.actionType}=${r._count._all}`).join(' · ') || 'none'}`)
const pushedToday = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, externalTargetId: { not: null }, updatedAt: { gte: since } } })
console.log(`  positive keywords with an Amazon id touched today: ${pushedToday}`)

// ── 5 · negatives, and the assertion that matters ───────────────────────────
console.log('\n── 5 · negatives by scope ──')
for (const lvl of ['AD_GROUP', 'CAMPAIGN']) {
  const total = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: true, negativeLevel: lvl } })
  const live = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: true, negativeLevel: lvl, externalTargetId: { not: null } } })
  const today = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: true, negativeLevel: lvl, createdAt: { gte: since } } })
  console.log(`  ${pad(lvl, 10)} ${pad(int(total), 7)} rows · ${pad(int(live), 7)} at Amazon · ${today} created today`)
}

// ── 6 · HV.0 still holding ───────────────────────────────────────────────────
console.log('\n── 6 · the engine ──')
for (const r of await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 2, select: { startedAt: true, outputSummary: true } }))
  console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${r.outputSummary}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
