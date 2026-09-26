/**
 * CHMAP M3 — the native round trip for our eBay workbook: a workbook IMPORTED into this database is exported again
 * from what Nexus holds, through the same mapping version, and compared cell by cell (rows keyed by Item ID + SKU).
 * Rows the import refused are counted, not compared. A planted change must be caught.
 *   cd apps/api && npx tsx scripts/chmap-roundtrip-ebay.mts --file "<path>" [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import ExcelJS from 'exceljs'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const FILE = arg('file'), JSON_OUT = arg('json')
if (!FILE) throw new Error('--file is required')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error(`refusing: a local database whose name contains "test" only (got ${url.hostname}${url.pathname})`)

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { readEbayWorkbook, resolveEbayCatalogWorkbook } = await import('../src/services/pim/catalog-ebay-workbook.js')
const { loadEbaySpec } = await import('../src/services/pim/channel-specs/index.js')
const { ebayChannelKeyOf } = await import('../src/services/channel-mapping/ebay-draft.js')
const { ebayFormOf } = await import('../src/services/channel-mapping/form.js')
const { findSetForForm } = await import('../src/services/channel-mapping/store.js')
const { exportEbayWorkbook } = await import('../src/services/channel-mapping/ebay-export-host.js')
const { compareEbayRows } = await import('../src/services/channel-mapping/ebay-export.js')
const { default: prisma } = await import('../src/db.js')

let exitCode = 0
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(readFileSync(FILE))
  const table = readEbayWorkbook(book, { filename: FILE.split('/').at(-1) })!
  const specs = new Map()
  for (const category of new Set(table.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))) specs.set(category, await loadEbaySpec(table.marketplace, [category]))
  const form = ebayFormOf({ marketplace: table.marketplace, sheet: table.sheet, categories: [...specs.keys()], channelKeys: table.headers.map(h => ebayChannelKeyOf(h, specs).channelKey) })
  const preview = await resolveEbayCatalogWorkbook(table)
  const set = await findSetForForm(form)
  if (!set) throw new Error('No mapping version for this workbook: import it first.')
  const refusedRows = new Set(preview.issues.map(i => i.row))
  const compared = table.records.filter(r => !refusedRows.has(r.row)).map(r => r.values)
  const wanted = [...new Set(compared.map(r => r.SKU?.trim()).filter(Boolean))]
  const skus = (await prisma.product.findMany({ where: { sku: { in: wanted }, deletedAt: null }, select: { sku: true } })).map(p => p.sku)
  if (!skus.length) { console.log(JSON.stringify({ file: FILE, rowsInFile: table.records.length, rowsRefusedOnImport: refusedRows.size, cellsCompared: 0, note: 'every row was refused on import; nothing to compare', refusals: [...new Set(preview.issues.map(i => i.message.slice(0, 120)))].slice(0, 3) })); return }
  const exported = await exportEbayWorkbook({ marketplace: table.marketplace, setId: set.id, skus })
  const result = compareEbayRows(table.headers, compared, exported.rows, exported.blankByDesign, exported.blankForRow)
  const listingOf = (r: Record<string, string>) => `${(r['Parent/Child'] ?? '').toLowerCase() === 'parent' ? r.SKU : r['Parent SKU']}|${r.SKU}`
  const target = exported.rows.find(r => r.Title && compared.some(o => listingOf(o) === listingOf(r) && o.Title))
  let control = 'no comparable row'
  if (target) {
    const planted = exported.rows.map(r => r === target ? { ...r, Title: `${r.Title} (planted)` } : r)
    const again = compareEbayRows(table.headers, compared, planted, exported.blankByDesign, exported.blankForRow)
    control = again.differ.length === result.differ.length + 1 ? 'caught' : 'NOT CAUGHT'
    if (control !== 'caught') exitCode = 1
  }
  const byHeader = (list: { header: string }[]) => Object.entries(list.reduce<Record<string, number>>((a, x) => { a[x.header] = (a[x.header] ?? 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1])
  const summary = {
    file: FILE, mapping: exported.set.label, rowsInFile: table.records.length, rowsRefusedOnImport: refusedRows.size, rowsExported: exported.rows.length,
    cellsCompared: result.compared, equal: result.equal, sameAsParentRow: result.inherited, differ: result.differ.length, missing: result.missing.length, extra: result.extra.length,
    blankByDesign: [...result.blankByDesign].map(([h, n]) => `${h} (${n}): ${exported.blankByDesign.get(h)}`),
    differByColumn: byHeader(result.differ).slice(0, 12), missingByColumn: byHeader(result.missing).slice(0, 12), extraByColumn: byHeader(result.extra).slice(0, 12),
    differSamples: result.differ.slice(0, 8), missingSamples: result.missing.slice(0, 6), extraSamples: result.extra.slice(0, 6), control,
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, result: { ...result, blankByDesign: [...result.blankByDesign] } }, null, 1))
  console.log(JSON.stringify(summary, null, 1))
})
await prisma.$disconnect()
process.exit(exitCode)
