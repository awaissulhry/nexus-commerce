/**
 * CHMAP M2 — parity proof: every Amazon file of a folder is read by the reader TWICE, with the rules alone and
 * with the mapping version the rules make for it (`buildAmazonDraftFields`). The two results must be identical,
 * row for row, cell decision for cell decision. A second pass plants ONE Owner decision per file (ignore one
 * mapped column) and must see exactly that column's cells move from "row" to "excluded" — the positive control.
 *
 * Pure reads: it loads cached schemas and marketplace languages; it writes nothing. The Owner's files are only read.
 *   cd apps/api && npx tsx scripts/chmap-parity.mts --dir "/path/LISTNGS" [--only <substring>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const DIR = arg('dir'), ONLY = arg('only')
if (!DIR) throw new Error('--dir is required')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error(`refusing: a local database whose name contains "test" only (got ${url.hostname}${url.pathname})`)

const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
const { mapAmazonWorkbook, amazonProductTypes } = await import('../src/services/pim/catalog-amazon-workbook.js')
const { loadAmazonSpec } = await import('../src/services/pim/channel-specs/index.js')
const { buildAmazonDraftFields } = await import('../src/services/channel-mapping/amazon-draft.js')
const { amazonFormOf, formLabel } = await import('../src/services/channel-mapping/form.js')
const { readerMapping } = await import('../src/services/channel-mapping/decisions.js')
const { normalizeLanguage } = await import('../src/services/pim/content-language.js')
const { default: prisma } = await import('../src/db.js')

const files: string[] = []
const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.(xlsm|xlsx)$/i.test(name) && !name.startsWith('~$')) files.push(p) } }
walk(DIR)

const report: { file: string; outcome: string; detail?: string }[] = []
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const markets = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, language: true, languages: true } })
  for (const path of files.filter(f => !ONLY || f.includes(ONLY)).sort()) {
    const file = relative(DIR, path)
    let parsed
    try { parsed = await detectAmazonTemplate(readFileSync(path), { strict: true }) } catch (e) { report.push({ file, outcome: 'unreadable', detail: (e as Error).message }); continue }
    if (!parsed) { report.push({ file, outcome: 'not an Amazon template' }); continue }
    const marketplace = parsed.meta.marketplace
    const market = markets.find(m => m.code === marketplace)
    if (!marketplace || !market) { report.push({ file, outcome: 'no marketplace' }); continue }
    const specs = new Map()
    for (const type of new Set([...amazonProductTypes(parsed), ...(parsed.meta.templateProductTypes ?? [])])) { try { specs.set(type, await loadAmazonSpec(marketplace, type)) } catch { /* refused per row */ } }
    const primaryLanguage = normalizeLanguage(market.language)
    const marketLanguages = [...new Set([primaryLanguage, ...(market.languages ?? []).map(normalizeLanguage)])]
    const form = amazonFormOf(parsed, marketplace)
    const rows = buildAmazonDraftFields(parsed, specs, { marketplace, primaryLanguage, marketLanguages, productTypes: form.formKey.split('+') })
    const fields = rows.map((r, i) => ({ ...r, id: `f${i}` }))
    const destination = { accountId: 'parity', marketplace, language: market.language, languages: market.languages ?? [] }
    const plain = mapAmazonWorkbook(parsed, specs, destination)
    const withMapping = mapAmazonWorkbook(parsed, specs, { ...destination, mapping: readerMapping({ id: 'parity', version: 1, status: 'DRAFT' }, formLabel(form, 1, 'DRAFT'), fields) })
    const same = JSON.stringify([plain.rows, plain.ledger, plain.issues, plain.exclusions]) === JSON.stringify([withMapping.rows, withMapping.ledger, withMapping.issues, withMapping.exclusions])
    // Positive control: the Owner ignores the most-filled mapped channel field; exactly its cells must move.
    const counts = new Map<string, number>()
    for (const e of plain.ledger) if (e.outcome === 'row' && e.field) counts.set(e.header, (counts.get(e.header) ?? 0) + 1)
    const target = fields.filter(f => f.targetKind === 'channelField' && counts.has(f.columnKey!)).sort((a, b) => counts.get(b.columnKey!)! - counts.get(a.columnKey!)!)[0]
    let control = 'no mapped column'
    if (target) {
      const planted = fields.map(f => f === target ? { ...f, state: 'ignored' as const, decidedBy: 'owner' as const, reason: 'parity control' } : f)
      const moved = mapAmazonWorkbook(parsed, specs, { ...destination, mapping: readerMapping({ id: 'parity', version: 2, status: 'DRAFT' }, 'control', planted) })
      const excluded = moved.ledger.filter(e => e.header === target.columnKey && e.outcome === 'excluded' && e.reason?.includes('parity control')).length
      const otherRowsBefore = plain.ledger.filter(e => e.header !== target.columnKey && e.outcome === 'row').length
      const otherRowsAfter = moved.ledger.filter(e => e.header !== target.columnKey && e.outcome === 'row').length
      control = excluded === counts.get(target.columnKey!) && otherRowsBefore === otherRowsAfter ? `caught (${excluded} cells of ${target.channelKey})` : `NOT CAUGHT (${excluded}/${counts.get(target.columnKey!)} moved; other rows ${otherRowsBefore}→${otherRowsAfter})`
    }
    const tally = (s: typeof rows) => ({ mapped: s.filter(r => r.state === 'mapped').length, ignored: s.filter(r => r.state === 'ignored').length, managed: s.filter(r => r.state === 'managed').length, unmapped: s.filter(r => r.state === 'unmapped').length })
    report.push({ file, outcome: same ? 'identical' : 'DIFFERENT', detail: `${form.formKey} ${form.templateVersion ?? '-'} · ${JSON.stringify(tally(rows))} · rows ${plain.rows.length} · control ${control}` })
  }
})
for (const r of report) console.log(`${r.outcome.padEnd(22)} ${r.file}${r.detail ? `  —  ${r.detail}` : ''}`)
const bad = report.filter(r => r.outcome === 'DIFFERENT' || r.detail?.includes('NOT CAUGHT'))
console.log(`\n${report.length} files · identical ${report.filter(r => r.outcome === 'identical').length} · different ${report.filter(r => r.outcome === 'DIFFERENT').length} · control not caught ${report.filter(r => r.detail?.includes('NOT CAUGHT')).length}`)
await prisma.$disconnect()
process.exit(bad.length ? 1 : 0)
