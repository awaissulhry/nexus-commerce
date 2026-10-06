/**
 * ADS PLAYBOOK PB-2 — ads-playbook: Claude reads HOW a product's Amazon ads are built and run (AdsPlaybookTemplate,
 * AdsPlaybook), per market and per category or product inside a market, through the one read the playbook screens use
 * (ads-playbook/read.ts):
 *
 *   effective  the playbook a product, a category or a market follows, each section with the row or template it came
 *              from; the product's own fields (enrolled, state, terms, budget, base bid, phase recipes); the slots it
 *              would be built from; what it owns; why it cannot compile yet; the strategy in force beside it (the phase)
 *   rows       every playbook row of a market
 *   templates  the business's templates (templateId: one, with its whole doc)
 *   history    the recorded changes of a template or of a market's rows
 *   capture    what a template captured from live campaigns would hold (a preview; nothing saved)
 *
 * Read only, Nexus only: no marketplace call. Honest: nothing reads a playbook yet (no engine, rule or Claude change);
 * an approved apply compiles it in a later step. Money (the product's budget and base bid, the least budget per slot,
 * the recipes' targets and bids, the strategy's numbers) sits only under the keys PLAYBOOK_MONEY names: a person without
 * financials.adspend.view gets the same answer minus exactly those keys.
 *
 * ADS PLAYBOOK PB-3 — set-ads-playbook: Claude asks to change ONE template or ONE playbook row (a market, a category or a
 * product in one market) through the one writer the Playbook section uses (ads-playbook/write.ts): set, capture a
 * template from live campaigns, enroll or take out a product (its phase recipes made absolute at enrollment), remove.
 * Nexus only. The preview judges each change by what it would make an enrolled product spend once applied; a change
 * that adds no spend may run by the business's rule inside the tool's limits; a RAISE never does — a person with
 * settings.security.manage approves it with their authenticator code, or the person who asked confirms it in Claude
 * with theirs, and `execute` checks that again. Undo writes the previous version back through this tool.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { PLAYBOOK_MONEY } from '../../advertising/ads-playbook/doc.js'
import { PLAYBOOK_VIEWS, readPlaybook, type PlaybookReadArgs } from '../../advertising/ads-playbook/read.js'
import {
  applyPlaybookPlan,
  PLAYBOOK_CHANGE_INPUT,
  planPlaybookChange,
  playbookStateNow,
  undoArgsOf,
  type PlaybookPreview,
  type PlaybookState,
} from '../../advertising/ads-playbook/write.js'
import { stepUpApproval } from '../step-up-approval.js'
import type { AgentTool, FieldPermission, ToolDoor, ToolUndo } from '../tool-types.js'
import { notRun } from './ads-change-kit.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const ID = z.string().trim().min(1).max(64)

const adsPlaybook: AgentTool = {
  name: 'ads-playbook',
  title: 'Ads playbook',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: PLAYBOOK_MONEY as Readonly<Record<string, FieldPermission>>,
  input: z.object({
    channel: z.preprocess(upper, z.enum(['AMAZON'])).default('AMAZON')
      .describe('AMAZON (default): the playbook covers Amazon Sponsored Products in this release'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (IT, DE, FR, ES, UK; business-overview lists them); omit for every market with a playbook or a campaign. capture needs one'),
    view: z.enum(PLAYBOOK_VIEWS).default('effective')
      .describe('effective (default): the playbook one scope follows, each part with its source; rows: every playbook row of a market; templates: the templates (templateId: one with its doc); history: recorded changes; capture: what a template captured from live campaigns would hold (nothing saved); compile: a dry run of building one product\'s playbook in one market (market and productId or sku; nothing created); build: the builds of a product\'s playbook (market and productId or sku), or one build (applicationId); drift: where what is live differs from what a product\'s playbook compiles to (market and productId or sku; a market alone: every enrolled product counted); winners: one product\'s search terms in one market — winning where they run, declining or lost, and the next step for each (market and productId or sku)'),
    productId: ID.optional().describe('effective or history: one product (a variation or a parent), its Nexus id'),
    sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
    categoryId: ID.optional().describe('effective or history: one category, its Nexus id (catalog-structure)'),
    templateId: ID.optional().describe('templates: one template, with its whole doc; history: that template\'s changes'),
    campaignIds: z.array(ID).min(1).max(50).optional()
      .describe('capture: the live campaigns to capture, their Nexus ids (campaignId in ad-campaigns); or portfolioId, or namePrefix'),
    portfolioId: z.string().trim().min(1).max(64).optional().describe('capture: every campaign of this Amazon portfolio (its Amazon portfolio id)'),
    namePrefix: z.string().trim().min(1).max(120).optional().describe('capture: every campaign whose name starts with this'),
    productToken: z.string().trim().min(1).max(60).optional()
      .describe("capture: the product's token in the campaign names (the word each campaign name of the set carries); it is taken out of the names, and a keyword holding it counts as brand"),
    competitorTokens: z.array(z.string().trim().min(1).max(60)).max(30).optional()
      .describe('capture: rival brand words, so a keyword holding one counts as competitor (a well-named campaign says it anyway)'),
    applicationId: ID.optional().describe('build: one build run, the applicationId apply-ads-playbook answered'),
    limit: z.coerce.number().int().min(1).max(100).default(20).describe('history: how many changes (default 20, max 100); build: how many builds (at most 50)'),
  }),
  description:
    "Read the business's Amazon Ads playbook: HOW a product's ads are built and run — the campaign set (slots: Auto, "
    + 'brand / competitor / category keywords by match type, product targeting), their names and portfolio, how the '
    + "product's daily budget splits, the start-bid ladder, placements, how harvested search terms flow between campaigns "
    + 'and which cross-negatives keep them apart, the hourly bid plans per rank role (performance, research), and the '
    + 'phase table (what changes in LAUNCH, GROW, PROFIT, CLEAR_STOCK, DEFEND and when to propose the next). A template is '
    + 'made once and reused; a playbook row per market, category or product names one and overrides parts of it (product '
    + '→ its parent → the deepest primary category → the market → the template; each part whole). view effective (default) '
    + "gives what one product, category or market follows, every part with its source, the product's own fields (enrolled "
    + '— a product is in only when its own row says so —, state, terms, daily budget, base bid, phase recipes), the slots '
    + 'it would be built from, what it owns (links), why it cannot compile yet, and the ads strategy in force beside it: '
    + "the phase is the strategy's goal, and the strategy's numbers are what the engines obey. For an enrolled product it "
    + 'also gives its phase check, computed by Nexus: days in phase and since when, the phase\'s hold, each exit rule with '
    + 'its numbers (ad orders, ACoS against the target, the change in orders, sellable units), the move Nexus proposes, '
    + "stock cover and the break-even ACoS (organic rank is not measured: DEFEND is the Owner's call). view rows lists a market's "
    + 'rows; templates the templates; history the changes; capture what a template captured from live campaigns would hold '
    + '(campaignIds, portfolioId or namePrefix, with productToken): slots, naming, budget shares, bid ladder, placements, '
    + "hourly plans by rank role and the product's terms — nothing is saved. view compile is a DRY RUN of building one "
    + "product's playbook in one market: every campaign, ad group, keyword, negative (the product's and the isolation "
    + 'ones), product ad, budget and start bid (the ladder clamped to the strategy\'s bid band) it would create, the '
    + "terms the product's own other campaigns already buy (skipped or accepted, as the template says), the terms other "
    + "products' campaigns also buy (kept and only listed: different products may share a keyword), the monthly caps, "
    + "the portfolio, and the blueprint gate's blockers — nothing is created, saved or sent. view build follows the builds "
    + 'apply-ads-playbook started (status, progress, the campaigns each made, what failed, what START will apply). view drift '
    + "lists where what is live differs from what one product's playbook compiles to in one market — a slot with no "
    + 'campaign, a campaign outside every slot, a child not advertised, a missing or misplaced keyword, a missing isolation, '
    + 'source or product negative, a placement off the playbook where the hourly plans do not own it, a compiled rule or '
    + 'hourly plan missing or changed, the portfolio, a name — each with what fixes it (apply-ads-playbook op sync, another '
    + 'tool, or nothing) and, for a change a person made himself, keep (into the playbook) or revert; bids and budgets the '
    + "engines moved are not drift, and the Owner's own hourly plans never are (a campaign they hold is listed as held). View "
    + "winners reads one product's search terms in its playbook campaigns in one market: winning where they run (kept there, "
    + 'nothing proposed), declining or lost, each with its next step in this order — bid (auto-bid already moves it toward '
    + 'the target), placement (a research slot or the term\'s own campaign, set-placement-multipliers), or a campaign of its '
    + 'own (apply-ads-playbook op hero) — with the bar (the strategy\'s harvest group), the target and the band it was judged '
    + 'on; an hourly plan\'s campaign or a performance slot is reported only. No engine, '
    + 'rule or Claude change follows a playbook until an approved apply compiles it. Budgets, bids and targets are '
    + 'ad-spend money: hidden from a person without permission to see ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readPlaybook(args as PlaybookReadArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

// ── PB-3 — set-ads-playbook ──────────────────────────────────────────────────────────────────────────────────────

/** Undo writes the previous version back through set-ads-playbook itself; refused once it moved since. */
export const SET_ADS_PLAYBOOK_UNDO: ToolUndo = {
  current: (change) => playbookStateNow(change.after as PlaybookState),
  request(change) {
    const before = change.before as PlaybookState | null
    const after = change.after as PlaybookState | null
    if (!before?.kind || !after?.kind) return { refusal: 'This change does not record the playbook it replaced.' }
    return { tool: 'set-ads-playbook', args: undoArgsOf(before, after) }
  },
}

/** The door a request came through, as the version row records it. */
const VIA: Record<ToolDoor, string> = { claude: 'claude', app: 'assistant', fleet: 'fleet', system: 'system' }

const setAdsPlaybook: AgentTool = {
  name: 'set-ads-playbook',
  title: 'Set the ads playbook',
  category: 'automation',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: nothing is sent to Amazon, and nothing reads a playbook until an approved apply compiles it.
  openWorld: false,
  // ads.automation.manage, and the ad-spend money a playbook holds (budgets, bids, recipes); a RAISE also needs
  // settings.security.manage and a fresh authenticator code, checked when it is approved and again in `execute`.
  requires: [F.adsAutomationManage, FIELDS.financialsAdspendView],
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: z.object({
    allowTemplateEdit: z.boolean().default(false)
      .describe('once this tool may run by rule: let a change of a TEMPLATE run without a person (a template reaches every product that follows it)'),
    markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
      .describe('once this tool may run by rule: the markets where a playbook row may change without a person (empty: every market)'),
  }),
  withinLimits(preview, limits) {
    const p = preview as Pick<PlaybookPreview, 'direction' | 'raises' | 'kind' | 'target'> | null
    if (!p?.direction) return 'there is no preview of this playbook change to check'
    if (p.direction === 'raise') return `it raises ${(p.raises ?? []).join(', ') || 'what a playbook may spend'}: a person with settings.security.manage decides, with their authenticator code`
    if (p.kind === 'template' && !limits.allowTemplateEdit) return 'a template reaches every product that follows it: this business lets a person decide each template change'
    const markets = (limits.markets as string[] | undefined) ?? []
    const market = p.target && 'market' in p.target ? p.target.market : null
    if (market && markets.length && !markets.includes(market)) return `this business lets the playbook change by rule only in ${markets.join(', ')}`
    return null
  },
  undo: SET_ADS_PLAYBOOK_UNDO,
  input: PLAYBOOK_CHANGE_INPUT,
  description:
    "Change the business's Amazon Ads playbook — HOW a product's ads are built and run — for ONE template or ONE playbook "
    + 'row. kind template: set (a new one needs its whole doc; or some sections, a name, a status), capture (a template '
    + 'captured from live campaigns: campaignIds, portfolioId or namePrefix, with market and productToken), remove (only '
    + 'while no row names it; retire it otherwise). kind playbook: a market, a category or a product in one market (level; '
    + 'a parent covers its variations): set its template, whole-section overrides (and on a product row the optional slots '
    + 'it leaves out, its name token, portfolio, daily budget, base bid, terms and phase recipes); op enroll includes the '
    + 'product (only into a playbook that compiles; its phase recipes are made absolute from its break-even ACoS, the '
    + "market's target and its base bid — the preview says from what); op leave takes it out; op remove deletes a row that "
    + 'owns nothing at Amazon. The preview lists every change from → to and judges each by what it would make an enrolled '
    + 'product spend once applied (RAISE: enrolling, a higher budget or base bid, more terms or slots, higher start-bid '
    + 'factors or placements, an isolation switch off). Nexus only: nothing reads a playbook yet and nothing at Amazon '
    + 'moves; a later step compiles it on an approved apply. Waits for a person to approve it in Nexus. A change that adds '
    + "no spend may run by the business's rule when the business allows it; a RAISE never does: a person with "
    + 'settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in '
    + 'Claude with theirs. Pass expectVersion (from ads-playbook) to refuse one that moved. Undo puts the previous version back.',
  async handler(args) {
    const planned = await planPlaybookChange(args)
    return 'error' in planned ? { ok: false, error: planned.error } : { ok: true, preview: planned.plan.preview }
  },
  async execute(args, ctx) {
    // One decision, re-checked against what was approved (the basis fingerprints the row, the changes and the recipes).
    const planned = await planPlaybookChange(args)
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    const { plan } = planned
    const approved = (ctx.approvedPreview as { basis?: unknown } | undefined)?.basis
    if (approved !== undefined && approved !== plan.preview.basis) {
      return notRun('Not run: what you approved has moved since — the playbook, its template or the products it judges changed. Ask for it again with the values as they are now.')
    }
    const approvalId = ctx.approvalId?.trim()
    if (!approvalId || !ctx.userId) return notRun('Not run: a playbook change runs only as an approved request, as the person who approved it.')
    let stepUpAt: Date | null = null
    if (plan.direction === 'raise') {
      // A raise runs only when it was approved with a fresh authenticator code (never by rule, never by a plain approve).
      const coded = await stepUpApproval(ctx)
      if ('refusal' in coded) return notRun(coded.refusal)
      stepUpAt = coded.at
    }
    const decision = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decidedBy: true } })
    const out = await applyPlaybookPlan(plan, {
      via: VIA[ctx.via] ?? ctx.via,
      actor: decision?.decidedBy ?? `user:${ctx.userId}`,
      actorUserId: ctx.userId,
      approvalId,
      stepUpAt,
      updatedBy: ctx.via === 'claude' ? `claude:${approvalId}` : `user:${ctx.userId}`,
    })
    if ('error' in out) return notRun(`Not run: ${out.error}`)
    return {
      ok: true,
      data: {
        id: out.id,
        version: out.version,
        direction: out.direction,
        changed: out.changes.length,
        note: 'Saved in Nexus; nothing is sent to Amazon, and nothing reads a playbook until an approved apply compiles it.',
      },
      change: { before: out.before, after: out.after },
    }
  },
}

export const ADS_PLAYBOOK_TOOLS: AgentTool[] = [adsPlaybook, setAdsPlaybook]
