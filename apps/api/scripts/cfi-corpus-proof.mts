/**
 * CFI-9 — the corpus proof (docs/channel-file-import/PLAN.md §4, BUILD.md). Every spreadsheet in a folder goes
 * through the REAL import path on a DISPOSABLE database copy, and every filled cell must be accounted for:
 *
 *   sniff → parse → resolve (Amazon / eBay reader) → ledger check (0 unaccounted · 0 duplicated · 0 dangling)
 *   → preview (the staged job) → apply the ready records (optional) → the product sheet's own export → compare.
 *
 * It refuses any database whose name does not contain "test" (the same rule as the API test guard) and any
 * non-local host. The Owner's files are only read. Nothing is sent to a channel: the channel keys are absent.
 *
 *   cd apps/api && npx tsx scripts/cfi-corpus-proof.mts --dir "/path/LISTNGS" --out /tmp/cfi-proof \
 *     [--apply final] [--family-map "JACKETS=jackets,SUITS=suits,ACCESSORIES=accessories"] [--only <substring>]
 *
 * `--apply final` applies only files in a "FINAL (upload this)" folder and the eBay workbooks (history and delete
 * files are previewed, never applied). Families for NEW products come from the first folder name via --family-map —
 * the Owner picks the family on the page; the map stands in for that choice.
 */
import './../src/env.js'
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import ExcelJS from 'exceljs'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const DIR = arg('dir'), OUT = arg('out') ?? '/tmp/cfi-proof', APPLY = arg('apply'), ONLY = arg('only')
// The Owner's review decisions, for a targeted run on ONE file (with --only): confirmed identity links and confirmed deletes.
const LINKS = arg('links') ? JSON.parse(arg('links')!) as Record<string, string> : undefined
const CONFIRM = arg('confirm-deletes') ? (arg('confirm-deletes') === 'true' ? true : JSON.parse(arg('confirm-deletes')!) as string[]) : undefined
if ((LINKS || CONFIRM) && !ONLY) throw new Error('--links / --confirm-deletes are review decisions for one file: add --only')
if (!DIR) throw new Error('--dir is required')
const FAMILY_MAP = Object.fromEntries((arg('family-map') ?? 'JACKETS=jackets,SUITS=suits,ACCESSORIES=accessories').split(',').map(p => p.split('=')))

// ── the database guard, before anything imports db.ts ──
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) {
  throw new Error(`refusing: the proof runs only on a local disposable database whose name contains "test" (got ${url.hostname}${url.pathname})`)
}
const { default: prisma } = await import('../src/db.js')
const [{ name: dbName }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (!/test/i.test(dbName)) throw new Error(`refusing: connected to ${dbName}`)

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { sniffWorkbook, amazonAttributeSheetDoor } = await import('../src/services/pim/channel-file-sniff.js')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
const amazon = await import('../src/services/pim/catalog-amazon-workbook.js')
const ebay = await import('../src/services/pim/catalog-ebay-workbook.js')
const jobs = await import('../src/services/pim/catalog-transfer-jobs.js')
const { exportCatalogTransfer } = await import('../src/services/pim/catalog-transfer-export.js')
const { readTransferFile } = await import('../src/services/pim/catalog-transfer-file.js')
const { transferCanonical } = await import('@nexus/shared/catalog-transfer')

mkdirSync(OUT, { recursive: true })
const files: string[] = []
const walk = (dir: string) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p); else if (/\.xls[xm]$/i.test(e)) files.push(p) } }
walk(DIR)
files.sort()

type Report = Record<string, unknown> & { file: string }
const reports: Report[] = []
const waitJob = async (id: string, until: string[]) => {
  for (let i = 0; i < 2400; i++) {
    const job = await prisma.bulkOperation.findUnique({ where: { id }, select: { status: true } })
    if (job && until.includes(job.status)) return job.status
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`job ${id} did not settle`)
}
const SPECIAL = new Set(['price', 'sale', 'presence', 'sellerSku'])
// eBay seller-defined specifics live in `platformAttributes.itemSpecifics` and have no product-sheet column: read them back directly.
const isSpecific = (field: string) => field.startsWith('itemSpecifics.')
let controlChecked = false

await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const families = new Map((await prisma.productFamily.findMany({ select: { id: true, code: true } })).map(f => [f.code, f.id]))
  for (const path of files) {
    const rel = relative(DIR, path)
    if (ONLY && !rel.includes(ONLY)) continue
    const report: Report = { file: rel }
    reports.push(report)
    const t0 = Date.now()
    try {
      if (basename(path).startsWith('~$')) { report.outcome = 'skipped: Excel lock file'; continue }
      const bytes = readFileSync(path)
      const sniff = await sniffWorkbook(new Uint8Array(bytes))
      report.kind = sniff.kind
      let result: { rows: any[]; issues: any[]; exclusions: any[]; links?: any[]; warnings?: string[]; ledger?: any[] } | undefined
      let ledger: Record<string, unknown[]> | undefined
      let market = 'IT'
      const familyId = families.get(FAMILY_MAP[rel.split('/')[0]] ?? '') ?? undefined
      if (sniff.kind === 'amazon-template') {
        const parsed = await detectAmazonTemplate(new Uint8Array(bytes), { strict: true })
        if (!parsed) throw new Error('sniffed as an Amazon template but the reader found none')
        market = parsed.meta.marketplace ?? 'IT'
        report.meta = { grammar: parsed.meta.grammar, sheet: parsed.meta.sheet, marketplace: parsed.meta.marketplace, language: parsed.meta.contentLanguageTag, productTypes: parsed.meta.productTypes, actions: parsed.meta.actions }
        result = await amazon.resolveAmazonCatalogWorkbook(parsed, { familyId, mode: 'upsert', links: LINKS, confirmDeletes: CONFIRM })
        ledger = amazon.checkLedger(parsed, result as never) as never
      } else if (sniff.kind === 'ebay-workbook') {
        const book = new ExcelJS.Workbook()
        await book.xlsx.load(bytes as never)
        const table = ebay.readEbayWorkbook(book, { filename: basename(path) })
        if (!table) throw new Error('sniffed as an eBay workbook but the reader found none')
        market = table.marketplace
        report.meta = { sheet: table.sheet, marketplace: table.marketplace, records: table.records.length }
        result = await ebay.resolveEbayCatalogWorkbook(table, { market, links: LINKS, confirmDeletes: CONFIRM })
        ledger = ebay.checkEbayLedger(table, result as never) as never
      } else if (sniff.kind === 'amazon-attribute-sheet') {
        report.outcome = `explained: ${amazonAttributeSheetDoor(basename(path))}`
        continue
      } else {
        report.outcome = `explained: not a channel file (${sniff.kind})`
        continue
      }
      report.parse = { rows: result.rows.length, issues: result.issues.length, exclusions: result.exclusions.length, links: result.links?.length ?? 0, ledgerEntries: result.ledger?.length ?? 0 }
      report.ledger = Object.fromEntries(Object.entries(ledger ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]))
      report.ledgerSample = Object.fromEntries(Object.entries(ledger ?? {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, (v as unknown[]).slice(0, 5)]))
      report.issueReasons = Object.entries(result.issues.reduce<Record<string, number>>((m, i) => { const k = String(i.message).replace(/^[^:]+: /, '').slice(0, 140); m[k] = (m[k] ?? 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8)
      if (!result.rows.length && !result.issues.length && !result.exclusions.length) { report.outcome = 'explained: the file holds no rows'; continue }

      const staged = await jobs.stageTransferJob({ ...result, mode: 'upsert', market, filename: `CFI9__${basename(path)}`, userId: null } as never)
      const state = await waitJob(staged.jobId, ['QUEUED', 'INVALID', 'FAILED'])
      const loaded = await jobs.readTransferJob(staged.jobId, null)
      const status = jobs.transferJobStatus(loaded!)
      report.preview = { state, counts: status.counts, links: status.links?.length ?? 0, deletes: status.deletes?.length ?? 0 }
      const refusedReasons = await prisma.importJobRow.findMany({ where: { jobId: staged.jobId, status: 'INVALID' }, select: { parsedValues: true }, take: 500 })
      report.reviewRefusals = Object.entries(refusedReasons.flatMap(r => ((r.parsedValues as any)?.issues ?? []).map((i: any) => String(i.message).replace(/^[^:]+: /, '').slice(0, 140))).reduce<Record<string, number>>((m, k) => { m[k] = (m[k] ?? 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8)

      const applicable = APPLY === 'all' || APPLY === 'final' && (/FINAL \(upload this\)/.test(rel) || sniff.kind === 'ebay-workbook')
      if (!applicable || state === 'FAILED') { report.outcome = `previewed (${state})`; continue }
      // Nothing but the confirmed deletes may end a listing: count ENDED listings before and after (checked below).
      const endedBefore = await prisma.channelListing.count({ where: { listingStatus: 'ENDED' } })
      try { await jobs.applyTransferJob(staged.jobId, null, status.reviewToken!, { readyOnly: true }) }
      catch (e) {
        // A review whose every record is refused has nothing to apply — an explained outcome, stated by the refusals above.
        if (e instanceof Error && /Nothing in this review is ready to apply/.test(e.message)) { report.outcome = `explained: nothing ready to apply (${state})`; continue }
        throw e
      }
      const applied = await waitJob(staged.jobId, ['COMPLETED', 'PARTIAL', 'FAILED'])
      const after = jobs.transferJobStatus((await jobs.readTransferJob(staged.jobId, null))!)
      report.apply = { state: applied, receipt: after.receipt }
      const failed = await prisma.importJobRow.findMany({ where: { jobId: staged.jobId, status: 'FAILED' }, select: { errorMessage: true }, take: 200 })
      report.applyFailures = Object.entries(failed.reduce<Record<string, number>>((m, f) => { const k = String(f.errorMessage).slice(0, 140); m[k] = (m[k] ?? 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8)

      // ── round trip: what the SAVED records wrote, read back through the product sheet's own export ──
      const saved = await prisma.importJobRow.findMany({ where: { jobId: staged.jobId, status: 'SUCCESS' }, select: { parsedValues: true } })
      const savedRows = saved.flatMap(r => ((r.parsedValues as any)?.target?.rows ?? []) as any[])
      const attrRows = savedRows.filter(r => !SPECIAL.has(r.field) && !isSpecific(r.field) && r.action === 'SET')
      const clearRows = savedRows.filter(r => r.action === 'CLEAR')
      const skus = [...new Set(savedRows.map(r => r.sku))]
      const rt = { compared: 0, equal: 0, missing: 0, differs: 0, clearsCompared: 0, clearsEmpty: 0, samples: [] as unknown[] }
      if (skus.length) {
        const exported = await exportCatalogTransfer({ market, skus, marketplaces: [market], layout: 'attributes', effective: false } as never)
        const back = await readTransferFile(exported.data as Buffer, exported.filename)
        const key = (r: any, locale = r.locale ?? '') => JSON.stringify([r.sku, r.entity === 'Products' ? '' : r.channel, r.entity === 'Products' ? '' : r.marketplace, r.entity === 'Products' ? '' : r.aliasKey ?? '', locale, r.field])
        const index = new Map((back.rows as any[]).map(r => [key(r), r]))
        const languages = [...new Set((back.rows as any[]).map(r => r.locale).filter(Boolean))]
        const find = (r: any) => index.get(key(r)) ?? (!r.locale ? languages.map(l => index.get(key(r, l))).find(Boolean) : undefined)
        let rowsToCompare = attrRows
        if (!controlChecked && attrRows.length) {
          // Positive control, once per run: a planted change MUST be reported as a difference.
          const planted = { ...attrRows[0], value: `${JSON.stringify(attrRows[0].value)}·CONTROL` }
          const hit = find(planted)
          report.control = hit && transferCanonical(hit.value) !== transferCanonical(planted.value) ? 'caught' : 'NOT CAUGHT'
          controlChecked = true
          rowsToCompare = attrRows
        }
        for (const r of rowsToCompare) {
          rt.compared++
          const e = find(r)
          if (!e) { rt.missing++; if (rt.samples.length < 10) rt.samples.push({ kind: 'missing', sku: r.sku, field: r.field }); continue }
          if (transferCanonical(e.value) === transferCanonical(r.value)) rt.equal++
          else { rt.differs++; if (rt.samples.length < 10) rt.samples.push({ kind: 'differs', sku: r.sku, field: r.field, imported: r.value, exported: e.value }) }
        }
        for (const r of clearRows) {
          rt.clearsCompared++
          const e = find(r)
          if (!e || e.value === null || e.value === undefined || e.value === '' || (Array.isArray(e.value) && !e.value.length)) rt.clearsEmpty++
        }
      }
      report.roundTrip = rt
      // Prices, presence and seller SKUs live in listing columns; read them back directly.
      const special = savedRows.filter(r => SPECIAL.has(r.field) || isSpecific(r.field) && r.action === 'SET')
      const sp = { price: { n: 0, equal: 0 }, presence: { n: 0, equal: 0 }, sellerSku: { n: 0, equal: 0 }, sale: { n: 0 }, itemSpecifics: { n: 0, equal: 0 } }
      for (const r of special) {
        const listing = await prisma.channelListing.findFirst({ where: { product: { sku: r.sku }, channel: r.channel, marketplace: r.marketplace, channelConnectionId: r.accountId, aliasKey: r.aliasKey ?? '' }, select: { price: true, listingStatus: true, platformAttributes: true } })
        if (r.field === 'price') { sp.price.n++; if (listing && Number(listing.price) === Number(r.value)) sp.price.equal++ }
        if (r.field === 'presence') { sp.presence.n++; if (listing?.listingStatus === 'ENDED') sp.presence.equal++ }
        if (r.field === 'sellerSku') { sp.sellerSku.n++; if ((listing?.platformAttributes as any)?.sellerSku === r.value) sp.sellerSku.equal++ }
        if (r.field === 'sale') sp.sale.n++
        if (isSpecific(r.field)) { sp.itemSpecifics.n++; const stored = (listing?.platformAttributes as any)?.itemSpecifics?.[r.field.slice('itemSpecifics.'.length)]; if (transferCanonical(Array.isArray(stored) && !Array.isArray(r.value) && stored.length === 1 ? stored[0] : stored) === transferCanonical(r.value)) sp.itemSpecifics.equal++ }
      }
      const endedAfter = await prisma.channelListing.count({ where: { listingStatus: 'ENDED' } })
      ;(sp as any).endedDelta = { expected: sp.presence.n, actual: endedAfter - endedBefore, equal: endedAfter - endedBefore === sp.presence.n ? 1 : 0, n: 1 }
      report.special = sp
      report.outcome = `applied (${applied})`
    } catch (e) {
      report.outcome = 'ERROR'
      report.error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    } finally {
      report.ms = Date.now() - t0
      writeFileSync(join(OUT, 'proof.json'), JSON.stringify({ db: dbName, dir: DIR, apply: APPLY ?? null, at: new Date().toISOString(), reports }, null, 1))
    }
  }
})

// ── the verdict ──
const specialBad = (r: Report) => Object.values((r.special as Record<string, { n: number; equal?: number }>) ?? {}).some(v => v.equal !== undefined && v.equal !== v.n)
const bad = reports.filter(r => specialBad(r) || r.outcome === 'ERROR' || Object.values((r.ledger as Record<string, number>) ?? {}).some(n => n > 0) || (r.roundTrip as any)?.missing || (r.roundTrip as any)?.differs || (r.roundTrip as any) && (r.roundTrip as any).clearsEmpty !== (r.roundTrip as any).clearsCompared || r.control === 'NOT CAUGHT')
const md = [
  `# CFI-9 corpus proof — ${new Date().toISOString()}`, '',
  `Database \`${dbName}\` · folder \`${DIR}\` · apply: ${APPLY ?? 'none (preview only)'} · files: ${reports.length} · **not clean: ${bad.length}**`, '',
  '| file | kind | parse rows / issues / excl. | ledger (unacc · dup · dangling) | preview | apply | round trip (equal / compared) | outcome |',
  '|---|---|---|---|---|---|---|---|',
  ...reports.map(r => {
    const p = r.parse as any, l = r.ledger as any, pv = r.preview as any, ap = r.apply as any, rt = r.roundTrip as any
    return `| ${r.file} | ${r.kind ?? ''} | ${p ? `${p.rows} / ${p.issues} / ${p.exclusions}` : ''} | ${l ? `${l.unaccounted ?? 0} · ${l.duplicated ?? 0} · ${l.danglingRows ?? 0}${l.phantom ? ` · ph ${l.phantom}` : ''}` : ''} | ${pv ? `${pv.state} · ch ${pv.counts?.changed} · ref ${pv.counts?.refused}` : ''} | ${ap ? `${ap.state} · saved ${ap.receipt?.saved} · skipped ${ap.receipt?.skipped ?? 0} · failed ${ap.receipt?.failed}` : ''} | ${rt ? `${rt.equal} / ${rt.compared}${rt.clearsCompared ? ` · clears ${rt.clearsEmpty}/${rt.clearsCompared}` : ''}` : ''} | ${r.outcome}${r.error ? `: ${r.error}` : ''} |`
  }),
]
writeFileSync(join(OUT, 'proof.md'), md.join('\n'))
console.log(JSON.stringify({ files: reports.length, notClean: bad.length, out: OUT, control: reports.find(r => r.control)?.control ?? 'not run' }))
await prisma.$disconnect()
process.exit(0)
