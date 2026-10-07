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
 * (W1-5: the bid engines read the target ACoS, the bid band and the largest change; W1-6: the monthly market cap, the
 * stop bid and the actions per run; W1-6b: category and product caps; W1-7: the search-term thresholds and protection;
 * W1-8: Claude's door reads what Claude may do alone) and `notReadYet` lists the rest; W1 wires the readers one by one.
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
import type { AgentTool, FieldPermission, ToolDoor, ToolUndo } from '../tool-types.js'
import { notRun } from './ads-change-kit.js'
import { codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'

/**
 * set-ads-strategy's code decision, in ONE place: a raise is a big door of the Owner's code rule (ads-code-rule.ts) —
 * the stepUp the strategy writer puts on a raise stays. Should the table ever let it go, a raise of what Claude may do
 * alone (claudeAutonomy) still keeps it: the Owner's own rule, which the writer enforces too. Never by rule either way.
 */
export function strategyCodeOf(preview: StrategyPreview): StrategyPreview & { noCode?: string } {
  if (!preview.stepUp || needsCode('set-ads-strategy: a raise')) return preview
  if (preview.changes.some((c) => c.field === 'claudeAutonomy' && c.direction === 'raise')) return preview
  return { ...preview, stepUp: null, noCode: DAY_TO_DAY_NO_CODE }
}

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
    + '(goal and why, target ACoS or TACoS and its band, monthly spend cap, lowest and highest bid, largest bid change, most actions per '
    + 'run, protection, harvest and negate thresholds, how a temporary stop works, what Claude may do alone per kind of '
    + "ad action, and the most changes, raises and budget increase Claude's ad changes may run by rule in a market a day — "
    + 'empty is 0). view effective (default) gives every number in force for a market, a category, a product, a campaign '
    + 'or an ad group, each with its source (product, its parent, the deepest primary category, or the market) and version; '
    + 'several products in one ad group take the safer number per field and name the product it came from; a category or '
    + 'product row always belongs to one market. It also lists the older settings that still bind (campaign bid limits, '
    + 'bid and harvest policies, the budget plan), the campaigns whose own target ACoS wins over the strategy, and the '
    + "business's own Claude level per ad tool and the level that applies here (effective: the strategy only narrows it). "
    + 'view rows lists every strategy row of a market; view history the changes. Each field\'s readBy names what acts on it '
    + "(the bid engines steer by its target ACoS after a campaign's own target and keep its lowest and highest bid and "
    + 'largest bid change — engines and rules are held to them, and a request a person approves that goes past the bid band '
    + "is warned on its card first; the budget engine reads the monthly caps — the market's, a category's, a product's — "
    + "and the stop bid; the retail guard and suppress-campaign the stop bid; the engines' guard the actions per run; the "
    + "search-term engines read the harvest and negate thresholds and protection; Claude's door reads what Claude may do "
    + 'alone); notReadYet lists the fields nothing reads yet, for which every engine works as before. A market cap also '
    + "says how this month stands (thisMonth: spend so far, the forecast, the cap where bids drop until the 1st); a "
    + "category's or product's cap says its own scope's spend so far and whether it is reached (then every ad group "
    + 'holding a product under it is at low bids until the 1st); a cap of 0 is no cap. Targets, bids, caps and spend '
    + 'thresholds are ad-spend money: hidden from a person without permission to see ad spend. Nexus only; reads nothing '
    + 'from Amazon.',
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
    + '(ACOS or TACOS, a whole percent: the aim, with an optional band loPct–hiPct around it that the bid brain, in shadow, '
    + 'leaves a bid alone inside), monthly spend cap, lowest and highest bid and stop bid (cents), largest bid change, '
    + 'most actions per run, protection, harvest and negate thresholds, how a temporary stop works (low bids), what Claude '
    + 'may do alone per kind of ad action, review days, and (market only) the most changes, raises and budget increase '
    + "Claude's ad changes may run by the business's rule there in a day — empty or 0 means none runs by rule; a value "
    + 'sets it, null clears it (inherit), absent leaves it; op remove '
    + 'deletes the row. At market level it can also add or remove protected search terms (they bind Nexus\'s write gate at '
    + "once) and clear the own target ACoS of the market's campaigns that would shadow the strategy (clearCampaignTargets; "
    + 'their old values are kept for undo). The preview lists every field from → to with the level it is in force from, and '
    + 'judges each RAISE or LOWER; it names the campaigns whose own target still wins. Only a field something reads acts '
    + '(readBy names it: e.g. the bid engines steer by the target ACoS and keep the lowest and highest bid and the largest '
    + 'bid change; the budget engine stops a market at its monthly cap with the stop bid; Claude\'s door holds every ad '
    + 'change Claude asks for there to the lower level of what Claude may do alone); every other field is stored and shown '
    + 'only (notReadYet). Waits '
    + 'for a person to approve it in Nexus. A change that only lowers may run by the business\'s rule when the business allows '
    + 'it; a RAISE never does: a person with settings.security.manage approves it in Nexus with their authenticator code, or '
    + 'the person who asked confirms it in Claude with theirs. Pass expectVersion (from ads-strategy view rows) to refuse a '
    + 'row that moved. Undo puts the previous version back.',
  async handler(args) {
    const planned = await planStrategyChange(args)
    return 'error' in planned ? { ok: false, error: planned.error } : { ok: true, preview: strategyCodeOf(planned.plan.preview) }
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
    let raiseWithoutCode: string | null = null
    if (plan.direction === 'raise') {
      // A raise never runs by rule (withinLimits refuses it; this is the last door), and runs only with a fresh
      // authenticator code where the fresh dry run's stepUp asks it (the code table: a big door) — never a plain approve.
      if (ctx.decidedVia === 'auto') return notRun('Not run: it raises the ads strategy, which a person decides, never a rule. Ask for it again; a person approves it.')
      const gate = await codeGate(ctx, strategyCodeOf(plan.preview))
      if ('refusal' in gate) return notRun(gate.refusal)
      stepUpAt = gate.at
      if (!stepUpAt) raiseWithoutCode = "approved by a person without the authenticator code: the Owner's code rule makes this raise a day-to-day change"
    }
    const decision = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decidedBy: true } })
    const out = await applyStrategyPlan(plan, {
      via: VIA[ctx.via] ?? ctx.via,
      actor: decision?.decidedBy ?? `user:${ctx.userId}`,
      actorUserId: ctx.userId,
      approvalId,
      stepUpAt,
      raiseWithoutCode,
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
        note: 'Saved in Nexus; the save itself sends nothing to Amazon. A field something reads acts from now on (readBy); every other field is stored and shown only (notReadYet).',
      },
      change: { before: out.before, after: out.after },
    }
  },
}

export const ADS_STRATEGY_TOOLS: AgentTool[] = [adsStrategy, setAdsStrategy]
