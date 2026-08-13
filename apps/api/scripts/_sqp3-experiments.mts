/**
 * _sqp3-experiments.mts — SQP.3 Phase A. The three unknowns, settled by experiment.
 *
 * 🔴 CALLS AMAZON. `createReport` × 5 (four Brand Analytics, one Sales & Traffic), then `getReport` /
 *    `getReportDocument`. It **writes nothing to SearchQueryPerformance** — the whole point of 4.1 is
 *    to COMPARE a fresh fetch against what is stored, and upserting first would destroy the evidence.
 *
 * ── The three questions, and the experiment each needs ────────────────────────────────────────
 *
 * **4.1 · Does re-fetching a week REVISE it?** The existing evidence points both ways and neither
 * measurement is sound: SQP.2's staged documents were byte-identical to what was stored (→ no
 * revision), while a probe of `updatedAt > ingestedAt` said 57% (→ revision). The second is
 * worthless, because Prisma's `@updatedAt` fires on every upsert-update whether a value moved or
 * not, and `ingestSqp`'s update branch writes every field every time. It measures **re-fetch**, not
 * **revision**. So: fetch the SAME (asin, week) again and compare FIELD BY FIELD against the stored
 * row. Three different week ages, one ASIN, so revision-versus-age is visible rather than inferred.
 *
 * **4.2 · Is the serial queue per report TYPE or account-wide?** SQP.2 measured it from SQP reports
 * only and concluded ~65/day for the whole account. That inference cannot distinguish "the account
 * generates one report at a time" from "Brand Analytics generates one report at a time". So: queue
 * four Brand Analytics reports, then immediately queue a Sales & Traffic report, and compare
 * `processingStartTime`/`processingEndTime`. **If the S&T window overlaps any BA window, the queue is
 * per-type and SQP's headroom is far larger than 4.1/day.**
 *
 * **4.3 · Does `SQP_LOOKBACK = 1` work?** Request the week one back (2026-08-02) rather than two
 * (2026-07-26) and see whether it returns FATAL, empty, or data — and if data, how much against the
 * same week fetched later.
 *
 * Two phases so the queue drains once for all five reports rather than serially per experiment:
 *   --request   fire the five createReports, write the ids to disk
 *   --collect   poll, download, compare, report
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'
import { parseSqp, SQP_REPORT_TYPE, periodWindow, share } from '../src/services/advertising/sqp.service.js'

const OUT = join(import.meta.dirname, '_sqp3-work')
const STATE = join(OUT, 'experiments.json')
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const d10 = (d: Date) => d.toISOString().slice(0, 10)
const ts = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(5, 19).replace('T', ' ') : '—')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mode = process.argv.find((a) => a.startsWith('--')) ?? '--find'

interface Job {
  label: string
  purpose: '4.1' | '4.2' | '4.3'
  reportType: string
  asin: string | null
  marketplace: string
  marketplaceId: string
  start: string
  end: string
  reportId?: string
  createdAtLocal?: string
}

async function marketplaceId(code: string): Promise<string> {
  const m = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code } }, select: { marketplaceId: true } })
  if (!m?.marketplaceId) throw new Error(`no marketplaceId for ${code}`)
  return m.marketplaceId
}

/**
 * The ASIN that can answer 4.1 at all: wide span AND many rows per week, so a field-by-field
 * comparison has something to compare. Sorting by span alone first picked an FR ASIN with ONE row in
 * its newest week — a span of 11 weeks and nothing to detect revision with. Ranked by newest-week
 * coverage, then by total, it picks IT B0BMSWM15B: 7 weeks at 100 rows each (the per-report cap).
 */
async function pickAsin(): Promise<{ asin: string; marketplace: string; weeks: Array<{ week: string; n: number }> }> {
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'asin', 'startDate'], _count: { _all: true },
  })
  const per = new Map<string, Array<{ week: string; n: number }>>()
  for (const r of rows) {
    if (!r.asin) continue
    const k = `${r.marketplace}|${r.asin}`
    const a = per.get(k) ?? []; a.push({ week: d10(r.startDate), n: r._count._all }); per.set(k, a)
  }
  const scored = [...per.entries()]
    .map(([k, ws]) => ({ k, ws: [...ws].sort((a, b) => b.week.localeCompare(a.week)) }))
    .filter((x) => x.ws.length >= 6)
    .sort((a, b) => b.ws[0].n - a.ws[0].n || b.ws.reduce((s, w) => s + w.n, 0) - a.ws.reduce((s, w) => s + w.n, 0))
  const best = scored[0]
  const [mkt, asin] = best.k.split('|')
  return { asin, marketplace: mkt, weeks: best.ws }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, '.gitignore'), '*\n')

  if (mode === '--find') {
    const p = await pickAsin()
    h('the ASIN the 4.1 experiment will use')
    line(`${p.asin} (${p.marketplace}) — stored in ${p.weeks.length} weeks: ${p.weeks.map((w) => `${w.week}:${w.n}`).join(' · ')}`)
    const counts = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: p.marketplace, asin: p.asin }, _count: { _all: true },
    })
    for (const c of counts.sort((a, b) => +b.startDate - +a.startDate)) line(`   ${d10(c.startDate)}: ${c._count._all} rows`)
    const now = new Date()
    h('the windows periodWindow would produce')
    for (const lb of [1, 2, 3]) {
      const w = periodWindow('WEEK', now, lb)
      line(`   lookback=${lb} → ${d10(w.start)} … ${d10(w.end)} (closed ${Math.floor((+now - +w.end) / 86_400_000)}d ago)`)
    }
    return
  }

  if (mode === '--request') {
    const p = await pickAsin()
    const mid = await marketplaceId(p.marketplace)
    const now = new Date()
    const lb1 = periodWindow('WEEK', now, 1)
    const lb2 = periodWindow('WEEK', now, 2)

    // 4.1 needs three AGES of the same ASIN, each with enough rows to compare: newest, middle, oldest.
    const stored = p.weeks.map((w) => w.week)
    const ages = [stored[0], stored[Math.floor(stored.length / 2)], stored[stored.length - 1]]
    const jobs: Job[] = ages.map((w, i) => ({
      label: `4.1-${['newest', 'mid', 'oldest'][i]}-${w}`,
      purpose: '4.1', reportType: SQP_REPORT_TYPE, asin: p.asin,
      marketplace: p.marketplace, marketplaceId: mid,
      start: w, end: d10(new Date(+new Date(`${w}T00:00:00Z`) + 6 * 86_400_000)),
    }))
    jobs.push({
      label: `4.3-lookback1-${d10(lb1.start)}`,
      purpose: '4.3', reportType: SQP_REPORT_TYPE, asin: p.asin,
      marketplace: p.marketplace, marketplaceId: mid, start: d10(lb1.start), end: d10(lb1.end),
    })
    // 4.2's probe: a DIFFERENT report type, queued LAST, so it sits behind four BA reports if the
    // queue is shared. Sales & Traffic is a report this account already pulls daily.
    jobs.push({
      label: '4.2-sales-traffic',
      purpose: '4.2', reportType: 'GET_SALES_AND_TRAFFIC_REPORT', asin: null,
      marketplace: p.marketplace, marketplaceId: mid,
      start: d10(new Date(+now - 3 * 86_400_000)), end: d10(new Date(+now - 3 * 86_400_000)),
    })

    h(`firing ${jobs.length} createReport calls (ASIN ${p.asin}, ${p.marketplace})`)
    line('🔴 order matters for 4.2: the four Brand Analytics reports go first, Sales & Traffic LAST.')
    line(`   lookback2 for reference = ${d10(lb2.start)} · lookback1 = ${d10(lb1.start)}`)
    const sp = getSpApiClient()
    for (const j of jobs) {
      try {
        const res: any = await (sp as any).callAPI({
          operation: 'createReport', endpoint: 'reports',
          body: {
            reportType: j.reportType, marketplaceIds: [j.marketplaceId],
            dataStartTime: new Date(`${j.start}T00:00:00Z`).toISOString(),
            dataEndTime: new Date(`${j.end}T23:59:59Z`).toISOString(),
            ...(j.asin ? { reportOptions: { reportPeriod: 'WEEK', asin: j.asin } } : {}),
          },
        })
        j.reportId = res?.reportId
        j.createdAtLocal = new Date().toISOString()
        line(`   ${padr(j.label, 34)} → ${j.reportId ?? 'NO ID'}`)
      } catch (e) {
        line(`   ${padr(j.label, 34)} → 🔴 ${(e as Error).message.slice(0, 90)}`)
      }
    }
    writeFileSync(STATE, JSON.stringify({ asin: p.asin, marketplace: p.marketplace, jobs }, null, 2))
    line()
    line(`state written to ${STATE}. Run --collect once the queue has drained (createReport is ~1/min, generation is serial).`)
    return
  }

  if (mode === '--collect') {
    if (!existsSync(STATE)) { line('no state — run --request first'); return }
    const st = JSON.parse(readFileSync(STATE, 'utf8')) as { asin: string; marketplace: string; jobs: Job[] }
    const sp = getSpApiClient()

    h('report status and PROCESSING WINDOWS — the 4.2 evidence')
    line(`${padr('label', 34)} ${padr('status', 12)} ${padr('processingStart', 16)} ${padr('processingEnd', 16)} ${pad('gen s', 6)}`)
    const meta: Array<{ j: Job; status: string; start?: string; end?: string; docId?: string }> = []
    for (const j of st.jobs) {
      if (!j.reportId) { line(`${padr(j.label, 34)} (never created)`); continue }
      try {
        const r: any = await (sp as any).callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId: j.reportId } })
        const gen = r?.processingStartTime && r?.processingEndTime
          ? ((+new Date(r.processingEndTime) - +new Date(r.processingStartTime)) / 1000).toFixed(0) : '—'
        line(`${padr(j.label, 34)} ${padr(r?.processingStatus ?? '?', 12)} ${padr(ts(r?.processingStartTime), 16)} ${padr(ts(r?.processingEndTime), 16)} ${pad(gen, 6)}`)
        meta.push({ j, status: r?.processingStatus ?? '?', start: r?.processingStartTime, end: r?.processingEndTime, docId: r?.reportDocumentId })
      } catch (e) {
        line(`${padr(j.label, 34)} 🔴 ${(e as Error).message.slice(0, 60)}`)
      }
      await sleep(600)
    }

    // ── 4.2 · do the two types INTERLEAVE? ────────────────────────────────────────────────────
    h('4.2 · is the queue per report TYPE, or account-wide?')
    const ba = meta.filter((m) => m.j.reportType === SQP_REPORT_TYPE && m.start && m.end)
    const st2 = meta.find((m) => m.j.purpose === '4.2' && m.start && m.end)
    if (!st2 || ba.length === 0) {
      line('not enough completed reports to judge — re-run --collect later')
    } else {
      const sAt = +new Date(st2.start!), eAt = +new Date(st2.end!)
      const overlaps = ba.filter((b) => {
        const bs = +new Date(b.start!), be = +new Date(b.end!)
        return sAt < be && bs < eAt
      })
      line(`Sales & Traffic processed ${ts(st2.start)} → ${ts(st2.end)}`)
      for (const b of ba) line(`   BA ${padr(b.j.label, 30)} ${ts(b.start)} → ${ts(b.end)}`)
      line()
      if (overlaps.length > 0) {
        line(`🔴 OVERLAP with ${overlaps.length} Brand Analytics report(s) ⇒ THE QUEUE IS PER TYPE.`)
        line('   SQP.2\'s 65/day was derived from BA reports only and therefore bounds BRAND ANALYTICS,')
        line('   not the account. The 4.1/day "headroom" figure does not apply to widening.')
      } else {
        const allBaEnd = Math.max(...ba.map((b) => +new Date(b.end!)))
        line(sAt >= allBaEnd
          ? '⇒ NO overlap, and S&T started only after every BA report finished ⇒ consistent with ONE ACCOUNT-WIDE queue.'
          : '⇒ NO overlap, but the ordering is not strictly after either — inconclusive from this sample.')
      }
    }

    // ── 4.1 · REVISION, compared field by field ───────────────────────────────────────────────
    h('4.1 · does re-fetching REVISE? Field-by-field against what is stored.')
    const FIELDS = ['searchQueryVolume', 'searchQueryRank', 'impressionsTotal', 'impressionsBrand', 'clicksTotal', 'clicksBrand', 'cartAddsTotal', 'cartAddsBrand', 'purchasesTotal', 'purchasesBrand'] as const
    for (const m of meta.filter((x) => x.j.purpose === '4.1')) {
      const ageDays = Math.floor((Date.now() - +new Date(`${m.j.start}T00:00:00Z`)) / 86_400_000)
      line()
      line(`── ${m.j.label} (week ${m.j.start}, ${ageDays}d old) · status ${m.status}`)
      if (m.status !== 'DONE' || !m.docId) { line('   not DONE yet — re-run --collect'); continue }
      let raw: string
      try {
        const doc: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: m.docId } })
        raw = typeof doc === 'string' ? doc : await (sp as any).download(doc)
      } catch (e) { line(`   🔴 document: ${(e as Error).message.slice(0, 80)}`); continue }
      let payload: unknown; try { payload = JSON.parse(raw) } catch { payload = raw }
      const fresh = parseSqp(payload)
      const stored = await prisma.searchQueryPerformance.findMany({
        where: { marketplace: m.j.marketplace, reportPeriod: 'WEEK', startDate: new Date(`${m.j.start}T00:00:00Z`), asin: m.j.asin ?? undefined },
        select: { searchQuery: true, searchQueryVolume: true, searchQueryRank: true, impressionsTotal: true, impressionsBrand: true, clicksTotal: true, clicksBrand: true, cartAddsTotal: true, cartAddsBrand: true, purchasesTotal: true, purchasesBrand: true, impressionShare: true, ingestedAt: true, updatedAt: true },
      })
      const byQ = new Map(stored.map((s) => [s.searchQuery, s]))
      line(`   fresh rows ${fresh.length} · stored rows ${stored.length}`)
      let identical = 0, differing = 0, newRows = 0
      const fieldDiffs = new Map<string, { n: number; examples: string[] }>()
      for (const f of fresh) {
        const s = byQ.get(f.searchQuery)
        if (!s) { newRows++; continue }
        let rowDiffers = false
        for (const k of FIELDS) {
          const a = (f as never as Record<string, number | null>)[k]
          const b = (s as never as Record<string, number | null>)[k]
          if (Number(a ?? 0) !== Number(b ?? 0)) {
            rowDiffers = true
            const e = fieldDiffs.get(k) ?? { n: 0, examples: [] }
            e.n++
            if (e.examples.length < 3) e.examples.push(`"${f.searchQuery.slice(0, 26)}" ${b} → ${a}`)
            fieldDiffs.set(k, e)
          }
        }
        if (rowDiffers) differing++; else identical++
      }
      const gone = stored.filter((s) => !fresh.some((f) => f.searchQuery === s.searchQuery)).length
      line(`   identical ${identical} · DIFFERING ${differing} · new in fresh ${newRows} · gone from fresh ${gone}`)
      if (fieldDiffs.size) {
        for (const [k, v] of [...fieldDiffs].sort((a, b) => b[1].n - a[1].n)) {
          line(`      ${padr(k, 20)} ${pad(v.n, 5)} rows — e.g. ${v.examples.join(' · ')}`)
        }
      } else if (fresh.length) {
        line('      ⇒ NO field differs on any matched row. This week is FROZEN at this age.')
      }
      // the timestamp illusion, for the record
      const touched = stored.filter((s) => +s.updatedAt > +s.ingestedAt + 1000).length
      line(`   (updatedAt > ingestedAt on ${touched} of ${stored.length} stored rows — that is RE-FETCH, not revision)`)
    }

    // ── 4.3 · does lookback 1 return data? ────────────────────────────────────────────────────
    h('4.3 · does SQP_LOOKBACK = 1 work?')
    const l1 = meta.find((x) => x.j.purpose === '4.3')
    if (!l1) line('no lookback-1 report')
    else {
      line(`week ${l1.j.start} · status ${l1.status}`)
      if (l1.status === 'DONE' && l1.docId) {
        try {
          const doc: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: l1.docId } })
          const raw = typeof doc === 'string' ? doc : await (sp as any).download(doc)
          let payload: unknown; try { payload = JSON.parse(raw) } catch { payload = raw }
          const rows = parseSqp(payload)
          line(`   rows returned: ${rows.length} · bytes ${Buffer.byteLength(raw)}`)
          if (rows.length === 0) {
            line('   ⇒ EMPTY. Lookback 1 is accepted by Amazon but the week is not populated yet, so')
            line('     moving the env var would buy nothing — it would ask for a week that is not there.')
          } else {
            const lb2Start = d10(periodWindow('WEEK', new Date(), 2).start)
            const lb2Rows = await prisma.searchQueryPerformance.count({ where: { marketplace: l1.j.marketplace, asin: l1.j.asin ?? undefined, startDate: new Date(`${lb2Start}T00:00:00Z`) } })
            line(`   ⇒ 🔴 DATA. ${rows.length} rows for the week one back, against ${lb2Rows} stored for ${lb2Start} (the current lookback-2 target) for this ASIN.`)
            line('     Lookback 1 is available: seven days of freshness for one env var.')
            const vol = rows.reduce((a, r) => a + r.impressionsTotal, 0)
            line(`     total market impressions in the fresh week: ${vol}`)
          }
        } catch (e) { line(`   🔴 document: ${(e as Error).message.slice(0, 90)}`) }
      } else if (l1.status === 'FATAL' || l1.status === 'CANCELLED') {
        line(`   ⇒ ${l1.status}. Amazon refuses the week one back, so lookback 2 is not conservatism — it is required.`)
      } else {
        line(`   ⇒ still ${l1.status}; re-run --collect`)
      }
    }

    h('control — nothing was written to SearchQueryPerformance')
    line(`SearchQueryPerformance rows: ${await prisma.searchQueryPerformance.count()}`)
    line(`newest stored week: ${d10((await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate!)}`)
    line('(this script only reads reports and compares; the upsert path is never called)')
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
