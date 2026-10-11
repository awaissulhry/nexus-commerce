/**
 * HARVEST ENGINE — what an approved change set runs (the `apply-harvest` request's execute), stage by stage:
 *
 *   portfolio  each new portfolio (ads-portfolio.service.ts createPortfolio: the gate for its market; Amazon's id), then
 *              its monthly cap when one was asked (updatePortfolioById: judged against the portfolio cap limit).
 *   campaign   each new campaign: the product's funnel campaign for the match — ONE manual Sponsored Products campaign
 *              (dynamic bids down only) in its portfolio, ONE ad group, one product ad per SKU its own campaigns
 *              advertise, born serving at the bids planned and on the live-write allowlist (a person approved its budget
 *              in this change set: the SP Super Wizard's own launch does the same). Through ads-create.service.ts (the
 *              write gate, the channel gateway), as the approver (`manual`: B17).
 *   harvest    each item: its record claimed (one per product × market × term, every actor), then the one writer
 *              (harvest/write.ts writeHarvest): the keyword (or a paused copy enabled), then its source and funnel blocks
 *              — only once the keyword stands. A stage that fails stops the items that wait for it, named; the others go.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@nexus/database'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { JUDGE_AFTER_MS } from '../brain/harvest.js'
import type { ChangeSetPlan } from './preview.js'
import type { ActorKind, PlannedItem } from './plan.js'
import { blocksOf, ENGINE_OWED_WORDS, jsonOf, writeHarvest, type BlockState, type HarvestWriteOutcome, type Who } from './write.js'

/** Statuses a new change set may take a term's record from (a brain decision, a past harvest that ended). */
/** HALF_DONE: a person completes the blocks still owed (a switched-on keyword Amazon has confirmed since). */
export const CLAIMABLE = ['SHADOW', 'HELD', 'PROPOSED', 'DECLINED', 'REFUSED', 'FAILED', 'UNDONE', 'HALF_DONE'] as const

export interface ItemOutcome {
  candidateId: string
  term: string
  harvestId: string | null
  status: HarvestWriteOutcome['status'] | 'SKIPPED'
  why: string
  keywordTargetId: string | null
  negatives: string[]
}

export interface ChangeSetOutcome {
  changeSetId: string | null
  portfolios: Array<{ key: string; portfolioId: string | null; ok: boolean; why: string }>
  campaigns: Array<{ key: string; campaignId: string | null; adGroupId: string | null; ok: boolean; why: string }>
  items: ItemOutcome[]
  harvestIds: string[]
  ok: number
  failed: number
}

const levelOf = (actor: ActorKind, who: Who) => (actor === 'RULE' && !who.manual ? 'AUTO' : 'PROPOSE')

/**
 * N1 (HCORE re-review) — what a completion of a HALF_DONE record keeps from the set that made it: the keyword it created or
 * switched on (Undo still pauses it), when it landed (its judging clock), and what the keyword was before that set
 * (`keywordBefore`: the plan of the completion finds the keyword standing, which it does only because that set made it).
 */
export interface Completion { keywordTargetId: string | null; landedAt: Date | null; judgeAfter: Date | null; verdict: string | null; keywordBefore: string | null }

/** Claim the term's record for this change set (create it, or take it from a state that may be taken). */
async function claimRecord(item: PlannedItem, a: { actor: ActorKind; actorId: string | null; who: Who; now: Date; newCampaign: unknown | null }): Promise<{ id: string; completion: Completion | null } | { refusal: string }> {
  const key = { product_market_term: workspaceKey({ productId: item.productId, marketplace: item.market, term: item.term }) }
  const d = item.destination!
  const content = {
    isAsin: item.isAsin, status: 'WRITING', level: levelOf(a.actor, a.who), destinationKind: d.kind === 'existing' ? 'EXISTING' : 'NEW_CAMPAIGN',
    destHow: d.kind === 'existing' ? d.how : 'new', destCampaignId: d.kind === 'existing' ? d.campaignId : null, destAdGroupId: d.kind === 'existing' ? d.adGroupId : null,
    bidCents: item.bid?.cents ?? null, sources: jsonOf(item.sources), funnel: jsonOf(item.funnel), heldBy: null,
    why: `${a.actor === 'PERSON' ? 'A person' : a.actor === 'CLAUDE' ? 'Claude' : a.actor === 'RULE' ? 'A rule' : 'The brain'} harvested it: ${d.why}`.slice(0, 2000),
    evidence: jsonOf({ ...(item.harvestedOn ?? {}), destination: { kind: d.kind, how: d.how, why: d.why }, bidWhy: item.bid?.why ?? null, keywordBefore: d.kind === 'existing' && d.status === 'already-there' ? 'stood' : d.kind === 'existing' && d.status === 're-enable' ? 'paused' : 'none' }),
    digest: '', runId: a.who.changeSetId ?? randomUUID(), decidedAt: a.now, checkedAt: a.now, changedAt: a.now,
    actorKind: a.actor, actorId: a.actorId, changeSetId: a.who.changeSetId, match: item.match, newCampaign: a.newCampaign == null ? Prisma.DbNull : jsonOf(a.newCampaign),
    stage: d.kind === 'new' ? 'CAMPAIGN' : 'KEYWORD',
    approvalId: null, undoApprovalId: null, keywordTargetId: null, landedAt: null, attempts: 1, lastError: null, judgeAfter: null, judgedAt: null, verdict: null, judgement: Prisma.DbNull,
    // A harvest unskips its term.
    skippedUntil: null, skippedForGood: false,
  }
  const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true, status: true, sources: true, funnel: true, keywordTargetId: true, landedAt: true, judgeAfter: true, verdict: true, evidence: true } })
  let completion: Completion | null = null
  if (was?.status === 'HALF_DONE') {
    const before = ((was.evidence ?? {}) as { keywordBefore?: unknown }).keywordBefore
    completion = { keywordTargetId: was.keywordTargetId, landedAt: was.landedAt, judgeAfter: was.judgeAfter, verdict: was.verdict, keywordBefore: typeof before === 'string' ? before : null }
    const evidence = (content.evidence ?? {}) as Record<string, unknown>
    Object.assign(content, {
      keywordTargetId: was.keywordTargetId, landedAt: was.landedAt, judgeAfter: was.judgeAfter, verdict: was.verdict,
      evidence: jsonOf({ ...evidence, ...(completion.keywordBefore ? { keywordBefore: completion.keywordBefore } : {}) }),
    })
    // A completion: the blocks that landed before keep their negative (an Undo lifts them); only the owed ones are written.
    const landed = new Map([...blocksOf(was.sources), ...blocksOf(was.funnel)].filter((b) => b.result === 'landed' && b.negativeTargetId).map((b) => [b.adGroupId, b]))
    const carry = (b: BlockState): BlockState => {
      const was = landed.get(b.adGroupId)
      if (!was || b.action === 'kept') return b
      // Another writer's negative stays another writer's (its undo never lifts it).
      return { ...b, action: 'negate', result: 'landed', negativeTargetId: was.negativeTargetId, error: null, ...(was.own === false ? { own: false as const } : {}) }
    }
    content.sources = jsonOf(item.sources.map(carry))
    content.funnel = jsonOf(item.funnel.map(carry))
    item.sources = item.sources.map(carry)
    item.funnel = item.funnel.map(carry)
  }
  if (!was) {
    try {
      const row = await prisma.adsBrainHarvest.create({ data: { productId: item.productId, marketplace: item.market, term: item.term, ...content } as never, select: { id: true } })
      return { id: row.id, completion: null }
    } catch (error) {
      // L3 — another harvest of the term made its record a moment ago: this change set leaves it (named, never thrown).
      if ((error as { code?: string }).code === 'P2002') return { refusal: 'another harvest of this term started a moment ago: this change set leaves it' }
      throw error
    }
  }
  const taken = await prisma.adsBrainHarvest.updateMany({ where: { id: was.id, status: { in: [...CLAIMABLE] } }, data: content as never })
  if (taken.count !== 1) return { refusal: `the term's harvest is ${was.status.toLowerCase().replace(/_/g, ' ')} meanwhile: this change set leaves it` }
  return { id: was.id, completion }
}

/**
 * What an item's writes store on its record. Pure.
 * N1 — a completion that did not land (held, refused, failed) leaves the record as the first set left it: HALF_DONE, its
 * keyword and the blocks that landed then still standing, so Undo stays offered; what happened is said. A completion that
 * lands keeps the first set's landing (its judging clock) when it had one.
 */
export function storedOutcome(o: HarvestWriteOutcome, now: Date, completion: Completion | null): Record<string, unknown> {
  if (completion && o.status !== 'DONE' && o.status !== 'HALF_DONE') {
    return {
      status: 'HALF_DONE', stage: 'NEGATIVES', sources: jsonOf(o.sources), funnel: jsonOf(o.funnel),
      lastError: o.error ?? o.why, changedAt: now,
      why: `the completion did not land (${o.why}): the keyword and the blocks that landed before still stand; harvest it again to finish`.slice(0, 2000),
    }
  }
  // A switch-on Amazon has not confirmed is no landing yet: no judging clock until the keyword serves (HFIX).
  const stands = o.status === 'DONE' || (o.status === 'HALF_DONE' && o.keyword?.confirmed !== false)
  return {
    status: o.status, sources: jsonOf(o.sources), funnel: jsonOf(o.funnel), stage: o.status === 'DONE' ? 'DONE' : o.status === 'HALF_DONE' ? 'NEGATIVES' : 'KEYWORD',
    ...(o.status === 'HELD' ? { heldBy: o.error } : {}),
    ...(o.keyword?.targetId ? { keywordTargetId: o.keyword.targetId } : {}),
    ...(o.keyword?.bidCents != null ? { bidCents: o.keyword.bidCents } : {}),
    ...(stands && !completion?.landedAt ? { landedAt: now, judgeAfter: new Date(now.getTime() + JUDGE_AFTER_MS), verdict: 'WAITING' } : {}),
    lastError: o.error, why: o.why.slice(0, 2000), changedAt: now,
  }
}

/** Store what became of an item's writes on its record. */
async function storeOutcome(id: string, o: HarvestWriteOutcome, now: Date, completion: Completion | null) {
  await prisma.adsBrainHarvest.update({ where: { id }, data: storedOutcome(o, now, completion) as never })
}

/** The new portfolios of the change set (and their caps). */
async function buildPortfolios(plan: ChangeSetPlan, who: Who): Promise<{ ids: Map<string, string>; out: ChangeSetOutcome['portfolios'] }> {
  const ids = new Map<string, string>()
  const out: ChangeSetOutcome['portfolios'] = []
  if (!plan.newPortfolios.length) return { ids, out }
  const { createPortfolio, updatePortfolioById } = await import('../ads-portfolio.service.js')
  for (const np of plan.newPortfolios) {
    try {
      const made = await createPortfolio({ name: np.name, marketplace: np.market, audit: { actor: who.actor, changeSetId: who.changeSetId } })
      if (made.portfolio.portfolioId.startsWith('local-pf-')) {
        out.push({ key: np.key, portfolioId: null, ok: false, why: `Amazon did not take the portfolio "${np.name}" (${made.amazonRefused ?? made.mode}): kept in Nexus only, so no campaign is built in it` })
        continue
      }
      let why = `portfolio "${np.name}" created`
      if (np.capMonthlyCents) {
        // L2 — the cap in the market's own currency; a cap that is refused builds NO campaign in an uncapped portfolio.
        const currencyCode = plan.newCampaigns.find((c) => c.market === np.market && c.currency)?.currency ?? 'EUR'
        const capped = await updatePortfolioById({ portfolioId: made.portfolio.portfolioId, budget: { amount: np.capMonthlyCents / 100, currencyCode, policy: 'monthlyRecurring' }, audit: { actor: who.actor, changeSetId: who.changeSetId } } as never)
        if (!(capped as { ok?: boolean }).ok) {
          out.push({ key: np.key, portfolioId: made.portfolio.portfolioId, ok: false, why: `${why}, but its monthly cap was not set (${(capped as { error?: string }).error ?? 'refused'}): no campaign is built in it uncapped` })
          continue
        }
        why += ', with its monthly cap'
      }
      ids.set(np.key, made.portfolio.portfolioId)
      out.push({ key: np.key, portfolioId: made.portfolio.portfolioId, ok: true, why })
    } catch (e) {
      out.push({ key: np.key, portfolioId: null, ok: false, why: `the portfolio "${np.name}" was not created: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return { ids, out }
}

/** The new campaigns of the change set: campaign, ad group, product ads (see the header). */
async function buildCampaigns(plan: ChangeSetPlan, portfolios: Map<string, string>, failedPortfolios: Set<string>, who: Who): Promise<{ groups: Map<string, { campaignId: string; adGroupId: string }>; out: ChangeSetOutcome['campaigns'] }> {
  const groups = new Map<string, { campaignId: string; adGroupId: string }>()
  const out: ChangeSetOutcome['campaigns'] = []
  if (!plan.newCampaigns.length) return { groups, out }
  const { createCampaignLocal, createAdGroupLocal, createProductAdLocal } = await import('../ads-create.service.js')
  for (const nc of plan.newCampaigns) {
    const pf = nc.portfolio && 'newPortfolio' in nc.portfolio ? portfolios.get(nc.portfolio.newPortfolio) ?? null : nc.portfolio && 'id' in nc.portfolio ? nc.portfolio.id : null
    if (nc.portfolio && 'newPortfolio' in nc.portfolio && (failedPortfolios.has(nc.portfolio.newPortfolio) || !pf)) {
      out.push({ key: nc.key, campaignId: null, adGroupId: null, ok: false, why: `its new portfolio was not created: the campaign "${nc.name}" was not built` })
      continue
    }
    try {
      const camp = await createCampaignLocal({
        name: nc.name, type: 'SP', marketplace: nc.market, targetingType: 'MANUAL', dailyBudgetEur: nc.dailyBudgetCents / 100, biddingStrategy: 'legacyForSales',
        ...(pf ? { portfolioId: pf } : {}), userId: who.actor, changeSetId: who.changeSetId, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits === true,
      })
      if (!camp.id || !camp.externalCampaignId) {
        out.push({ key: nc.key, campaignId: camp.id || null, adGroupId: null, ok: false, why: `the campaign "${nc.name}" did not reach Amazon (${camp.reason ?? 'no id came back'})` })
        continue
      }
      // A person approved its budget in this change set: on the live-write allowlist at birth (the SP Super Wizard's launch).
      if (who.manual) await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } })
      const g = await createAdGroupLocal({ campaignId: camp.id, name: nc.adGroupName, defaultBidEur: nc.defaultBidCents / 100, userId: who.actor, manual: who.manual, requireAmazon: true, creationFlow: true, changeSetId: who.changeSetId })
      if (!g.id || !g.externalAdGroupId) {
        out.push({ key: nc.key, campaignId: camp.id, adGroupId: g.id ?? null, ok: false, why: `the ad group of "${nc.name}" did not reach Amazon (${g.notSent?.reason ?? 'no id came back'})` })
        continue
      }
      let ads = 0
      const problems: string[] = []
      for (const sku of nc.skus) {
        const ad = await createProductAdLocal({ adGroupId: g.id, sku, userId: who.actor, manual: who.manual, launch: true, creationFlow: true, changeSetId: who.changeSetId })
          .catch((e: unknown) => ({ id: null, externalAdId: null, error: e instanceof Error ? e.message : String(e) }))
        if ((ad as { externalAdId?: string | null }).externalAdId) ads++
        else problems.push(`${sku}: ${(ad as { notSent?: { reason?: string } }).notSent?.reason ?? (ad as { error?: string }).error ?? 'not sent'}`)
      }
      if (!ads) {
        out.push({ key: nc.key, campaignId: camp.id, adGroupId: g.id, ok: false, why: `no product ad of "${nc.name}" reached Amazon (${problems.slice(0, 3).join('; ')}): its keywords are not added` })
        continue
      }
      groups.set(nc.key, { campaignId: camp.id, adGroupId: g.id })
      out.push({ key: nc.key, campaignId: camp.id, adGroupId: g.id, ok: true, why: `campaign "${nc.name}" built: one ad group, ${ads} product ad${ads === 1 ? '' : 's'}${problems.length ? ` (${problems.length} not sent: ${problems.slice(0, 3).join('; ')})` : ''}` })
    } catch (e) {
      out.push({ key: nc.key, campaignId: null, adGroupId: null, ok: false, why: `the campaign "${nc.name}" was not built: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return { groups, out }
}

/** Run an approved change set (its plan read fresh and re-checked by the caller): stages, then each item. */
export async function executeChangeSet(plan: ChangeSetPlan, a: { actor: ActorKind; actorId: string | null; who: Who; now?: Date }): Promise<ChangeSetOutcome> {
  const now = a.now ?? new Date()
  const pf = await buildPortfolios(plan, a.who)
  const failedPf = new Set(pf.out.filter((x) => !x.ok).map((x) => x.key))
  const built = await buildCampaigns(plan, pf.ids, failedPf, a.who)
  const items: ItemOutcome[] = []
  for (const item of plan.items) {
    const base = { candidateId: item.candidateId, term: item.term, keywordTargetId: null, negatives: [] as string[] }
    if (item.refusal || !item.destination || !item.bid) { items.push({ ...base, harvestId: null, status: 'SKIPPED', why: item.refusal ?? 'nothing to write' }); continue }
    let dest = item.destination
    let nc: ChangeSetPlan['newCampaigns'][number] | undefined
    if (dest.kind === 'new') {
      nc = plan.newCampaigns.find((c) => c.key === (dest as { key: string }).key)
      const g = built.groups.get(dest.key)
      const why = built.out.find((c) => c.key === (dest as { key: string }).key)?.why ?? 'the new campaign was not built'
      if (!g) { items.push({ ...base, harvestId: null, status: 'SKIPPED', why }); continue }
      dest = { kind: 'existing', how: 'chosen', adGroupId: g.adGroupId, campaignId: g.campaignId, status: 'will-create', existingTargetId: null, why: `the new campaign "${nc?.name ?? dest.key}"` }
    }
    const planned: PlannedItem = { ...item, destination: dest }
    const claim = await claimRecord(planned, { ...a, now, newCampaign: nc ? { key: nc.key, name: nc.name, adGroupName: nc.adGroupName, dailyBudgetCents: nc.dailyBudgetCents, portfolio: nc.portfolio, builtCampaignId: dest.campaignId, builtAdGroupId: dest.adGroupId } : null })
    if ('refusal' in claim) { items.push({ ...base, harvestId: null, status: 'SKIPPED', why: claim.refusal }); continue }
    let o: HarvestWriteOutcome
    try {
      o = await writeHarvest({
        term: item.term, isAsin: item.isAsin, match: item.match, destAdGroupId: dest.adGroupId, bidCents: item.bid.cents,
        // The landing guard decides again at the write (landed / switch on / create / hold): the plan's status is only shown.
        keywordTargetId: null, sources: planned.sources, funnel: planned.funnel, retryRefused: true, metric: 'harvest',
        noServeWords: 'a harvest never goes into a destination that does not serve', owedWords: ENGINE_OWED_WORDS,
      }, a.who)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      o = { status: 'FAILED', keyword: null, sources: [...planned.sources], funnel: [...planned.funnel], why: `the write failed (${msg}): nothing was written`, error: msg }
    }
    await storeOutcome(claim.id, o, now, claim.completion)
    logger.info('[harvest-engine] item', { harvestId: claim.id, term: item.term, status: o.status, actor: a.who.actor, changeSetId: a.who.changeSetId })
    items.push({ ...base, harvestId: claim.id, status: o.status, why: o.why, keywordTargetId: o.keyword?.targetId ?? null, negatives: [...o.sources, ...o.funnel].map((s) => s.negativeTargetId).filter((x): x is string => !!x).sort() })
  }
  const harvestIds = items.map((i) => i.harvestId).filter((x): x is string => !!x)
  return {
    changeSetId: a.who.changeSetId, portfolios: pf.out, campaigns: built.out, items, harvestIds,
    ok: items.filter((i) => i.status === 'DONE' || i.status === 'HALF_DONE').length,
    failed: items.filter((i) => i.status !== 'DONE' && i.status !== 'HALF_DONE').length,
  }
}
