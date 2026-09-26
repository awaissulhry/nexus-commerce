/**
 * NCF N8 — the REAL-file round trip of Shopify's product CSV on a LOCAL database whose name contains "test":
 *   file → import preview (what would be written, excluded, refused) → [--apply: apply it, confirming the file's link
 *   proposals with --confirm-links] → [export through the store's ACTIVE version → the same cells].
 *
 * 🔴 The Owner's file is private (the repository is public): this script prints NUMBERS ONLY. Every reason is printed as
 * a template, with the file's handles, SKUs and values replaced; nothing of the file is written anywhere.
 *
 *   cd apps/api && DATABASE_URL=postgresql://…/nexus_ncf_shopify_test npx tsx scripts/ncf-shopify-roundtrip.mts --file "<products_export.csv>" [--apply --confirm-links] [--seed-listings]
 *
 * `--seed-listings` (a PRIVATE copy only: its name must contain "ncf" and "test") first gives every Nexus product the file's
 * SKUs belong to — and its parent — a Shopify listing in the store, as Nexus would after publishing it, so the real file
 * has something to link to. The run says so. With `--apply` the file is then applied, its version activated and the
 * file written back through it, and the two are compared.
 */
import { readFileSync } from 'node:fs'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const FILE = arg('file'), APPLY = process.argv.includes('--apply'), CONFIRM = process.argv.includes('--confirm-links'), SEED = process.argv.includes('--seed-listings')
if (!FILE) throw new Error('--file is required')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error('refusing: a local database whose name contains "test" only')
if (SEED && !/ncf/i.test(url.pathname)) throw new Error('refusing: --seed-listings writes listings; use a private copy whose name contains "ncf" and "test"')

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { readShopifyCsv, resolveShopifyCsv, checkShopifyLedger, shopifyStoreTargets } = await import('../src/services/pim/catalog-shopify-csv.js')
const { default: prisma } = await import('../src/db.js')

const table = readShopifyCsv(readFileSync(FILE))
// Every private token of the file, longest first, so a reason can be printed as a template.
const skuHeader = table.headers.find(h => h === 'Variant SKU' || h === 'SKU'), handleHeader = table.headers.find(h => h === 'Handle' || h === 'URL handle')!
const secrets = [...new Set(table.records.flatMap(r => [r.values[handleHeader], skuHeader ? r.values[skuHeader] : '']).map(s => s?.trim()).filter((s): s is string => !!s && s.length > 2))]
const template = (reason: string, extra: string[] = []) => [...secrets, ...extra].sort((a, b) => b.length - a.length)
  .reduce((text, s) => text.split(s).join('<id>'), reason).replace(/"[^"]*"/g, '"<v>"').replace(/File value: .*/g, 'File value: <v>').replace(/\(\d[^)]*\)/g, '(<v>)').replace(/\b[A-Z0-9]+(?:-[A-Z0-9]+){1,}\b/g, '<id>')
const tally = (items: { key: string }[]) => Object.entries(items.reduce<Record<string, number>>((acc, i) => { acc[i.key] = (acc[i.key] ?? 0) + 1; return acc }, {})).sort((a, b) => b[1] - a[1])

await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const handles = new Set(table.records.map(r => r.values[handleHeader]?.trim()).filter(Boolean))
  const skus = new Set(table.records.map(r => (skuHeader ? r.values[skuHeader] : '')?.trim()).filter(Boolean))
  const nexusSkus = (await prisma.product.findMany({ where: { sku: { in: [...skus] }, deletedAt: null }, select: { sku: true } })).length
  console.log('file', JSON.stringify({ columns: table.headers.length, rows: table.records.length, products: handles.size, variantSkus: skus.size, skusThatAreNexusProducts: nexusSkus, dialect: table.dialect }))
  const stores = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true } })
  const store = stores[0]?.id
  const targets = store ? await shopifyStoreTargets(prisma, store) : []
  // Every Nexus SKU is private too: a reason may name a Nexus product (a parent the file's SKUs belong to).
  secrets.push(...(await prisma.product.findMany({ select: { sku: true } })).map(p => p.sku).filter(s => s.length > 2))
  console.log('database', JSON.stringify({ name: url.pathname.slice(1), shopifyStores: stores.length, shopifyListings: targets.length, listingsWithAKnownHandle: targets.filter(t => t.handles.length).length }))
  if (SEED && store) {
    const found = await prisma.product.findMany({ where: { sku: { in: [...skus] }, deletedAt: null }, select: { id: true, parentId: true } })
    const ids = [...new Set(found.flatMap(p => [p.id, ...(p.parentId ? [p.parentId] : [])]))]
    const have = new Set((await prisma.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: store, aliasKey: '', productId: { in: ids } }, select: { productId: true } })).map(l => l.productId))
    for (const productId of ids.filter(id => !have.has(id))) await prisma.channelListing.create({ data: { productId, channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', channelConnectionId: store, platformAttributes: {} } })
    console.log('seeded (private copy only)', JSON.stringify({ shopifyListingsCreated: ids.length - have.size, forProducts: found.length, parents: ids.length - found.length }))
    targets.splice(0, targets.length, ...await shopifyStoreTargets(prisma, store))
  }
  const read = async (links?: Record<string, string>) => resolveShopifyCsv(table, { links })
  let result = await read()
  const extras: string[] = []
  const summarise = (label: string, r: Awaited<ReturnType<typeof read>>) => {
    const ledger = checkShopifyLedger(table, r)
    console.log(label, JSON.stringify({ written: r.rows.length, excluded: r.exclusions.length, refused: r.issues.length, linkProposals: r.links.length, mapping: r.mapping ? { version: r.mapping.version, status: r.mapping.status, created: r.mapping.created } : null,
      ledger: { cells: r.ledger.length, unaccounted: ledger.unaccounted.length, duplicated: ledger.duplicated.length, dangling: ledger.danglingRows.length, phantom: ledger.phantom.length } }))
    console.log(`${label} rows by field`, JSON.stringify(tally(r.rows.map(x => ({ key: x.field.startsWith('shopify_metafield:') ? 'metafield' : x.field })))))
    console.log(`${label} refused by reason`, JSON.stringify(tally(r.issues.map(i => ({ key: template(i.message, extras) })))))
    console.log(`${label} excluded by reason`, JSON.stringify(tally(r.exclusions.map(e => ({ key: template(e.message, extras) })))))
  }
  summarise('import', result)
  if (CONFIRM && result.links.length) {
    result = await read(Object.fromEntries(result.links.map(l => [l.fileSku, l.proposedSku])))
    summarise('import (links confirmed)', result)
  }
  if (!APPLY) return
  const { stageTransferJob, applyTransferJob, readTransferJob, transferJobStatus } = await import('../src/services/pim/catalog-transfer-jobs.js')
  const job = await stageTransferJob({ rows: result.rows, issues: result.issues, mode: 'update', market: 'GLOBAL', filename: 'shopify-real-file.csv', userId: null })
  const wait = async (states: string[]) => { for (let i = 0; i < 600; i++) { const loaded = (await readTransferJob(job.jobId, null))!; if (states.includes(loaded.job.status)) return transferJobStatus(loaded); await new Promise(r => setTimeout(r, 250)) } throw new Error('the job did not finish') }
  const reviewed = await wait(['QUEUED', 'INVALID'])
  console.log('review', JSON.stringify({ state: reviewed.state, counts: reviewed.counts }))
  // CFI-7 — a review with refused rows applies its ready records only (the Owner's "apply the ready ones").
  if (!['QUEUED', 'INVALID'].includes(reviewed.state)) return
  await applyTransferJob(job.jobId, null, reviewed.reviewToken!, { readyOnly: reviewed.state === 'INVALID' })
  const done = await wait(['COMPLETED', 'PARTIAL', 'FAILED'])
  console.log('apply', JSON.stringify({ state: done.state, counts: done.counts }))
  const again = await read(CONFIRM ? Object.fromEntries(result.links.map(l => [l.fileSku, l.proposedSku])) : undefined)
  summarise('re-import after apply', again)
  // Idempotence: the same file again plans no change (every cell restates what Nexus now holds).
  const { buildTransferPlan, transferContracts } = await import('../src/services/pim/catalog-transfer-plan.js')
  const { loadTransferContext } = await import('../src/services/pim/catalog-transfer.service.js')
  const plan = await buildTransferPlan(again.rows, 'update', await loadTransferContext(again.rows), transferContracts('GLOBAL'))
  const cells = plan.targets.flatMap(t => t.cells)
  console.log('re-import plan', JSON.stringify({ changed: cells.filter(c => c.verdict === 'changed').length, unchanged: cells.filter(c => c.verdict === 'unchanged').length, refusedByPlanner: plan.issues.length,
    changedFields: tally(cells.filter(c => c.verdict === 'changed').map(c => ({ key: c.field }))) }))
  // The file written back through the version the import used, once activated, compared with the original cell by cell.
  if (!result.mapping) return
  const { activateSet } = await import('../src/services/channel-mapping/store.js')
  const { exportShopifyCsv } = await import('../src/services/channel-mapping/shopify-export-host.js')
  const { compareShopifyCsv } = await import('../src/services/channel-mapping/shopify-export.js')
  const { shopifyChannelKeyOf } = await import('../src/services/channel-mapping/shopify-draft.js')
  await activateSet(result.mapping.setId)
  const linkedRoots = [...new Set((await shopifyStoreTargets(prisma, store!)).filter(t => t.handles.length).map(t => t.parentSku ?? t.sku))]
  try {
    const out = await exportShopifyCsv({ setId: result.mapping.setId, skus: linkedRoots })
    const back = readShopifyCsv(out.bytes)
    const cmp = compareShopifyCsv(table, { headers: back.headers, rows: back.records.map(r => back.headers.map(h => r.values[h])) }, shopifyChannelKeyOf)
    console.log('export', JSON.stringify({ productsWritten: out.products, variantRows: out.variants, columnsWritten: out.headers.length, columnsLeftOut: out.omitted.length, productsRefused: out.refused.length,
      lineEnding: back.dialect.lineEnding, bom: back.dialect.bom }))
    console.log('export refused by reason', JSON.stringify(tally(out.refused.map(r => ({ key: template(r.reason) })))))
    console.log('round trip', JSON.stringify({ compared: cmp.compared, equal: cmp.equal, differ: cmp.differ.length, missing: cmp.missing.length, extra: cmp.extra.length, columnsLeftOut: cmp.columnsLeftOut, fileRowsWithSkuNotWritten: cmp.rowsNotWritten,
      differingColumns: tally([...cmp.differ, ...cmp.missing, ...cmp.extra].map(d => ({ key: d.header }))) }))
  } catch (error) { console.log('export refused', template(error instanceof Error ? error.message : String(error))) }
})
await prisma.$disconnect()
process.exit(0)
