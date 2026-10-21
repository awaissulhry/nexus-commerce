/**
 * Meta ads changes, step 19 — new campaigns and ad sets, and copies, on the business's chosen Meta ad account:
 *   create-meta-campaign  a campaign (every OUTCOME_ objective but app promotion; campaign budget or ad set budgets with
 *                         sharing said explicitly; bid strategy always sent; special ad category always sent; spend cap;
 *                         reach and frequency; promoted object; scheduled increases; Advantage+ levers; the unified PCA
 *                         flow from 2026-10-22) — CMP-020–029, 031–033, 035, 040, 058, 074 (answered), 077, 087
 *   create-meta-ad-set    an ad set in one of its campaigns (goal, billing, destination, budget or the campaign's with a
 *                         minimum / cap, bid, ROAS goal, times, attribution, promoted object with the business's Page,
 *                         custom conversion or boosted product set, dynamic creative, scheduled increases, a minimal
 *                         targeting with Advantage+ audience said explicitly, the EU payer / beneficiary) — AS-031, 032
 *                         (answered), 063, 066, 067, 073, 080, 089
 *   copy-meta-ads         a campaign, ad set or ad (with its children or alone, into another campaign / ad set, renamed,
 *                         new times, another campaign budget, an ad's creative name / URL tags; in the background beyond
 *                         Meta's 3 ads) — CMP-052–055, AS-037–039, AD-047, AD-048, AD-054 (answered)
 * Each is born PAUSED (copies: status_option=PAUSED) unless the person asks activate (SPENDS MONEY). Each a Nexus change
 * like set-meta-status (meta-ads-kit.ts): a preview from the live state (Meta checks a create first: validate_only with
 * its recommendations; a copy has no check), an approvalId, a person approves it, it runs as that person. Undo deletes ONLY
 * what the change made (its record names it), while nothing else hangs under it and it has spent nothing, read live first:
 * the same tool with removeMade + undoOf. Meta's own MCP tools (ads_create_campaign, ads_create_ad_set: paused) create
 * without a spending sentence, Meta's recommendations in the preview, an EU payer check or an undo; these add all four,
 * and copies, which Meta's MCP does not offer.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { liveAccountCapabilities, liveAccountPixels, liveCampaign } from '../../marketing/meta-ads/live-settings.js'
import { liveChosenPage, liveCopySource, liveCopyTargetAdSet, liveDsaDefaults, liveMadeObject, type MadeNow } from '../../marketing/meta-ads/live-create.js'
import { metaCatalogProblem } from '../../marketing/meta-ads/catalog-rule.js'
import { promotedMerged } from '../../marketing/meta-ads/change-campaign-settings.js'
import { ATTRIBUTION_PRESETS } from '../../marketing/meta-ads/change-ad-set-settings.js'
import { campaignCreateDraft, CREATE_CAMPAIGN_NOT_SENT, type CampaignCreateRequest } from '../../marketing/meta-ads/change-create-campaign.js'
import { adSetCreateDraft, CREATE_AD_SET_NOT_SENT, type AdSetCreateRequest } from '../../marketing/meta-ads/change-create-ad-set.js'
import { COPY_NOT_SENT, copyDraft, MAX_AD_IDS, type CopyRequest } from '../../marketing/meta-ads/change-copy.js'
import { madeByCopy, nothingMade, removalDraft, REMOVE_LATER, type MadeRecord } from '../../marketing/meta-ads/change-create-common.js'
import { createdIdOf, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import {
  BID_STRATEGIES, BILLING_EVENTS, CUSTOM_EVENT_TYPES, META_NAME_TEXT, META_STRICT_TEXT, OPTIMIZATION_GOALS, OPTIMIZATION_SUB_EVENTS, OUTCOME_OBJECTIVES,
} from '../../gateway/meta-settings-rules.js'
import { CREATE_SPECIAL_AD_CATEGORIES, DESTINATION_TYPES, RENAME_STRATEGIES } from '../../gateway/meta-create-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers: their sentences quote budgets, bids and caps (Meta's recommendations may too). */
const META_CREATE_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, steps: ADSPEND, metaRecommendations: ADSPEND, values: ADSPEND,
} as const

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const centsArg = (what: string) => z.number().int().positive().max(100_000_000_000).describe(`${what}, in minor units of the ad account's currency (cents for EUR)`)
const typedText = (max: number, pattern: RegExp) => z.string().trim().min(1).max(max).regex(pattern, 'no control or format characters')
const isoArg = (what: string) => z.string().trim().min(10).max(40).describe(`${what} (ISO 8601 with its offset, e.g. 2026-11-01T08:00:00Z)`)
const idArg = (what: string) => z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only').describe(what)
const activateArg = z.boolean().optional().describe('true: made ACTIVE — SPENDS MONEY once what it needs is on (the person\'s decision); left out: made PAUSED')
const removeMadeArg = z.literal(true).optional().describe('ONLY the undo of an earlier change of this tool (undo-change asks for it): deletes what that change made, nothing else')
const undoOfArg = z.string().trim().min(1).max(64).optional().describe('with removeMade: the id of the change undone (its record names what it made)')
const schedulesArg = z.array(z.object({
  startTime: isoArg('when the increase starts (in the future)'),
  endTime: isoArg('when it ends (at least 3 hours later)'),
  increaseCents: z.number().int().positive().max(100_000_000_000).optional().describe('an increase by an AMOUNT on the daily budget, minor units, whole currency units only (Meta does not document a smaller unit)'),
  increasePercent: z.number().int().min(1).max(700).optional().describe('or an increase by a PERCENTAGE of the daily budget (1–700)'),
})).min(1).max(50).describe('one-time budget increases made with it (daily budgets only; Meta: at most 50, each ≥ 3 hours, the total ≤ 8 daily budgets; the account needs Meta\'s budget scheduling)')
const promotedBase = {
  pixelId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('the pixel (one of the ad account\'s own) — with customEventType'),
  customEventType: z.enum(CUSTOM_EVENT_TYPES).optional().describe('the conversion event (PURCHASE, ADD_TO_CART, …)'),
  customEventStr: z.string().trim().min(1).max(100).optional().describe('with OTHER: the event\'s own name'),
  productCatalogId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('a catalog of the chosen ad account\'s business portfolio (never a portfolio another Nexus business uses)'),
  productSetId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('a product set of such a catalog'),
  valueSemanticType: z.enum(['VALUE', 'MARGIN', 'LIFETIME_VALUE']).optional().describe('what the event value means'),
}

// ── shared: live reads → draft, the undo, the record ───────────────────────────────────────────────────────────

/** A builder that turns a refusal of the live reads (another account, not that kind) into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

type CreateTool = 'create-meta-campaign' | 'create-meta-ad-set' | 'copy-meta-ads'
const UNDO_ONLY = new Set(['connectionId', 'why', 'removeMade', 'undoOf'])

/**
 * removeMade (the undo of an earlier change of this tool): the change's own record (read in this business: row-level
 * security), never ids a caller names; each object it made read live; deleted only while nothing else hangs under it and it
 * has spent nothing (change-create-common.ts removalDraft).
 */
async function removeMadeDraft(tool: CreateTool, args: Record<string, unknown>, account: MetaChangeAccount): Promise<MetaChangeDraft | { refusal: string }> {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !UNDO_ONLY.has(k))
  if (extra.length) return { refusal: `removeMade is the undo of an earlier ${tool} change and takes nothing else (${extra.join(', ')}).` }
  const changeId = typeof args.undoOf === 'string' ? args.undoOf.trim() : ''
  if (!changeId) return { refusal: `removeMade is only the undo of an earlier ${tool} change (undo-change asks for it with undoOf): this tool deletes nothing else.` }
  const row = await prisma.agentChange.findFirst({ where: { id: changeId, toolName: tool }, select: { after: true, undoneAt: true } })
  if (!row) return { refusal: `Change ${changeId} is not a ${tool} change of this business.` }
  if (row.undoneAt) return { refusal: `Change ${changeId} was undone already.` }
  const record = (row.after ?? {}) as unknown as MadeRecord & { adAccountId?: string }
  if (record.adAccountId && record.adAccountId !== account.adAccountId) return { refusal: `Change ${changeId} made its objects on another Meta ad account than the one this business uses now: Nexus deletes nothing there.` }
  const live: MadeNow[] = []
  for (const top of record.top ?? []) {
    try {
      live.push(await liveMadeObject(account.target, top.kind, top.id, record.madeAt))
    } catch (err) {
      // An object Nexus cannot read (another account now, a refusal) is kept: removalDraft says so.
      if (!(err instanceof MetaLiveRefusal)) throw err
    }
  }
  return removalDraft(record, live, tool)
}

/** The run's record: what the create or copy made (its ids from Meta's answer), or what the undo deleted. */
function madeFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) {
  const before = draft.before as MadeRecord
  const madeAt = new Date().toISOString()
  if (before.op === 'remove') {
    const removed = done.map((d) => ({ kind: d.request.kind, id: d.request.objectId }))
    return { data: { deleted: removed }, before, after: { ...nothingMade('remove'), madeAt, removed } satisfies MadeRecord }
  }
  const { request, result } = done[0]
  const node = result.node
  if (before.op === 'background-copy') {
    const requestSetId = createdIdOf(node)
    const after: MadeRecord = { ...nothingMade('background-copy'), madeAt, requestSetId, noUndo: [`Meta makes a background copy later and Nexus never has the copies' ids — ${REMOVE_LATER}.`] }
    return { data: { requestSetId, note: 'Meta makes the copies in the background: meta-campaigns view copies (or meta-ad-sets) shows them once made.' }, before, after }
  }
  const name = typeof request.params.name === 'string' ? request.params.name : null
  const made = before.op === 'copy'
    ? madeByCopy(request.kind, node, null)
    : (() => { const id = createdIdOf(node); return id ? [{ kind: request.kind, id, name }] : [] })()
  const top = made.length && made[0].kind !== 'creative' ? [{ kind: made[0].kind as MadeRecord['top'][number]['kind'], id: made[0].id }] : []
  const after: MadeRecord = { op: before.op, made, top, madeAt, ...(top.length ? {} : { noUndo: ['Meta did not answer the new object\'s id, so undo cannot tell it apart.'] }) }
  return {
    data: { made: made.map((m) => ({ kind: m.kind, id: m.id })), ...(top.length ? { id: top[0].id } : {}) },
    before,
    after,
  }
}

const bookkeeping = async () => 'Nexus\'s Meta pages show it after the next daily read; meta-campaigns, meta-ad-sets or meta-ad-details show it now.'

/** Undo of a create or a copy: the same tool deletes what this change made (removeMade + undoOf); the rest is said. */
function madeUndo(tool: CreateTool): ToolUndo {
  return {
    async current(change: ToolChange) {
      const after = (change.after ?? {}) as MadeRecord & { accountId?: string; adAccountId?: string }
      // Only on the account it was made on; the undo's own preview reads every object live before anything is queued.
      return (await recordAccount(after)) ? after : null
    },
    request(change: ToolChange) {
      const after = (change.after ?? {}) as MadeRecord & { accountId?: string }
      if (after.op === 'remove') return { refusal: 'This change deleted what an earlier change made: a deletion on Meta is final, there is nothing to put back.' }
      if (after.op === 'background-copy') return { refusal: `A background copy is made by Meta later and Nexus never had the copies' ids — ${REMOVE_LATER}.` }
      if (!after.top?.length) return { refusal: `This change recorded nothing it made on Meta${after.noUndo?.length ? ` (${after.noUndo.join(' ')})` : ''}.` }
      return {
        tool,
        args: {
          ...(after.accountId ? { connectionId: after.accountId } : {}),
          removeMade: true,
          ...(change.id ? { undoOf: change.id } : {}),
          why: `undo of an earlier ${tool}: delete what it made`,
        },
      }
    },
  }
}

const common = {
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A create or copy is undone (its undo deletes it) while nothing else hangs under it and it has spent nothing; the undo
  // itself (removeMade) and a background copy have no way back.
  reversibility: 'partial',
  consequencesFor: (args: Record<string, unknown>) => (args.removeMade === true || args.background === true ? { reversibility: 'none' as const } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_CREATE_MONEY,
} satisfies Partial<AgentTool>

const restOf = <T>(args: Record<string, unknown>): T => {
  const { connectionId: _c, why: _w, removeMade: _r, undoOf: _u, ...rest } = args
  return rest as T
}

// ── create-meta-campaign ────────────────────────────────────────────────────────────────────────────────────────

const buildCampaign = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.removeMade === true) return removeMadeDraft('create-meta-campaign', args, account)
  const request = restOf<CampaignCreateRequest>(args)
  const target = account.target
  const merged = request.promotedObject ? promotedMerged(null, request.promotedObject) : {}
  const pixels = merged.pixel_id ? await liveAccountPixels(target) : null
  const catalogProblem = merged.product_catalog_id || merged.product_set_id ? await metaCatalogProblem(target, { catalogId: merged.product_catalog_id ?? null, productSetId: merged.product_set_id ?? null }) : undefined
  const capabilities = request.budgetSchedules?.length ? await liveAccountCapabilities(target) : null
  const source = request.sourceCampaignId ? await liveCampaign(target, request.sourceCampaignId) : null
  return campaignCreateDraft(request, { adAccountId: account.adAccountId, currency: account.currency, pixels, catalogProblem, capabilities, source })
})

const createMetaCampaign: AgentTool = {
  ...common,
  name: 'create-meta-campaign',
  title: 'Make a Meta campaign (paused)',
  input: z.object({
    connectionId: metaConnectionArg,
    name: typedText(400, META_NAME_TEXT).optional().describe('its name (emoji allowed) — required'),
    objective: z.enum(OUTCOME_OBJECTIVES).optional().describe('required: OUTCOME_SALES, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS or OUTCOME_AWARENESS (OUTCOME_APP_PROMOTION is refused: no app is linked in Nexus; legacy objectives are deprecated)'),
    specialAdCategories: z.array(z.enum(CREATE_SPECIAL_AD_CATEGORIES)).max(4).optional().describe('its special ad categories (housing, employment, financial products, online gambling); none = [] (always sent). Never political or social-issue ads'),
    specialAdCategoryCountries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).min(1).max(250).optional().describe('the countries the category applies to (two letters; needed with a category)'),
    dailyBudgetCents: centsArg('a campaign daily budget (Advantage+ campaign budget: its ad sets share it)').optional(),
    lifetimeBudgetCents: centsArg('a campaign lifetime budget (each ad set then needs an end time)').optional(),
    bidStrategy: z.enum(BID_STRATEGIES).optional().describe('the bid strategy (always sent; default LOWEST_COST_WITHOUT_CAP — highest volume; Meta would default to a bid cap). LOWEST_COST_WITH_MIN_ROAS: Sales only, for good under a campaign budget'),
    budgetSharing: z.boolean().optional().describe('no campaign budget only: let ad sets share up to 20% of their budgets (sent false unless true; Meta lets it go off later but never on again)'),
    spendCapCents: centsArg('a spend cap over its whole run (Meta asks about USD 100 at least)').optional(),
    buyingType: z.enum(['AUCTION', 'RESERVED']).optional().describe('AUCTION (default) or RESERVED (reach and frequency: needs Meta\'s eligibility and a reservation per ad set; no spend cap, no special category)'),
    promotedObject: z.object(promotedBase).optional().describe('what every ad of it is optimised for (a pixel and its event, a catalog); usually set on each ad set'),
    budgetSchedules: schedulesArg.optional(),
    sourceCampaignId: idArg('bookkeeping only: the campaign of this ad account it was copied from (copy-meta-ads copies a campaign)').optional(),
    advantagePlus: z.boolean().optional().describe('check the levers of an Advantage+ sales or leads campaign (Sales / Leads with a campaign budget): Meta derives Advantage+ — the preview says what its ad sets need'),
    pcaUnified: z.literal(true).optional().describe('the unified PCA flow (is_pca_unified): Sales only, from 2026-10-22, for good (Meta: immutable after creation)'),
    activate: activateArg,
    removeMade: removeMadeArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'Make ONE new campaign on the business\'s chosen Meta ad account: its name, objective (Sales, Traffic, Engagement, '
    + 'Leads, Awareness), special ad category (always sent; [] when none — never political), its budget — a campaign '
    + 'budget (Advantage+ campaign budget) or budgets on its ad sets with ad set budget sharing said explicitly (Meta needs '
    + 'it since v24) —, its bid strategy (always sent: Meta would otherwise default to a bid cap), spend cap, reach and '
    + 'frequency buying, promoted object (the account\'s own pixel, its business portfolio\'s catalog), one-time budget '
    + 'increases, where it was copied from, the Advantage+ levers (Meta derives Advantage+; the preview says what its ad '
    + 'sets need) and the unified PCA flow (from 2026-10-22). Amounts in minor units of the account currency. It is made '
    + 'PAUSED: activate makes it ACTIVE — SPENDS MONEY once an ad set and an ad under it are on (the person\'s decision). '
    + 'Meta checks it first (validate_only) and the preview shows Meta\'s setup recommendations when it has any. Ad sets: '
    + `create-meta-ad-set. Not here: ${CREATE_CAMPAIGN_NOT_SENT.join(' ')} Undo deletes the campaign while nothing else `
    + 'hangs under it and it has spent nothing (read live first).'
    + META_CHANGE_RULES,
  undo: madeUndo('create-meta-campaign'),
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCampaign(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCampaign(args), madeFinish, bookkeeping),
}

// ── create-meta-ad-set ──────────────────────────────────────────────────────────────────────────────────────────

const buildAdSet = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.removeMade === true) return removeMadeDraft('create-meta-ad-set', args, account)
  const request = restOf<AdSetCreateRequest>(args)
  if (!request.campaignId) return { refusal: 'Name the campaign the new ad set goes in (campaignId; create-meta-campaign makes one).' }
  const target = account.target
  const campaign = await liveCampaign(target, request.campaignId)
  const ask = request.promotedObject ?? {}
  const merged = promotedMerged(null, ask)
  const pixels = merged.pixel_id ? await liveAccountPixels(target) : null
  let catalogProblem: string | null | undefined
  if (merged.product_catalog_id || merged.product_set_id || ask.boostedProductSetId) {
    catalogProblem = await metaCatalogProblem(target, { catalogId: merged.product_catalog_id ?? null, productSetId: merged.product_set_id ?? null })
    if (!catalogProblem && ask.boostedProductSetId) catalogProblem = await metaCatalogProblem(target, { catalogId: merged.product_catalog_id ?? null, productSetId: ask.boostedProductSetId })
  }
  const pageId = ask.pageId ? await liveChosenPage(target) : null
  const dsaDefaults = await liveDsaDefaults(target)
  const capabilities = request.budgetSchedules?.length ? await liveAccountCapabilities(target) : null
  return adSetCreateDraft(request, { adAccountId: account.adAccountId, currency: account.currency, campaign, pixels, catalogProblem, pageId, dsaDefaults, capabilities })
})

const createMetaAdSet: AgentTool = {
  ...common,
  name: 'create-meta-ad-set',
  title: 'Make a Meta ad set (paused)',
  input: z.object({
    connectionId: metaConnectionArg,
    campaignId: metaIdArg('required: the campaign it goes in (of this ad account)').optional(),
    name: typedText(400, META_NAME_TEXT).optional().describe('its name (≤ 400, emoji allowed) — required'),
    optimizationGoal: z.enum(OPTIMIZATION_GOALS).optional().describe('required: its performance goal (OFFSITE_CONVERSIONS, VALUE, LINK_CLICKS, REACH, …; the goals Meta allows depend on the objective)'),
    billingEvent: z.enum(BILLING_EVENTS).optional().describe('what is paid for (sent; default IMPRESSIONS — LINK_CLICKS and THRUPLAY goals may pay per click / ThruPlay)'),
    optimizationSubEvent: z.enum(OPTIMIZATION_SUB_EVENTS).optional().describe('an optimisation sub-event (video sound on, travel)'),
    destinationType: z.enum(DESTINATION_TYPES).optional().describe('where people convert (WEBSITE, SHOP_AUTOMATIC, MESSENGER, WHATSAPP, ON_AD instant forms, …; Meta calls some a beta)'),
    dailyBudgetCents: centsArg('its daily budget (no campaign budget; the ad set runs longer than 24 h)').optional(),
    lifetimeBudgetCents: centsArg('its lifetime budget (no campaign budget; needs endTime)').optional(),
    minSpendTargetCents: centsArg('under a campaign budget: the minimum it should spend (Meta\'s best effort)').optional(),
    spendCapCents: centsArg('under a campaign budget: the most it may spend').optional(),
    bidStrategy: z.enum(BID_STRATEGIES).optional().describe('its bid strategy (no campaign budget; sent, default LOWEST_COST_WITHOUT_CAP): a cap needs bidAmountCents, COST_CAP impressions billing, LOWEST_COST_WITH_MIN_ROAS the VALUE goal and roasGoal'),
    bidAmountCents: centsArg('its bid cap or cost cap (per 1,000 impressions when billed on impressions)').optional(),
    roasGoal: z.number().min(0.01).max(1000).optional().describe('its minimum ROAS with a ROAS goal strategy (2.5 = 2.5× the spend back; Meta writes it × 10,000)'),
    startTime: isoArg('when it starts (left out: now)').optional(),
    endTime: isoArg('when it ends').nullable().optional().describe('when it ends (ISO 8601); null: no end (daily budgets only)'),
    attribution: z.enum(ATTRIBUTION_PRESETS).optional().describe('the attribution Meta optimises on (1d_click, 7d_click, 1d_click_1d_view, 7d_click_1d_view: Sales with conversions; else 1d_click)'),
    promotedObject: z.object({
      ...promotedBase,
      pixelRule: z.string().trim().max(2000).optional().describe('a pixel rule (Meta\'s JSON rule as a string, ≤ 3 levels, ≤ 10 conditions)'),
      pageId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('the Page the ads promote — only the Facebook Page this business chose (Leads with instant forms need it)'),
      customConversionId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('one of the ad account\'s own custom conversions'),
      boostedProductSetId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('with productSetId: a product set of the same catalogs to push harder (Meta gives it to some accounts only)'),
    }).optional().describe('what it is optimised for: Sales with conversions need a pixel and its event, a custom conversion or a product set; apps, offers, events and WhatsApp numbers are not sent'),
    dynamicCreative: z.boolean().optional().describe('true: a dynamic creative ad set (for good; one creative with an asset feed; a placement-customised creative cannot run in it)'),
    budgetSchedules: schedulesArg.optional(),
    targeting: z.object({
      countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).min(1).max(250).optional().describe('countries (two letters)'),
      regions: z.array(z.string().trim().regex(/^\d{1,20}$/)).min(1).max(200).optional().describe('region keys (meta-targeting-search)'),
      cities: z.array(z.object({
        key: z.string().trim().regex(/^\d{1,20}$/).describe('a city key (meta-targeting-search)'),
        radiusKm: z.number().int().min(17).max(80).optional().describe('the radius around it in km (17–80)'),
      })).min(1).max(250).optional().describe('cities, with an optional radius'),
      ageMin: z.number().int().min(13).max(65).optional().describe('the minimum age (Meta\'s default 18; 18 at least in the EU; with Advantage+ audience at most 25)'),
      ageMax: z.number().int().min(13).max(65).optional().describe('the maximum age (not with Advantage+ audience)'),
      gender: z.enum(['all', 'male', 'female']).optional().describe('everyone (default), men or women'),
      customAudienceIds: z.array(z.string().trim().regex(/^\d{1,20}$/)).min(1).max(100).optional().describe('custom audiences it reaches (the account\'s own)'),
      excludedCustomAudienceIds: z.array(z.string().trim().regex(/^\d{1,20}$/)).min(1).max(100).optional().describe('custom audiences it never reaches'),
      advantageAudience: z.boolean().optional().describe('Advantage+ audience: Meta may reach beyond the ages, gender and audiences named (sent 0 unless true)'),
    }).optional().describe('required: who sees it — at least one location; placements, interests and the rest: set-meta-targeting / set-meta-placements after'),
    dsa: z.object({
      payor: typedText(512, META_STRICT_TEXT).describe('who pays for the ads (shown to people in the EU)'),
      beneficiary: typedText(512, META_STRICT_TEXT).describe('who benefits from the ads (shown to people in the EU)'),
    }).optional().describe('the EU payer and beneficiary: needed when it may reach the EU and the ad account saved no default'),
    activate: activateArg,
    removeMade: removeMadeArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'Make ONE new ad set in a campaign of the business\'s chosen Meta ad account: its name, performance goal, billing '
    + '(sent; impressions by default), destination, budget (its own — daily, longer than 24 h, or lifetime with an end — or, '
    + 'under a campaign budget, a minimum spend and a spend cap), bid strategy, bid or ROAS goal (step 18\'s rules and '
    + 'units), start and end, attribution, promoted object (the account\'s own pixel and custom conversions, its business '
    + 'portfolio\'s catalog and product sets, the Page this business chose), dynamic creative, one-time budget increases '
    + 'and who sees it: countries, regions, cities, age, gender, custom audiences, with Advantage+ audience sent explicitly '
    + '(off unless asked) — Meta\'s Advantage+ placements unless set-meta-placements narrows them later. An ad set that may '
    + 'reach the EU needs a payer and beneficiary: the account\'s saved defaults, else dsa — refused in words with neither. '
    + 'Amounts in minor units of the account currency. It is made PAUSED: activate makes it ACTIVE — SPENDS MONEY once an '
    + 'ad under it is on (the line says when its campaign is off, so nothing spends yet). Meta checks it first '
    + '(validate_only) and the preview shows Meta\'s setup recommendations. Ads: create-meta-ad. Not here: '
    + `${CREATE_AD_SET_NOT_SENT.join(' ')} Undo deletes the ad set while nothing else hangs under it and it has spent nothing (read live first).`
    + META_CHANGE_RULES,
  undo: madeUndo('create-meta-ad-set'),
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAdSet(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildAdSet(args), madeFinish, bookkeeping),
}

// ── copy-meta-ads ───────────────────────────────────────────────────────────────────────────────────────────────

const buildCopy = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.removeMade === true) return removeMadeDraft('copy-meta-ads', args, account)
  const request = restOf<CopyRequest>(args)
  if (!request.kind) return { refusal: 'Name what is copied: kind campaign, adset or ad.' }
  const target = account.target
  const dsaDefaults = await liveDsaDefaults(target)
  if (request.kind === 'ad' && request.background) {
    const targetAdSet = request.targetAdSetId ? await liveCopyTargetAdSet(target, request.targetAdSetId) : null
    return copyDraft(request, { adAccountId: account.adAccountId, currency: account.currency, source: null, sourceCampaign: null, targetCampaign: null, targetAdSet, dsaDefaults })
  }
  if (!request.sourceId) return { refusal: 'Name what is copied (sourceId).' }
  const source = await liveCopySource(target, request.kind, request.sourceId, request.kind !== 'ad' && request.deepCopy === true)
  const sourceCampaign = request.kind === 'campaign' && request.budgetOverride ? await liveCampaign(target, source.id) : null
  const targetCampaign = request.kind === 'adset' && request.targetCampaignId && request.targetCampaignId !== source.campaignId ? await liveCampaign(target, request.targetCampaignId) : null
  const targetAdSet = request.kind === 'ad' && request.targetAdSetId && request.targetAdSetId !== source.adSetId ? await liveCopyTargetAdSet(target, request.targetAdSetId) : null
  return copyDraft(request, { adAccountId: account.adAccountId, currency: account.currency, source, sourceCampaign, targetCampaign, targetAdSet, dsaDefaults })
})

const copyMetaAds: AgentTool = {
  ...common,
  name: 'copy-meta-ads',
  title: 'Copy Meta campaigns, ad sets, ads',
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(['campaign', 'adset', 'ad']).optional().describe('required: what is copied — campaign, adset or ad'),
    sourceId: idArg('the campaign, ad set or ad copied (of this ad account)').optional(),
    adIds: z.array(z.string().trim().regex(/^\d{1,20}$/)).min(1).max(MAX_AD_IDS).optional().describe(`kind ad with background only: up to ${MAX_AD_IDS} ads copied in one asynchronous request (Meta documents no parameters for it: its answer decides)`),
    deepCopy: z.boolean().optional().describe('a campaign or ad set WITH its children (ad sets and ads): Meta copies at most 3 ads in one request (more: background, up to 51)'),
    targetCampaignId: idArg('an ad set copy: into this campaign of the account (it takes that campaign\'s settings, such as its budget)').optional(),
    targetAdSetId: idArg('an ad copy: into this ad set of the account (Meta cannot move an ad: this copy is the way)').optional(),
    rename: z.object({
      strategy: z.enum(RENAME_STRATEGIES).optional().describe('DEEP_RENAME (the copy and its children), ONLY_TOP_LEVEL_RENAME (default) or NO_RENAME'),
      prefix: typedText(100, META_NAME_TEXT).optional().describe('put before the names'),
      suffix: typedText(100, META_NAME_TEXT).optional().describe('put after the names (Meta\'s default: a localised " - Copy")'),
    }).optional().describe('how the copy is named'),
    startTime: isoArg('an ad set copy\'s start, or a campaign deep copy\'s ad sets\' start').optional(),
    endTime: isoArg('its end').nullable().optional().describe('an ad set copy\'s end, or a campaign deep copy\'s ad sets\' end (ISO 8601); null: no end (daily budgets)'),
    budgetOverride: z.object({
      dailyBudgetCents: centsArg('the copy\'s campaign daily budget').optional(),
      lifetimeBudgetCents: centsArg('the copy\'s campaign lifetime budget').optional(),
    }).optional().describe('a campaign copy with another campaign budget of the same kind (Meta\'s parameter_overrides: keys undocumented, its answer decides)'),
    creative: z.object({
      name: typedText(100, META_NAME_TEXT).optional().describe('the new creative\'s name'),
      urlTags: z.string().trim().min(3).max(1024).regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces').optional().describe('the new creative\'s URL tags (key=value&key=value, e.g. utm_source=meta)'),
    }).optional().describe('an ad copy with a new creative like the source\'s, with this name and / or URL tags'),
    keepSourceStatus: z.literal(true).optional().describe('the copy takes the source\'s status (INHERITED_FROM_SOURCE) — only from a paused source'),
    background: z.boolean().optional().describe('copy in the background: a campaign or ad set with more than 3 ads (Meta: up to 51), or several ads (adIds). Nexus gets no ids back: no undo'),
    activate: activateArg,
    removeMade: removeMadeArg,
    undoOf: undoOfArg,
    why: metaWhyArg,
  }),
  description:
    'Copy ONE campaign, ad set or ad of the business\'s chosen Meta ad account: alone or with its children (deepCopy: '
    + 'Meta copies at most 3 ads in one request; up to 51 in the background), an ad set into another campaign of it (it '
    + 'takes that campaign\'s settings, such as its budget — a copy into another market is the person\'s decision), an ad '
    + 'into another ad set of it (Meta cannot move an ad: this is the way; the old one stays), renamed, with new times, a '
    + 'campaign with another campaign budget (Meta\'s parameter_overrides: its answer decides), an ad with its creative\'s '
    + 'name or URL tags changed (a new creative). The copy is made PAUSED (status_option sent explicitly); activate makes it '
    + 'ACTIVE — SPENDS MONEY (the line says when a parent is off, so nothing spends yet); keepSourceStatus only from a paused '
    + 'source. EU ad sets without a payer and beneficiary (and no account default) are refused in words. In the background '
    + '(background: a campaign or ad set with more than 3 ads, or up to 20 ads) Meta makes the copies later: no undo. Meta '
    + `has no check for a copy. Not here: ${COPY_NOT_SENT.join(' ')} Undo deletes the copy (its copied children go with it) `
    + 'while nothing else hangs under it and it has spent nothing (read live first).'
    + META_CHANGE_RULES,
  undo: madeUndo('copy-meta-ads'),
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCopy(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCopy(args), madeFinish, bookkeeping),
}

export const META_ADS_CREATE_TOOLS: AgentTool[] = [createMetaCampaign, createMetaAdSet, copyMetaAds]
