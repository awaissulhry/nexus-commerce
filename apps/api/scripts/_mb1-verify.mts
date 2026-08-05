/** READ-ONLY: MB.1 — did the floor columns land, and what is live right now? */
const { default: prisma } = await import('../src/db.js')

// information_schema columns are `name`, which the Prisma raw deserializer refuses — cast to text.
const cols = await prisma.$queryRaw<Array<{ t: string; c: string; d: string }>>`
  SELECT table_name::text AS t, column_name::text AS c, data_type::text AS d FROM information_schema.columns
  WHERE (table_name = 'RankTarget' AND column_name = 'floorBidCents')
     OR (table_name = 'Campaign' AND column_name = 'bidsSuppressedFloorCents')
  ORDER BY t`
console.log('MB.1 columns:', cols.length ? cols.map((c) => `${c.t}.${c.c}:${c.d}`).join('  ') : 'MISSING')

const targets = await prisma.rankTarget.findMany({
  where: { OR: [{ pause: true }, { allOut: true }] },
  select: { key: true, name: true, pause: true, allOut: true, biasPct: true, floorBidCents: true, maxCpcCents: true, scopeCampaignId: true },
  orderBy: { sortOrder: 'asc' },
})
console.log('\nMin-bid / all-out targets in the library:')
for (const t of targets) console.log(`  ${t.key.padEnd(16)} pause=${t.pause} allOut=${t.allOut} bias=${t.biasPct ?? 'null'} floor=${t.floorBidCents ?? 'null (→2¢)'} maxCpc=${t.maxCpcCents ?? 'null'}`)

const supp = await prisma.campaign.findMany({
  where: { bidsSuppressedAt: { not: null } },
  select: { name: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true },
  take: 20,
})
console.log(`\ncampaigns currently bid-suppressed: ${supp.length}`)
for (const c of supp) console.log(`  ${c.name} · floor=${c.bidsSuppressedFloorCents ?? 'null (legacy 2¢)'} · since ${c.bidsSuppressedAt?.toISOString()}`)

// Which schedules actually use the Min-bid target, and where — the blast radius of MB.3.
const scheds = await prisma.adSchedule.findMany({
  where: { enabled: true },
  select: { id: true, campaignId: true, defaultTargetKey: true, windows: true, targetOverrides: true },
})
let baselineMin = 0, windowMin = 0, withOverride = 0
for (const s of scheds) {
  if (s.defaultTargetKey === 'pause') baselineMin++
  const w = Array.isArray(s.windows) ? (s.windows as Array<{ targetKey?: string }>) : []
  if (w.some((x) => x?.targetKey === 'pause')) windowMin++
  const ov = (s.targetOverrides ?? {}) as Record<string, unknown>
  if (ov.pause) withOverride++
}
console.log(`\nenabled schedules: ${scheds.length} · Min bid as baseline: ${baselineMin} · Min bid in a window: ${windowMin} · with a per-campaign Min-bid override: ${withOverride}`)
await prisma.$disconnect()
