/**
 * ADS PLAYBOOK PB-5a — apply-ads-playbook: Claude asks to apply ONE product's playbook in ONE market (the playbook is the
 * business's own: ads-playbook reads it, set-ads-playbook changes it). Two ops in PB-5a, hero in PB-6c; start and stop
 * come in PB-5b.
 *
 *   build   create the slots the product does not hold yet, through the SP Super Wizard's own launch (Owner rule 1;
 *           ads-playbook/build.ts) — each campaign ENABLED at Amazon's 2¢ floor with its planned bids remembered
 *           (suppressed by the person who asked, never paused), OFF the live-write allowlist, without placements. It
 *           serves next to nothing (not nothing) until START. The plan is the dry run's (ads-playbook view compile),
 *           judged by the blueprint gate (Owner rule 3: only the product's own campaigns are kept apart); `execute`
 *           re-plans it and runs exactly what was approved, detached: it answers the run's id at once (view build).
 *   adopt   bind existing campaigns to the product's slots (ads-playbook/adopt.ts): Nexus only — nothing at Amazon, no
 *           allowlist, bid or rule moves; the playbook's own hourly plans follow the slots, switched off (PB-8, rank.ts).
 *   hero    PB-6c — a winning term's own campaign (ads-playbook/hero.ts, hero-build.ts): ONE campaign, ONE exact keyword,
 *           the product's own product ads and negatives, built by the same build (the SP Super Wizard's launch) and
 *           born the same way — at the 2¢ floor, off the allowlist, placements at START — linked as the slot
 *           `hero:<term>`. One per term per product per market. The term keeps running where it runs now: nothing is
 *           negated and no bid is lowered there; once the hero itself meets the harvest bar, the playbook's harvest and
 *           isolation rules close it in the research campaigns (handover B). Another product buying the term never
 *           refuses it (rule 3). Spend is added only at START, by the playbook's start.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands and a refusal is not queued; it runs only
 * as an approved request, as the approver, and refuses when what was approved moved. Strategy-bound (ads-autonomy-kit.ts):
 * a build is a kind of its own (create, as create-ad-campaign); it may run by the business's rule only inside the ads
 * strategy and this tool's limits — by default it does not (maxCampaigns 0: every build waits for a person). An adopt
 * only writes Nexus links: the strategy does not narrow it.
 *
 * Undo: a build (a hero too) — archive-ads of every campaign it made (buildRunId), permanent at Amazon; an adopt — the
 * inverse adopt.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { applyAdopt, planAdopt, type AdoptPlan } from '../../advertising/ads-playbook/adopt.js'
import { previewArtifacts } from '../../advertising/ads-playbook/artifacts.js'
import { buildRunCampaigns, inFlightRefusal, planBuild, startPlaybookBuild, type BuildPlan } from '../../advertising/ads-playbook/build.js'
import { PLAYBOOK_MONEY, SLOT_KEY } from '../../advertising/ads-playbook/doc.js'
import { HERO_KEY } from '../../advertising/ads-playbook/hero.js'
import { planHero, type HeroBuildPlan } from '../../advertising/ads-playbook/hero-build.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, strategyFactsMoney, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import type { AgentTool, FieldPermission, ToolContext, ToolDoor, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'apply-ads-playbook'
const ID = z.string().trim().min(1).max(64)
const MAX_SLOTS = 30

const input = z.object({
  op: z.enum(['build', 'adopt', 'hero'])
    .describe('build: create the slots the product does not hold yet (born at the 2¢ floor, off the live-write allowlist, no placements: nothing spends until START); adopt: bind campaigns the product already runs to its slots (Nexus only); hero: a campaign of its own for one winning term (one exact keyword, born the same way; the term keeps running where it is)'),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('ONE Amazon market code (IT, DE, FR, ES, UK; business-overview lists them)'),
  productId: ID.optional().describe('the product (a parent or a variation), its Nexus id; or sku'),
  sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
  slots: z.array(z.union([SLOT_KEY, HERO_KEY])).max(MAX_SLOTS).optional().describe('build: only these missing slots (slot keys from ads-playbook view compile); default: every slot the product does not hold; a campaign of its own for a term is named by its key, hero:<term>'),
  bind: z.array(z.object({
    slot: SLOT_KEY.describe('the slot key'),
    campaignId: ID.describe('the campaign that plays it, its Nexus id (campaignId in ad-campaigns)'),
  })).max(MAX_SLOTS).optional().describe('adopt: campaigns named for slots (the others are matched by name, then by shape)'),
  unbind: z.array(SLOT_KEY).max(MAX_SLOTS).optional().describe('adopt: slots whose adopted campaign is taken off the playbook again (the undo of an adopt)'),
  term: z.string().trim().min(1).max(80).optional().describe('hero: the search term that gets a campaign of its own (one exact keyword); ads-playbook view winners names the ones whose next step it is'),
  expectVersion: z.number().int().min(0).optional().describe('the product playbook row version you read (ads-playbook): refused when it moved since'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const MOVED_ROW = 'The playbook row moved since you read it (expectVersion): read it again with ads-playbook.'
const UNDO_BUILD = "Undo archives every campaign the build made (archive-ads buildRunId): permanent at Amazon, an archived campaign never comes back."

/** What a build's preview says about each campaign it makes (the plan's detail is ads-playbook view compile). */
function campaignLines(p: BuildPlan) {
  return p.campaigns.map((c) => {
    const g = c.adGroups[0]
    const t = g?.targets ?? []
    const positive = t.filter((x) => !x.isNegative)
    return {
      slot: c.role, name: c.name, targeting: c.targetingType,
      dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), startBidCents: g?.defaultBidCents ?? 0,
      keywords: positive.filter((x) => x.kind === 'KEYWORD').length, productTargets: positive.filter((x) => x.kind === 'PRODUCT').length,
      autoGroups: positive.filter((x) => x.kind === 'AUTO').length, negatives: t.length - positive.length,
      placementsAtStart: c.placementBidding.length,
    }
  })
}

/** The build, planned and judged: its preview, and the plan `execute` runs. */
async function buildPreview(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan?: BuildPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const out = await planBuild({ market: a.market, productId: a.productId, sku: a.sku, only: a.slots })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  if (!p.playbook) return refuse(`${p.product.sku} has no product playbook row in ${p.market}: set one (set-ads-playbook), enroll it, then build.`)
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (!p.enrolled) return refuse(`${p.product.sku} is not enrolled in its playbook in ${p.market}: a person includes it first (set-ads-playbook op enroll).`)
  if (!p.compiles) return refuse(`The playbook does not compile yet: ${p.problems.join('; ')}.`)
  if (!p.campaigns.length) return refuse(a.slots?.length ? `Nothing to build: ${a.slots.join(', ')} ${a.slots.length === 1 ? 'is' : 'are'} held by a live campaign already.` : 'Nothing to build: every slot of the playbook is held by a live campaign (ads-playbook view compile).')
  if (!p.allowed) return refuse(`The blueprint gate refuses this build — ${p.blockers.join(' ')}`)
  // A dry run writes nothing: a build that stopped (no progress for 30 minutes) is only said here; the build marks it FAILED.
  const flying = await inFlightRefusal(p.market, p.nameToken!, p.playbook.id)
  if (flying && !flying.stopped) return refuse(`A build of this product is running (run ${flying.applicationId}): follow it with ads-playbook view build.`)
  const stoppedNote = flying?.stopped
    ? `An earlier build of this product (run ${flying.applicationId}) stopped${flying.campaign ? ` at "${flying.campaign}"` : ''} without finishing: this build marks it FAILED. What it made can be archived (archive-ads buildRunId ${flying.applicationId}) or adopted.`
    : null
  let currency: string
  try { currency = await marketCurrency('AMAZON', p.market) } catch (e) { return refuse((e as Error).message) }

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it (no allowlist). Each
  // campaign is its own write: the gate's value cap is held against the largest single budget (the whole set's daily
  // budget is held by this tool's limits and the strategy's month, below).
  const largestBudgetCents = Math.max(0, ...p.campaigns.map((c) => Math.round(Number(c.dailyBudget ?? 0) * 100)))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: p.market, payloadValueCents: largestBudgetCents }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // The facts the business's rule is judged on: a build adds its daily budgets where its product is in the strategy.
  const facts = await buildLimitFacts({
    tool: TOOL, action: 'create',
    items: [{ entity: { kind: 'products', market: p.market, productIds: [p.product.productId] }, change: { field: 'dailyBudget', fromCents: null, toCents: p.dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: p.market }, select: { id: true } }))
  const artifacts = await previewArtifacts({
    playbookId: p.playbook.id, market: p.market, productId: p.product.productId, nameToken: p.nameToken!, doc: p.doc!,
    slots: p.linked.map((l) => ({ key: l.key, campaignId: l.campaignId, adGroupId: null, origin: 'built', rankRole: p.doc!.structure.slots.find((s) => s.key === l.key)?.rankRole ?? 'none' })),
    mode: 'build', actor: 'user:preview', changeSetId: null, compiledVersion: p.playbook.version,
  }, [])
  const floor = SUPPRESSION_FLOOR_CENTS
  const campaigns = campaignLines(p)
  const effect = `Builds ${plural(campaigns.length, 'Sponsored Products campaign')} of ${p.product.sku}'s playbook in ${p.market} through the SP Super Wizard's launch `
    + `(${campaigns.map((c) => c.slot).join(', ')}): ${amountLabel(p.dailyBudgetCents, currency)} of daily budget in all, advertising ${plural(p.productAds.length, 'ASIN')}. `
    + `Each is born ENABLED with every bid at the ${floor}-cent floor (the planned bids remembered; suppressed, never paused), off the live-write allowlist and without placements: `
    + 'it serves next to nothing (not nothing) until START puts it on the allowlist and its planned bids and placements back.'
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'build',
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        currency,
        campaigns,
        totals: p.totals,
        dailyBudgetCents: p.dailyBudgetCents,
        highestPlannedBidCents: p.highestPlannedBidCents,
        productAds: p.productAds,
        portfolio: p.portfolio,
        linked: p.linked,
        sharedWithOtherProducts: p.sharedWithOtherProducts,
        skippedShared: p.skippedShared,
        acceptedShared: p.acceptedShared,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: START puts them back.` },
        liveWrites: false,
        placements: 'deferred to START (a campaign off the allowlist is refused them)',
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${p.market}.` } : {}),
        warnings: [...p.warnings, ...(stoppedNote ? [stoppedNote] : [])],
        artifacts: artifacts.lines,
        ...(artifacts.errors.length ? { artifactErrors: artifacts.errors } : {}),
        basis: hash({ row: [p.playbook.id, p.playbook.version], template: p.template, campaigns: p.campaigns, productAds: p.productAds, portfolio: p.portfolio, linked: p.linked }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: ['ads-playbook view build (applicationId): follow the build', 'START (a later step) puts the campaigns on the allowlist and their planned bids and placements back'],
        undoNote: UNDO_BUILD,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/** The adopt, planned: its preview, and the plan `execute` writes. */
async function adoptPreview(a: Args): Promise<{ result: ToolResult; plan?: AdoptPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const out = await planAdopt({ market: a.market, productId: a.productId, sku: a.sku, bind: a.bind, unbind: a.unbind })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (p.problems.length) return refuse(`Not queued: ${p.problems.join('; ')}.`)
  if (!p.bindings.length && !p.unbinds.length) {
    const why = [
      p.ambiguous.length ? `${p.ambiguous.map((x) => `slot "${x.slot}" could be ${x.campaignIds.join(' or ')}`).join('; ')} (name one with bind)` : '',
      p.outside.length ? `${plural(p.outside.length, 'campaign')} play no free slot` : '',
      p.empty.length ? `no campaign plays ${p.empty.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    return refuse(`Nothing to adopt for ${p.product.sku} in ${p.market}${why ? `: ${why}` : ''}.`)
  }
  // The playbook's own artifacts after the adopt (PB-8: its hourly plans follow the slots, created switched off).
  const rankRole = (key: string) => p.doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
  const after = [...p.linked, ...p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId }))]
  const artifacts = await previewArtifacts({
    playbookId: p.playbook.id, market: p.market, productId: p.product.productId, nameToken: p.nameToken, doc: p.doc,
    slots: after.map((l) => ({ key: l.slot, campaignId: l.campaignId, adGroupId: null, origin: 'adopted', rankRole: rankRole(l.slot) })),
    mode: 'adopt', actor: 'user:preview', changeSetId: null, compiledVersion: p.playbook.version,
  }, [])
  const effect = `Binds ${plural(p.bindings.length, 'campaign')} ${p.product.sku} already runs in ${p.market} to its playbook's slots`
    + `${p.bindings.length ? ` (${p.bindings.map((b) => `${b.slot} ← "${b.name}"`).join(', ')})` : ''}`
    + `${p.unbinds.length ? `, and takes ${plural(p.unbinds.length, 'adopted slot')} off again (${p.unbinds.map((u) => u.slot).join(', ')})` : ''}. `
    + 'Nexus only: nothing is sent to Amazon by the links, and no bid, allowlist or rule of these campaigns changes. '
    + "The playbook's own hourly plans follow its slots (artifacts): created switched off, nothing runs until START; a campaign taken off a plan that is on leaves it at STOP; an hourly plan the playbook did not make is never touched."
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'adopt',
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        bindings: p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId, name: b.name, why: b.why })),
        unbinds: p.unbinds,
        ambiguous: p.ambiguous,
        outside: p.outside,
        empty: p.empty,
        linked: p.linked,
        ...(p.portfolioId ? { portfolio: { portfolioId: p.portfolioId, does: 'link' } } : {}),
        warnings: p.warnings,
        artifacts: artifacts.lines,
        ...(artifacts.errors.length ? { artifactErrors: artifacts.errors } : {}),
        basis: p.basis,
        reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
        effect,
        undoNote: 'Undo asks for the opposite adopt (the slots bound here taken off, the ones taken off bound again).',
      },
    },
  }
}

/** PB-6c — what a hero's preview says about where its term runs now (the winners view's entries for it). */
const currentLines = (p: HeroBuildPlan) => p.hero.current.slice(0, 10).map((e) => ({
  slot: e.slot, campaignId: e.campaignId, campaignName: e.campaignName, state: e.state, nextStep: e.nextStep, orders: e.current?.orders ?? 0,
}))

/** PB-6c — a hero, planned and judged: its preview, and the plan `execute` hands to the build. */
async function heroPreview(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan?: HeroBuildPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  if (!a.term?.trim()) return refuse('A hero is for one term: name it (term). ads-playbook view winners names the terms whose next step is a campaign of their own.')
  const out = await planHero({ market: a.market, productId: a.productId, sku: a.sku, term: a.term })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  const h = p.hero.plan
  if (!p.playbook) return refuse(`${p.product.sku} has no product playbook row in ${p.market}: set one (set-ads-playbook) and enroll it first.`)
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (!p.enrolled) return refuse(`${p.product.sku} is not enrolled in its playbook in ${p.market}: a person includes it first (set-ads-playbook op enroll).`)
  if (p.playbook.state === 'STOPPED') return refuse(`${p.product.sku}'s playbook in ${p.market} is stopped: start it again before its terms get campaigns of their own.`)
  if (!p.compiles) return refuse(`No campaign of its own for "${h.term}": ${p.problems.join('; ')}.`)
  if (!p.allowed) return refuse(`The blueprint gate refuses this campaign — ${p.blockers.join(' ')}`)
  const flying = await inFlightRefusal(p.market, p.nameToken!, p.playbook.id)
  if (flying && !flying.stopped) return refuse(`A build of this product is running (run ${flying.applicationId}): follow it with ads-playbook view build, then ask again.`)
  let currency: string
  try { currency = await marketCurrency('AMAZON', p.market) } catch (e) { return refuse((e as Error).message) }

  // Where it lands: asked as a creation (no campaign yet, no allowlist), held against its one daily budget.
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: p.market, payloadValueCents: p.dailyBudgetCents }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  const facts = await buildLimitFacts({
    tool: TOOL, action: 'create',
    items: [{ entity: { kind: 'products', market: p.market, productIds: [p.product.productId] }, change: { field: 'dailyBudget', fromCents: null, toCents: p.dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: p.market }, select: { id: true } }))
  const artifacts = await previewArtifacts({
    playbookId: p.playbook.id, market: p.market, productId: p.product.productId, nameToken: p.nameToken!, doc: p.doc!,
    slots: p.linked.map((l) => ({ key: l.key, campaignId: l.campaignId, adGroupId: null, origin: 'built', rankRole: p.doc!.structure.slots.find((s) => s.key === l.key)?.rankRole ?? 'none' })),
    mode: 'build', actor: 'user:preview', changeSetId: null, compiledVersion: p.playbook.version,
  }, [])
  const floor = SUPPRESSION_FLOOR_CENTS
  const campaigns = campaignLines(p)
  const where = p.hero.current.length
    ? p.hero.current.slice(0, 3).map((e) => `"${e.campaignName}" (${e.state})`).join(', ')
    : `none of ${p.product.sku}'s playbook campaigns yet`
  const effect = `Builds ONE Sponsored Products campaign of its own for "${h.term}" — ${p.product.sku}'s hero for this term in ${p.market} — through the SP Super Wizard's launch: `
    + `one exact keyword, ${plural(p.productAds.length, 'ASIN')}, ${plural(h.negatives, 'negative')}, ${amountLabel(p.dailyBudgetCents, currency)} of daily budget. `
    + `Born ENABLED with its bid at the ${floor}-cent floor (the planned bid remembered; suppressed, never paused), off the live-write allowlist and without placements: it serves next to nothing (not nothing) until START. `
    + `"${h.term}" keeps running where it runs now (${where}): nothing is negated and no bid is lowered there. Once the hero itself meets the harvest bar, the playbook's harvest and isolation rules (when on) close it in the research campaigns — never before.`
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'hero',
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        currency,
        term: h.term,
        hero: {
          key: h.key, intent: h.intent, modelSlot: h.modelSlot, ...(h.ownIntent ? {} : { modelNote: `no Exact slot for ${h.intent.toLowerCase()} terms: modelled on "${h.modelSlot}"` }),
          keyword: { text: h.term, match: 'EXACT' }, negatives: h.negatives,
          bidFrom: h.bidFrom === 'cpc' ? "the term's cost per click where it runs now, inside the strategy's band" : "the playbook's start-bid ladder for its Exact slot, inside the strategy's band (the term has no clicks yet)",
          budgetFrom: h.budgetFrom === 'spend' ? "the term's own daily spend where it runs now" : h.budgetFrom === 'productBudget' ? "the product's daily budget (the term spends more than it)" : "the playbook's least budget per slot",
        },
        current: currentLines(p),
        keepsRunning: `"${h.term}" keeps running where it runs now: no negative, no lower bid, no pause anywhere (the Owner's rule 2: winners are never shuffled).`,
        campaigns,
        dailyBudgetCents: p.dailyBudgetCents,
        highestPlannedBidCents: p.highestPlannedBidCents,
        productAds: p.productAds,
        portfolio: p.portfolio,
        acceptedShared: p.acceptedShared,
        sharedWithOtherProducts: p.sharedWithOtherProducts,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Its bid starts at the ${floor}-cent floor and the bid planned is remembered: START puts it back.` },
        liveWrites: false,
        placements: 'deferred to START (a campaign off the allowlist is refused them)',
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${p.market}.` } : {}),
        warnings: [...p.warnings, ...(flying?.stopped ? [`An earlier build of this product (run ${flying.applicationId}) stopped without finishing: this one marks it FAILED.`] : [])],
        artifacts: artifacts.lines,
        ...(artifacts.errors.length ? { artifactErrors: artifacts.errors } : {}),
        basis: hash({ row: [p.playbook.id, p.playbook.version], template: p.template, term: h.key, campaigns: p.campaigns, productAds: p.productAds, portfolio: p.portfolio, linked: p.linked }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: [
          'ads-playbook view build (applicationId): follow the build',
          `START puts it on the allowlist with its planned bid and placements back (apply-ads-playbook op start, slots ["${h.key}"])`,
          `ads-playbook view winners: follow "${h.term}" in both places`,
        ],
        undoNote: UNDO_BUILD,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/** The door a request came through, as the version row records it. */
const VIA: Record<ToolDoor, string> = { claude: 'claude', app: 'assistant', fleet: 'fleet', system: 'system' }

/**
 * Claude's limits for a build run by rule: the kit's (one product per request), and the most campaigns, daily budget and
 * highest planned bid a build may make without a person — 0 by default: every build waits for a person until he types a
 * number — and the markets.
 */
const APPLY_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(MAX_SLOTS).default(0).describe('build: the most campaigns one build may create by rule; 0 = every build waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("build: the most daily budget (all its campaigns, minor units of the market's currency) one build may create by rule; 0 = every build waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("build: the highest planned bid (restored at START) a build created by rule may hold, in minor units of the market's currency"),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets where it may run by rule (empty = every market)'),
})

/** PB-5a — apply-ads-playbook's own checks around the kit's (C1–C7, the month). Pure. */
function applyRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    op?: string; market?: string; newMarket?: boolean; campaigns?: unknown[]; dailyBudgetCents?: number; highestPlannedBidCents?: number; currency?: string
  }
  if (!p.op) return 'there is no preview of this playbook apply to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (p.market && markets.length && !markets.includes(p.market)) return `this business lets a playbook apply run by rule only in ${markets.join(', ')}`
  if (p.op === 'adopt') return null
  const common = commonRefusal(preview, limits)
  if (common) return common
  if (p.op !== 'build' && p.op !== 'hero') return `op ${p.op} is not one this tool runs by rule; a person decides`
  const currency = p.currency ?? 'EUR'
  if (p.newMarket) return `it builds the first campaigns in ${p.market}: a person decides a new market`
  const n = p.campaigns?.length ?? 0
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a build create by rule${maxCampaigns === 0 ? ' (0: every build waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if ((p.dailyBudgetCents ?? 0) > budget) return `its daily budgets add up to ${amountLabel(p.dailyBudgetCents ?? 0, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a build create by rule; a person decides`
  const bid = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  const highest = p.highestPlannedBidCents ?? 0
  if (highest > bid) return `its highest planned bid ${amountLabel(highest, currency)} is above the ${amountLabel(bid, currency)} this tool's limits allow by rule; a person decides`
  const facts = limitFactsOf(preview)
  for (const scope of Object.values(facts?.scopes ?? {})) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBid || highest <= max) continue
    return `its highest planned bid ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  return null
}

/** What a change of this tool recorded: the op, and its run (build, hero: its key too) or its links (adopt). */
type ApplyAfter =
  | { op: 'build' | 'hero'; playbookId: string; applicationId: string; key?: string }
  | { op: 'adopt'; playbookId: string; market: string; productId: string; bound: Array<{ slot: string; campaignId: string }>; unbound: Array<{ slot: string; campaignId: string }> }

/** Undo: a build — a hero too — is archived (archive-ads buildRunId, permanent at Amazon); an adopt is the inverse adopt. */
export const APPLY_PLAYBOOK_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as ApplyAfter
    if (after.op === 'build' || after.op === 'hero') {
      // A build (a hero's too) stands while a campaign it made is not archived (one still running stands too: archive-ads waits for it).
      const run = await buildRunCampaigns(after.applicationId)
      const standing = 'refusal' in run ? /still running/.test(run.refusal) : run.campaignIds.length > 0
      const same = { op: after.op, playbookId: after.playbookId, applicationId: after.applicationId, ...(after.key ? { key: after.key } : {}) }
      return standing ? same : { ...same, archived: true }
    }
    if (after.op === 'adopt') {
      const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: after.playbookId, kind: 'slot' }, select: { key: true, refId: true } })
      const has = (s: { slot: string; campaignId: string }) => links.some((l) => l.key === s.slot && l.refId === s.campaignId)
      return { ...after, bound: after.bound.filter(has), unbound: after.unbound.filter((u) => !has(u)) }
    }
    return change.after
  },
  request(change) {
    const after = (change.after ?? {}) as ApplyAfter
    if (after.op === 'build' || after.op === 'hero') {
      return after.applicationId
        ? { tool: 'archive-ads', args: { buildRunId: after.applicationId, why: after.op === 'hero' ? 'undo of a playbook hero: archived for good' : 'undo of a playbook build: archived for good' } }
        : { refusal: 'This change does not name the build it started.' }
    }
    if (after.op === 'adopt') {
      if (!after.bound.length && !after.unbound.length) return { refusal: 'This adopt bound and unbound nothing.' }
      return {
        tool: TOOL,
        args: {
          op: 'adopt', market: after.market, productId: after.productId,
          ...(after.bound.length ? { unbind: after.bound.map((b) => b.slot) } : {}),
          ...(after.unbound.length ? { bind: after.unbound } : {}),
          why: 'undo of a playbook adopt',
        },
      }
    }
    return { refusal: 'This change does not record what it applied.' }
  },
}

const applyAdsPlaybook: AgentTool = {
  name: TOOL,
  title: 'Apply the ads playbook',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, F.adsAutomationManage, FIELDS.financialsAdspendView],
  restrictedFields: { ...PLAYBOOK_MONEY, ...strategyFactsMoney(), highestPlannedBidCents: FIELDS.financialsAdspendView } as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // A build is undone by archiving what it made (permanent at Amazon; what it spent stays spent); an adopt in full.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: APPLY_LIMITS,
  withinLimits: applyRefusal,
  undo: APPLY_PLAYBOOK_UNDO,
  description:
    "Apply ONE product's Amazon ads playbook in ONE market (ads-playbook reads it). op build creates the slots the product "
    + "does not hold yet through the SP Super Wizard's own launch: each campaign born at the 2-cent floor (its planned "
    + 'bids remembered; suppressed, never paused), off the live-write allowlist and without placements, so it spends next '
    + 'to nothing until a later START. The plan is the dry run of ads-playbook view compile, held to the blueprint gate '
    + '(only the product\'s own campaigns are kept apart; another product may buy the same keyword). It runs on its own '
    + 'once approved: follow it with ads-playbook view build. op hero builds ONE campaign of its own for one winning term '
    + '(term; ads-playbook view winners names the terms whose next step it is): one exact keyword, the product\'s own '
    + 'product ads and negatives, born the same way as a build (2-cent floor, off the allowlist, placements at START) and '
    + 'linked as the slot hero:<term>, at most one per term; the term keeps running where it runs now (nothing negated, no '
    + 'bid lowered) until the hero itself proves. op adopt binds campaigns the product already runs to its '
    + 'slots (bind names some; the rest match by name, then by shape): Nexus only, nothing at Amazon moves (the playbook\'s '
    + 'own hourly plans follow the slots, switched off until START; one another plan holds is never taken). A person '
    + 'approves it in Nexus, unless the business lets it run by its rule inside its limits and the ads strategy (by '
    + 'default a build does not: maxCampaigns 0). Refused, and not queued, when the product is not enrolled, nothing is '
    + 'missing, the gate or Amazon\'s write gate refuses it, or a build of it is already running. Undo: a build is archived '
    + '(archive-ads, permanent at Amazon); an adopt is reversed by the opposite adopt.',
  async handler(args, ctx) {
    const a = args as Args
    if (a.op === 'hero') return (await heroPreview(a, ctx)).result
    return a.op === 'adopt' ? (await adoptPreview(a)).result : (await buildPreview(a, ctx)).result
  },
  async execute(args, ctx) {
    const a = args as Args
    const approvalId = ctx.approvalId?.trim()
    const decision = approvalId ? await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decidedBy: true } }) : null
    const writerOf = (changeSetId: string) => ({
      via: VIA[ctx.via] ?? ctx.via,
      actor: decision?.decidedBy ?? `user:${ctx.userId}`,
      actorUserId: ctx.userId ?? null,
      approvalId: changeSetId,
      updatedBy: ctx.via === 'claude' ? `claude:${changeSetId}` : `user:${ctx.userId}`,
    })

    if (a.op === 'adopt') {
      const fresh = await adoptPreview(a)
      if (!fresh.result.ok || !fresh.plan) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid adopt'}`)
      const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
      const now = fresh.result.preview as Record<string, unknown>
      const moved = ['op', 'basis', 'bindings'].filter((k) => k in before && canonical(before[k]) !== canonical(now[k]))
      if (moved.length) return notRun(`Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the campaigns as they are now.`)
      const run = approvedRun(ctx, a.why ?? String(now.effect ?? ''))
      if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
      const p = fresh.plan
      const out = await applyAdopt(p, { ...writerOf(run.changeSetId), changeSetId: run.changeSetId })
      if ('error' in out) return notRun(`Not run: ${out.error}`)
      return {
        ok: true,
        data: { bound: out.bound, unbound: out.unbound, ...(out.errors.length ? { errors: out.errors } : {}), note: 'Saved in Nexus: nothing was sent to Amazon.' },
        change: {
          before: { op: 'adopt', playbookId: p.playbook.id, linked: p.linked },
          after: { op: 'adopt', playbookId: p.playbook.id, market: p.market, productId: p.product.productId, bound: p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId })), unbound: p.unbinds },
        },
      }
    }

    if (a.op === 'hero') {
      // PB-6c — a hero runs as a build of one campaign (the same executor, the same launch).
      const fresh = await heroPreview(a, ctx)
      if (!fresh.result.ok || !fresh.plan) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid campaign of its own'}`)
      const refusal = recheck(ctx, fresh.result, ['op', 'basis', 'reach'])
      if (refusal) return notRun(refusal)
      const p = fresh.plan
      const preview = fresh.result.preview as { reach: StoredReach; effect: string }
      const run = approvedRun(ctx, a.why ?? preview.effect)
      if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
      const requester = await requesterOf(ctx, run.actor)
      const started = await startPlaybookBuild({ plan: p, actor: run.actor, requester, changeSetId: run.changeSetId, writer: writerOf(run.changeSetId) })
      if ('refusal' in started) return notRun(`Not run: ${started.refusal}`)
      if (started.alreadyRunning) return notRun(`Not run: a build of this product is already running (run ${started.applicationId}): follow it with ads-playbook view build.`)
      return {
        ok: true,
        data: {
          applicationId: started.applicationId,
          status: 'RUNNING',
          key: p.hero.plan.key,
          reach: preview.reach,
          changeSetId: run.changeSetId,
          note: `Runs on its own; follow it with ads-playbook view build (applicationId ${started.applicationId}). Born at ${SUPPRESSION_FLOOR_CENTS}¢ and off the live-write allowlist — nothing spends until START. "${p.hero.plan.term}" keeps running where it runs now.`,
        },
        change: {
          before: { op: 'hero', playbookId: p.playbook!.id, term: p.hero.plan.term, slots: p.linked },
          after: { op: 'hero', playbookId: p.playbook!.id, applicationId: started.applicationId, key: p.hero.plan.key },
        },
      }
    }

    const fresh = await buildPreview(a, ctx)
    // What is no longer a valid build (the product deleted, nothing missing) is said as it is, before the re-check.
    if (!fresh.result.ok) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid build'}`)
    const refusal = recheck(ctx, fresh.result, ['op', 'basis', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.plan!
    const preview = fresh.result.preview as { reach: StoredReach; effect: string }
    const run = approvedRun(ctx, a.why ?? preview.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const requester = await requesterOf(ctx, run.actor)
    const started = await startPlaybookBuild({ plan: p, actor: run.actor, requester, changeSetId: run.changeSetId, writer: writerOf(run.changeSetId) })
    if ('refusal' in started) return notRun(`Not run: ${started.refusal}`)
    if (started.alreadyRunning) return notRun(`Not run: a build of this product is already running (run ${started.applicationId}): follow it with ads-playbook view build.`)
    return {
      ok: true,
      data: {
        applicationId: started.applicationId,
        status: 'RUNNING',
        reach: preview.reach,
        changeSetId: run.changeSetId,
        note: `Runs on its own; follow it with ads-playbook view build (applicationId ${started.applicationId}). Born at ${SUPPRESSION_FLOOR_CENTS}¢ and off the live-write allowlist — nothing spends until START.`,
      },
      change: {
        before: { op: 'build', playbookId: p.playbook!.id, state: p.playbook!.state, slots: p.linked },
        after: { op: 'build', playbookId: p.playbook!.id, applicationId: started.applicationId },
      },
    }
  },
}

export const ADS_PLAYBOOK_APPLY_TOOLS: AgentTool[] = [applyAdsPlaybook]
