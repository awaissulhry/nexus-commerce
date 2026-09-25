/**
 * CFI measurement harness — runs the EXISTING import code paths on ONE file, against the private
 * database copy `nexus_cfi_20260924` (never nexus_development, never production).
 *
 * The functions called are exactly the ones the routes call:
 *   catalog-amazon : catalog-transfer.routes.ts:135-136  readAmazonCatalogWorkbook → stageTransferJob
 *   catalog-plain  : catalog-transfer.routes.ts:135-136  readTransferFile → stageTransferJob
 *   drawer         : catalog-transfer.routes.ts:45-55 + 56-62  inspectEditorTransfer → readEditorInput → requireEditorVersions
 *                    → resolveProductTransferBoundary → stageTransferJob(mode 'update', boundary)
 *   source         : catalog-transfer.routes.ts:100-104  inspectCatalogSource
 * The job preview (runTransferJob) runs in this process; we wait for it and dump every outcome row.
 *
 * Usage (cwd apps/api): node --import tsx harness.mts '<json args>'
 *   args: { id, path, file, market?, account?, family?, productSku?, mode?, stage?: boolean }
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const API = '/Users/awais/nexus-commerce/apps/api/src'
const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad/runs/out'
mkdirSync(OUT, { recursive: true })
const args = JSON.parse(process.argv[2]) as { id: string; path: string; file: string; market?: string; account?: string; family?: string; productSku?: string; mode?: string; stage?: boolean }

// ── the database guard: the clone, by name, before any import that constructs a pool ──
const url = process.env.DATABASE_URL ?? ''
if (!/@127\.0\.0\.1:55439\/nexus_cfi_20260924$/.test(url)) throw new Error(`refusing: DATABASE_URL is not the private clone (${url.replace(/:[^:@]*@/, ':***@')})`)

const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_cfi_20260924') throw new Error(`refusing: connected to ${name}`)

const out: Record<string, unknown> = { args, db: name, startedAt: new Date().toISOString() }
const t0 = performance.now()
const lap = (k: string) => { (out.ms ??= {} as Record<string, number>); (out.ms as Record<string, number>)[k] = Math.round(performance.now() - t0) }
const group = <T,>(items: T[], key: (t: T) => string, sample: (t: T) => string) => {
  const m = new Map<string, { n: number; samples: Set<string> }>()
  for (const i of items) { const k = key(i); const g = m.get(k) ?? { n: 0, samples: new Set() }; g.n++; if (g.samples.size < 400) g.samples.add(sample(i)); m.set(k, g) }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => ({ message: k, n: g.n, fields: [...g.samples] }))
}
const summarize = (parsed: { rows: any[]; issues: any[]; exclusions?: any[]; warnings?: string[] }) => ({
  rows: parsed.rows.length, issues: parsed.issues.length, exclusions: parsed.exclusions?.length ?? 0, warnings: parsed.warnings ?? [],
  rowFields: group(parsed.rows, r => `${r.entity}|${r.channel}|${r.marketplace}|${r.locale}|${r.field}`, r => r.sku),
  issueGroups: group(parsed.issues, i => i.message.replace(/^[^:]+: /, ''), i => i.field),
  exclusionGroups: group(parsed.exclusions ?? [], e => e.message.replace(/^[^:]+: /, '').replace(/Source reference: .*$/, 'Source reference: …'), e => e.field),
})

let jobId: string | undefined
const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
// The owner's business — every local row belongs to it (measured: 355/355 products).
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
try {
  const buffer = readFileSync(args.file)
  const filename = `CFI__${basename(args.file)}`
  const mode = (args.mode ?? 'update') as 'update' | 'create' | 'upsert'
  let parsed: any
  let boundary: any
  if (args.path === 'catalog-amazon') {
    const { readAmazonCatalogWorkbook } = await import(`${API}/services/pim/catalog-amazon-workbook.ts`)
    const { detectAmazonTemplate } = await import(`${API}/services/amazon/template-workbook.ts`)
    // The same strict parse the importer runs first — kept for the per-key coverage table.
    const detected = await detectAmazonTemplate(buffer, { strict: true }).catch((e: Error) => ({ error: e.message }))
    if (detected && !('error' in detected)) {
      out.meta = detected.meta
      out.headers = detected.headers
      out.labels = detected.labels
      out.populated = Object.fromEntries(detected.headers.map((h: string) => [h, detected.rows.filter((r: Record<string, string>) => (r[h] ?? '').trim()).length]))
      out.skus = detected.rows.map((r: Record<string, string>) => [r['contribution_sku#1.value'] ?? r['item_sku'] ?? '', r.__action])
    } else out.detect = detected
    lap('detected')
    // 'auto' = what the Owner would pick: the file's own marketplace, else the folder's market code.
    if (args.market === 'auto') {
      const fromMeta = detected && !('error' in detected) ? detected.meta.marketplace : undefined
      const fromPath = /(?:^|[\/ _-])(IT|DE|FR|ES|UK|GB)(?=[\/ ._-]|$)/.exec(args.file.replace(/^.*LISTNGS/, ''))?.[1]
      args.market = fromMeta ?? (fromPath === 'GB' ? 'UK' : fromPath) ?? 'IT'
      out.marketChosen = { market: args.market, from: fromMeta ? 'file' : fromPath ? 'folder' : 'default' }
    }
    parsed = await readAmazonCatalogWorkbook(buffer, args.account!, args.market!, { familyId: args.family, mode })
  } else if (args.path === 'catalog-plain') {
    const { readTransferFile } = await import(`${API}/services/pim/catalog-transfer-file.ts`)
    parsed = await readTransferFile(buffer, filename, { blankPolicy: 'ignore' })
  } else if (args.path === 'drawer') {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: args.productSku, deletedAt: null }, select: { id: true } })
    const editor = await import(`${API}/services/pim/catalog-editor-workbook.ts`)
    const transfer = await import(`${API}/services/pim/catalog-product-transfer.ts`)
    const stages: unknown[] = []
    const inspected = await editor.inspectEditorTransfer(buffer, filename, product.id, null, (event: string, detail: unknown) => stages.push({ event, detail }))
    out.inspect = { ...inspected, stages }
    lap('inspected')
    parsed = editor.requireEditorVersions(await editor.readEditorInput(inspected.inputId, product.id, null))
    boundary = await transfer.resolveProductTransferBoundary(product.id, inspected.selection)
  } else if (args.path === 'source') {
    const { inspectCatalogSource } = await import(`${API}/services/pim/catalog-source.service.ts`)
    const inspected = await inspectCatalogSource(buffer, filename, null)
    out.inspect = { headers: inspected.headers, total: inspected.total, sample: inspected.sample.slice(0, 2) }
  } else throw new Error(`unknown path ${args.path}`)
  lap('parsed')
  if (parsed) {
    out.parse = summarize(parsed)
    out.rawRows = parsed.rows.map((r: any) => ({ sku: r.sku, entity: r.entity, channel: r.channel, marketplace: r.marketplace, aliasKey: r.aliasKey, locale: r.locale, field: r.field, value: r.value, source: r.source }))
    out.rawIssues = parsed.issues
    out.rawExclusions = parsed.exclusions ?? []
  }
  if (parsed && args.stage) {
    const { stageTransferJob } = await import(`${API}/services/pim/catalog-transfer-jobs.ts`)
    const staged = await stageTransferJob({ ...parsed, ...(boundary ? { boundary } : {}), mode: boundary ? 'update' : mode, market: args.market ?? 'IT', filename, userId: null })
    jobId = staged.jobId
    out.jobId = jobId
    lap('staged')
    for (let i = 0; i < 1800; i++) {
      const job = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { status: true, processed: true, total: true, errors: true, changes: true } })
      if (job && job.status !== 'PREVIEWING' && job.status !== 'STAGING') {
        out.job = { status: job.status, total: job.total, errors: job.errors, counts: (job.changes as any)?.counts, warnings: (job.changes as any)?.warnings }
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }
    lap('previewed')
    const records = await prisma.importJobRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' }, select: { rowIndex: true, targetId: true, status: true, errorMessage: true, parsedValues: true } })
    out.outcomes = records.map(r => {
      const v = r.parsedValues as any
      return { index: r.rowIndex, status: r.status, error: r.errorMessage, changed: v?.changed, identity: v?.target?.identity ?? v?.rows?.[0] ?? v?.issues?.[0] ?? v?.exclusions?.[0]?.identity,
        cells: v?.target?.cells?.map((c: any) => ({ field: c.field, entity: c.entity, locale: c.locale, verdict: c.verdict, before: c.before, after: c.after, beforeState: c.beforeState, afterState: c.afterState })),
        create: v?.target?.create, issues: v?.issues, exclusions: v?.exclusions?.length ? v.exclusions : undefined, preserved: v?.preserved?.length ? v.preserved : undefined }
    })
  }
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e)
  out.errorStack = e instanceof Error ? e.stack?.split('\n').slice(0, 6) : undefined
}
})
lap('done')
writeFileSync(join(OUT, `${args.id}.json`), JSON.stringify(out, null, 1))
console.log(JSON.stringify({ id: args.id, error: out.error, parse: out.parse && { rows: (out.parse as any).rows, issues: (out.parse as any).issues, exclusions: (out.parse as any).exclusions }, job: out.job && { status: (out.job as any).status, counts: (out.job as any).counts }, ms: out.ms }))
await prisma.$disconnect().catch(() => {})
process.exit(0)
