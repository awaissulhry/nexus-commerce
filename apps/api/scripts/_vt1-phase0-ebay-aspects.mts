/**
 * VT.1 Phase 0 (a) — the LIVE eBay aspects for GALE's eBay category on IT and DE, read-only.
 *   cd apps/api && npx tsx scripts/_vt1-phase0-ebay-aspects.mts [categoryId]
 * `throwOnError: true` so an auth/network failure is a LOUD failure, never a clean empty
 * (reference_could_not_measure_vs_measured_empty). POSITIVE CONTROL: the IT list must contain `Colore`.
 */
import '../src/env.js'
console.log('DB (recordApiCall audit rows land here):', (process.env.DATABASE_URL ?? '').replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@'))
const categoryId = process.argv[2] ?? '177104'
const { EbayCategoryService } = await import('../src/services/ebay-category.service.js')
const ebayCategoryService = new EbayCategoryService()
for (const mk of ['IT', 'DE']) {
  const t0 = Date.now()
  let aspects: any[] = []
  try {
    aspects = await ebayCategoryService.getCategoryAspectsRich(categoryId, mk, { forceRefresh: true, throwOnError: true })
  } catch (err) {
    console.log(`\n${mk} — FAILED (not an empty reading): ${err instanceof Error ? err.message : String(err)}`)
    continue
  }
  const ms = Date.now() - t0
  const eligible = aspects.filter((a) => a.variantEligible)
  console.log(`\n=== eBay category ${categoryId} · ${mk} · ${aspects.length} aspects in ${ms} ms · variantEligible ${eligible.length}`)
  console.log('  POSITIVE CONTROL — the list contains "Colore":', aspects.some((a) => a.name === 'Colore'))
  console.log('  variantEligible names:', JSON.stringify(eligible.map((a) => a.name)))
  console.log('  variantEligible detail:', JSON.stringify(eligible.map((a) => ({ name: a.name, englishName: a.englishName ?? null, required: a.required, usage: a.usage, mode: a.mode, cardinality: a.cardinality, values: a.values.length }))))
  for (const want of ['color', 'size']) {
    const hits = aspects.filter((a) => [a.name, a.englishName].some((n: string | undefined) => n && n.toLowerCase().replace(/[\s_-]/g, '') === want)
      || (want === 'color' && ['Colore', 'Farbe'].includes(a.name)) || (want === 'size' && ['Taglia', 'Größe', 'Grösse'].includes(a.name)))
    console.log(`  ${want} → ${JSON.stringify(hits.map((a) => ({ name: a.name, englishName: a.englishName ?? null, variantEligible: a.variantEligible, required: a.required })))}`)
  }
  console.log('  all aspect names:', JSON.stringify(aspects.map((a) => a.name)))
}
// DE has its OWN tree (77) — 177104 is an IT leaf. Find the DE equivalent by search and read ITS aspects,
// so the "names in the market's language" claim is measured on a real DE leaf rather than asserted.
console.log('\n=== DE — the IT leaf does not exist in tree 77; searching the DE tree for the equivalent leaf')
for (const term of ['Motorradjacke', 'Motorrad Jacke Herren']) {
  try {
    const hits = await ebayCategoryService.searchCategories('DE', term, { limit: 5, throwOnError: true } as any)
    console.log(`  searchCategories(${JSON.stringify(term)}, DE) →`, JSON.stringify(hits))
  } catch (err) { console.log(`  searchCategories(${JSON.stringify(term)}, DE) FAILED: ${err instanceof Error ? err.message : String(err)}`) }
}
const deCat = process.argv[3]
if (deCat) {
  try {
    const a = await ebayCategoryService.getCategoryAspectsRich(deCat, 'DE', { forceRefresh: true, throwOnError: true })
    const el = a.filter((x: any) => x.variantEligible)
    console.log(`\n=== eBay category ${deCat} · DE · ${a.length} aspects · variantEligible ${el.length}`)
    console.log('  POSITIVE CONTROL — the list contains "Farbe":', a.some((x: any) => x.name === 'Farbe'))
    console.log('  variantEligible:', JSON.stringify(el.map((x: any) => ({ name: x.name, englishName: x.englishName ?? null, required: x.required, usage: x.usage, values: x.values.length }))))
    console.log('  all aspect names:', JSON.stringify(a.map((x: any) => x.name)))
  } catch (err) { console.log(`  DE ${deCat} FAILED: ${err instanceof Error ? err.message : String(err)}`) }
}
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
process.exit(0)
