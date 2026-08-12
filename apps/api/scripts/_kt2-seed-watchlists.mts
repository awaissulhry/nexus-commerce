/**
 * _kt2-seed-watchlists.mts — create the four per-market watchlists. **THIS WRITES.**
 *
 * The only writing script in the KT series, run once per environment, idempotent: it creates a list
 * only if that market has none, and adds only terms the list does not already hold. Re-running it
 * changes nothing.
 *
 * The seed was chosen from `_kt2-seed-candidates.mts` and confirmed by the operator 2026-08-12:
 *
 *   IT  the 97 existing curated coverage terms, COPIED (a hand-made list beats a derived one)
 *   DE  21 · ES 7 · FR 8 — "terms we bid on that Brand Analytics can actually measure"
 *                          (positive KEYWORD AdTargets ∩ SQP queries seen in the last 90 days)
 *   all + the 10 AdKeywordProtection whitelist terms, flagged branded and hidden by default
 *
 * Why that intersection and not something bigger: every row it produces can carry volume, rank and
 * share, so the grid is answerable rather than decorative. What it does NOT cover is on the record —
 * paid-but-SQP-blind queries: IT 610, DE 340, ES 62, FR 76 — and the alternative (every SQP query in
 * the market: IT 3,013 · DE 2,254 · ES 1,950 · FR 624) is a discovery list, which §7.1 of the study
 * gives to Share of Voice, not to the tracker.
 *
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt2-seed-watchlists.mts
 *      add --dry to print the plan and write nothing.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { addTerms, classifyBranded, createWatchlist, importFromCoverageSet, listWatchlists, normTerm } from '../src/services/advertising/keyword-watchlist.service.js'

const DRY = process.argv.includes('--dry')
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 68 - s.length))}`) }
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

/** positive KEYWORD targets ∩ SQP queries with a row in the last 90 days, per market */
async function bidIntersectSqp(market: string): Promise<string[]> {
  const targets = await prisma.adTarget.findMany({
    where: {
      isNegative: false,
      expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] },
      adGroup: { campaign: { marketplace: market } },
    },
    select: { expressionValue: true },
  })
  const bid = new Set(targets.map((t) => normTerm(t.expressionValue)).filter(Boolean))
  if (!bid.size) return []
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 90); since.setUTCHours(0, 0, 0, 0)
  const sqp = await prisma.searchQueryPerformance.groupBy({
    by: ['searchQuery'],
    where: { marketplace: market, startDate: { gte: since }, searchQuery: { in: [...bid] } },
    _max: { searchQueryVolume: true },
  })
  // biggest market first, so a truncated list is the useful half
  return sqp
    .sort((a, b) => (b._max.searchQueryVolume ?? 0) - (a._max.searchQueryVolume ?? 0))
    .map((r) => normTerm(r.searchQuery))
}

async function main() {
  line(DRY ? '── DRY RUN: nothing will be written ──' : '── WRITING ──')

  const protections = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' },
    select: { term: true, matchType: true, isPrefix: true, marketplace: true },
  })
  const coverageSets = await prisma.keywordCoverageSet.findMany({
    select: { id: true, name: true, marketplace: true, _count: { select: { terms: true } } },
  })
  line(`protections: ${protections.length} · coverage sets available to import: ${coverageSets.map((s) => `${s.name}(${s.marketplace}, ${s._count.terms})`).join(', ')}`)

  const existing = await listWatchlists()
  if (existing.length) {
    h('already present — these markets are left untouched')
    for (const w of existing) line(`   ${w.marketplace} "${w.name}" terms=${w.terms} branded=${w.brandedTerms} default=${w.isDefault} source=${w.source}`)
  }

  for (const market of MARKETS) {
    h(market)
    if (existing.some((w) => w.marketplace === market)) { line('   has a watchlist already — skipped'); continue }

    const set = coverageSets.find((s) => s.marketplace === market)
    const derived = set ? [] : await bidIntersectSqp(market)
    const protTerms = protections.filter((p) => !p.marketplace || p.marketplace === market).map((p) => normTerm(p.term))

    const name = set ? `${market} — curated coverage` : `${market} — bid keywords we can measure`
    const source = set ? 'coverage-set-import' : 'bid-keywords'
    line(`   plan: "${name}" (source=${source})`)
    if (set) line(`         import ${set._count.terms} terms from coverage set "${set.name}" (copied, never referenced)`)
    else line(`         ${derived.length} terms from bid ∩ SQP-90d${derived.length ? `, e.g. ${derived.slice(0, 5).join(' · ')}` : ''}`)
    line(`         + ${protTerms.length} protected brand terms, flagged branded`)
    if (!set && !derived.length) line('   ⚠ nothing to seed for this market — it would get an empty list')

    if (DRY) continue

    const w = await createWatchlist({ marketplace: market, name, source, isDefault: true, createdBy: 'kt2-seed' })
    if (set) {
      const r = await importFromCoverageSet({ watchlistId: w.id, coverageSetId: set.id })
      line(`   imported ${r.added} (${r.duplicates} dup, ${r.invalid} invalid) from "${r.setName}"`)
    } else if (derived.length) {
      const r = await addTerms({ watchlistId: w.id, terms: derived, addedFrom: 'bid-keywords∩sqp90d' })
      line(`   added ${r.added} (${r.duplicates} dup, ${r.invalid} invalid)`)
    }
    const p = await addTerms({ watchlistId: w.id, terms: protTerms, addedFrom: 'ad-keyword-protection' })
    line(`   added ${p.added} protected terms, of which classified branded: ${p.branded}`)
    // the classifier is the authority; assert it agreed rather than trusting the label
    const disagreed = protTerms.filter((t) => !classifyBranded(t, market, protections))
    if (disagreed.length) line(`   🔴 classifier did NOT flag: ${disagreed.join(', ')} — investigate before trusting branded=0`)
  }

  h('result')
  for (const w of await listWatchlists()) {
    line(`   ${w.marketplace}  "${w.name}"  terms=${w.terms}  branded=${w.brandedTerms}  default=${w.isDefault}  source=${w.source}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
