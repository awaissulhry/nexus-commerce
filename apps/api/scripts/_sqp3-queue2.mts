/**
 * _sqp3-queue2.mts — 🔴 SQP.3 §4.2, REDONE. The first attempt did not settle it.
 *
 * The flaw: `createReport` is rate-limited at ~65 s per call, so firing four Brand Analytics reports
 * and then a Sales & Traffic one meant the BA reports had FINISHED GENERATING (18:33:20) before the
 * S&T report was even created (~18:34+). The absence of overlap therefore proves nothing — there was
 * no queue left for S&T to be behind.
 *
 * The fix: fire both types CONCURRENTLY with `Promise.all`, so both land in whatever queue exists
 * within the same second, and fire several of each so the windows have room to interleave.
 *
 *   · If BA and S&T processing windows OVERLAP → the queues are per report type.
 *   · If all six windows are strictly sequential → one account-wide queue.
 *
 * 🔴 CALLS AMAZON: 6 createReports. Writes nothing.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'
import { SQP_REPORT_TYPE, periodWindow } from '../src/services/advertising/sqp.service.js'

const OUT = join(import.meta.dirname, '_sqp3-work')
const STATE = join(OUT, 'queue2.json')
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const d10 = (d: Date) => d.toISOString().slice(0, 10)
const tms = (s?: string | null) => (s ? new Date(s).toISOString().slice(11, 23) : '—')
const mode = process.argv.find((a) => a.startsWith('--')) ?? '--collect'

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sp = getSpApiClient()
  const m = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: 'IT' } }, select: { marketplaceId: true } })
  const mid = m!.marketplaceId!

  if (mode === '--request') {
    const asins = (await prisma.searchQueryPerformance.groupBy({
      by: ['asin'], where: { marketplace: 'IT' }, _count: { _all: true },
    })).filter((a) => a.asin).sort((a, b) => b._count._all - a._count._all).slice(0, 3).map((a) => a.asin!)
    const w = periodWindow('WEEK', new Date(), 2)
    const day = d10(new Date(Date.now() - 4 * 86_400_000))

    const specs = [
      ...asins.map((asin) => ({ label: `BA-${asin}`, type: SQP_REPORT_TYPE, asin, start: d10(w.start), end: d10(w.end) })),
      ...[4, 5, 6].map((d) => {
        const dd = d10(new Date(Date.now() - d * 86_400_000))
        return { label: `ST-${dd}`, type: 'GET_SALES_AND_TRAFFIC_REPORT', asin: null as string | null, start: dd, end: dd }
      }),
    ]
    h(`firing ${specs.length} createReport calls CONCURRENTLY (3 Brand Analytics + 3 Sales & Traffic)`)
    line('🔴 Promise.all, not sequentially — the point is that both types are queued in the same second.')
    const t0 = Date.now()
    const results = await Promise.all(specs.map(async (s) => {
      try {
        const res: any = await (sp as any).callAPI({
          operation: 'createReport', endpoint: 'reports',
          body: {
            reportType: s.type, marketplaceIds: [mid],
            dataStartTime: new Date(`${s.start}T00:00:00Z`).toISOString(),
            dataEndTime: new Date(`${s.end}T23:59:59Z`).toISOString(),
            ...(s.asin ? { reportOptions: { reportPeriod: 'WEEK', asin: s.asin } } : {}),
          },
        })
        return { ...s, reportId: res?.reportId as string | undefined, atMs: Date.now() - t0 }
      } catch (e) { return { ...s, reportId: undefined, error: (e as Error).message.slice(0, 80), atMs: Date.now() - t0 } }
    }))
    for (const r of results) line(`   ${padr(r.label, 26)} +${pad(r.atMs, 6)}ms → ${r.reportId ?? `🔴 ${(r as { error?: string }).error}`}`)
    const spread = Math.max(...results.map((r) => r.atMs)) - Math.min(...results.map((r) => r.atMs))
    line(`⇒ all six createReport calls landed within ${spread} ms of each other${spread > 60_000 ? ' 🔴 — the rate limiter serialised them anyway; the test is weakened' : ' ✓'}`)
    writeFileSync(STATE, JSON.stringify(results, null, 2))
    return
  }

  if (!existsSync(STATE)) { line('no state — run --request first'); return }
  const jobs = JSON.parse(readFileSync(STATE, 'utf8')) as Array<{ label: string; type: string; reportId?: string }>
  h('processing windows, to the millisecond')
  const rows: Array<{ label: string; type: string; s: number; e: number; status: string }> = []
  line(`${padr('label', 26)} ${padr('status', 10)} ${padr('start', 14)} ${padr('end', 14)} ${pad('gen s', 6)}`)
  for (const j of jobs) {
    if (!j.reportId) continue
    try {
      const r: any = await (sp as any).callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId: j.reportId } })
      const s = r?.processingStartTime ? +new Date(r.processingStartTime) : 0
      const e = r?.processingEndTime ? +new Date(r.processingEndTime) : 0
      line(`${padr(j.label, 26)} ${padr(r?.processingStatus ?? '?', 10)} ${padr(tms(r?.processingStartTime), 14)} ${padr(tms(r?.processingEndTime), 14)} ${pad(s && e ? ((e - s) / 1000).toFixed(0) : '—', 6)}`)
      if (s && e) rows.push({ label: j.label, type: j.type, s, e, status: r.processingStatus })
    } catch (e) { line(`${padr(j.label, 26)} 🔴 ${(e as Error).message.slice(0, 50)}`) }
    await new Promise((r) => setTimeout(r, 500))
  }

  h('🔴 THE VERDICT')
  const ba = rows.filter((r) => r.type === SQP_REPORT_TYPE)
  const st = rows.filter((r) => r.type !== SQP_REPORT_TYPE)
  if (ba.length === 0 || st.length === 0) { line(`not enough completed of both types (BA ${ba.length}, S&T ${st.length}) — re-run --collect`); return }
  const overlaps: string[] = []
  for (const b of ba) for (const s of st) {
    if (b.s < s.e && s.s < b.e) overlaps.push(`${b.label} [${tms(new Date(b.s).toISOString())}–${tms(new Date(b.e).toISOString())}] ∩ ${s.label} [${tms(new Date(s.s).toISOString())}–${tms(new Date(s.e).toISOString())}]`)
  }
  // also: do same-type reports ever overlap each other? If not, serial WITHIN a type is confirmed.
  const baSelf = ba.some((a, i) => ba.some((b, j) => i !== j && a.s < b.e && b.s < a.e))
  const stSelf = st.some((a, i) => st.some((b, j) => i !== j && a.s < b.e && b.s < a.e))
  line(`Brand Analytics reports overlapping EACH OTHER: ${baSelf ? '🔴 yes — BA is not serial' : 'no — BA is serial within itself'}`)
  line(`Sales & Traffic reports overlapping EACH OTHER: ${stSelf ? '🔴 yes — S&T is not serial' : 'no — S&T is serial within itself'}`)
  line()
  if (overlaps.length) {
    line(`🔴 ${overlaps.length} CROSS-TYPE OVERLAP(S) — THE QUEUE IS PER REPORT TYPE:`)
    for (const o of overlaps.slice(0, 6)) line(`   ${o}`)
    line()
    line("⇒ SQP.2's 65 reports/day was derived from Brand Analytics reports alone and therefore bounds")
    line('  BRAND ANALYTICS, not the account. The 4.1/day "headroom" does not constrain widening.')
  } else {
    const allS = [...rows].sort((a, b) => a.s - b.s)
    const strictly = allS.every((r, i) => i === 0 || r.s >= allS[i - 1].e - 1500)
    line(strictly
      ? '⇒ NO cross-type overlap and every window is strictly sequential ⇒ ONE ACCOUNT-WIDE QUEUE.\n  SQP.2\'s 65/day bounds everything, and widening has ~4/day of headroom.'
      : '⇒ NO cross-type overlap, but the windows are not strictly sequential either — inconclusive.')
    line(`  (windows, in order: ${allS.map((r) => `${r.label}@${tms(new Date(r.s).toISOString())}`).join(' → ')})`)
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
