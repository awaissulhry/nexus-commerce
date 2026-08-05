/**
 * ACR.2.4 — is AIREON's zero real, or is the parser failing? READ-ONLY, writes nothing.
 *
 * The widen fetched four AIREON reports successfully and every one produced
 * `[sqp] parser yielded 0 rows`. Two readings, opposite meanings:
 *
 *   · Amazon genuinely has no Search Query rows for these ASINs that week — AIREON took no
 *     measurable search presence, which is itself the answer to the coverage question.
 *   · The parser cannot read this payload shape — a repeat of the defect that zeroed 9,278
 *     rows and made the whole ACR.2.1 repair necessary.
 *
 * A GALE ASIN is fetched as a CONTROL on the SAME week through the SAME code path. If GALE
 * parses and AIREON does not, the parser is at fault. If both report the same structure and
 * only AIREON's is empty, the zero is real.
 */
import '../src/env.js'
await import('../src/db.js')
const { fetchSpApiJsonReport } = await import('../src/services/sp-api-reports.service.js')

const WEEK_START = new Date('2026-07-19T00:00:00.000Z')
const WEEK_END = new Date('2026-07-25T00:00:00.000Z')
const MARKETPLACE_ID = 'APJ6JRA9NG5V4' // IT

const CASES: Array<{ label: string; asin: string }> = [
  { label: 'AIREON (subject)', asin: 'B0F4NVZB6N' },   // AIREON-JACKET-NERO-NEO-MEN-XL
  { label: 'GALE   (control)', asin: 'B0BMSH19GY' },   // GALE-JACKET-BLACK-MEN-XL, 41,343 impressions
]

for (const c of CASES) {
  process.stdout.write(`\n═══ ${c.label} · ${c.asin} ═══\n`)
  try {
    const r = await fetchSpApiJsonReport<Record<string, unknown>>({
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceId: MARKETPLACE_ID,
      dataStartTime: WEEK_START,
      dataEndTime: WEEK_END,
      reportOptions: { reportPeriod: 'WEEK', asin: c.asin },
    })
    const p = r.payload
    console.log(`  top-level keys: ${Object.keys(p).join(', ')}`)
    const byAsin = p.dataByAsin
    console.log(`  dataByAsin: ${Array.isArray(byAsin) ? `ARRAY of ${byAsin.length}` : typeof byAsin}`)
    if (Array.isArray(byAsin) && byAsin.length > 0) {
      const first = byAsin[0] as Record<string, unknown>
      console.log(`  first row keys: ${Object.keys(first).join(', ')}`)
      const q = (first.searchQueryData ?? {}) as Record<string, unknown>
      const imp = (first.impressionData ?? {}) as Record<string, unknown>
      console.log(`  sample: query="${String(first.searchQuery ?? '?')}" volume=${String(q.searchQueryVolume ?? '?')} ` +
        `imprTotal=${String(imp.totalQueryImpressionCount ?? '?')} imprBrand=${String(imp.asinImpressionCount ?? '?')}`)
    }
    const spec = p.reportSpecification as Record<string, unknown> | undefined
    if (spec) console.log(`  reportSpecification.reportOptions: ${JSON.stringify(spec.reportOptions ?? {})}`)
  } catch (e) {
    console.log(`  FETCH FAILED: ${(e as Error).message}`)
  }
}

console.log('\nVERDICT GUIDE:')
console.log('  control non-empty + subject empty → the zero is REAL; AIREON had no search presence that week.')
console.log('  both empty                        → the week or the request shape is wrong, not the ASINs.')
console.log('  control empty                     → the parser/shape regressed; STOP and fix that first.\n')

const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
