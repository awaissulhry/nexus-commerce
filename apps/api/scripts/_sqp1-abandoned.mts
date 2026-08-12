/**
 * _sqp1-abandoned.mts — SQP.1 Phase A, the one question the ledgers cannot answer.
 *
 * 🔴 CALLS AMAZON — `getReport` only, on report ids AMAZON ALREADY HAS. It creates no report,
 *    downloads no document, and writes NOTHING to the database. Every call is a metadata GET.
 *
 * The two zero-yield nights abandoned 40 reports each at the 300s poll ceiling. Whether that
 * ceiling is the whole defect turns on one fact no ledger holds: did Amazon EVER finish them?
 *   · If they are DONE now → the reports were merely slow, and the fix is to stop throwing away
 *     an in-flight reportId (resume it next run) and/or to raise a ceiling that sits just above
 *     the p99 of everything that has ever succeeded (279s vs 300s).
 *   · If they are still IN_QUEUE / IN_PROGRESS hours later → raising the ceiling buys nothing and
 *     the problem is upstream of us, in Amazon's generation queue for this account.
 * Those two findings imply different Phase B work, so guessing is not an option.
 *
 * 🔴 The reportId column is NULL for all 104 abandoned rows — failReportRun never records it. It
 *    survives ONLY inside the error message text, so that is where this reads it from. Amazon
 *    retains report metadata for ~72h, so anything older than that is expected to be gone; a 404
 *    is reported as 'expired', never silently dropped.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-abandoned.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { SellingPartner } from 'amazon-sp-api'
import { SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const ts = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(5, 19).replace('T', ' ') : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const abandoned = await prisma.amazonReportRun.findMany({
    where: { reportType: SQP_REPORT_TYPE, errorMessage: { contains: 'did not reach DONE within' } },
    select: { marketplace: true, requestedAt: true, completedAt: true, errorMessage: true, reportId: true, dataStartTime: true },
    orderBy: { requestedAt: 'desc' },
  })
  const mkts = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, marketplaceId: true } })
  const codeOf = new Map(mkts.filter((m) => m.marketplaceId).map((m) => [m.marketplaceId!, m.code]))

  const targets = abandoned
    .map((r) => ({ ...r, rid: /report (\d+) did not reach DONE/.exec(r.errorMessage ?? '')?.[1] ?? null }))
    .filter((r) => r.rid)
  h('the abandoned reports — recovered from the error text, since the column is null')
  line(`abandoned rows: ${abandoned.length} · reportId present in the COLUMN: ${abandoned.filter((r) => r.reportId).length} · recoverable from the MESSAGE: ${targets.length}`)
  const ageH = (d: Date) => (Date.now() - +d) / 3_600_000
  line(`age spread: ${targets.length ? `${ageH(targets[0].requestedAt).toFixed(1)}h (newest) … ${ageH(targets[targets.length - 1].requestedAt).toFixed(1)}h (oldest)` : '—'}`)
  line('Amazon retains report metadata ~72h, so rows older than that are expected to answer 404.')

  const client = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as 'eu' | 'na' | 'fe',
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  } as any)

  h('getReport on each — metadata only, no download, no write')
  line(`${padr('requested', 15)} ${padr('mkt', 5)} ${padr('reportId', 14)} ${pad('age h', 6)}  processingStatus`)
  const tally = new Map<string, number>()
  const doneRows: Array<{ rid: string; mkt: string; requested: Date; created?: string; done?: string }> = []
  for (const t of targets) {
    let status = 'unknown'
    let extra = ''
    try {
      const res: any = await client.callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId: t.rid! } })
      status = res?.processingStatus ?? 'no-status'
      if (res?.processingStartTime && res?.processingEndTime) {
        const genMs = +new Date(res.processingEndTime) - +new Date(res.processingStartTime)
        extra = `  gen ${(genMs / 1000).toFixed(0)}s (${ts(new Date(res.processingStartTime))} → ${ts(new Date(res.processingEndTime))})`
      } else if (res?.processingStartTime) {
        extra = `  started ${ts(new Date(res.processingStartTime))}, no end time`
      }
      if (status === 'DONE') doneRows.push({ rid: t.rid!, mkt: codeOf.get(t.marketplace ?? '') ?? '?', requested: t.requestedAt, created: res?.createdTime, done: res?.processingEndTime })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status = /404|not ?found|NotFound/i.test(msg) ? 'expired (404)' : `error: ${msg.slice(0, 70)}`
    }
    tally.set(status.startsWith('error:') ? 'error' : status, (tally.get(status.startsWith('error:') ? 'error' : status) ?? 0) + 1)
    line(`${padr(ts(t.requestedAt), 15)} ${padr(codeOf.get(t.marketplace ?? '') ?? '?', 5)} ${padr(t.rid, 14)} ${pad(ageH(t.requestedAt).toFixed(1), 6)}  ${status}${extra}`)
    await sleep(600) // getReport is 2 rps / burst 15 — stay well inside it
  }

  h('VERDICT')
  line(`status tally: ${[...tally].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  const done = tally.get('DONE') ?? 0
  const parked = (tally.get('IN_QUEUE') ?? 0) + (tally.get('IN_PROGRESS') ?? 0)
  const expired = tally.get('expired (404)') ?? 0
  const fatal = (tally.get('FATAL') ?? 0) + (tally.get('CANCELLED') ?? 0)
  const answered = done + parked + fatal
  line()
  if (answered === 0) {
    line('Every id answered 404 — Amazon has already purged this metadata, so the question is')
    line('unanswerable from here. It becomes answerable by re-running this the morning after the')
    line('next zero-yield night, which is worth scheduling rather than guessing at.')
  } else {
    line(`of ${answered} reports Amazon still remembers: DONE ${done} · still generating ${parked} · FATAL/CANCELLED ${fatal} (expired ${expired})`)
    line()
    if (done > parked && done > 0) {
      line('⇒ THE REPORTS WERE MERELY SLOW. They finished; we had already stopped polling. Two')
      line('  consequences: (a) the 300s ceiling is the defect, and it sits at the p99 of every report')
      line('  that ever succeeded (279s) — i.e. it was always going to start cutting off the tail;')
      line('  (b) every abandoned reportId is a finished report we paid for and threw away.')
    } else if (parked > 0 && done === 0) {
      line('⇒ THE REPORTS NEVER FINISHED, and still have not. Raising the poll ceiling would buy')
      line('  nothing: the wait is unbounded, not merely long. The constraint is Amazon-side report')
      line('  generation for this account, and the fix has to be asynchronous — request, record the')
      line('  reportId, collect on a LATER run — not a longer wait inside one run.')
    } else {
      line('⇒ Mixed. Read the per-row statuses above before choosing a Phase B design; neither')
      line('  "raise the ceiling" nor "go async" is supported by this on its own.')
    }
    if (doneRows.length) {
      line()
      line('reports that ARE done — what Amazon says it took:')
      for (const r of doneRows.slice(0, 12)) line(`  ${padr(r.rid, 14)} ${padr(r.mkt, 4)} requested ${ts(r.requested)} · created ${r.created ? ts(new Date(r.created)) : '—'} · finished ${r.done ? ts(new Date(r.done)) : '—'}`)
    }
  }

  h('control — nothing was written')
  line(`SearchQueryPerformance rows ${await prisma.searchQueryPerformance.count()} (unchanged from 15075 if this probe wrote nothing)`)
  line(`AmazonReportRun rows ${await prisma.amazonReportRun.count()} (unchanged from 5999)`)
  line(`newest SQP period ${d10((await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate)}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
