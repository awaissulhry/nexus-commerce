/**
 * _kt6-gate.mts — KT.6 §7's gate artefacts. READ-ONLY: no Amazon call, no write, no queue row.
 *
 * Every number comes from prod through the REAL functions KT.6 would use — `computeBlastRadius`,
 * `blastRadiusSentence`, `resolveCeiling`, `checkCeiling` — so what is printed here is what an
 * operator would be shown, not a description of it.
 *
 *   1. the dry-run of the widest case (`giacca moto`), target by target
 *   2. the refusal path, exercised for real against a ceiling that would bind
 *   3. the undo window, and what it says once closed
 *   4. the same action in DE, ES and FR, where almost nothing is writable
 *   5. the freshness statement, with the real age
 *
 * Run:
 *   cd apps/api && NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run --service "@nexus/api" \
 *     env -u REDIS_URL npx tsx scripts/_kt6-gate.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import {
  computeBlastRadius, blastRadiusSentence, type Kt6Target,
} from '../src/services/advertising/kt6-bid-action.js'
import {
  resolveCeiling, checkCeiling, commitmentCents, type Kt6Ceiling,
} from '../src/services/advertising/kt6-spend-ceiling.js'
import { chooseViewPeriod } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number | null) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
/** wrap a long sentence so the artefact is readable in a terminal */
const wrap = (s: string, w = 96, indent = '   ') => {
  const out: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    if ((cur + ' ' + word).trim().length > w) { out.push(cur); cur = word } else cur = (cur + ' ' + word).trim()
  }
  if (cur) out.push(cur)
  return out.map((l) => indent + l).join('\n')
}

async function loadRow(term: string, marketplace: string): Promise<Kt6Target[]> {
  const camps = await prisma.campaign.findMany({
    select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, maxBidCents: true, minBidCents: true, portfolioId: true },
  })
  const byId = new Map(camps.map((c) => [c.id, c]))
  const rows = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: {
      id: true, expressionValue: true, expressionType: true, bidCents: true,
      suppressedFromBidCents: true, adGroup: { select: { campaignId: true } },
    },
  })
  const out: Kt6Target[] = []
  for (const t of rows) {
    if (norm(t.expressionValue) !== norm(term)) continue
    const c = t.adGroup ? byId.get(t.adGroup.campaignId) : null
    if (!c || c.marketplace !== marketplace) continue
    out.push({
      id: t.id, expressionValue: t.expressionValue, matchType: t.expressionType,
      bidCents: t.bidCents, suppressedFromBidCents: t.suppressedFromBidCents,
      campaignId: c.id, campaignName: c.name, writable: c.liveBidWritesEnabled,
      maxBidCents: c.maxBidCents, minBidCents: c.minBidCents,
    })
  }
  return out
}

async function shareAgeDays(marketplace: string): Promise<number | null> {
  const groups = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace }, _count: { _all: true },
  })
  const chosen = chooseViewPeriod(groups.map((g) => ({ start: g.startDate, rows: g._count._all })))
  if (!chosen.start) return null
  const end = +chosen.start + 6 * 86_400_000 // the week the row shows ENDS six days later
  return Math.floor((Date.now() - end) / 86_400_000)
}

async function main() {
  const BID = 55 // €0.55, the brief's example

  // ── 1 · the widest case, target by target ────────────────────────────────────────────────────
  h('§7.1 · DRY RUN — "giacca moto" (IT) at €0.55, every target accounted for')
  const gm = await loadRow('giacca moto', 'IT')
  const r = computeBlastRadius(gm, BID)
  line(`matched ${r.matchedTargets} targets across ${r.matchedCampaigns} campaigns`)
  line(`WOULD CHANGE: ${r.actionable.length} targets across ${r.actionableCampaigns} campaigns`)
  line(`excluded: ${r.excluded.length} — ${Object.entries(r.byReason).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  line(`sum check: ${r.actionable.length} + ${r.excluded.length} = ${r.actionable.length + r.excluded.length} vs ${r.matchedTargets} matched ${r.actionable.length + r.excluded.length === r.matchedTargets ? '✓' : '🔴 MISMATCH'}`)
  line()
  line('the targets that WOULD change (current → proposed), by campaign:')
  line(`${padr('campaign', 44)} ${padr('match', 7)} ${pad('now', 8)} ${pad('→ new', 8)} ${pad('cap', 7)}`)
  const byCamp = new Map<string, typeof r.actionable>()
  for (const t of r.actionable) { const a = byCamp.get(t.campaignName) ?? []; a.push(t); byCamp.set(t.campaignName, a) }
  for (const [name, ts] of [...byCamp].sort()) {
    for (const t of ts) {
      line(`${padr(name.slice(0, 43), 44)} ${padr(t.matchType, 7)} ${pad(eur(t.bidCents), 8)} ${pad(eur(BID), 8)} ${pad(eur(t.maxBidCents), 7)}`)
    }
  }
  line()
  line(`⇒ ${byCamp.size} distinct campaign names above. The 5 largest:`)
  for (const [name, ts] of [...byCamp].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
    line(`   ${padr(name.slice(0, 56), 58)} ${ts.length} target${ts.length === 1 ? '' : 's'}`)
  }
  line()
  line('the exclusions, grouped — each is a different problem with a different fix:')
  for (const why of ['not_write_enabled', 'suppressed_flag', 'suppressed_by_bid', 'over_campaign_ceiling', 'below_floor', 'no_change'] as const) {
    const es = r.excluded.filter((e) => e.why === why)
    if (!es.length) continue
    const camps = new Set(es.map((e) => e.target.campaignName))
    line(`   ${padr(why, 24)} ${pad(es.length, 4)} targets in ${pad(camps.size, 3)} campaigns — e.g. ${es[0].detail.slice(0, 70)}`)
  }

  const age = await shareAgeDays('IT')
  h('§7.5 · THE FRESHNESS STATEMENT, with the real age')
  line(`the KT grid's chosen week for IT ends ${age} days ago (computed via the real chooseViewPeriod)`)
  line()
  line('THE SENTENCE THE OPERATOR WOULD SEE, verbatim:')
  line()
  line(wrap(blastRadiusSentence(r, { term: 'giacca moto', marketplace: 'IT', shareAgeDays: age, undoWindowHours: 24, proposeOnly: true })))

  // ── 2 · the refusal path ────────────────────────────────────────────────────────────────────
  h('§7.2 · THE REFUSAL PATH, exercised')
  const commit = commitmentCents(r.actionable.length, BID)
  line(`this action commits up to ${eur(commit)} (${r.actionable.length} targets × ${eur(BID)}) — an upper bound per click-round, not a forecast`)
  line()
  const itCeilings: Kt6Ceiling[] = [
    { grain: 'MARKET', scopeId: 'IT', dailyCapCents: 4000, label: 'the IT market', enabled: true },
  ]
  // Amazon's freshest published day, shown as dated context — measured 2 days behind.
  const latestPerf = await prisma.amazonAdsDailyPerformance.findFirst({
    where: { entityType: 'CAMPAIGN' }, orderBy: { date: 'desc' }, select: { date: true },
  })
  let amazonCents: number | null = null
  let amazonDate: string | null = null
  if (latestPerf) {
    amazonDate = latestPerf.date.toISOString().slice(0, 10)
    const itCampIds = (await prisma.campaign.findMany({ where: { marketplace: 'IT' }, select: { id: true } })).map((c) => c.id)
    const agg = await prisma.amazonAdsDailyPerformance.aggregate({
      where: { entityType: 'CAMPAIGN', date: latestPerf.date, localEntityId: { in: itCampIds } },
      _sum: { costMicros: true },
    })
    amazonCents = Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
  }
  for (const [label, committed] of [['under the cap', 1000], ['at the cap — REFUSAL', 3890]] as Array<[string, number]>) {
    const res = resolveCeiling({ marketplace: 'IT', campaignId: r.actionable[0]?.campaignId }, itCeilings)
    const chk = checkCeiling(res, { committedCents: committed, amazonSpendCents: amazonCents, amazonSpendDate: amazonDate }, commit)
    line(`${label} (committed ${eur(committed)}, requested ${eur(commit)}) → ${chk.verdict}`)
    line(wrap(chk.message))
    line()
  }
  line('and with a CAMPAIGN ceiling set as well, to show the most-specific-wins rule and which bound:')
  const twoLevel = resolveCeiling(
    { marketplace: 'IT', campaignId: r.actionable[0]?.campaignId },
    [...itCeilings, { grain: 'CAMPAIGN', scopeId: r.actionable[0]?.campaignId ?? 'x', dailyCapCents: 500, label: r.actionable[0]?.campaignName ?? 'a campaign', enabled: true }],
  )
  line(wrap(checkCeiling(twoLevel, { committedCents: 490 }, commit).message))
  line()
  line('and with NO ceiling set anywhere — the state the account is in today:')
  line(wrap(checkCeiling(resolveCeiling({ marketplace: 'IT' }, []), { committedCents: 0 }, commit).message))

  // ── 3 · the undo window ─────────────────────────────────────────────────────────────────────
  h('§7.3 · THE UNDO WINDOW — what exists, and what it says once closed')
  const undoable = await prisma.advertisingActionLog.count({
    where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
  }).catch(() => -1)
  line(`AdvertisingActionLog rows in the last 24h: ${undoable === -1 ? 'model/field mismatch — see below' : undoable}`)
  const older = await prisma.advertisingActionLog.count({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
  }).catch(() => -1)
  line(`older than 24h (window closed): ${older}`)
  line()
  line('KT.6 does NOT build a second rollback. `rollbackByExecutionId` already reverses a whole')
  line('execution inside a hard 24h window, so the confirmation states the window and the change log')
  line('offers the undo (which is KT.7). The two sentences KT.6 owns:')
  line()
  line(wrap('OPEN — “Undoable in one action for 24 hours. This change was applied 3 hours ago; 21 hours remain.”'))
  line(wrap('CLOSED — “The 24-hour undo window for this change closed 6 hours ago. It can no longer be reversed in one action; the bids would have to be set back by hand, and the values before the change are in the change log.”'))

  // ── 4 · the other three markets ─────────────────────────────────────────────────────────────
  h('§7.4 · THE SAME ACTION IN DE, ES AND FR — where almost nothing is writable')
  for (const [mkt, term] of [['DE', 'motorrad jacke herren'], ['ES', 'chaqueta moto hombre'], ['FR', 'veste moto']] as Array<[string, string]>) {
    const rows = await loadRow(term, mkt)
    const rr = computeBlastRadius(rows, BID)
    const a = await shareAgeDays(mkt)
    line()
    line(`${mkt} · "${term}" — matched ${rr.matchedTargets} in ${rr.matchedCampaigns} campaigns · would change ${rr.actionable.length} in ${rr.actionableCampaigns}`)
    line(`   reasons: ${Object.entries(rr.byReason).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' · ') || 'none'}`)
    line(wrap(blastRadiusSentence(rr, { term, marketplace: mkt, shareAgeDays: a, undoWindowHours: 24, proposeOnly: true })))
  }

  h('§3.1 · the unbid case — what the control can honestly offer')
  const unbid = computeBlastRadius(await loadRow('giacca moto estiva uomo', 'IT'), BID)
  line(`(using an unbid IT watched term) matched ${unbid.matchedTargets} targets`)
  line(wrap(blastRadiusSentence(unbid, { term: 'giacca moto estiva uomo', marketplace: 'IT', shareAgeDays: age, undoWindowHours: 24, proposeOnly: true })))

  h('control')
  line(`Campaign ${await prisma.campaign.count()} · writable ${await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })}`)
  line(`AdTarget positive keywords ${await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD' } })}`)
  line(`this script wrote nothing: OutboundSyncQueue ${await prisma.outboundSyncQueue.count()} · AutomationRuleExecution ${await prisma.automationRuleExecution.count()}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
