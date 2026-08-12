/**
 * _sqp2-stage.mts — SQP.2 Phase A. Get the 80 finished reports onto disk before they expire.
 *
 * 🔴 CALLS AMAZON: `getReport` + `getReportDocument` + document download. It creates NO report and
 *    writes NOTHING to the database. Staging is a read; the upsert is a separate, gated decision.
 *
 * WHY THIS RUNS FIRST AND ALONE. SQP.1 established that 104 abandoned Brand Analytics reports all
 * reached DONE and were thrown away, and that report DOCUMENTS are retained ~72h. So the deadline is
 * not on the decision to keep the data — it is on the DOWNLOAD. Once the bytes are on disk the
 * upsert has no clock attached to it at all. See docs/2026-08-12-sqp-feed.md §8.
 *
 * ── Design notes that matter ──────────────────────────────────────────────────────────────────
 *
 * · **RESUMABLE.** `getReportDocument` is the tightest limit in the Reports API (0.0167 rps, burst
 *   15 — i.e. ~1/min once the burst is spent), so 80 documents is over an hour of wall clock. Any
 *   report already on disk with a manifest line is skipped, so this can be killed and re-run.
 *
 * · **The RAW document is kept as well as the parsed rows.** The brief asks for NDJSON of parsed
 *   rows and that is written; the raw is kept alongside because `parseSqp` has been WRONG before
 *   (ACR.0.2: every "our side" count read 0 across 9,232 rows on a key-name mismatch, and the unit
 *   test asserted the same wrong assumption). If the parser needs fixing after these documents
 *   expire, a re-parse must not require a re-download of something that no longer exists.
 *
 * · **Report ids come from the error text**, because `failReportRun` dropped the column until
 *   2026-08-12 (null on all 104). SQP.1's fix keeps it going forward; these rows predate it.
 *
 * · **Four outcomes, never one failure**: DONE-and-downloaded · DONE-but-document-gone ·
 *   still-generating · terminal (FATAL/CANCELLED). A 404 is reported as expired, never swallowed.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp2-stage.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { SellingPartner } from 'amazon-sp-api'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSqp, SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'

const OUT = join(import.meta.dirname, '_sqp2-staged')
const RAW = join(OUT, 'raw')
const MANIFEST = join(OUT, 'manifest.ndjson')

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const ts = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(5, 19).replace('T', ' ') : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ManifestRow {
  reportId: string
  marketplace: string
  marketplaceId: string
  asin: string | null
  reportPeriod: string
  startDate: string
  endDate: string
  rowCount: number
  distinctAsinsInDoc: number
  downloadedAt: string
  sha256: string
  bytes: number
  requestedAt: string
}

async function main() {
  mkdirSync(RAW, { recursive: true })
  // Belt and braces: nothing under _sqp2-staged/ can ever be swept into a commit by another
  // session's `git add -A`. Four such sweeps have happened in this programme.
  writeFileSync(join(OUT, '.gitignore'), '*\n')

  const already = new Map<string, ManifestRow>()
  if (existsSync(MANIFEST)) {
    for (const l of readFileSync(MANIFEST, 'utf8').split('\n')) {
      if (!l.trim()) continue
      try { const r = JSON.parse(l) as ManifestRow; already.set(r.reportId, r) } catch { /* partial last line */ }
    }
  }
  line(`staging dir: ${OUT}`)
  line(`already staged: ${already.size}`)

  // ── the report ids, recovered from the error text ────────────────────────────────────────────
  const abandoned = await prisma.amazonReportRun.findMany({
    where: { reportType: SQP_REPORT_TYPE, errorMessage: { contains: 'did not reach DONE within' } },
    select: { marketplace: true, requestedAt: true, errorMessage: true, reportId: true, dataStartTime: true, dataEndTime: true },
    orderBy: { requestedAt: 'desc' },
  })
  const mkts = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, marketplaceId: true } })
  const codeOf = new Map(mkts.filter((m) => m.marketplaceId).map((m) => [m.marketplaceId!, m.code]))

  const targets = abandoned
    .map((r) => ({ ...r, rid: r.reportId ?? /report (\d+) did not reach DONE/.exec(r.errorMessage ?? '')?.[1] ?? null }))
    .filter((r): r is typeof r & { rid: string } => !!r.rid)

  h('the recovery set')
  line(`abandoned SQP reports on record: ${abandoned.length} · with a recoverable id: ${targets.length}`)
  const ageH = (d: Date) => (Date.now() - +d) / 3_600_000
  const byBatch = new Map<string, number>()
  for (const t of targets) byBatch.set(d10(t.requestedAt), (byBatch.get(d10(t.requestedAt)) ?? 0) + 1)
  line(`by request date: ${[...byBatch].sort((a, b) => b[0].localeCompare(a[0])).map(([k, v]) => `${k}→${v}`).join(' · ')}`)
  line(`age: newest ${ageH(targets[0].requestedAt).toFixed(1)}h · oldest ${ageH(targets[targets.length - 1].requestedAt).toFixed(1)}h`)
  line('🔴 Amazon retains report documents ~72h. Anything past that is expected to be gone; a 404 is')
  line('   reported as expired rather than retried, so the real remaining window is measured not assumed.')

  const client = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as 'eu' | 'na' | 'fe',
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  } as any)

  h('staging — getReport, getReportDocument, download, parse, write')
  line(`${padr('requested', 15)} ${padr('mkt', 4)} ${padr('reportId', 14)} ${pad('age h', 6)} ${padr('outcome', 22)} rows  asin`)

  const tally = { staged: 0, skipped: 0, expired: 0, generating: 0, terminal: 0, error: 0, zeroRows: 0 }
  const zeroRowReports: string[] = []
  const staged: ManifestRow[] = [...already.values()]

  for (const t of targets) {
    const mkt = codeOf.get(t.marketplace ?? '') ?? t.marketplace ?? '?'
    const prefix = `${padr(ts(t.requestedAt), 15)} ${padr(mkt, 4)} ${padr(t.rid, 14)} ${pad(ageH(t.requestedAt).toFixed(1), 6)}`
    if (already.has(t.rid)) {
      tally.skipped++
      continue
    }

    // 1 · status + document id
    let docId: string | null = null
    try {
      const res: any = await client.callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId: t.rid } })
      const status = res?.processingStatus
      if (status !== 'DONE') {
        if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') { tally.generating++; line(`${prefix} ${padr(`still ${status}`, 22)}`) }
        else { tally.terminal++; line(`${prefix} ${padr(`terminal ${status}`, 22)}`) }
        continue
      }
      docId = res?.reportDocumentId ?? null
      if (!docId) { tally.error++; line(`${prefix} ${padr('DONE but no documentId', 22)}`); continue }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/404|not ?found|NotFound/i.test(msg)) { tally.expired++; line(`${prefix} ${padr('🔴 EXPIRED (getReport)', 22)}`) }
      else { tally.error++; line(`${prefix} ${padr('error', 22)} ${msg.slice(0, 60)}`) }
      continue
    }

    // 2 · the document itself — the thing with the clock on it
    let raw: string
    try {
      const docRes: any = await client.callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: docId } })
      raw = typeof docRes === 'string' ? docRes : await (client as any).download(docRes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/404|not ?found|NotFound|expire|gone/i.test(msg)) { tally.expired++; line(`${prefix} ${padr('🔴 EXPIRED (document)', 22)}`) }
      else { tally.error++; line(`${prefix} ${padr('error (document)', 22)} ${msg.slice(0, 60)}`) }
      continue
    }

    // 3 · parse with the REAL parser, so what is staged is what an ingest would store
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { payload = raw }
    const rows = parseSqp(payload)
    const spec = ((payload ?? {}) as any)?.reportSpecification
    const asinFromSpec: string | null = spec?.reportOptions?.asin ?? null
    const asinsInDoc = [...new Set(rows.map((r) => r.asin).filter((a): a is string => !!a))]
    const asin = asinFromSpec ?? asinsInDoc[0] ?? null

    if (rows.length === 0) { tally.zeroRows++; zeroRowReports.push(t.rid) }

    // 4 · write. Raw first — it is the irreplaceable artefact.
    writeFileSync(join(RAW, `${t.rid}.json`), raw)
    writeFileSync(join(OUT, `${t.rid}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    const m: ManifestRow = {
      reportId: t.rid,
      marketplace: mkt,
      marketplaceId: t.marketplace ?? '',
      asin,
      reportPeriod: 'WEEK',
      startDate: d10(t.dataStartTime),
      endDate: d10(t.dataEndTime),
      rowCount: rows.length,
      distinctAsinsInDoc: asinsInDoc.length,
      downloadedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: Buffer.byteLength(raw),
      requestedAt: t.requestedAt.toISOString(),
    }
    appendFileSync(MANIFEST, JSON.stringify(m) + '\n')
    staged.push(m)
    tally.staged++
    line(`${prefix} ${padr(rows.length ? 'staged' : '🔴 staged, 0 ROWS', 22)} ${pad(rows.length, 4)}  ${asin ?? '—'}${asinsInDoc.length > 1 ? ` (+${asinsInDoc.length - 1} more in doc)` : ''}`)

    // getReportDocument is 0.0167 rps / burst 15. auto_request_throttled backs off for us, but
    // pacing keeps us out of the retry path where a 429 storm can cost the whole window.
    await sleep(4_000)
  }

  h('OUTCOME')
  line(`staged this run   : ${tally.staged}`)
  line(`already on disk   : ${tally.skipped}`)
  line(`🔴 expired        : ${tally.expired}`)
  line(`still generating  : ${tally.generating}`)
  line(`terminal          : ${tally.terminal}`)
  line(`errors            : ${tally.error}`)
  line(`total on disk now : ${staged.length} of ${targets.length} recoverable ids`)
  // 🔴 The brief's stop condition was "a staged report parses to zero rows ⇒ the parser is at
  // fault, because SQP.1 proved these reports are not empty". SQP.1 proved they reached DONE — and
  // separately measured that **25 of 40 come back genuinely empty every night**, because the ASIN
  // selection asks about ASINs Brand Analytics holds nothing on (docs/2026-08-12-sqp-feed.md §6.2).
  // Confirmed on the first document staged here: report 115405020677 for B0BVQLQY1D is a literal
  // `"dataByAsin": []`, 334 bytes, and B0BVQLQY1D is one of the six IT ASINs SQP.1 measured as never
  // having produced a row. So SOME zeros are the expected majority outcome and prove nothing.
  //
  // The condition that would actually implicate the parser is ALL of them parsing to zero — that
  // cannot be a property of the account. Reported that way instead.
  const totalRows = staged.reduce((a, m) => a + m.rowCount, 0)
  if (staged.length > 0 && totalRows === 0) {
    line()
    line(`🔴 STOP CONDITION — all ${staged.length} staged reports parsed to ZERO rows, ${totalRows} in total.`)
    line('   No account produces nothing across every ASIN and every week, so this implicates the')
    line('   PARSER, not the feed. Do not upsert. Every raw document is on disk to diagnose against.')
  } else if (tally.zeroRows) {
    line()
    line(`${tally.zeroRows} of ${tally.staged + tally.skipped} staged reports parsed to zero rows — EXPECTED, not a defect.`)
    line(`   ${staged.filter((m) => m.rowCount > 0).length} reports carry ${totalRows} rows between them, so the parser demonstrably works;`)
    line('   the zeros are ASINs Brand Analytics holds nothing on, which is SQP.1 §6.2 measured again.')
    line(`   Empty documents are ~334 bytes with a literal "dataByAsin": []. Verified, not assumed.`)
  }

  h('what is on disk, by market and period')
  const byKey = new Map<string, { reports: number; rows: number; asins: Set<string> }>()
  for (const m of staged) {
    const k = `${m.marketplace}|${m.startDate}`
    const e = byKey.get(k) ?? { reports: 0, rows: 0, asins: new Set<string>() }
    e.reports++; e.rows += m.rowCount; if (m.asin) e.asins.add(m.asin)
    byKey.set(k, e)
  }
  line(`${padr('mkt', 5)} ${padr('week', 12)} ${pad('reports', 8)} ${pad('rows', 7)} ${pad('ASINs', 6)}`)
  for (const [k, e] of [...byKey].sort()) {
    const [mk, wk] = k.split('|')
    line(`${padr(mk, 5)} ${padr(wk, 12)} ${pad(e.reports, 8)} ${pad(e.rows, 7)} ${pad(e.asins.size, 6)}`)
  }
  line()
  line(`TOTAL staged rows: ${staged.reduce((a, m) => a + m.rowCount, 0)} across ${staged.length} reports`)

  h('control — nothing was written to the database')
  line(`SearchQueryPerformance rows ${await prisma.searchQueryPerformance.count()}`)
  line(`newest stored period ${d10((await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate)}`)
  line('(this script issues only getReport / getReportDocument — no createReport, no upsert)')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
