/** Round trip on the private clone: apply a staged catalog-transfer preview, export natively, compare every cell. */
import { readFileSync, writeFileSync } from 'node:fs'
const API = '/Users/awais/nexus-commerce/apps/api/src'
const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad/runs/out'
const a = JSON.parse(process.argv[2]) as { id: string; job: string; file: string; market: string; productType: string; rootSku: string }
if (!/@127\.0\.0\.1:55439\/nexus_cfi_20260924$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing: not the clone')
const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_cfi_20260924') throw new Error('refusing: ' + name)
const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
const { detectAmazonTemplate } = await import(`${API}/services/amazon/template-workbook.ts`)
const vault = await import(`${API}/services/amazon/template-vault.service.ts`)
const { AmazonFlatFileService } = await import(`${API}/services/amazon/flat-file.service.ts`)
const { CategorySchemaService } = await import(`${API}/services/categories/schema-sync.service.ts`)
const { AmazonService } = await import(`${API}/services/marketplaces/amazon.service.ts`)
const jobs = await import(`${API}/services/pim/catalog-transfer-jobs.ts`)
const out: Record<string, unknown> = { args: a }
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const original = new Uint8Array(readFileSync(a.file))
  const orig = (await detectAmazonTemplate(original))!
  // The family's own workbook becomes the export base — what the FX parse route does on upload (routes:1044-1050).
  out.capture = await vault.captureFamilyWorkbook(prisma, original, orig.meta, a.file.split('/').pop()!, orig.headers, orig.rows as never)
  const ff = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))
  const root = await prisma.product.findFirstOrThrow({ where: { sku: a.rootSku }, select: { id: true } })
  const manifest = await ff.generateManifest(a.market, a.productType, false)
  const columns = (manifest.groups ?? []).flatMap((g: any) => g.columns ?? []).map((c: any) => ({ id: c.id, labelEn: c.labelEn, labelLocal: c.labelLocal, fieldRef: c.fieldRef }))
  const exportNow = async (tag: string, live = false) => {
    const rows = await ff.getExistingRows(a.market, a.productType, root.id, 'all', live ? { skipSnapshotOverlay: true } : undefined)
    const res = await vault.buildAmazonTemplateExport(prisma, { marketplace: a.market, columns, rows: rows as never })
    writeFileSync(`${OUT}/${a.id}-${tag}.xlsm`, res.bytes)
    const back = (await detectAmazonTemplate(res.bytes))!
    return { rows: rows.length, base: res.base, mapped: `${res.mappedHeaders}/${res.totalHeaders}`, rowsWritten: res.rowsWritten, back }
  }
  const compare = (back: Awaited<ReturnType<typeof detectAmazonTemplate>>) => {
    const sku = (r: Record<string, string>) => (r['contribution_sku#1.value'] ?? '').trim()
    const bySku = new Map(back!.rows.map(r => [sku(r), r]))
    const cells: { sku: string; key: string; file: string; nexus: string }[] = []
    let equal = 0, blankBoth = 0
    for (const r of orig.rows) for (const h of orig.headers) {
      const f = (r[h] ?? '').trim(), n = (bySku.get(sku(r))?.[h] ?? '').trim()
      if (!f && !n) { blankBoth++; continue }
      if (f === n) { equal++; continue }
      cells.push({ sku: sku(r), key: h, file: f, nexus: n })
    }
    const missingSkus = orig.rows.map(sku).filter(s => !bySku.has(s))
    return { fileRows: orig.rows.length, exportRows: back!.rows.length, missingSkus, equal, differ: cells.length, blankBoth, cells }
  }
  const before = await exportNow('before')
  out.before = { ...before, back: undefined, compare: compare(before.back) }
  // Apply the staged preview exactly as the page's Apply button does (routes:165-170).
  const loaded = await jobs.readTransferJob(a.job, null)
  out.jobBefore = loaded && { status: loaded.job.status, token: !!loaded.payload.reviewToken }
  if (loaded!.job.status === 'QUEUED') await jobs.applyTransferJob(a.job, null, loaded!.payload.reviewToken!)
  for (let i = 0; i < 1200; i++) {
    const j = await prisma.bulkOperation.findUnique({ where: { id: a.job }, select: { status: true, errors: true, changes: true } })
    if (j && !['RUNNING', 'QUEUED'].includes(j.status)) { out.applied = { status: j.status, errors: j.errors, receipt: (j.changes as any)?.receipt, counts: (j.changes as any)?.counts }; break }
    await new Promise(r => setTimeout(r, 500))
  }
  out.failedRows = await prisma.importJobRow.findMany({ where: { jobId: a.job, status: 'FAILED' }, select: { targetId: true, errorMessage: true }, take: 50 })
  const after = await exportNow('after')
  out.after = { ...after, back: undefined, compare: compare(after.back) }
  const live = await exportNow('after-live', true)
  out.afterLive = { ...live, back: undefined, compare: compare(live.back) }
})
writeFileSync(`${OUT}/${a.id}.json`, JSON.stringify(out, null, 1))
const s = (x: any) => x && { rows: x.rows, base: x.base, mapped: x.mapped, equal: x.compare.equal, differ: x.compare.differ, missingSkus: x.compare.missingSkus.length }
console.log(JSON.stringify({ id: a.id, applied: out.applied && (out.applied as any).status, failed: (out.failedRows as any[]).length, before: s(out.before), after: s(out.after), afterLive: s(out.afterLive) }))
await prisma.$disconnect(); process.exit(0)
