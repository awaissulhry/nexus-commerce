/**
 * _kt-verify-kt6.mts — verify SQP.2's load-bearing claim, and measure what KT.6 may write to.
 *
 *   A. Is maxBiasPct really null on all five RankTargets? (SQP.2 says the IS branch is unreachable
 *      for 0 of 45 campaigns, which dissolves the blast radius two prompts were built around.)
 *   B. The write gate: how many campaigns can a rule actually touch, and what guardrails are set?
 *   C. The KT page's own action surface: the 64 unbid IT terms, and the blast radius of the widest
 *      bid action (giacca moto = 53 campaigns).
 *   D. What a Keyword Tracker rule can carry today — scope and spend ceiling.
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-kt6.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }

async function main() {
  // ── A · the band ─────────────────────────────────────────────────────────
  h('A · RankTarget.maxBiasPct — is the impression-share branch reachable at all?')
  const targets = await prisma.rankTarget.findMany()
  line(`RankTarget rows: ${targets.length}`)
  for (const t of targets) {
    const rec = t as unknown as Record<string, unknown>
    const keys = Object.keys(rec).filter((k) => /bias|max|target|cap|cpc|allout/i.test(k))
    line(`  ${String(rec.key ?? rec.id)}: ${keys.map((k) => `${k}=${rec[k] === null ? 'NULL' : String(rec[k])}`).join(' · ')}`)
  }
  const nullBias = targets.filter((t) => (t as unknown as Record<string, unknown>).maxBiasPct == null).length
  line(`maxBiasPct NULL on ${nullBias} of ${targets.length} RankTargets`)

  const groups = await prisma.rankScheduleGroup.findMany({ select: { id: true, name: true, enabled: true, marketplace: true } })
  line(`RankScheduleGroup: ${groups.length} (enabled ${groups.filter((g) => g.enabled).length})`)
  const scheds = await prisma.adSchedule.count()
  const schedEnabled = await prisma.adSchedule.count({ where: { enabled: true } })
  line(`AdSchedule rows: ${scheds} (enabled ${schedEnabled})`)

  // ── B · the write gate ───────────────────────────────────────────────────
  h('B · The write gate — what can a rule actually touch?')
  const campTotal = await prisma.campaign.count()
  const campActive = await prisma.campaign.count({ where: { status: { not: 'ARCHIVED' } } })
  line(`Campaign rows: ${campTotal} (non-archived ${campActive})`)
  for (const f of ['liveBidWritesEnabled', 'pinBids', 'pinBudget', 'pinPlacement'] as const) {
    try {
      const on = await prisma.campaign.count({ where: { [f]: true } as never })
      line(`  ${f} = true on ${on} of ${campTotal}`)
    } catch (e) { line(`  ${f}: FIELD MISSING (${(e as Error).message.slice(0, 60)})`) }
  }
  for (const f of ['minBidCents', 'maxBidCents', 'targetAcosPct', 'maxHourlySpendCentsEur'] as const) {
    try {
      const set = await prisma.campaign.count({ where: { [f]: { not: null } } as never })
      line(`  ${f} set on ${set} of ${campTotal}`)
    } catch (e) { line(`  ${f}: FIELD MISSING (${(e as Error).message.slice(0, 60)})`) }
  }
  const byMkt = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true }, where: { liveBidWritesEnabled: true } as never }).catch(() => null)
  if (byMkt) line(`  writable by market: ${byMkt.map((r) => `${r.marketplace}=${r._count._all}`).sort().join(' · ')}`)

  // ── C · the action surface ───────────────────────────────────────────────
  h('C · What the Keyword Tracker could act on')
  const wl = await (prisma as unknown as {
    keywordWatchlist: { findMany: (a: unknown) => Promise<Array<{ marketplace: string; name: string; isDefault: boolean; terms: Array<{ term: string; isBranded: boolean }> }>> }
  }).keywordWatchlist.findMany({ include: { terms: true } })
  const tg = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false },
    select: { expressionValue: true, expressionType: true, bidCents: true, status: true, adGroupId: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true, liveBidWritesEnabled: true, status: true } } } } },
    take: 6000,
  })
  for (const w of wl) {
    if (!w.isDefault) continue
    const terms = w.terms.filter((t) => !t.isBranded).map((t) => t.term.trim().toLowerCase())
    let unbid = 0, bidTerms = 0, targetsTotal = 0, writableTargets = 0
    let widest = { term: '', camps: 0, targets: 0, writable: 0 }
    for (const t of terms) {
      const mine = tg.filter((x) => (x.expressionValue ?? '').trim().toLowerCase() === t && x.adGroup?.campaign?.marketplace === w.marketplace)
      if (!mine.length) { unbid++; continue }
      bidTerms++
      targetsTotal += mine.length
      const wr = mine.filter((x) => x.adGroup?.campaign?.liveBidWritesEnabled)
      writableTargets += wr.length
      const camps = new Set(mine.map((x) => x.adGroup?.campaign?.id)).size
      if (camps > widest.camps) widest = { term: t, camps, targets: mine.length, writable: wr.length }
    }
    line(`${w.marketplace} "${w.name}": ${terms.length} terms · unbid ${unbid} · bid ${bidTerms}`)
    line(`    keyword targets behind them: ${targetsTotal} · in write-gated campaigns: ${writableTargets} (${targetsTotal ? Math.round((writableTargets / targetsTotal) * 100) : 0}%)`)
    if (widest.camps) line(`    widest blast radius: "${widest.term}" — ${widest.camps} campaigns · ${widest.targets} targets · ${widest.writable} of them writable`)
  }

  // ── D · what a KT rule can carry ─────────────────────────────────────────
  h('D · Scope + spend ceiling on an advertising rule today')
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: { id: true, name: true, trigger: true, enabled: true, autonomyLevel: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, maxDailyAdSpendCentsEur: true },
  })
  line(`advertising rules: ${rules.length}`)
  line(`  with scopeMarketplace: ${rules.filter((r) => r.scopeMarketplace).length} · portfolio: ${rules.filter((r) => r.scopePortfolioId).length} · campaign: ${rules.filter((r) => r.scopeCampaignId).length} · product: ${rules.filter((r) => r.scopeProductId).length}`)
  line(`  with maxDailyAdSpendCentsEur set: ${rules.filter((r) => r.maxDailyAdSpendCentsEur != null).length}`)
  line(`  autonomy: ${['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'].map((l) => `${l}=${rules.filter((r) => r.autonomyLevel === l).length}`).join(' · ')}`)
  line(`  KEYWORD_RANK_BID rules: ${rules.filter((r) => r.trigger === 'KEYWORD_RANK_BID').length} · SOV_BID: ${rules.filter((r) => r.trigger === 'SOV_BID').length}`)

  // the cap that is the real policy
  const since = new Date(Date.now() - 60 * 864e5)
  const capped = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } }).catch(() => -1)
  const total = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } }).catch(() => -1)
  line(`AdvertisingActionLog last 60d: ${total} rows · DAILY_CAP_EXCEEDED ${capped}`)

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
