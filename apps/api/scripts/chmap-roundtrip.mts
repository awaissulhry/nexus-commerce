/**
 * CHMAP M3 — the native round trip (study §8.6, check 2): an Amazon file that was IMPORTED into this database is
 * EXPORTED again from what Nexus holds, into the same template, through the same mapping version, and the two files
 * are compared cell by cell. A planted change must be caught (the positive control).
 *
 * Local disposable databases only (name contains "test"). The Owner's file is only read. Nothing is sent anywhere.
 *   cd apps/api && npx tsx scripts/chmap-roundtrip.mts --file "<path to an imported Amazon file>" [--prices off] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const FILE = arg('file'), JSON_OUT = arg('json')
if (!FILE) throw new Error('--file is required')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error(`refusing: a local database whose name contains "test" only (got ${url.hostname}${url.pathname})`)

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
const { captureTemplateToVault } = await import('../src/services/amazon/template-vault.service.js')
const { amazonFormOf } = await import('../src/services/channel-mapping/form.js')
const { findSetForForm } = await import('../src/services/channel-mapping/store.js')
const { exportAmazonTemplate } = await import('../src/services/channel-mapping/amazon-export-host.js')
const { compareTemplateRows } = await import('../src/services/channel-mapping/amazon-export.js')
const { resolveAmazonCatalogWorkbook } = await import('../src/services/pim/catalog-amazon-workbook.js')
const { default: prisma } = await import('../src/db.js')

const bytes = readFileSync(FILE)
let exitCode = 0
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const original = (await detectAmazonTemplate(bytes, { strict: true }))!
  const marketplace = original.meta.marketplace!
  const form = amazonFormOf(original, marketplace)
  // The import preview finds (or makes) the file's mapping version, as a real import does.
  const preview = await resolveAmazonCatalogWorkbook(original, { marketplace, mode: 'update' })
  const set = await findSetForForm(form)
  if (!set) throw new Error('No mapping version for this file: import it first (the import makes the version).')
  // The template bytes Nexus writes into: capture this file's template when the vault does not hold it yet.
  if (!(await prisma.amazonTemplateVault.findFirst({ where: { templateIdentifier: original.meta.templateIdentifier ?? '' } }))) await captureTemplateToVault(prisma as never, bytes, original.meta, basename(FILE))
  const skuHeader = original.headers.find(h => h.startsWith('contribution_sku'))!
  const fileSkus = [...new Set(original.rows.map(r => (r[skuHeader] ?? '').trim()).filter(Boolean))]
  // Seller SKUs → Nexus product SKUs (a market may name the product differently).
  const products = await prisma.product.findMany({ where: { sku: { in: fileSkus }, deletedAt: null }, select: { sku: true } })
  const known = new Set(products.map(p => p.sku))
  const viaListing = fileSkus.filter(s => !known.has(s)).length
    ? await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace, OR: fileSkus.filter(s => !known.has(s)).map(s => ({ platformAttributes: { path: ['sellerSku'], equals: s } })) }, select: { product: { select: { sku: true } } } })
    : []
  const skus = [...known, ...viaListing.map(l => l.product.sku)]
  // Compare like with like: the export writes the action the file used (blank = the template's own default).
  const actionHeader = original.headers.find(h => h === '::record_action')
  const actionCells = actionHeader ? original.rows.map(r => (r[actionHeader] ?? '').trim()) : []
  const actions = original.meta.actions
  const recordAction = actionCells.every(v => !v) ? 'blank' as const : actions.partial > actions.replace ? 'partial_update' as const : 'full_update' as const
  // Rows the import REFUSED never reached Nexus: they are counted, not compared.
  const refused = new Map<string, string>()
  for (const issue of preview.issues) {
    const fileSku = (issue as { fileSku?: string }).fileSku ?? issue.sku
    if (fileSku && !refused.has(fileSku)) refused.set(fileSku, issue.message.slice(0, 160))
  }
  const exported = await exportAmazonTemplate({ marketplace, setId: set.id, skus, includePrices: arg('prices') !== 'off', recordAction })
  const back = (await detectAmazonTemplate(exported.bytes, { strict: true }))!
  const blank = new Map(exported.blankByDesign.map(b => [b.header, b.reason]))
  const comparedRows = original.rows.filter(r => !refused.has((r[skuHeader] ?? '').trim()))
  const result = compareTemplateRows(original, comparedRows, back.rows, skuHeader, blank, exported.blankForRow)
  // Positive control: one planted change in an exported row that the original also has must appear as one more difference.
  const originalSkus = new Set(comparedRows.map(r => (r[skuHeader] ?? '').trim()))
  const target = back.rows.find(r => originalSkus.has((r[skuHeader] ?? '').trim()) && Object.keys(r).some(h => h.startsWith('item_name') && r[h] && comparedRows.find(o => o[skuHeader] === r[skuHeader])?.[h]))
  let caught = false
  if (target) {
    const nameHeader = Object.keys(target).find(h => h.startsWith('item_name') && target[h])!
    const planted = back.rows.map(r => r === target ? { ...r, [nameHeader]: `${r[nameHeader]} (planted)` } : r)
    const control = compareTemplateRows(original, comparedRows, planted, skuHeader, blank, exported.blankForRow)
    caught = control.differ.length + control.missing.length + control.extra.length === result.differ.length + result.missing.length + result.extra.length + 1 && control.equal === result.equal - 1
  }
  const byHeader = (list: { header: string }[]) => Object.entries(list.reduce<Record<string, number>>((a, x) => { a[x.header] = (a[x.header] ?? 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1])
  const summary = {
    file: FILE, mapping: exported.set.label, rowsInFile: original.rows.length, rowsExported: exported.rows, recordAction,
    rowsRefusedOnImport: refused.size, refusedReasons: [...new Set(refused.values())].slice(0, 5),
    cellsCompared: result.compared, equal: result.equal, differ: result.differ.length, missing: result.missing.length, extra: result.extra.length,
    blankByDesign: result.blankByDesign.map(b => `${b.header} (${b.cells}): ${b.reason}`),
    differByColumn: byHeader(result.differ).slice(0, 15), missingByColumn: byHeader(result.missing).slice(0, 15), extraByColumn: byHeader(result.extra).slice(0, 15),
    differSamples: result.differ.slice(0, 12), missingSamples: result.missing.slice(0, 8), extraSamples: result.extra.slice(0, 8),
    control: target ? (caught ? 'caught' : 'NOT CAUGHT') : 'no comparable row',
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, result }, null, 1))
  console.log(JSON.stringify(summary, null, 1))
  if (target && !caught) exitCode = 1
})
await prisma.$disconnect()
process.exit(exitCode)
