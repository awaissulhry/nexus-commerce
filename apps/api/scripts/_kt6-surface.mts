/**
 * _kt6-surface.mts — KT.6's measurement. READ-ONLY, no Amazon call, no write.
 *
 * Everything KT.6 designs against, measured before anything is built:
 *   §6  the stop conditions — is it still safe to build this at all?
 *   §2.1 what a row can reach: terms, unbid, targets behind them, and how many are writable
 *   §2.2 the write gate's real shape, per market
 *   §2.3/§4 which ceiling fields exist, which are populated, and WHAT IS REFUSING WRITES TODAY
 *   §3.1 for an unbid term, is there a plausible destination the page could name?
 *
 * 🔴 The refusal count is the one number this programme has already got wrong twice (693,704 vs
 *    46,298, "in different tables and neither confirmed"), so it is measured three ways and the
 *    null branch is spelled out. A `NOT: { errorMessage: 'X' }` in Prisma may or may not include
 *    rows where errorMessage IS NULL — that is a property of the generated SQL, not of my opinion,
 *    so it is tested by running both forms and comparing.
 *
 * Run:
 *   cd apps/api && NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run --service "@nexus/api" \
 *     env -u REDIS_URL npx tsx scripts/_kt6-surface.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { graduationCeiling } from '../src/services/advertising/ads-graduation.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

async function main() {
  // ── §6 · the stop conditions ─────────────────────────────────────────────────────────────────
  h('§6 · STOP CONDITIONS — is KT.6 still safe to build?')
  const targets = await prisma.rankTarget.findMany({ select: { key: true, maxBiasPct: true, biasPct: true, allOut: true } })
  const withBias = targets.filter((t) => t.maxBiasPct != null)
  line(`1 · RankTarget.maxBiasPct set on ${withBias.length} of ${targets.length} — ${withBias.length === 0 ? '✓ still NULL everywhere; the rank engine cannot chase' : `🔴 SET on ${withBias.map((t) => t.key).join(',')} — a bid engine may be live; STOP`}`)
  const mode = process.env.NEXUS_COVERAGE_ENGINE_MODE
  line(`2 · NEXUS_COVERAGE_ENGINE_MODE = ${mode === undefined ? 'unset ✓' : `🔴 "${mode}" — STOP`}`)
  const campaigns = await prisma.campaign.findMany({
    select: {
      id: true, name: true, marketplace: true, status: true,
      liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true,
      pinBids: true, pinBudget: true, pinPlacement: true, targetAcosPct: true,
      dailyBudget: true, spend: true,
    },
  })
  const writable = campaigns.filter((c) => c.liveBidWritesEnabled)
  line(`3 · liveBidWritesEnabled = ${writable.length} of ${campaigns.length} — ${writable.length === 82 ? '✓ unchanged at 82' : `🔴 CHANGED (was 82) — the guardrail picture moved; report`}`)
  const withMin = campaigns.filter((c) => c.minBidCents != null)
  const withMax = campaigns.filter((c) => c.maxBidCents != null)
  line(`    minBidCents set on ${withMin.length} of ${campaigns.length} ${withMin.length === 0 ? '✓ (no floor anywhere — KT.6 must supply its own)' : '🔴 CHANGED — a floor now exists; report'}`)
  line(`    maxBidCents set on ${withMax.length} · exactly the writable set? ${withMax.length === writable.length && withMax.every((c) => c.liveBidWritesEnabled) ? '✓ yes' : '🔴 no — check'}`)
  const pins = campaigns.filter((c) => c.pinBids || c.pinBudget || c.pinPlacement)
  line(`    authority pins on ${pins.length} of ${campaigns.length} ${pins.length === 0 ? '✓ none' : '🔴 pins exist now — they deny before bounds; report'}`)
  line(`    targetAcosPct set on ${campaigns.filter((c) => c.targetAcosPct != null).length}`)

  // ── §2.2 · the write gate per market ─────────────────────────────────────────────────────────
  h('§2.2 · the write gate, per market')
  line(`${padr('mkt', 5)} ${pad('campaigns', 10)} ${pad('writable', 9)} ${pad('%', 5)} ${pad('maxBid range', 18)}`)
  for (const m of MARKETS) {
    const cs = campaigns.filter((c) => c.marketplace === m)
    const w = cs.filter((c) => c.liveBidWritesEnabled)
    const caps = w.map((c) => c.maxBidCents).filter((x): x is number => x != null)
    line(`${padr(m, 5)} ${pad(cs.length, 10)} ${pad(w.length, 9)} ${pad(cs.length ? `${Math.round((w.length / cs.length) * 100)}%` : '—', 5)} ${pad(caps.length ? `${eur(Math.min(...caps))}–${eur(Math.max(...caps))}` : 'none', 18)}`)
  }
  const other = [...new Set(campaigns.map((c) => c.marketplace))].filter((m) => !MARKETS.includes(m as never))
  if (other.length) line(`(other markets present: ${other.join(', ')})`)

  // ── §2.1 · the action surface ────────────────────────────────────────────────────────────────
  h('§2.1 · what a row can reach — terms, targets, and how many are WRITABLE')
  const watchlists = await prisma.keywordWatchlist.findMany({
    select: { marketplace: true, isDefault: true, terms: { select: { term: true, isBranded: true } } },
  })
  const termsFor = (m: string) => {
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    return (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
  }
  const campById = new Map(campaigns.map((c) => [c.id, c]))

  // 🔴 isNegative, NOT expressionType — and expressionType is normalised at read time because two
  // crons rewrite it (~65 rows/min), so a single-spelling filter loses rows.
  const allTargets = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: {
      id: true, expressionValue: true, expressionType: true, bidCents: true, status: true,
      adGroupId: true, adGroup: { select: { id: true, name: true, campaignId: true } },
    },
  })
  line(`positive KEYWORD AdTargets in the account: ${allTargets.length}`)
  line(`expressionType spellings present: ${[...new Set(allTargets.map((t) => t.expressionType))].sort().join(', ')}`)
  line()
  line(`${padr('mkt', 5)} ${pad('terms', 6)} ${pad('unbid', 6)} ${pad('targets', 8)} ${pad('writable', 9)} ${pad('%', 5)}  widest row`)
  const perMarket = new Map<string, { terms: string[]; byTerm: Map<string, typeof allTargets> }>()
  for (const m of MARKETS) {
    const terms = termsFor(m)
    const byTerm = new Map<string, typeof allTargets>()
    for (const t of allTargets) {
      const c = t.adGroup ? campById.get(t.adGroup.campaignId) : null
      if (!c || c.marketplace !== m) continue
      const k = norm(t.expressionValue)
      if (!terms.includes(k)) continue
      const arr = byTerm.get(k) ?? []; arr.push(t); byTerm.set(k, arr)
    }
    perMarket.set(m, { terms, byTerm })
    const total = [...byTerm.values()].reduce((a, v) => a + v.length, 0)
    const writ = [...byTerm.values()].flat().filter((t) => campById.get(t.adGroup!.campaignId)?.liveBidWritesEnabled).length
    const unbid = terms.filter((t) => !byTerm.has(t)).length
    const widest = [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    const wCamps = widest ? new Set(widest[1].map((t) => t.adGroup!.campaignId)).size : 0
    const wWrit = widest ? widest[1].filter((t) => campById.get(t.adGroup!.campaignId)?.liveBidWritesEnabled).length : 0
    line(`${padr(m, 5)} ${pad(terms.length, 6)} ${pad(unbid, 6)} ${pad(total, 8)} ${pad(writ, 9)} ${pad(total ? `${Math.round((writ / total) * 100)}%` : '—', 5)}  ${widest ? `${widest[0]} — ${wCamps} campaigns · ${widest[1].length} targets · ${wWrit} writable` : '—'}`)
  }

  h('§6.5 · the widest row in detail — the case every control must survive')
  const it = perMarket.get('IT')!
  const gm = it.byTerm.get('giacca moto') ?? []
  const gmCamps = new Set(gm.map((t) => t.adGroup!.campaignId))
  const gmWrit = gm.filter((t) => campById.get(t.adGroup!.campaignId)?.liveBidWritesEnabled)
  const gmWritCamps = new Set(gmWrit.map((t) => t.adGroup!.campaignId))
  line(`"giacca moto": ${gm.length} targets · ${gmCamps.size} campaigns · ${gmWrit.length} writable in ${gmWritCamps.size} campaigns`)
  line(gm.length === 100 && gmCamps.size === 53 ? '✓ unchanged at 100 targets / 53 campaigns' : `🔴 CHANGED from 100/53 — report before designing`)
  const bids = gmWrit.map((t) => t.bidCents).filter((x): x is number => x != null)
  line(`writable bids: ${bids.length} with a bid · range ${eur(Math.min(...bids))}–${eur(Math.max(...bids))} · states ${[...new Set(gmWrit.map((t) => t.status))].join(',')}`)
  const gmCapped = [...gmWritCamps].map((id) => campById.get(id)!).filter((c) => c.maxBidCents != null)
  line(`writable campaigns with a maxBidCents: ${gmCapped.length} of ${gmWritCamps.size} · ceilings ${[...new Set(gmCapped.map((c) => eur(c.maxBidCents)))].sort().join(', ')}`)

  // ── §3.1 · an unbid term — is there a destination to name? ───────────────────────────────────
  h('§3.1 · an unbid term — could the page name a destination, or must it hand off?')
  const unbidIT = it.terms.filter((t) => !it.byTerm.has(t))
  line(`IT unbid watched terms: ${unbidIT.length} of ${it.terms.length}`)
  const sample = unbidIT.slice(0, 5)
  const itCampIds = campaigns.filter((c) => c.marketplace === 'IT' && c.liveBidWritesEnabled).map((c) => c.id)
  const itGroups = await prisma.adGroup.findMany({
    where: { campaignId: { in: itCampIds } },
    select: { id: true, name: true, campaignId: true, targetingType: true, defaultBidCents: true },
  })
  line(`writable IT campaigns: ${itCampIds.length} · ad groups in them: ${itGroups.length}`)
  const manualGroups = itGroups.filter((g) => g.targetingType !== 'AUTO')
  line(`  of those, MANUAL ad groups (a keyword can be added): ${manualGroups.length}`)
  line(`  targetingType values present: ${[...new Set(itGroups.map((g) => g.targetingType))].join(', ')}`)
  line()
  line('🔴 The question is whether ONE destination is derivable, or whether the operator must pick.')
  line(`   ${manualGroups.length} candidate ad groups for a new keyword in writable IT campaigns.`)
  line(manualGroups.length > 1
    ? `   ⇒ ${manualGroups.length} candidates means NO single destination is derivable. KT.6 must either make the\n     operator choose or hand off — it must not invent one. (HV.3 measured the same thing for\n     harvest: unique for 13% of sources, median 5 candidates.)`
    : '   ⇒ a single destination exists')

  // ── §2.3 / §4 · ceilings: what exists, what is populated ────────────────────────────────────
  h('§2.3 · the spend ceiling — what exists today')
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: {
      id: true, name: true, enabled: true, autonomyLevel: true, actions: true, trigger: true,
      maxDailyAdSpendCentsEur: true, maxValueCentsEur: true, maxExecutionsPerDay: true,
      scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    },
  })
  line(`ADVERTISING rules: ${rules.length}`)
  line(`  with maxDailyAdSpendCentsEur : ${rules.filter((r) => r.maxDailyAdSpendCentsEur != null).length}`)
  line(`  with maxValueCentsEur        : ${rules.filter((r) => r.maxValueCentsEur != null).length}`)
  line(`  with scopeMarketplace        : ${rules.filter((r) => r.scopeMarketplace).length}`)
  line(`  with scopePortfolioId        : ${rules.filter((r) => r.scopePortfolioId).length}`)
  line(`  with scopeCampaignId         : ${rules.filter((r) => r.scopeCampaignId).length}`)
  line(`  with scopeProductId          : ${rules.filter((r) => r.scopeProductId).length}`)
  line()
  line('⇒ the ceiling exists per RULE. There is no per-SCOPE ceiling object anywhere:')
  line('  a market/line/portfolio/campaign cap cannot be expressed today at all.')

  // Campaign-level spend fields that DO exist
  const withBudget = campaigns.filter((c) => c.dailyBudget != null)
  line()
  line(`Campaign.dailyBudget set on ${withBudget.length} of ${campaigns.length} (that is Amazon's budget, not a nexus ceiling)`)
  line(`Campaign.spend populated on ${campaigns.filter((c) => Number(c.spend) > 0).length} — 🔴 an UNLABELLED 30-day window, not today's spend`)

  // ── §4.2 · what is refusing writes today — measured three ways ───────────────────────────────
  h('§4.2 · 🔴 what is actually refusing, and the null branch spelled out')
  const since = new Date(Date.now() - 60 * 86_400_000)
  const totalExec = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } })
  const capExec = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
  const nullErr = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: null } })
  const otherErr = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: { not: null }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
  line(`AutomationRuleExecution rows in the last 60 days: ${totalExec}`)
  line(`  errorMessage = 'DAILY_CAP_EXCEEDED' : ${capExec}`)
  line(`  errorMessage IS NULL                : ${nullErr}`)
  line(`  some other errorMessage             : ${otherErr}`)
  line(`  ⇒ sum ${capExec + nullErr + otherErr} vs total ${totalExec} ${capExec + nullErr + otherErr === totalExec ? '✓ accounts for every row' : '🔴 does not add up'}`)
  line()
  // The exact predicate the cap uses, vs the one it probably meant.
  const asWritten = await prisma.automationRuleExecution.count({
    where: { startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } },
  })
  const asIntended = await prisma.automationRuleExecution.count({
    where: { startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
  })
  line(`🔴 THE NULL BRANCH, tested rather than assumed (automation-rule.service.ts:573):`)
  line(`   count(NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' })                    = ${asWritten}`)
  line(`   count(OR: [{ errorMessage: null }, { not: 'DAILY_CAP_EXCEEDED' }])    = ${asIntended}`)
  line(`   rows with a NULL errorMessage                                          = ${nullErr}`)
  line(asWritten === asIntended
    ? `   ⇒ IDENTICAL: Prisma's NOT includes NULL rows, so the cap counts successes. No bug here.`
    : `   ⇒ 🔴 THEY DIFFER by ${asIntended - asWritten}. Prisma's NOT EXCLUDES null-errorMessage rows, so\n     maxExecutionsPerDay counts only ERRORED executions and effectively never trips on success.\n     That is a real defect in the cap, found by spelling out the branch.`)
  line()
  // Is there any OTHER refusal record? The gate's own deny tag.
  const skipped = await prisma.outboundSyncQueue.count({ where: { createdAt: { gte: since }, syncStatus: 'SKIPPED' } })
  const gateDeny = await prisma.outboundSyncQueue.count({ where: { createdAt: { gte: since }, errorMessage: { contains: 'ADS-WRITE-GATE-DENY' } } })
  line(`OutboundSyncQueue in 60d: SKIPPED ${skipped} · carrying an ADS-WRITE-GATE-DENY tag ${gateDeny}`)
  const byStatus = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { createdAt: { gte: since } }, _count: { _all: true } })
  line(`  by status: ${byStatus.map((s) => `${s.syncStatus}=${s._count._all}`).join(' · ')}`)
  line()
  line('⇒ Name the table when quoting a refusal count. DAILY_CAP_EXCEEDED lives in')
  line('  AutomationRuleExecution.errorMessage and is an EXECUTION-COUNT cap, not a spend cap.')
  line('  The write gate\'s own denials are on OutboundSyncQueue, tagged in errorMessage.')

  // ── the graduation ceiling for KT.6's two actions ────────────────────────────────────────────
  h('D1 · the ceiling for KT.6\'s two actions, from the real graduationCeiling()')
  const protections = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
  for (const [label, acts] of [
    ['bid change (bid_up / bid_down / lower_bid_to_floor)', ['bid_up', 'bid_down', 'lower_bid_to_floor']],
    ['create a keyword (promote_to_exact)', ['promote_to_exact']],
    ['both together', ['bid_down', 'promote_to_exact']],
  ] as Array<[string, string[]]>) {
    const v = graduationCeiling({ actionTypes: acts, hasKeywordProtections: protections > 0 })
    line(`${padr(label, 52)} → ${padr(v.maxLevel, 8)} ${v.reason}`)
  }
  line(`(protected terms configured: ${protections})`)

  // ── control ──────────────────────────────────────────────────────────────────────────────────
  h('control — prove the zeros are measurements')
  line(`Campaign ${campaigns.length} · AdTarget positive keywords ${allTargets.length} · AdGroup(IT writable) ${itGroups.length}`)
  line(`KeywordWatchlist ${watchlists.length} · terms ${watchlists.reduce((a, w) => a + w.terms.length, 0)}`)
  line(`AutomationRule(ADVERTISING) ${rules.length} · AutomationRuleExecution(60d) ${totalExec} · OutboundSyncQueue(60d) ${byStatus.reduce((a, s) => a + s._count._all, 0)}`)
  // wrong-field control: this must THROW, proving the query layer is live
  try {
    await (prisma.campaign as never as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({ select: { maxHourlySpendCentsEur: true } })
    line('🔴 Campaign.maxHourlySpendCentsEur SELECTED WITHOUT ERROR — the field exists after all; re-read')
  } catch (e) {
    line(`✓ wrong-field control threw as expected (Campaign.maxHourlySpendCentsEur does not exist): ${String(e).slice(0, 90).replace(/\n/g, ' ')}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
