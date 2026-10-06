/**
 * ADS AUTONOMY W1-2 — ads-strategy: Claude reads the Owner's Amazon Ads strategy (AdsStrategy), per market and per
 * category or product inside a market, through the one read the strategy screens use (ads-strategy/read.ts):
 *
 *   effective  every number in force for a market, a category, a product, a campaign or an ad group, each with the row
 *              it came from; the older settings that also bind; the campaigns whose own target ACoS wins; what Claude
 *              may do alone per kind of ad action
 *   rows       every strategy row of a market, and the older settings at the same grains
 *   history    the recorded changes, newest first
 *
 * Read only, Nexus only: no marketplace call. Honest about readers: each field's `readBy` names what acts on it
 * (W1-5: the bid engines read the target ACoS, the bid band and the largest change; W1-7: the search-term thresholds and
 * protection; W1-8: Claude's door reads what Claude may do alone) and `notReadYet` lists the rest; W1 wires the readers
 * one by one.
 * Money (targets, bids, caps, spend thresholds) sits only under the keys STRATEGY_MONEY names: a person without
 * financials.adspend.view gets the same answer minus exactly those keys.
 *
 * ADS AUTONOMY W1-3 — set-ads-strategy: Claude asks to change ONE row (a market, a category or a product in one market)
 * through the one writer the Strategy tab uses (ads-strategy/write.ts). Its preview judges every field raise / lower /
 * same on the value in force; a LOWERING may run by the business's rule (limits `allowLower`); a RAISE never does — a
 * person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked
 * confirms it in Claude with theirs, and `execute` checks that again (agents/step-up-approval.ts). Undo writes the
 * previous version back through this tool (an undo of a lowering is a raise: it needs the code too).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { STRATEGY_MONEY } from '../../advertising/ads-strategy/fields.js'
import { readStrategy, STRATEGY_VIEWS, type StrategyReadArgs } from '../../advertising/ads-strategy/read.js'
import {
  applyStrategyPlan,
  planStrategyChange,
  STRATEGY_CHANGE_INPUT,
  strategyStateNow,
  undoArgsOf,
  type StrategyPreview,
  type StrategyState,
} from '../../advertising/ads-strategy/write.js'
import { stepUpApproval } from '../step-up-approval.js'
import type { AgentTool, FieldPermission, ToolDoor, ToolUndo } from '../tool-types.js'
import { notRun } from './ads-change-kit.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const ID = z.string().trim().min(1).max(64)

const adsStrategy: AgentTool = {
  name: 'ads-strategy',
  title: 'Ads strategy',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: STRATEGY_MONEY as Readonly<Record<string, FieldPermission>>,
  input: z.object({
    channel: z.preprocess(upper, z.enum(['AMAZON'])).default('AMAZON')
      .describe('AMAZON (default): the strategy covers Amazon Sponsored Products in this release'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('one Amazon market code (IT, DE, FR, ES, UK; business-overview lists them); omit for every market with a strategy or a campaign. A campaign or an ad group answers in its own market'),
    view: z.enum(STRATEGY_VIEWS).default('effective')
      .describe('effective (default): every number in force for one scope, with the row it came from; rows: every strategy row of the market and the older settings at the same grains; history: the recorded changes, newest first'),
    productId: ID.optional().describe('effective or history: one product (a variation or a parent), its Nexus id'),
    sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
    categoryId: ID.optional().describe('effective or history: one category, its Nexus id (catalog-structure)'),
    campaignId: ID.optional()
      .describe('effective: one Amazon campaign, its Nexus id (campaignId in ad-campaigns): every product of its ad groups, the safer value per field'),
    adGroupId: ID.optional()
      .describe('effective: one ad group, its Nexus id (adGroupId in ad-targets): its products, the safer value per field'),
    limit: z.coerce.number().int().min(1).max(100).default(20).describe('history: how many changes (default 20, max 100)'),
  }),
  description:
    "Read the business's Amazon Ads strategy: what the Owner set per market, and per category or product inside a market "
    + '(goal and why, target ACoS or TACoS, monthly spend cap, lowest and highest bid, largest bid change, most actions per '
    + 'run, protection, harvest and negate thresholds, how a temporary stop works, and what Claude may do alone per kind of '
    + 'ad action). view effective (default) gives every number in force for a market, a category, a product, a campaign '
    + 'or an ad group, each with its source (product, its parent, the deepest primary category, or the market) and version; '
    + 'several products in one ad group take the safer number per field and name the product it came from; a category or '
    + 'product row always belongs to one market. It also lists the older settings that still bind (campaign bid limits, '
    + 'bid and harvest policies, the budget plan), the campaigns whose own target ACoS wins over the strategy, and the '
    + "business's own Claude level per ad tool and the level that applies here (effective: the strategy only narrows it). "
    + 'view rows lists every strategy row of a market; view history the changes. Each field\'s readBy names what acts on it '
    + "(the bid engines steer by its target ACoS after a campaign's own target and keep its lowest and highest bid and "
    + 'largest bid change — engines and rules are held to them, and a request a person approves that goes past the bid band '
    + "is warned on its card first; the search-term engines read the harvest and negate thresholds and protection; Claude's "
    + 'door reads what Claude may do alone); notReadYet lists the fields nothing reads yet, for which every engine works as '
    + 'before. Targets, bids, caps and spend thresholds are ad-spend money: hidden from a person without permission to see '
    + 'ad spend. Nexus only; reads nothing from Amazon.',
  handler: async (args) => {
    const out = await readStrategy(args as StrategyReadArgs)
    return 'error' in out ? { ok: false, error: out.error } : { ok: true, data: out.data }
  },
}

// ── W1-3 — set-ads-strategy ──────────────────────────────────────────────────────────────────────────────────────

/** C2 — undo writes the previous version back through set-ads-strategy itself; refused once the row moved since. */
export const SET_ADS_STRATEGY_UNDO: ToolUndo = {
  current: (change) => strategyStateNow(change.after as StrategyState),
  request(change) {
    const before = change.before as StrategyState | null
    const after = change.after as StrategyState | null
    if (!before?.level || !after?.level) return { refusal: 'This change does not record the strategy it replaced.' }
    return { tool: 'set-ads-strategy', args: undoArgsOf(before, after) }
  },
}

/** The door a request came through, as the version row records it. */
const VIA: Record<ToolDoor, string> = { claude: 'claude', app: 'assistant', fleet: 'fleet', system: 'system' }

const setAdsStrategy: AgentTool = {
  name: 'set-ads-strategy',
  title: 'Set the ads strategy',
  category: 'automation',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: nothing is sent to Amazon. A protected term binds Nexus's write gate at once; the fields an engine or a
  // door reads (readBy) act from its next run.
  openWorld: false,
  // ads.automation.manage, and the ad-spend money it holds; a RAISE also needs settings.security.manage and a fresh
  // authenticator code, checked when it is approved and again in `execute` (never in `requires`: tool-never.vitest).
  requires: [F.adsAutomationManage, FIELDS.financialsAdspendView],
  reversibility: 'full',
  // A lowering is a brake ("stopping is never harder than going", the set-ad-guardrail precedent): it may run by the
  // business's rule. A raise never does — no limit can let it (withinLimits).
  maxClaudeTrust: 'auto',
  limits: z.object({
    allowLower: z.boolean().default(true)
      .describe('once this tool may run by rule: let a change that only lowers (tightens) the strategy run without a person; a raise never does'),
  }),
  withinLimits(preview, limits) {
    const p = preview as Pick<StrategyPreview, 'direction' | 'raises'> | null
    if (!p?.direction) return 'there is no preview of this strategy change to check'
    if (p.direction === 'raise') return `it raises ${(p.raises ?? []).join(', ') || 'the strategy'}: a person with settings.security.manage decides, with their authenticator code`
    return limits.allowLower ? null : 'this business lets a person decide every change of the ads strategy'
  },
  undo: SET_ADS_STRATEGY_UNDO,
  input: STRATEGY_CHANGE_INPUT,
  description:
    "Change the business's Amazon Ads strategy for ONE scope: a market, or a category or a product inside one market "
    + '(level market | category | product; a parent covers its variations). values sets fields: goal and why, target '
    + '(ACOS or TACOS, a whole percent), monthly spend cap, lowest and highest bid and stop bid (cents), largest bid change, '
    + 'most actions per run, protection, harvest and negate thresholds, how a temporary stop works (low bids), what Claude '
    + 'may do alone per kind of ad action, review days; a value sets it, null clears it (inherit), absent leaves it; op remove '
    + 'deletes the row. At market level it can also add or remove protected search terms (they bind Nexus\'s write gate at '
    + "once) and clear the own target ACoS of the market's campaigns that would shadow the strategy (clearCampaignTargets; "
    + 'their old values are kept for undo). The preview lists every field from → to with the level it is in force from, and '
    + 'judges each RAISE or LOWER; it names the campaigns whose own target still wins. A field an engine reads acts from its '
    + "next run: the bid engines steer by the target ACoS and keep the lowest and highest bid and the largest bid change, "
    + 'the search-term engines read the harvest and negate thresholds and protection, and Claude\'s door holds every ad '
    + 'change Claude asks for there to what Claude may do alone (readBy says what reads each field; notReadYet lists the '
    + 'fields nothing reads, which move no bid or budget). Waits '
    + 'for a person to approve it in Nexus. A change that only lowers may run by the business\'s rule when the business allows '
    + 'it; a RAISE never does: a person with settings.security.manage approves it in Nexus with their authenticator code, or '
    + 'the person who asked confirms it in Claude with theirs. Pass expectVersion (from ads-strategy view rows) to refuse a '
    + 'row that moved. Undo puts the previous version back.',
  async handler(args) {
    const planned = await planStrategyChange(args)
    return 'error' in planned ? { ok: false, error: planned.error } : { ok: true, preview: planned.plan.preview }
  },
  async execute(args, ctx) {
    // One decision, re-checked against what was approved (the basis fingerprints the row, the terms and the campaigns).
    const planned = await planStrategyChange(args)
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    const { plan } = planned
    const approved = (ctx.approvedPreview as { basis?: unknown } | undefined)?.basis
    if (approved !== undefined && approved !== plan.preview.basis) {
      return notRun('Not run: what you approved has moved since — the strategy row, a protected term or a campaign\'s own target changed. Ask for it again with the values as they are now.')
    }
    const approvalId = ctx.approvalId?.trim()
    if (!approvalId || !ctx.userId) return notRun('Not run: a strategy change runs only as an approved request, as the person who approved it.')
    let stepUpAt: Date | null = null
    if (plan.direction === 'raise') {
      // A raise runs only when it was approved with a fresh authenticator code (never by rule, never by a plain approve).
      const coded = await stepUpApproval(ctx)
      if ('refusal' in coded) return notRun(coded.refusal)
      stepUpAt = coded.at
    }
    const decision = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decidedBy: true } })
    const out = await applyStrategyPlan(plan, {
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
        strategyId: out.strategyId,
        version: out.version,
        direction: out.direction,
        changed: out.changes.length,
        note: 'Saved in Nexus; nothing is sent to Amazon. The engines that read a changed field act on it from their next run (readBy in ads-strategy).',
      },
      change: { before: out.before, after: out.after },
    }
  },
}

export const ADS_STRATEGY_TOOLS: AgentTool[] = [adsStrategy, setAdsStrategy]
