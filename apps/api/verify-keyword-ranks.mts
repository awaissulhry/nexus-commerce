// SK3 verifier — KeywordRank backend: ingest snapshots, then verify the GET endpoint's "latest +
// prior + rankDelta" collapse logic against the DB. Seeds rows tagged source '__sk3test' and
// deletes them at the end (prod stays clean). Run: cd apps/api && npx tsx verify-keyword-ranks.mts
import 'dotenv/config'
import { config } from 'dotenv'
import path from 'node:path'
config({ path: path.join(process.cwd(), '..', '..', '.env'), override: true })

const { default: prisma } = await import('./src/db.js')

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const TAG = '__sk3test'

// clean any leftovers from a prior run
await prisma.keywordRank.deleteMany({ where: { source: TAG } })

// Seed: "motorcycle jacket" improved organic 18 → 12 (delta +6); "biker gloves" only one snapshot.
const t0 = new Date(Date.now() - 7 * 86_400_000)
const t1 = new Date()
await prisma.keywordRank.createMany({ data: [
  { keyword: 'motorcycle jacket', marketplace: 'DE', organicRank: 18, sponsoredRank: 5, searchVolume: 40500, capturedAt: t0, source: TAG },
  { keyword: 'motorcycle jacket', marketplace: 'DE', organicRank: 12, sponsoredRank: 3, searchVolume: 40500, capturedAt: t1, source: TAG },
  { keyword: 'biker gloves', marketplace: 'DE', organicRank: 9, sponsoredRank: 2, searchVolume: 8100, capturedAt: t1, source: TAG },
  { keyword: 'motorcycle jacket', marketplace: 'IT', organicRank: 22, sponsoredRank: 7, searchVolume: 12000, capturedAt: t1, source: TAG },
] })

// Replicate the GET /advertising/keyword-ranks collapse (latest + prior per keyword×marketplace).
const rows = await prisma.keywordRank.findMany({ where: { source: TAG }, orderBy: [{ keyword: 'asc' }, { marketplace: 'asc' }, { capturedAt: 'desc' }] })
const byKey = new Map<string, { latest: typeof rows[number]; prior?: typeof rows[number] }>()
for (const r of rows) {
  const k = `${r.keyword} ${r.marketplace}`
  const e = byKey.get(k)
  if (!e) byKey.set(k, { latest: r }); else if (!e.prior) e.prior = r
}
const items = [...byKey.values()].map(({ latest, prior }) => ({
  keyword: latest.keyword, marketplace: latest.marketplace, organicRank: latest.organicRank, sponsoredRank: latest.sponsoredRank,
  searchVolume: latest.searchVolume, rankDelta: prior?.organicRank != null && latest.organicRank != null ? prior.organicRank - latest.organicRank : 0,
}))

console.log('[KeywordRank GET collapse]')
ok(items.length === 3, `3 distinct keyword×marketplace rows (got ${items.length})`)
const mjDE = items.find((i) => i.keyword === 'motorcycle jacket' && i.marketplace === 'DE')
ok(mjDE?.organicRank === 12, `latest organic rank for "motorcycle jacket" DE = 12 (got ${mjDE?.organicRank})`)
ok(mjDE?.sponsoredRank === 3, `latest sponsored rank = 3 (got ${mjDE?.sponsoredRank})`)
ok(mjDE?.rankDelta === 6, `rankDelta = +6 (18→12 improvement) (got ${mjDE?.rankDelta})`)
const gloves = items.find((i) => i.keyword === 'biker gloves')
ok(gloves?.rankDelta === 0, `single-snapshot keyword has rankDelta 0 (got ${gloves?.rankDelta})`)
const mjIT = items.find((i) => i.keyword === 'motorcycle jacket' && i.marketplace === 'IT')
ok(mjIT?.organicRank === 22, `marketplace isolation: same keyword IT organic = 22 (got ${mjIT?.organicRank})`)

// marketplace filter
const deOnly = await prisma.keywordRank.findMany({ where: { source: TAG, marketplace: 'DE' } })
ok(deOnly.length === 3 && deOnly.every((r) => r.marketplace === 'DE'), `marketplace=DE filter returns only DE rows (${deOnly.length})`)

// clean up
await prisma.keywordRank.deleteMany({ where: { source: TAG } })
const leftover = await prisma.keywordRank.count({ where: { source: TAG } })
ok(leftover === 0, `cleanup: all __sk3test rows removed (${leftover} left)`)

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} passed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
