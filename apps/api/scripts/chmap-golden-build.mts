/**
 * CHMAP M5 — build the golden fixtures from the Owner's real files (study §8.6, decision D2 A).
 *
 * For each golden file: an ANONYMISED copy (scanned: no original private value may remain), the channel schemas it
 * needs (trimmed to what the reader uses, gzipped — Amazon's and eBay's schemas are public), and the pinned result of
 * the golden pipeline in `manifest.json`. The real files are only read. Run it again when a golden file, a schema or
 * the mapping rules change on purpose; the golden test then pins the new result.
 *   cd apps/api && npx tsx scripts/chmap-golden-build.mts --dir "/path/LISTNGS"
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const DIR = arg('dir'), PIN_ONLY = process.argv.includes('--pin-only')
if (!DIR && !PIN_ONLY) throw new Error('--dir is required (or --pin-only to re-pin the existing fixtures)')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error('refusing: a local database whose name contains "test" only')
const OUT = new URL('../src/services/channel-mapping/__fixtures__/golden/', import.meta.url).pathname
mkdirSync(join(OUT, 'specs'), { recursive: true })

const GOLDEN = [
  { id: 'amazon-it-coat-pants', kind: 'amazon', why: 'IT template 2026.0713, one market, parent + 20 variations', file: 'JACKETS/Gale/Amazon/LISTINGS/IT/GALE IT - FINAL (upload this)/GALE IT.xlsm' },
  { id: 'amazon-de-coat-pants', kind: 'amazon', why: 'DE template 2026.0715: German labels, DE-only columns', file: 'JACKETS/Gale/Amazon/LISTINGS/DE/GALE DE - FINAL (upload this)/GALE DE.xlsm' },
  { id: 'amazon-fr-coat-pants', kind: 'amazon', why: 'FR template: FR size labels', file: 'JACKETS/Gale/Amazon/LISTINGS/FR/GALE FR - FINAL (upload this)/GALE FR.xlsm' },
  { id: 'amazon-es-coat-pants', kind: 'amazon', why: 'ES template: a different price and feature order', file: 'JACKETS/Gale/Amazon/LISTINGS/ES/GALE ES - FINAL (upload this)/GALE ES.xlsm' },
  { id: 'amazon-de-suit', kind: 'amazon', why: 'COAT + PANTS rows in one file, the team_name workaround', file: 'JACKETS/AIREON/AMAZON/LISTINGS/DE/AIREON DE - FINAL (upload this)/AIREON DE.xlsm' },
  { id: 'amazon-de-market-parent', kind: 'amazon', why: 'the parent SKU differs by market', file: 'JACKETS/Moss/Amazon/LISTINGS/DE/MOSS DE - FINAL (upload this)/MOSS DE.xlsm' },
  { id: 'amazon-it-flat-file-2024', kind: 'amazon', why: 'the OLD flat-file grammar (read only)', file: 'JACKETS/Gale/Amazon/IT/Gale Jacket IT.xlsm' },
  { id: 'ebay-it-177104', kind: 'ebay', why: 'our eBay workbook: 5 listings sharing 20 SKUs, custom specifics', file: 'JACKETS/Gale/eBay/IT/GALE IT.xlsx' },
  { id: 'ebay-it-legacy', kind: 'ebay', why: 'the legacy 66-column eBay file (no Item IDs)', file: 'XAVIA-eBay-IT-REGAL.xlsx' },
] as const

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { anonymiseAmazonTemplate, anonymiseEbayWorkbook } = await import('./lib/chmap-anonymise-lib.mts')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
const { amazonProductTypes } = await import('../src/services/pim/catalog-amazon-workbook.js')
const { loadAmazonSpec, loadEbaySpec } = await import('../src/services/pim/channel-specs/index.js')
const { readEbayWorkbook } = await import('../src/services/pim/catalog-ebay-workbook.js')
const { amazonGolden, ebayGolden, loadSpec } = await import('../src/services/channel-mapping/__tests__/golden-pipeline.js')
const { default: prisma } = await import('../src/db.js')
const ExcelJS = (await import('exceljs')).default

/** Keep what the reader uses: every field, and of the schema only the selectors of each attribute. */
function trim(spec: any) {
  const properties: Record<string, unknown> = {}
  for (const [key, node] of Object.entries((spec.validationSchema?.properties ?? {}) as Record<string, any>)) {
    if (!node?.selectors) continue
    const items: Record<string, unknown> = {}
    for (const selector of node.selectors) { const s = node.items?.properties?.[selector]; if (s) items[selector] = { enum: s.enum, enumNames: s.enumNames, const: s.const } }
    properties[key] = { selectors: node.selectors, items: { properties: items } }
  }
  return { ...spec, validationSchema: { properties }, fetchedAt: null }
}

if (PIN_ONLY) {
  // Re-pin: the fixtures stay byte-for-byte; only the expected results are computed again from them.
  const { readFileSync: read } = await import('node:fs')
  const current = JSON.parse(read(join(OUT, 'manifest.json'), 'utf8'))
  for (const f of current.fixtures) {
    const specs = new Map(f.specs.map((s: string) => { const spec = loadSpec(read(join(OUT, 'specs', s))); return [spec.category, spec] }))
    const bytes = read(join(OUT, f.file))
    f.expected = f.kind === 'amazon' ? await amazonGolden(bytes, specs as never, f.market) : await ebayGolden(bytes, f.filename, specs as never)
    console.log(f.id, JSON.stringify(f.expected.roundTrip))
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(current, null, 1) + '\n')
  process.exit(0)
}
const fake = new Map<string, string>()
const manifest: Record<string, unknown>[] = []
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const markets = await prisma.marketplace.findMany({ select: { channel: true, code: true, language: true, languages: true, currency: true } })
  for (const g of GOLDEN) {
    const real = readFileSync(join(DIR, g.file))
    if (g.kind === 'amazon') {
      const anon = await anonymiseAmazonTemplate(real, fake)
      if (anon.leaks.length) throw new Error(`${g.id}: LEAK ${anon.leaks.slice(0, 3).join('; ')}`)
      const file = `${g.id}.xlsm`
      writeFileSync(join(OUT, file), anon.bytes)
      const parsed = (await detectAmazonTemplate(anon.bytes, { strict: true }))!
      const mk = parsed.meta.marketplace!
      const specs = new Map()
      const specFiles: string[] = []
      for (const type of new Set([...amazonProductTypes(parsed), ...(parsed.meta.templateProductTypes ?? [])])) {
        const name = `amazon-${mk}-${type}.json.gz`
        const spec = await loadAmazonSpec(mk, type)
        if (spec.absent) continue
        writeFileSync(join(OUT, 'specs', name), gzipSync(JSON.stringify(trim(spec))))
        specs.set(type, loadSpec(readFileSync(join(OUT, 'specs', name))))
        specFiles.push(name)
      }
      const m = markets.find(x => x.channel === 'AMAZON' && x.code === mk)!
      const market = { language: m.language, languages: m.languages ?? [], currency: m.currency ?? null }
      const expected = await amazonGolden(anon.bytes, specs, market)
      manifest.push({ id: g.id, kind: g.kind, why: g.why, file, marketplace: mk, market, specs: specFiles, expected })
    } else {
      const anon = await anonymiseEbayWorkbook(real, fake)
      if (anon.leaks.length) throw new Error(`${g.id}: LEAK ${anon.leaks.slice(0, 3).join('; ')}`)
      const file = `${g.id}.xlsx`
      writeFileSync(join(OUT, file), anon.bytes)
      const book = new ExcelJS.Workbook(); await book.xlsx.load(anon.bytes)
      const table = readEbayWorkbook(book, { filename: g.file.split('/').at(-1) })!
      const specs = new Map()
      const specFiles: string[] = []
      for (const category of new Set(table.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))) {
        const name = `ebay-${table.marketplace}-${category}.json.gz`
        const spec = await loadEbaySpec(table.marketplace, [category])
        writeFileSync(join(OUT, 'specs', name), gzipSync(JSON.stringify(trim(spec))))
        specs.set(category, loadSpec(readFileSync(join(OUT, 'specs', name))))
        specFiles.push(name)
      }
      const expected = await ebayGolden(anon.bytes, g.file.split('/').at(-1)!, specs)
      manifest.push({ id: g.id, kind: g.kind, why: g.why, file, filename: g.file.split('/').at(-1), marketplace: table.marketplace, specs: specFiles, expected })
    }
    const last = manifest.at(-1) as { expected: { roundTrip: unknown; read: unknown } }
    console.log(g.id, JSON.stringify(last.expected.read), JSON.stringify(last.expected.roundTrip))
  }
})
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ note: 'CHMAP golden fixtures — anonymised copies of the Owner’s files (scripts/chmap-golden-build.mts). Never the originals: the repository is public.', built: new Date().toISOString().slice(0, 10), fixtures: manifest }, null, 1) + '\n')
await prisma.$disconnect()
process.exit(0)
