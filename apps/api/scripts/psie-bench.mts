/**
 * PSIE step 0 — time the product sheet's import/export on a DISPOSABLE local database, stage by stage.
 *
 *   cd apps/api && npx tsx scripts/psie-bench.mts --sku GALE-JACKET [--changes 40] [--engine old] [--market IT] [--out <dir>]
 *
 * One run = export the family's editing workbook (every product, every listing, shared details, every language)
 * → change N cells in the file (half shared names, half listing titles, the value gets " ·b" appended; a positive
 * control) → import it back (read → review → save) → read the values back from the database.
 *
 * It refuses any database whose name does not contain "test" and any non-local host (the CFI proof's rule).
 * Nothing is sent to a channel: the channel keys are absent and background jobs are off.
 */
import './../src/env.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const SKU = arg('sku') ?? 'GALE-JACKET', CHANGES = Number(arg('changes') ?? 40), ENGINE = arg('engine') ?? 'old', MARKET = arg('market') ?? 'IT'
const OUT = arg('out') ?? '/tmp/psie-bench'

// ── the database guard, before anything imports db.ts ──
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) {
  throw new Error(`refusing: the bench runs only on a local disposable database whose name contains "test" (got ${url.hostname}${url.pathname})`)
}
const { default: prisma } = await import('../src/db.js')
const [{ name: dbName }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (!/test/i.test(dbName)) throw new Error(`refusing: connected to ${dbName}`)
console.log(`database ${url.hostname}/${dbName} · family ${SKU} · ${CHANGES} changes · engine ${ENGINE}`)

const { withWorkspace } = await import('../src/lib/workspace-context.js')
mkdirSync(OUT, { recursive: true })

const timings: Record<string, number> = {}
const time = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now()
  try { return await work() } finally { timings[stage] = Math.round(performance.now() - started); console.log(`  ${stage.padEnd(22)} ${String(timings[stage]).padStart(7)} ms`) }
}

/** Change up to `count` text cells in the data sheets: shared `name` first, then listing titles. Returns what changed. */
async function editWorkbook(bytes: Buffer, count: number) {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as never)
  const manifest = book.getWorksheet('Nexus workbook')
  if (!manifest) throw new Error('not a Nexus workbook')
  const scopes: { sheet: string; entity: string }[] = []
  manifest.eachRow((row, n) => { if (n > 4 && row.getCell(1).value) scopes.push({ sheet: String(row.getCell(1).value), entity: String(row.getCell(2).value) }) })
  const edits: { sheet: string; sku: string; field: string; before: string; after: string }[] = []
  const wanted = [['Products', ['name']], ['Overrides', ['item_name', 'title']]] as const
  for (const [entity, fields] of wanted) {
    for (const scope of scopes.filter(s => s.entity === entity)) {
      const sheet = book.getWorksheet(scope.sheet)!
      const keys = sheet.getRow(2).values as unknown[]
      const col = keys.findIndex(k => typeof k === 'string' && fields.some(f => k === f || k.startsWith(`${f}@`)))
      const skuCol = keys.findIndex(k => k === 'sku')
      if (col < 0 || skuCol < 0) continue
      for (let r = 3; r <= sheet.rowCount && edits.length < (entity === 'Products' ? Math.ceil(count / 2) : count); r++) {
        const cell = sheet.getRow(r).getCell(col), value = cell.value
        if (typeof value !== 'string' || !value.trim()) continue
        cell.value = `${value} ·b`
        edits.push({ sheet: scope.sheet, sku: String(sheet.getRow(r).getCell(skuCol).value), field: String(keys[col]), before: value, after: `${value} ·b` })
      }
    }
  }
  return { bytes: Buffer.from(await book.xlsx.writeBuffer()), edits }
}

await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const root = await prisma.product.findFirst({ where: { sku: SKU, deletedAt: null }, select: { id: true } })
  if (!root) throw new Error(`no product ${SKU}`)
  const { productTransferOptions, resolveProductTransferBoundary } = await import('../src/services/pim/catalog-product-transfer.js')
  const options = await time('options', () => productTransferOptions(root.id))
  const selection = { productIds: options.products.map(p => p.id), includeShared: true, listingIds: options.listings.map(l => l.id), locales: options.locales }
  console.log(`  ${options.products.length} products · ${options.listings.length} listings · ${options.locales.length} languages`)

  if (ENGINE === 'old') {
    const { exportCatalogTransfer } = await import('../src/services/pim/catalog-transfer-export.js')
    const { writeEditorWorkbook, inspectEditorTransfer, readEditorInput, requireEditorVersions } = await import('../src/services/pim/catalog-editor-workbook.js')
    const jobs = await import('../src/services/pim/catalog-transfer-jobs.js')
    const boundary = await resolveProductTransferBoundary(root.id, selection)
    const file = await time('export', () => exportCatalogTransfer({ market: MARKET, boundary, layout: 'wide', workbookWriter: scopes => writeEditorWorkbook(scopes, boundary, null) }))
    let bytes = Buffer.from(file.data as Buffer), filename = file.filename
    // A ZIP export: edit its first workbook part only (the bench measures the import, not the split).
    let zip: JSZip | undefined, partName = ''
    if (/\.zip$/i.test(filename)) {
      zip = await JSZip.loadAsync(bytes)
      partName = Object.keys(zip.files).find(n => /\.xlsx$/i.test(n))!
      bytes = await zip.file(partName)!.async('nodebuffer')
    }
    const edited = await time('edit (bench only)', () => editWorkbook(bytes, CHANGES))
    let upload = edited.bytes
    if (zip) { zip.file(partName, upload); upload = await zip.generateAsync({ type: 'nodebuffer' }) }
    writeFileSync(join(OUT, `edited-${filename}`), upload)
    console.log(`  file ${filename} ${(upload.length / 1024).toFixed(0)} KB · ${edited.edits.length} cells changed`)
    const inspected = await time('read file', () => inspectEditorTransfer(upload, filename, root.id, null))
    console.log(`  ${inspected.attributes} attribute rows sent back for ${edited.edits.length} changed cells`)
    const staged = await time('stage review', async () => {
      const boundaryFromFile = await resolveProductTransferBoundary(root.id, inspected.selection)
      const parsed = requireEditorVersions(await readEditorInput(inspected.inputId, root.id, null))
      return jobs.stageTransferJob({ ...parsed, boundary: boundaryFromFile, mode: 'update', market: MARKET, userId: null })
    })
    const wait = async (id: string, until: string[]) => {
      for (let i = 0; i < 12_000; i++) {
        const loaded = await jobs.readTransferJob(id, null)
        if (loaded && until.includes(loaded.job.status)) return jobs.transferJobStatus(loaded)
        await new Promise(r => setTimeout(r, 50))
      }
      throw new Error('timeout')
    }
    const review = await time('review (background)', () => wait(staged.jobId, ['QUEUED', 'INVALID', 'FAILED']))
    console.log(`  review ${review.state} · changed ${review.counts.changed} · unchanged ${review.counts.unchanged} · refused ${review.counts.refused}`)
    if (review.state === 'FAILED') throw new Error(`review failed: ${review.error}`)
    await jobs.applyTransferJob(staged.jobId, null, review.reviewToken!, { readyOnly: review.state === 'INVALID' })
    const done = await time('save (background)', () => wait(staged.jobId, ['COMPLETED', 'PARTIAL', 'FAILED']))
    console.log(`  save ${done.state} · receipt ${JSON.stringify(done.receipt)}`)
    // Positive control: every edited shared name must now end with " ·b".
    const names = edited.edits.filter(e => e.field === 'name')
    const saved = await prisma.product.findMany({ where: { sku: { in: names.map(e => e.sku) } }, select: { sku: true, name: true } })
    const landed = saved.filter(p => p.name.endsWith(' ·b')).length
    console.log(`  read-back: ${landed}/${names.length} edited shared names landed`)
    timings.total = Object.entries(timings).filter(([k]) => !['options', 'edit (bench only)'].includes(k)).reduce((n, [, v]) => n + v, 0)
    writeFileSync(join(OUT, `bench-${ENGINE}-${SKU}-${Date.now()}.json`), JSON.stringify({ engine: ENGINE, sku: SKU, db: dbName, changes: edited.edits.length, attributeRows: inspected.attributes,
      review: { state: review.state, counts: review.counts }, receipt: done.receipt, landed, timings }, null, 2))
    console.log(`  TOTAL export + read + review + save: ${timings.total} ms`)
  } else if (ENGINE === 'new') {
    const { exportCatalogTransfer } = await import('../src/services/pim/catalog-transfer-export.js')
    const { writeEditorWorkbook } = await import('../src/services/pim/catalog-editor-workbook.js')
    const sheet = await import('../src/services/pim/sheet-transfer/sheet-import.service.js')
    const boundary = await resolveProductTransferBoundary(root.id, selection)
    const notes: string[] = []
    const file = await time('export', () => exportCatalogTransfer({ market: MARKET, boundary, layout: 'wide', sheet: { notes }, workbookWriter: scopes => writeEditorWorkbook(scopes, boundary, null, { style: 'sheet' }) }))
    if (notes.length) console.log(`  export notes: ${notes.length} (${notes[0]})`)
    let bytes = Buffer.from(file.data as Buffer), filename = file.filename
    let zip: JSZip | undefined, partName = ''
    if (/\.zip$/i.test(filename)) {
      zip = await JSZip.loadAsync(bytes)
      partName = Object.keys(zip.files).find(n => /\.xlsx$/i.test(n))!
      bytes = await zip.file(partName)!.async('nodebuffer')
    }
    // Negative control: the file exactly as exported changes nothing and is refused with a sentence.
    const untouched = await sheet.startSheetImport({ buffer: Buffer.from(file.data as Buffer), filename, productId: root.id, market: MARKET, userId: null }).then(() => 'accepted', (e: Error) => e.message)
    console.log(`  unedited file: ${untouched}`)
    const edited = await time('edit (bench only)', () => editWorkbook(bytes, CHANGES))
    let upload = edited.bytes
    if (zip) { zip.file(partName, upload); upload = await zip.generateAsync({ type: 'nodebuffer' }) }
    writeFileSync(join(OUT, `edited-new-${filename}`), upload)
    console.log(`  file ${filename} ${(upload.length / 1024).toFixed(0)} KB · ${edited.edits.length} cells changed`)
    const wait = async (id: string, until: string[]) => {
      for (let i = 0; i < 12_000; i++) {
        const status = await sheet.sheetImportStatus(id, null)
        if (status && until.includes(status.state)) return status
        await new Promise(r => setTimeout(r, 25))
      }
      throw new Error('timeout')
    }
    const started = await time('read file', () => sheet.startSheetImport({ buffer: upload, filename, productId: root.id, market: MARKET, userId: null }))
    const review = await time('check (background)', () => wait(started.jobId, ['READY', 'FAILED']))
    console.log(`  check ${review.state} · ${JSON.stringify(review.summary)}${review.error ? ` · ${review.error}` : ''}`)
    if (review.state === 'FAILED') throw new Error(`check failed: ${review.error}`)
    if (review.summary.problems) {
      const problems = await sheet.sheetImportChanges(started.jobId, null, { filter: 'problems' })
      for (const p of problems?.changes.slice(0, 8) ?? []) console.log(`    problem ${p.sku} · ${p.destination} · ${p.label}: ${p.problem}`)
    }
    await sheet.applySheetImport(started.jobId, null, review.reviewToken!)
    const done = await time('save (background)', () => wait(started.jobId, ['DONE', 'PARTIAL', 'FAILED']))
    console.log(`  save ${done.state} · receipt ${JSON.stringify(done.receipt)} · readiness ${done.readiness ?? 'none'}`)
    // Readiness is rebuilt right after the save: time it, and prove it ran (the family's index rows are newer than the save).
    const readinessStarted = performance.now()
    let settled = done
    while (settled.readiness === 'pending') { await new Promise(r => setTimeout(r, 100)); settled = (await sheet.sheetImportStatus(started.jobId, null))! }
    timings['readiness (after save)'] = Math.round(performance.now() - readinessStarted)
    const familyIds = (await prisma.product.findMany({ where: { OR: [{ id: root.id }, { parentId: root.id }] }, select: { id: true } })).map(p => p.id)
    const newest = await prisma.readinessIndex.findFirst({ where: { productId: { in: familyIds } }, orderBy: { computedAt: 'desc' }, select: { computedAt: true } }).catch(() => null)
    console.log(`  readiness ${settled.readiness} after ${timings['readiness (after save)']} ms · newest index row ${newest?.computedAt?.toISOString() ?? 'unknown'} (save done ${done.completedAt})`)
    const saved = await prisma.importJobRow.findMany({ where: { jobId: started.jobId, completedAt: { not: null } }, orderBy: { completedAt: 'asc' }, select: { targetId: true, status: true, errorMessage: true, completedAt: true } })
    const gaps = saved.slice(1).map((r, i) => ({ target: r.targetId, ms: r.completedAt!.getTime() - saved[i].completedAt!.getTime() })).sort((a, b) => b.ms - a.ms)
    console.log(`  slowest records: ${gaps.slice(0, 5).map(g => `${g.ms} ms ${g.target}`).join(' | ')}`)
    for (const failed of saved.filter(r => r.status === 'FAILED')) console.log(`  FAILED ${failed.targetId}: ${failed.errorMessage}`)
    const names = edited.edits.filter(e => e.field === 'name')
    const landedCount = async () => (await prisma.product.findMany({ where: { sku: { in: names.map(e => e.sku) } }, select: { name: true } })).filter(p => p.name.endsWith(' ·b')).length
    const landed = await landedCount()
    console.log(`  read-back: ${landed}/${names.length} edited shared names landed`)
    const outbound = await prisma.outboundSyncQueue.count({ where: { createdAt: { gte: new Date(Date.parse(started.startedAt)) }, syncType: 'CONTENT_UPDATE' } })
    console.log(`  channel updates queued by the import: ${outbound} (D1 (a) expects 0)`)
    const undo = await time('undo', async () => { const u = await sheet.undoSheetImport(started.jobId, null); return wait(u!.jobId, ['DONE', 'PARTIAL', 'FAILED']) })
    const restored = names.length - await landedCount()
    console.log(`  undo ${undo.state} · receipt ${JSON.stringify(undo.receipt)} · ${restored}/${names.length} names restored`)
    timings.total = ['export', 'read file', 'check (background)', 'save (background)'].reduce((n, k) => n + (timings[k] ?? 0), 0)
    writeFileSync(join(OUT, `bench-${ENGINE}-${SKU}-${Date.now()}.json`), JSON.stringify({ engine: ENGINE, sku: SKU, db: dbName, changes: edited.edits.length,
      check: { state: review.state, summary: review.summary }, receipt: done.receipt, landed, outbound, undo: { state: undo.state, receipt: undo.receipt, restored }, timings }, null, 2))
    console.log(`  TOTAL export + read + check + save: ${timings.total} ms`)
  } else throw new Error(`engine ${ENGINE} is not built yet`)
})
await prisma.$disconnect()
// Service modules start timers (recovery, caches); the bench is done.
process.exit(0)
