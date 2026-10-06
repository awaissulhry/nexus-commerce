/**
 * MCP full control R9–R15 (plan part 06 §3) — Claude changes automations: a request the door stores as an approval
 * (a person decides it, or — where a tool's ceiling and the business's limits allow — the business's rule), through the
 * automations' own services, with their audit rows, a stored change and an undo.
 *
 * Rules every tool here follows (part 06 §3):
 *   · a rule never pauses, archives or switches anything on — such an action, rule or suggestion is refused, naming the
 *     substitute (lower bids for a temporary stop; AA-W2-12/13: a real pause, an enable or an archive is its own request —
 *     pause-ads, enable-ads, archive-ads);
 *   · a rule is born OBSERVE (eBay: OFF) and climbs one step per request; AUTO only through the graduation gate (D-R1).
 *     AA-W2-11 (D-W2-4 = A): by the business's rule only for automations it lists, once their gate is open; the ads
 *     dial and an engine the env switches stay a person's click (automation-limits.ts);
 *   · no delete: a rule is retired to OFF;
 *   · env is the server's: nothing here reads or writes an env value.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { AgentTool, ToolUndo } from '../tool-types.js'
import { RULE_KINDS, type RuleKind } from '../../automation/automation-rule-guard.js'
import { applyAdRuleSave, planAdRuleSave, readRuleConfig, type SaveRuleInput, type SavedRuleConfig } from '../../automation/ad-rule-save.service.js'
import { automationAdapter } from '../../automation/automation-catalog.service.js'
import type { AutomationLevel } from '../../automation/automation-levels.js'
import { applySwitch, planSwitch, readSwitchRow, switchPermission, type Direction } from '../../automation/automation-switch.service.js'
import { AUTOMATION, AUTOMATION_RESTRICTED_FIELDS } from './automation-read.tools.js'
import { RULE_DOMAINS, STOP_AREAS, applyStop, planStop, stopPermission, stopStateNow, type RuleDomain, type StopArea, type StopChange } from '../../automation/automation-stop.service.js'
import type { ToolContext } from '../tool-types.js'
import { STEER_ACTIONS, STEER_LEVELS, applySteer, assignmentStateNow, charterStateNow, planSteer, steerUndoOf, type SteerInput, type SteerRecord } from '../../agent-fleet/fleet-steer-plan.service.js'
import { ENGINE_SETTINGS, SETTING_ARG, applyTune, planTune, restoreArgsOf, tuneStateNow, type EngineSetting, type TuneInput, type TuneRecord } from '../../advertising/ads-engine-tune.service.js'
import type { DecisionItem } from '../../advertising/ads-suggestion-decide.service.js'
import type { StoredReach } from './ads-change-kit.js'
import { SUGGESTION_LIMITS, suggestionLimitFacts, suggestionRefusal } from './suggestion-limits.js'
import { SAVE_RULE_LIMITS, TUNE_LIMITS, TURN_UP_LIMITS, automationFacts, ruleSaveFacts, ruleSaveRefusal, tuneRefusal, turnUpRefusal } from './automation-limits.js'
import { automationScope, tuneScope } from '../../advertising/ads-strategy/automation-scope.js'
import { CAMPAIGN_GUARDRAIL_KINDS, isCampaignKind } from '../../advertising/ads-guardrail-change.service.js'

const ID = z.string().trim().min(1).max(64)
const JSON_OBJECT = z.record(z.string().max(64), z.unknown())

const RULE_SCOPE = z.object({
  marketplace: z.string().trim().min(1).max(20).optional().describe('the market it may act on, e.g. IT (eBay: EBAY_IT)'),
  portfolioId: ID.optional().describe('Amazon: the portfolio (its Amazon portfolio id) it may act on'),
  campaignId: ID.optional().describe('Amazon: the one campaign (Nexus id) it may act on'),
  productId: ID.optional().describe('Amazon: the product line (parent) or variation (Nexus id) it may act on'),
  campaignIds: z.array(ID).max(200).optional().describe('eBay: the campaigns it may act on'),
  wholeAccount: z.boolean().optional().describe('true to let it reach every campaign — said out loud, never implied'),
})

const COUNT = z.coerce.number().int().min(0).max(1_000_000_000)
const RULE_CAPS = z.object({
  maxExecutionsPerDay: COUNT.nullable().optional().describe('runs per day it may act on; above 0'),
  maxWritesPerDay: COUNT.nullable().optional().describe('writes per day before it falls back to a dry run; above 0'),
  maxValueCentsEur: COUNT.nullable().optional().describe('euro cents one run may commit; above 0'),
  maxDailyAdSpendCentsEur: COUNT.nullable().optional().describe('optional: euro cents of ad spend per day'),
})

/** save-ad-rule's arguments that put a saved rule back exactly as it was (its undo). */
export function saveArgsOf(config: SavedRuleConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: config.kind, ruleId: config.ruleId, name: config.name, trigger: config.trigger, scope: config.scope }
  if (config.kind === 'ebay-ads') {
    out.action = config.action
    if (config.guardrails != null) out.guardrails = config.guardrails
    if (config.cooldownHours != null) out.cooldownHours = config.cooldownHours
  } else {
    out.description = config.description ?? null
    out.conditions = config.conditions ?? []
    out.actions = config.actions ?? []
    out.caps = config.caps ?? {}
  }
  return out
}

/** C2 — undo of save-ad-rule: save the rule as it was, through save-ad-rule itself. A rule it created is retired, never deleted. */
export const SAVE_AD_RULE_UNDO: ToolUndo = {
  async current(change) {
    const after = change.after as SavedRuleConfig
    return (await readRuleConfig(after.kind, after.ruleId))?.config ?? null
  },
  request(change) {
    const before = change.before as (SavedRuleConfig & { created?: boolean }) | null
    const after = change.after as SavedRuleConfig
    if (!before || before.created) {
      // A rule this change created is retired, never deleted: turned down to OFF (an eBay rule was saved OFF already).
      if (after.kind === 'ebay-ads') return { refusal: `"${after.name}" was saved switched off; removing it is a person's click in Nexus.` }
      return { tool: 'turn-down-automation', args: { automation: after.kind === 'marketing' ? 'E2' : 'A1', rowId: after.ruleId, level: 'OFF' } }
    }
    return { tool: 'save-ad-rule', args: saveArgsOf(before) }
  },
}

function inputOf(args: Record<string, unknown>): SaveRuleInput {
  return {
    kind: args.kind as RuleKind,
    ruleId: args.ruleId as string | undefined,
    name: args.name as string | undefined,
    description: args.description as string | null | undefined,
    trigger: args.trigger,
    conditions: args.conditions as unknown[] | undefined,
    actions: args.actions as unknown[] | undefined,
    action: args.action,
    guardrails: args.guardrails,
    scope: args.scope as SaveRuleInput['scope'],
    caps: args.caps as SaveRuleInput['caps'],
    cooldownHours: args.cooldownHours as number | undefined,
  }
}

const saveAdRule: AgentTool = {
  name: 'save-ad-rule',
  title: 'Save an ads rule',
  category: 'automation',
  description:
    'Create or edit an ads rule — Amazon ads (kind amazon-ads), eBay ads (ebay-ads) or a marketing campaign rule ' +
    '(marketing). Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code ' +
    'when the business set it so — or, for an Amazon ads rule only, run by the business\'s rule inside its limits and the ' +
    'ads strategy of the rule\'s scope (every cap set and within those limits, 0 by default; a rule for the whole account ' +
    'waits for a person). A new rule is born OBSERVE (it runs and records, proposes ' +
    'and writes nothing; an eBay rule is saved OFF) and climbs with turn-up-automation. Refused, in words: any pause ' +
    '(a rule never pauses — use lower_bid_to_floor for a temporary stop; a real pause is its own request, pause-ads), an action outside the allowed ones, no scope (say wholeAccount: true for ' +
    'the whole account), a cap missing or 0, a percent where a fraction belongs (condition ratios such as acos are fractions: 0.3, not 30; ' +
    'action values carry their own unit — bid_apply\'s targetAcos and every …Pct value are percents, and eBay rule values are ' +
    'percents), a condition on a field ' +
    "the trigger never hands the rule, no conditions. Editing an AUTO rule drops it to PROPOSE. Amazon and marketing " +
    'rules: trigger, conditions [{ field, op, value }], actions [{ type, … }], caps. eBay: trigger { scope, all }, action, ' +
    'guardrails { maxActionsPerRun }. Give ruleId to edit: fields left out keep the rule\'s own.',
  riskTier: 'medium',
  readOnly: false,
  // A rule save is always stored as an approval: no tool policy can let it run unasked.
  requiresApprovalDefault: true,
  // Nexus only: a saved rule acts only once it is turned up.
  openWorld: false,
  requires: [F.adsAutomationManage, FIELDS.financialsAdspendView],
  // The previous rule is recorded and put back by undo; a new rule is retired to OFF.
  reversibility: 'full',
  // AA-W2-11 — an Amazon ads rule may be saved by the business's rule, inside the ads strategy of its scope and these
  // limits (automation-limits.ts); a save never raises a rule's level, so it acts on nothing by itself.
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: SAVE_RULE_LIMITS,
  withinLimits: ruleSaveRefusal,
  undo: SAVE_AD_RULE_UNDO,
  input: z.object({
    kind: z.enum(RULE_KINDS as [RuleKind, ...RuleKind[]]).describe('amazon-ads, ebay-ads or marketing'),
    ruleId: ID.optional().describe('the rule to edit (from list-automations / automation-detail); omit to create one'),
    name: z.string().trim().min(1).max(120).optional().describe('its name; required for a new rule'),
    description: z.string().max(500).nullable().optional().describe('Amazon / marketing: what it is for'),
    trigger: z.union([z.string().trim().min(1).max(64), JSON_OBJECT]).optional()
      .describe('Amazon / marketing: the trigger name (e.g. KEYWORD_HIGH_ACOS, MKT_ACOS_BREACH); eBay: { scope: CPS_AD | CPC_KEYWORD, all: [conditions] }'),
    conditions: z.array(JSON_OBJECT).max(50).optional().describe('Amazon / marketing: [{ field, op, value }] on fields the trigger hands the rule; ratios as fractions'),
    actions: z.array(JSON_OBJECT).max(20).optional().describe('Amazon / marketing: [{ type, …parameters }] — bids, budgets, placements, negatives, harvest, retail guard, notify'),
    action: JSON_OBJECT.optional().describe('eBay: one action { type, … } — adjust_ad_rate, set_rate_to_breakeven_factor, bid_down_keyword, alert'),
    guardrails: JSON_OBJECT.optional().describe('eBay: { maxActionsPerRun (required, above 0), minClicks?, minSpendCents?, maxBidChangePct? }'),
    scope: RULE_SCOPE.optional().describe('what it may act on; replaces the rule\'s scope when given'),
    caps: RULE_CAPS.optional().describe('Amazon / marketing: its caps; merged into the rule\'s own'),
    cooldownHours: z.coerce.number().int().min(1).max(720).optional().describe('eBay: hours before it may act on the same entity again'),
  }),
  async handler(args, ctx) {
    if (args.kind === 'marketing' && !ctx.can(F.marketingAutomationManage)) {
      return { ok: false, error: `A marketing rule needs the ${F.marketingAutomationManage} permission.` }
    }
    const planned = await planAdRuleSave(inputOf(args))
    if ('error' in planned) return { ok: false, error: planned.error }
    const { config, ...preview } = planned.plan
    // AA-W2-11 — what the business's rule is judged on: the ads strategy of its scope, its caps, its level after the save.
    const byRule = await ruleSaveFacts({ kind: planned.plan.kind, ruleId: planned.plan.ruleId, scope: planned.plan.scope, caps: config.caps, level: planned.plan.level }, ctx.approvalId)
    return { ok: true, preview: { ...preview, ...byRule } }
  },
  async execute(args, ctx) {
    if (args.kind === 'marketing' && !ctx.can(F.marketingAutomationManage)) {
      return { ok: false, error: `A marketing rule needs the ${F.marketingAutomationManage} permission.` }
    }
    const out = await applyAdRuleSave(inputOf(args), ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return {
      ok: true,
      data: { ruleId: out.ruleId, name: out.after.name, level: out.level, created: out.before == null },
      // A creation records what it created as `before` (created: true), never null: a change with no before cannot be undone (C2).
      change: { before: out.before ?? { kind: out.after.kind, ruleId: out.ruleId, name: out.after.name, created: true }, after: out.after },
    }
  },
}

// ── R10 — turn-up-automation / turn-down-automation ──────────────────────────────────────────────────

/** What a switch move changed: the automation, its row (none for the ads dial), and the level. */
interface SwitchChange { automation: string; rowId: string | null; name: string; level: AutomationLevel }

function switchArgs(change: SwitchChange, level: AutomationLevel): Record<string, unknown> {
  return { automation: change.automation, ...(change.rowId ? { rowId: change.rowId } : {}), level }
}

async function levelNow(change: SwitchChange): Promise<SwitchChange | null> {
  const adapter = automationAdapter(change.automation)
  const row = adapter ? await readSwitchRow(adapter, change.rowId ?? undefined) : null
  return row ? { automation: change.automation, rowId: change.rowId, name: row.name, level: row.level } : null
}

/** C2 — a switch move is put back by the opposite move to the level it replaced, through the same gate (AUTO: the gate again). */
function switchUndo(direction: Direction): ToolUndo {
  return {
    current: (change) => levelNow(change.after as SwitchChange),
    request(change) {
      const before = change.before as SwitchChange
      return { tool: direction === 'up' ? 'turn-down-automation' : 'turn-up-automation', args: switchArgs(before, before.level) }
    },
  }
}

function permitted(ctx: ToolContext, automation: unknown, rowId?: unknown): { adapter: NonNullable<ReturnType<typeof automationAdapter>> } | { error: string } {
  const adapter = automationAdapter(String(automation ?? ''))
  if (!adapter) return { error: `There is no automation "${String(automation)}".` }
  if (!ctx.can(adapter.view)) return { error: `${adapter.name} needs the ${adapter.view} permission.` }
  const manage = switchPermission(adapter, rowId ? String(rowId) : undefined)
  if (manage && !ctx.can(manage)) return { error: `Switching ${adapter.name} needs the ${manage} permission.` }
  return { adapter }
}

function switchTool(direction: Direction): AgentTool {
  const up = direction === 'up'
  const levels = (up ? ['OBSERVE', 'PROPOSE', 'AUTO'] : ['OFF', 'OBSERVE', 'PROPOSE']) as [AutomationLevel, ...AutomationLevel[]]
  return {
    name: up ? 'turn-up-automation' : 'turn-down-automation',
    title: up ? 'Turn an automation up' : 'Turn an automation down',
    category: 'automation',
    description: up
      ? 'Move an automation (an ads rule, an eBay or operations rule, the ads dial, a plan, a pool, a schedule, a coverage set, ' +
        'an autonomous agent, a repricing rule) UP the OFF · OBSERVE · PROPOSE · AUTO ladder. A move waits for a person: ' +
        'approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so — unless ' +
        'the business lets it run by its rule inside its limits and, for an Amazon ads automation, the ads strategy where it ' +
        'acts (its products, else its market; one for the whole account or across markets waits): up to PROPOSE by default; ' +
        'AUTO only for an automation the ' +
        'business lists, once its graduation gate is open (the preview shows the evidence), and a rule only with its own caps ' +
        'set inside those limits. A rule (Amazon or eBay ads, marketing, listing, replenishment, review or bulk-operation) ' +
        'reaches AUTO only after the graduation gate (14 days watched, 10 real runs, 1 match; an Amazon ads rule also a live ' +
        'production connection) — refused otherwise, for a person too; an Amazon ads rule\'s graduation ceiling and a contested ' +
        'placement lane refuse too. An autopilot plan, a budget pool, a dayparting or budget schedule and a coverage set do ' +
        'not hold a person\'s click, but the business\'s rule takes them to AUTO only on the same evidence: a plan\'s decided ' +
        'proposals, a pool\'s rebalances, a schedule\'s writes while it was on, the coverage engine\'s records for a set. The ' +
        'ads dial and a repricing rule have no such evidence: their AUTO is a person\'s click. An engine the server env switches ' +
        '(rank-defend, budget enforcement, auto-bid, top-of-search defense, the coverage engine, the fleet sweep, the snapshot ' +
        'repricer) has a switch for this business — leave rowId out: it goes up only as far as the env allows, and only with a ' +
        'person\'s click.'
      : 'Move an automation DOWN the ladder (to PROPOSE, OBSERVE or OFF). Waits for a person to approve it in Nexus, unless ' +
        'the business lets Claude run it by its rule inside its limits. A brake — a rule that lowers bids or negates, a ' +
        'dayparting or budget schedule, budget enforcement, rank-defend — is said to be one: turning it down can raise spend, ' +
        'so it waits for a person unless the business\'s limits let Claude turn brakes down (never by default). Nothing is ' +
        'deleted: OFF is how a rule is retired. An ' +
        'engine the server env switches is turned down for this business alone with rowId left out.',
    riskTier: 'medium',
    readOnly: false,
    requiresApprovalDefault: true,
    // At AUTO a rule writes to a marketplace; a dayparting schedule switched off restores bids and may resume a campaign.
    openWorld: true,
    // Seeing automations (ai.view, as list-automations) is the floor; each kind's own manage permission is checked per call.
    requires: [F.aiView],
    reversibility: 'full',
    // AA-W2-11 (D-W2-4 = A) — up may run by rule too: to AUTO only for listed automations once their gate is open. Up is
    // the ads strategy's `automation` kind: judged where the automation acts (automation-scope.ts). Down is a brake.
    maxClaudeTrust: 'auto',
    ...(up ? { strategyBound: 'amazon-ads' as const } : {}),
    limits: up
      ? TURN_UP_LIMITS
      : z.object({ allowBrakeDown: z.boolean().default(false).describe('let Claude turn a brake down without a person (it can raise spend); never by default') }),
    withinLimits(preview, limits) {
      if (up) return turnUpRefusal(preview, limits)
      const p = preview as { to?: AutomationLevel; brake?: string | null } | null
      if (!p?.to) return 'there is no preview of this move to check'
      return p.brake && !limits.allowBrakeDown ? `turning a brake down can raise spend (${p.brake}): a person decides` : null
    },
    undo: switchUndo(direction),
    input: z.object({
      automation: AUTOMATION.describe('the automation: its number from list-automations (A1 … N17) or its key'),
      rowId: ID.optional().describe('the row to switch (a rule, plan, pool, schedule …); omit for the ads dial (A3) or an engine\'s own switch'),
      level: z.enum(levels).describe(up ? 'the level to go up to: OBSERVE, PROPOSE or AUTO' : 'the level to go down to: PROPOSE, OBSERVE or OFF'),
    }),
    async handler(args, ctx) {
      const found = permitted(ctx, args.automation, args.rowId)
      if ('error' in found) return { ok: false, error: found.error }
      const planned = await planSwitch(found.adapter, args.rowId as string | undefined, args.level as AutomationLevel, direction)
      if ('error' in planned) return { ok: false, error: planned.error }
      if (!up) return { ok: true, preview: planned.plan }
      // AA-W2-11 — what the business's rule is judged on: the ads strategy where the automation acts.
      const byRule = await automationFacts(await automationScope(found.adapter.key, args.rowId as string | undefined), 'turn-up-automation', ctx.approvalId, [planned.plan.row.id])
      return { ok: true, preview: { ...planned.plan, ...byRule } }
    },
    async execute(args, ctx) {
      const found = permitted(ctx, args.automation, args.rowId)
      if ('error' in found) return { ok: false, error: found.error }
      const out = await applySwitch(found.adapter, args.rowId as string | undefined, args.level as AutomationLevel, direction, ctx.userId ?? null)
      if ('error' in out) return { ok: false, error: out.error }
      // An engine's own switch (R16) and the ads dial have no row; a row's switch names it.
      const base = { automation: found.adapter.key, rowId: !out.plan.env && found.adapter.levelSwitch?.needsRow ? out.plan.row.id : null, name: out.plan.row.name }
      return {
        ok: true,
        data: { automation: found.adapter.key, row: out.plan.row, from: out.plan.from, level: out.level, ...(out.note ? { note: out.note } : {}) },
        change: { before: { ...base, level: out.plan.from }, after: { ...base, level: out.level } },
      }
    },
  }
}

// ── R11 — decide-automation-suggestions ──────────────────────────────────────────────────────────────

type DecideKind = 'amazon-ads' | 'ebay-ads'
/**
 * What a decision changed. AA-W2-10 (D7) — an Amazon batch run as an approved request also names its change set (the
 * approval: every write of its applies carries it) and the negatives its applies created, for undo-ad-change.
 */
interface DecisionChange { kind: DecideKind; items: Array<{ id: string; status: string }>; changeSetId?: string; negatives?: Array<{ targetId: string }> }

/** The permission each Amazon suggestion family needs, on top of the tool's own (null when held). */
function familyPermission(ctx: ToolContext) {
  return (family: string): string | null => {
    const need = family === 'bids' ? F.adsBidsEdit : family === 'budget' ? F.adsBudgetsEdit : F.adsCampaignsManage
    return ctx.can(need) ? null : `a ${family} suggestion needs the ${need} permission`
  }
}

async function statusesNow(change: DecisionChange): Promise<DecisionChange> {
  const ids = change.items.map((i) => i.id)
  if (change.kind === 'ebay-ads') {
    const { ebayProposalStatuses } = await import('../../marketing/ebay-ads-rule-crud.service.js')
    return { kind: change.kind, items: await ebayProposalStatuses(ids) }
  }
  const { suggestionStatuses } = await import('../../advertising/ads-suggestion-decide.service.js')
  const now: DecisionChange = { kind: change.kind, items: await suggestionStatuses(ids) }
  if (change.changeSetId) now.changeSetId = change.changeSetId
  if (change.negatives) {
    // 5f — status decides, as in retireNegatives: the negatives still standing.
    const listed = change.negatives.map((n) => n.targetId)
    const standing = listed.length ? await prisma.adTarget.findMany({ where: { id: { in: listed }, isNegative: true, status: { not: 'ARCHIVED' } }, select: { id: true } }) : []
    const ids = new Set(standing.map((t) => t.id))
    now.negatives = listed.filter((id) => ids.has(id)).map((targetId) => ({ targetId }))
  }
  return now
}

/**
 * C2 — dismissed Amazon suggestions are restored to waiting. AA-W2-10 (D7) — applied ones are put back by undo-ad-change
 * of the request's change set (its bids, budgets and placements, and the negatives it created); a batch that both
 * applied and dismissed names the two requests. An apply recorded before its writes carried the change set is undone
 * from the Change Log.
 */
export const DECIDE_UNDO: ToolUndo = {
  current: (change) => statusesNow(change.after as DecisionChange),
  request(change) {
    const after = change.after as DecisionChange
    const applied = after.items.filter((i) => i.status !== 'dismissed' && i.status !== 'REJECTED' && i.status !== 'pending' && i.status !== 'PENDING')
    if (after.kind === 'ebay-ads') return { refusal: 'An eBay proposal once decided cannot be put back: a rejected one is raised again by its rule; an applied one is rolled back in Nexus.' }
    if (!applied.length) return { tool: 'decide-automation-suggestions', args: { kind: after.kind, decisions: after.items.map((i) => ({ suggestionId: i.id, decide: 'restore' })) } }
    if (!after.changeSetId) return { refusal: `${applied.length} of these suggestions were applied: what they changed at Amazon is undone from the Change Log in Nexus.` }
    const dismissed = after.items.filter((i) => i.status === 'dismissed').length
    if (dismissed) {
      return { refusal: `${applied.length} of these suggestions were applied and ${dismissed} dismissed: put the applied ones back with undo-ad-change (changeSetId ${after.changeSetId}), and restore the dismissed ones with decide-automation-suggestions (decide: restore).` }
    }
    return { tool: 'undo-ad-change', args: { changeSetId: after.changeSetId, why: 'undo of applied rule suggestions' } }
  },
}

const decideSuggestions: AgentTool = {
  name: 'decide-automation-suggestions',
  title: 'Decide rule suggestions',
  category: 'automation',
  description:
    'Apply or dismiss what PROPOSE rules suggested (kind amazon-ads: the Suggestions queue; ebay-ads: eBay rule proposals), up to ' +
    '100 at a time. Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the ' +
    'business set it so — or, for Amazon suggestions only, run by the business\'s rule inside its limits and the ads strategy ' +
    'where each apply lands (with its default limits only cuts, negatives, dismissals and restores; a raise, a new keyword, or an apply ' +
    'Nexus cannot measure before it runs — a sweep across a market — waits for a person). An applied change reaches Amazon or ' +
    'eBay through their write gates; for Amazon the preview says, per suggestion, whether it lands live at Amazon or in ' +
    'sandbox, and each limit it meets with its source. Refused before anything waits: a suggestion that pauses, switches on ' +
    'or archives (a rule\'s change never does: dismiss it — a temporary stop is lower bids, and a real pause, an enable ' +
    'or an archive is its own request: pause-ads, enable-ads, archive-ads), one whose target is held at the floor by no-pause ' +
    'suppression, one already decided, one Amazon\'s write gate would refuse, anything while ads automation is halted. An ' +
    'applied Amazon suggestion is written as its rule, under this request: undo-change puts its bids, budgets and placements ' +
    'back and retires the negatives it created (undo-ad-change of its changeSetId); keywords it created stay. One decided by ' +
    'rule never takes a placement lane the hourly bid plans hold. One its rule passes over (such a lane, a protected product, ' +
    'a campaign its picker leaves out …) writes nothing: it is said as skipped, with why, and keeps waiting. restore puts ' +
    'dismissed Amazon suggestions back to waiting.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  requires: [F.adsAutomationManage, FIELDS.financialsAdspendView],
  // An applied bid or budget is put back by undo-ad-change of the request's change set, but it ran in between; a
  // dismissal is restored; a keyword an apply created stays.
  reversibility: 'partial',
  // AA-W2-10 — may run by the business's rule, inside its limits per family and the ads strategy where each apply lands
  // (suggestion-limits.ts). An apply decided by rule is not a person's write: it passes `operatorApproved: false`, so it
  // skips a placement lane the rank engine holds instead of taking it (D7).
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: SUGGESTION_LIMITS,
  withinLimits: suggestionRefusal,
  undo: DECIDE_UNDO,
  input: z.object({
    kind: z.enum(['amazon-ads', 'ebay-ads']).describe('amazon-ads (the Suggestions queue) or ebay-ads (eBay rule proposals)'),
    decisions: z.array(z.object({
      suggestionId: ID.describe('the suggestion (Amazon) or proposal (eBay) id'),
      decide: z.enum(['apply', 'dismiss', 'restore']).describe('apply, dismiss, or restore a dismissed Amazon suggestion'),
    })).min(1).max(100).describe('up to 100 decisions'),
  }),
  async handler(args, ctx) {
    const decisions = args.decisions as Array<{ suggestionId: string; decide: 'apply' | 'dismiss' | 'restore' }>
    if (args.kind === 'ebay-ads') {
      const { planEbayProposalDecisions } = await import('../../marketing/ebay-ads-rule-crud.service.js')
      const planned = await planEbayProposalDecisions(decisions)
      if ('error' in planned) return { ok: false, error: planned.error }
      return { ok: true, preview: decidePreview('ebay-ads', planned.items) }
    }
    const { planSuggestionDecisions } = await import('../../advertising/ads-suggestion-decide.service.js')
    const planned = await planSuggestionDecisions(decisions, familyPermission(ctx))
    if ('error' in planned) return { ok: false, error: planned.error }
    const reached = await suggestionReach(planned.items)
    if ('error' in reached) return { ok: false, error: reached.error }
    // AA-W2-10 — the facts the business's rule is judged on: the ads strategy where each apply lands, and each family's move.
    const byRule = await suggestionLimitFacts(planned.items, ctx.approvalId)
    return { ok: true, preview: { ...decidePreview('amazon-ads', reached.items as unknown as Array<Record<string, unknown>>), ...byRule } }
  },
  async execute(args, ctx) {
    const decisions = args.decisions as Array<{ suggestionId: string; decide: 'apply' | 'dismiss' | 'restore' }>
    const kind = args.kind as DecideKind
    let results: Array<{ suggestionId: string; ok: boolean; status: string; detail: string | null; skipped?: true }>
    let set: Pick<DecisionChange, 'changeSetId' | 'negatives'> | null = null
    if (kind === 'ebay-ads') {
      const crud = await import('../../marketing/ebay-ads-rule-crud.service.js')
      const planned = await crud.planEbayProposalDecisions(decisions)
      if ('error' in planned) return { ok: false, error: planned.error }
      results = await crud.applyEbayProposalDecisions(decisions, ctx.userId ?? null)
    } else {
      const svc = await import('../../advertising/ads-suggestion-decide.service.js')
      const planned = await svc.planSuggestionDecisions(decisions, familyPermission(ctx))
      if ('error' in planned) return { ok: false, error: planned.error }
      // D7 — each decision records the person who approved it, as the eBay path does. AA-W2-10 — an apply decided by the
      // business's rule is not a person's write (no placement lane the rank engine holds), and every write of an apply
      // joins this request's change set, its audit reason naming the request and who decided it.
      const byRule = ctx.decidedVia === 'auto'
      const approvalId = ctx.approvalId?.trim()
      const who = byRule ? 'run by rule' : ctx.userId ? `approved by user:${ctx.userId}` : 'approved'
      const out = await svc.applySuggestionDecisions(decisions, ctx.userId ?? null, {
        operatorApproved: !byRule,
        ...(approvalId ? { approval: { changeSetId: approvalId, reason: `${ctx.via === 'claude' ? 'Claude request' : 'Approved request'} ${approvalId} (${who})` } } : {}),
      })
      results = out.results
      if (approvalId) set = { changeSetId: approvalId, negatives: out.negatives.map((targetId) => ({ targetId })) }
    }
    const before = kind === 'ebay-ads' ? 'PENDING' : 'pending'
    // A batch is recorded when any decision went through: those changed something, and undo must know them.
    if (!results.some((r) => r.ok)) return { ok: false, error: results.map((r) => `${r.suggestionId}: ${r.detail ?? 'refused'}`).join('; ') }
    return {
      ok: true,
      // AA-W2-10 — a suggestion its rule passed over is said as skipped (with why), never as decided.
      data: { results, decided: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok && !r.skipped).length, skipped: results.filter((r) => r.skipped).length, ...(set ? { changeSetId: set.changeSetId } : {}) },
      change: {
        before: { kind, items: decisions.map((d) => ({ id: d.suggestionId, status: d.decide === 'restore' ? 'dismissed' : before })) },
        after: { kind, items: results.map((r) => ({ id: r.suggestionId, status: r.status })), ...(set ?? {}) },
      },
    }
  },
}

/** The write-gate field an applied suggestion of each family writes, as Claude's own ad tools hand it to the gate. */
const GATE_FIELD: Record<string, string> = { bids: 'bid', 'new-keywords': 'bid', budget: 'dailyBudget', placement: 'placementBidding', negatives: 'negativeKeyword' }

/**
 * D7 — where each Amazon apply lands, asked of Amazon's write gate (read-only) as every other ad tool asks it: live or
 * sandbox, kept on the item, so the person sees it and the approval's re-check (its `items`) refuses a change of it. A
 * refusal is not queued. A market- or account-wide sweep names no single campaign: the gate answers for its market's
 * connection, and each campaign's own checks (allowlist, pins, bounds) run as the rule writes to it.
 */
async function suggestionReach(items: DecisionItem[]): Promise<{ items: Array<DecisionItem & { reach?: StoredReach }> } | { error: string }> {
  const { checkLiveReach, liveReachOf } = await import('./ads-tool-guards.js')
  const { gateRefusal, storedReach } = await import('./ads-change-kit.js')
  const { checkAdsWriteGate } = await import('../../advertising/ads-write-gate.js')
  const problems: string[] = []
  const out: Array<DecisionItem & { reach?: StoredReach }> = []
  for (const item of items) {
    const where = item.decide === 'apply' ? item.landsOn : undefined
    if (!where) { out.push(item); continue }
    const label = `${item.rule ?? 'a rule'} on ${item.entity}`
    if (where.scope === 'campaign' && !where.campaignId) {
      problems.push(`${label}: its campaign is not found in Nexus, so nothing can be written for it — dismiss it`)
      continue
    }
    const field = GATE_FIELD[item.family]
    const valueCents = item.family === 'bids' ? item.projected : item.family === 'budget' && item.projected != null ? Math.round(item.projected * 100) : null
    const reach = where.campaignId
      ? await checkLiveReach({
          campaignId: where.campaignId,
          marketplace: where.marketplace,
          changes: field ? [{ field, valueCents }] : [],
          ...(item.family === 'negatives' && where.term ? { isNegation: true, keywordText: where.term } : {}),
          byRule: true, // 4A — the rule writes it, so the rule's checks answer (not the approver's own-click pass)
        })
      : liveReachOf(await checkAdsWriteGate({ marketplace: where.marketplace, payloadValueCents: 0 }))
    if (reach.reach === 'refused') { problems.push(`${label}: ${gateRefusal(reach)}`); continue }
    out.push({ ...item, reach: storedReach(reach) })
  }
  if (problems.length) return { error: `Not queued — ${problems.join('; ')}` }
  return { items: out }
}

function decidePreview(kind: DecideKind, items: Array<Record<string, unknown>>) {
  const applies = items.filter((i) => i.decide === 'apply').length
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const i of items) changes[`${String(i.entity && typeof i.entity === 'object' ? JSON.stringify(i.entity) : i.entity)} (${String(i.suggestionId)})`] = { from: i.status, to: i.decide }
  // D7 — Amazon: how many applies land live and how many in sandbox, as the gate answered for each.
  const reached = items.map((i) => i.reach as StoredReach | undefined).filter((r): r is StoredReach => !!r)
  const live = reached.filter((r) => r.reach === 'live')
  const profiles = [...new Set(live.map((r) => (r as { profileId: string }).profileId))].sort().join(', ')
  const amazon = ` at Amazon, through the write gate (${live.length} live, ${reached.length - live.length} in sandbox)`
  return {
    action: 'decide-automation-suggestions', kind, items, changes,
    effect: `${applies} to apply${applies ? (kind === 'ebay-ads' ? ' at eBay' : amazon) : ''}, ${items.length - applies} to dismiss or restore.`,
    ...(kind === 'amazon-ads' && applies
      ? {
          reachNote: live.length
            ? `live: after approval ${live.length} of them ${live.length === 1 ? 'is' : 'are'} sent to Amazon (Amazon Ads profile ${profiles})${reached.length > live.length ? `; ${reached.length - live.length} in sandbox are recorded in Nexus only` : ''}.`
            : 'sandbox: after approval they are recorded in Nexus only. Amazon ads writes are not live, so nothing reaches Amazon.',
        }
      : {}),
  }
}

// ── R12 — stop-automation / resume-automation ────────────────────────────────────────────────────────

function stopTool(direction: 'stop' | 'resume'): AgentTool {
  const stop = direction === 'stop'
  return {
    name: stop ? 'stop-automation' : 'resume-automation',
    title: stop ? 'Stop automation' : 'Resume automation',
    category: 'automation',
    description: stop
      ? 'Stop an area at once: Amazon ads automation (the account halt), eBay ads automation (its dial halt), the agent fleet, the ' +
        'review request mailer (pause), or every switched-on rule of one domain (area rules, with domain). Waits for a person to ' +
        'approve it in Nexus — a business may let Claude run it by itself, since it only stops. Resumed only by resume-automation: ' +
        'a person approves every resume in Nexus.'
      : 'Resume an area stopped by stop-automation or the breaker: Amazon ads, eBay ads, the agent fleet, the review mailer, or ' +
        'the rules a stop switched off (area rules, with domain and ruleIds). Waits for a person to approve it in Nexus — always: ' +
        'a resume after a breaker trip is a person\'s decision.',
    riskTier: stop ? 'medium' : 'high',
    readOnly: false,
    requiresApprovalDefault: true,
    // A stop writes nothing outside Nexus (it stops writes); a resume lets automations act at Amazon and eBay again.
    openWorld: !stop,
    // Seeing automations (ai.view, as list-automations) is the floor; each kind's own manage permission is checked per call.
    requires: [F.aiView],
    reversibility: 'full',
    maxClaudeTrust: stop ? 'auto' : 'ask',
    ...(stop ? {
      limits: z.object({ areas: z.array(z.enum(STOP_AREAS)).max(STOP_AREAS.length).default([...STOP_AREAS]).describe('the areas Claude may stop without a person') }),
      withinLimits(preview: unknown, limits: Record<string, unknown>) {
        const p = preview as { area?: StopArea } | null
        if (!p?.area) return 'there is no preview of this stop to check'
        const areas = (limits.areas as StopArea[] | undefined) ?? [...STOP_AREAS]
        return areas.includes(p.area) ? null : `stopping ${p.area} without a person is not allowed here`
      },
    } : {}),
    undo: {
      current: (change) => stopStateNow(change.after as StopChange),
      request(change) {
        const after = change.after as StopChange
        return {
          tool: stop ? 'resume-automation' : 'stop-automation',
          args: { area: after.area, ...(after.domain ? { domain: after.domain } : {}), ...(after.ruleIds ? { ruleIds: after.ruleIds } : {}), ...(stop ? {} : { reason: 'undo of a resume' }) },
        }
      },
    },
    input: z.object({
      area: z.enum(STOP_AREAS).describe('amazon-ads, ebay-ads, agent-fleet, review-mailer, or rules (every switched-on rule of one domain)'),
      domain: z.enum(RULE_DOMAINS).optional().describe('area rules: which rules (default replenishment)'),
      ruleIds: z.array(ID).max(250).optional().describe(stop ? 'area rules: only these rules (default: every switched-on rule of the domain)' : 'area rules: the rules to switch back on (from the stop)'),
      ...(stop ? { reason: z.string().trim().min(3).max(200).describe('why: shown on the halt and in the audit') } : {}),
    }),
    async handler(args, ctx) {
      const area = args.area as StopArea
      const domain = args.domain as RuleDomain | undefined
      const need = stopPermission(area, domain)
      if (!ctx.can(need)) return { ok: false, error: `${stop ? 'Stopping' : 'Resuming'} ${area} needs the ${need} permission.` }
      const planned = await planStop(direction, area, domain, args.ruleIds as string[] | undefined, args.reason as string | undefined)
      if ('error' in planned) return { ok: false, error: planned.error }
      return { ok: true, preview: planned.plan }
    },
    async execute(args, ctx) {
      const area = args.area as StopArea
      const domain = args.domain as RuleDomain | undefined
      const need = stopPermission(area, domain)
      if (!ctx.can(need)) return { ok: false, error: `${stop ? 'Stopping' : 'Resuming'} ${area} needs the ${need} permission.` }
      const out = await applyStop(direction, area, domain, args.ruleIds as string[] | undefined, args.reason as string | undefined, ctx.userId ?? null)
      if ('error' in out) return { ok: false, error: out.error }
      return { ok: true, data: { area, effect: out.plan.effect, ruleIds: out.plan.ruleIds }, change: out.change }
    },
  }
}

// ── R13 — set-ad-guardrail ───────────────────────────────────────────────────────────────────────────

type GuardrailChange = import('../../advertising/ads-guardrail-change.service.js').GuardrailState

/** C2 — a guardrail is put back as it was: removed when this change created it, set back to its old values otherwise. */
export const GUARDRAIL_UNDO: ToolUndo = {
  async current(change) {
    const after = change.after as GuardrailChange
    const svc = await import('../../advertising/ads-guardrail-change.service.js')
    return { kind: after.kind, key: after.key, row: svc.guardrailState(after.kind, await svc.readGuardrail(after.kind, after.key)) }
  },
  request(change) {
    const before = change.before as GuardrailChange
    const key = Object.fromEntries(Object.entries(before.key).filter(([, v]) => v != null))
    if (!before.row) return { tool: 'set-ad-guardrail', args: { kind: before.kind, op: 'remove', ...key } }
    // W3-2 — a campaign's own guardrail keeps every value, a cleared one (null) too: the undo sets the kind back whole.
    const campaignKind = isCampaignKind(before.kind)
    const row = Object.fromEntries(Object.entries(before.row).filter(([k, v]) => v != null || campaignKind || ['dailyCapCents', 'minBidCents', 'maxBidCents'].includes(k)))
    return { tool: 'set-ad-guardrail', args: { kind: before.kind, op: 'set', ...key, ...row } }
  },
}

/** W3-2 — a campaign's own guardrail is set where its screens set it: those routes need ads.campaigns.manage. */
function campaignGuardrailPermitted(ctx: ToolContext, kind: unknown): string | null {
  return isCampaignKind(String(kind)) && !ctx.can(F.adsCampaignsManage) ? `Setting a campaign's ${String(kind)} needs the ${F.adsCampaignsManage} permission.` : null
}

const setAdGuardrail: AgentTool = {
  name: 'set-ad-guardrail',
  title: 'Set an ads guardrail',
  category: 'automation',
  description:
    'Set or remove a guardrail Nexus\'s Amazon ads write gate checks before a Nexus write reaches Amazon (the external ' +
    'bidding engine writes to Amazon itself and does not pass this gate): a spend ceiling (kind spend-ceiling, at campaign, ' +
    'product line, portfolio or market grain), a bid policy (bid-policy: min / max bid at line, portfolio or market grain), ' +
    'a protected term no rule may negate (protected-term), or one campaign\'s own guardrails (campaignId): its lowest and ' +
    'highest bid (campaign-bid-bounds), its lowest and highest daily budget and the baseline relative budget rules start ' +
    'from (campaign-budget-bounds), the most one change may move a keyword or target bid (bid-change-cap; an ad group\'s ' +
    'default bid is not stepped), its CPC ceiling (cpc-ceiling: ' +
    'a bid asked for on the bid screens or by Claude\'s bid tools held to a multiple of a target\'s average cost per click; ' +
    'the engines do not read it), ' +
    'or its pins (pin: bids, budget or placement adjustments no engine, rule or schedule may write). Nexus only: nothing is ' +
    'sent to Amazon. A campaign\'s own bid bound takes the place of a bid policy on its side (it can be looser), and the ' +
    'ads strategy\'s band binds beside it, the stricter winning: a campaign guardrail never widens the strategy, and a bid ' +
    'bound is judged on the bounds in force before and after (the preview names what binds after the change). A ' +
    'spend ceiling caps the daily budget INCREASES authorised in its scope: a budget raise that would take today\'s raises ' +
    'past it is refused, a budget cut never trips it, and it does not cap what Amazon actually spends, bid raises or ' +
    'placement raises. Waits for a person to approve it in Nexus, unless the business lets Claude run it by its rule inside ' +
    'its limits (a campaign\'s own guardrail: only in the markets or campaigns those limits list, none by default). Each ' +
    'change is judged: tightening (a new or lower ceiling, a new or lower bid ceiling, a new protected term, a lower ' +
    'largest bid change, a CPC ceiling switched on or lowered) may run inside those limits; loosening (a higher cap, a ' +
    'cleared or removed guardrail, a higher bid or budget ceiling in force, a bid or budget floor that holds spend up, a ' +
    'baseline that anchors budget rules higher, a CPC ceiling raised or off, a pin set or lifted — a pin stops cuts too) ' +
    'can add spend and waits for a person unless the business\'s limits let Claude loosen guardrails (never by default). ' +
    'The write gate applies it at its next decision.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  requires: [F.adsAutomationManage, F.adsBidsEdit, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: z.object({
    allowLoosen: z.boolean().default(false).describe('let Claude loosen a guardrail without a person (it can raise spend); never by default'),
    // W3-2 — a campaign's own guardrail runs by rule only where these list it (either list); empty = nowhere.
    markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(50).default([])
      .describe('a campaign\'s own guardrail: the markets (e.g. IT) where it may change without a person; empty = none'),
    campaignIds: z.array(ID).max(250).default([])
      .describe('a campaign\'s own guardrail: the campaigns (Nexus ids) where it may change without a person, beside the markets; empty = none'),
  }),
  withinLimits(preview, limits) {
    const p = preview as { kind?: string; direction?: string; why?: string; market?: string | null; campaignId?: string } | null
    if (!p?.direction) return 'there is no preview of this guardrail change to check'
    if (p.kind && isCampaignKind(p.kind)) {
      const markets = (limits.markets as string[] | undefined) ?? []
      const campaigns = (limits.campaignIds as string[] | undefined) ?? []
      const listed = (!!p.market && markets.includes(p.market)) || (!!p.campaignId && campaigns.includes(p.campaignId))
      const named = [...markets, ...campaigns.map((id) => `campaign ${id}`)]
      if (!listed) return `a campaign's own guardrail changes by rule only in the markets or campaigns this business lists (${named.length ? named.slice(0, 10).join(', ') + (named.length > 10 ? ', …' : '') : 'none listed'}); this one is ${p.market ? `in ${p.market}` : 'in no market'}: a person decides`
    }
    return p.direction === 'loosen' && !limits.allowLoosen ? `loosening a guardrail can raise spend (${p.why}): a person decides` : null
  },
  undo: GUARDRAIL_UNDO,
  input: z.object({
    kind: z.enum(['spend-ceiling', 'bid-policy', 'protected-term', ...CAMPAIGN_GUARDRAIL_KINDS])
      .describe('spend-ceiling, bid-policy or protected-term; or a campaign\'s own: campaign-bid-bounds, campaign-budget-bounds, bid-change-cap, cpc-ceiling or pin'),
    op: z.enum(['set', 'remove']).describe('set (create or change) or remove (a campaign kind: clear it — no bounds, no largest change, CPC ceiling off, every pin lifted)'),
    grain: z.enum(['CAMPAIGN', 'LINE', 'PORTFOLIO', 'MARKET']).optional().describe('spend-ceiling / bid-policy: what it binds (a spend ceiling: CAMPAIGN unless named; a bid policy: LINE, PORTFOLIO or MARKET)'),
    scopeId: ID.optional().describe('spend-ceiling / bid-policy: the campaign id, product line (parent product) id, portfolio id or market code it binds'),
    label: z.string().trim().min(1).max(120).optional().describe('spend-ceiling / bid-policy: a name for it (default: the scope\'s name)'),
    dailyCapCents: COUNT.nullable().optional().describe('spend-ceiling: the daily cap in euro cents; null = opened but not set'),
    minBidCents: COUNT.nullable().optional().describe('bid-policy (at least 2) or campaign-bid-bounds: the lowest bid, in cents of the campaign\'s currency; null clears it'),
    maxBidCents: COUNT.nullable().optional().describe('bid-policy or campaign-bid-bounds: the highest bid, in cents of the campaign\'s currency; null clears it'),
    minBudgetCents: COUNT.nullable().optional().describe('campaign-budget-bounds: the lowest daily budget, in cents of the campaign\'s currency (at least 100); null clears it'),
    maxBudgetCents: COUNT.nullable().optional().describe('campaign-budget-bounds: the highest daily budget, in cents (at least 100); null clears it'),
    budgetBaselineCents: COUNT.nullable().optional().describe('campaign-budget-bounds: the daily budget relative budget rules and a restore to baseline start from, in cents (at least 100); null clears it'),
    maxBidChangePct: z.coerce.number().gt(0).max(500).nullable().optional().describe('bid-change-cap: the most one change may move a keyword or target bid, in % (above 0, at most 500; a decimal as the screens store it); null clears it'),
    cpcMultiple: z.coerce.number().min(1).max(10).optional().describe('cpc-ceiling: the multiple of a target\'s average cost per click a bid may reach (1–10; kept as it is when not given, 1.5 at first)'),
    enabled: z.boolean().optional().describe('spend-ceiling / bid-policy: switch it on or off (off loosens); cpc-ceiling: on (the default when set) or off'),
    note: z.string().max(300).nullable().optional().describe('why, kept on the row (pin: on the campaign, at most 280 characters)'),
    pinBids: z.boolean().optional().describe('pin: true pins the campaign\'s bids (no engine, rule or schedule writes them), false lifts the pin'),
    pinBudget: z.boolean().optional().describe('pin: true pins its daily budget, false lifts the pin'),
    pinPlacement: z.boolean().optional().describe('pin: true pins its placement adjustments, false lifts the pin'),
    term: z.string().trim().min(1).max(200).optional().describe('protected-term: the term no rule may negate'),
    matchType: z.enum(['EXACT', 'PREFIX', 'CONTAINS']).optional().describe('protected-term: how the term matches (default EXACT)'),
    marketplace: z.string().trim().min(1).max(20).optional().describe('protected-term: only in this market'),
    campaignId: ID.optional().describe('a campaign kind: the campaign (its Nexus id, from ad-campaigns); protected-term: only in this campaign'),
  }),
  async handler(args, ctx) {
    const denied = campaignGuardrailPermitted(ctx, args.kind)
    if (denied) return { ok: false, error: denied }
    const { planGuardrail } = await import('../../advertising/ads-guardrail-change.service.js')
    const planned = await planGuardrail(args as never)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: planned.plan }
  },
  async execute(args, ctx) {
    const denied = campaignGuardrailPermitted(ctx, args.kind)
    if (denied) return { ok: false, error: denied }
    const { applyGuardrail } = await import('../../advertising/ads-guardrail-change.service.js')
    const out = await applyGuardrail(args as never, ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return { ok: true, data: { kind: out.plan.kind, op: out.plan.op, direction: out.plan.direction, label: out.plan.label }, change: { before: out.before, after: out.after } }
  },
}

// ── R14 — tune-ad-engine ─────────────────────────────────────────────────────────────────────────────────


/** What each setting's own route needs, on top of the tool's floor (ads.automation.manage and the ad-spend money). */
const TUNE_PERMISSION: Partial<Record<EngineSetting, string>> = {
  'budget-pool': F.adsBudgetsEdit,
  'budget-schedule': F.adsBudgetsEdit,
  'coverage-set': F.adsCampaignsManage,
  'rank-target': F.adsCampaignsManage,
  'harvest-policy': F.adsCampaignsManage,
  'ebay-campaign-policy': F.adsCampaignsManage,
}

const CENTS = z.coerce.number().int().min(1).max(100_000_000)
const PCT = (max: number) => z.coerce.number().int().min(0).max(max)
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** C2 — a setting is put back as it was, through tune-ad-engine itself (a harvest scope it gave a policy goes back to inheriting). */
export const TUNE_UNDO: ToolUndo = {
  current: (change) => tuneStateNow(change.after as TuneRecord),
  request: (change) => ({ tool: 'tune-ad-engine', args: restoreArgsOf(change.before as TuneRecord) }),
}

function tuneInputOf(args: Record<string, unknown>): TuneInput {
  const setting = args.setting as EngineSetting
  return { setting, subjectId: args.subjectId as string | undefined, values: (args[SETTING_ARG[setting]] as Record<string, unknown> | undefined) ?? {} }
}

function tunePermitted(ctx: ToolContext, setting: EngineSetting): string | null {
  const need = TUNE_PERMISSION[setting]
  return need && !ctx.can(need as never) ? `Tuning a ${setting} needs the ${need} permission.` : null
}

const tuneAdEngine: AgentTool = {
  name: 'tune-ad-engine',
  title: 'Tune an ads engine setting',
  category: 'automation',
  description:
    'Change one setting an ads engine runs by: a budget pool (budget-pool: daily budget, strategy, cool-down, largest shift), a coverage ' +
    'set\'s caps (coverage-set), a rank target of the hourly bid plans (rank-target: placement %, bid ceiling, Min-bid floor), a budget ' +
    'schedule\'s windows (budget-schedule), a harvest policy (harvest-policy: the criteria that qualify a search term, per scope), an eBay ' +
    'campaign\'s automation policy (ebay-campaign-policy), the account default target ACOS (account-target-acos) or the anomaly breaker\'s ' +
    'limits (breaker). A change waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator ' +
    'code when the business set it so — unless the business lets it run by its rule inside its limits and the ads strategy ' +
    'where the setting acts (one that can raise spend for the whole account waits). The preview shows every ' +
    'change, whether it can raise spend (a higher budget, cap, target ACOS or breaker limit, a pool shift, a looser harvest, a ' +
    'lowering window removed) and by how many percent at most: a change that cannot raise spend may run by rule; one that can, ' +
    'only when each raise is one value rising within the business\'s percent (0 by default); a raise with no percent — a cleared ' +
    'cap, a new strategy, a window, a looser harvest, a breaker that trips later — waits for a person. Switching on / off is ' +
    'turn-up / turn-down-automation; dayparting windows are not tuned here (never pause).',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // A pool, schedule, rank target or coverage set acts at Amazon on its next run with the new values.
  openWorld: true,
  requires: [F.adsAutomationManage, FIELDS.financialsAdspendView],
  reversibility: 'full',
  // AA-W2-11 — may run by rule: a change that cannot raise spend, or one whose every raise is within `maxRaisePct`
  // (a numeric limit in place of the old allowRaise switch; 0 by default) — and, as the ads strategy's `automation`
  // kind, inside the strategy where the setting acts (automation-scope.ts).
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: TUNE_LIMITS,
  withinLimits: tuneRefusal,
  undo: TUNE_UNDO,
  input: z.object({
    setting: z.enum(ENGINE_SETTINGS).describe('which setting: budget-pool, coverage-set, rank-target, budget-schedule, harvest-policy, ebay-campaign-policy, account-target-acos or breaker'),
    subjectId: ID.optional().describe('the pool, coverage set, rank target, budget schedule or eBay campaign (Nexus id) to tune; not for harvest-policy, account-target-acos or breaker'),
    budgetPool: z.object({
      totalDailyBudgetCents: CENTS.optional().describe('the pool\'s daily budget, in euro cents'),
      strategy: z.enum(['STATIC', 'PROFIT_WEIGHTED', 'URGENCY_WEIGHTED']).optional().describe('how it splits the budget: STATIC, PROFIT_WEIGHTED or URGENCY_WEIGHTED'),
      coolDownMinutes: z.coerce.number().int().min(15).max(10_080).optional().describe('minutes between two rebalances'),
      maxShiftPerRebalancePct: z.coerce.number().int().min(1).max(100).optional().describe('the most of the pool one rebalance may move, in %'),
    }).optional().describe('budget-pool: the fields to change'),
    coverageSet: z.object({
      dailySpendCapCents: CENTS.nullable().optional().describe('the set\'s daily spend cap in euro cents; null clears it'),
      acosCapPct: z.coerce.number().min(1).max(500).nullable().optional().describe('the set\'s ACOS cap in % (e.g. 35); null clears it'),
    }).optional().describe('coverage-set: the caps to change'),
    // 2e — only what the hourly bid plan reads; it reads no impression-share goal, ACOS cap, step or climb.
    rankTarget: z.object({
      biasPct: PCT(900).nullable().optional().describe('the placement percentage the target holds in its hours (0–900); null = 0% (on a Min-bid target: leave the placement as it is)'),
      maxCpcCents: CENTS.nullable().optional().describe('the CPC ceiling, in cents: the placement percentage is held low enough that no bid passes it; null = none'),
      floorBidCents: CENTS.nullable().optional().describe('a Min-bid target\'s floor bid, in cents; null = €0.02'),
    }).optional().describe('rank-target: the fields to change'),
    budgetSchedule: z.object({
      windows: z.array(z.object({
        day: z.coerce.number().int().min(0).max(6).describe('weekday, 0 = Sunday … 6 = Saturday'),
        start: HHMM.optional().describe('HH:MM in the schedule\'s time zone; leave out with end for all day'),
        end: HHMM.optional().describe('HH:MM'),
        adj: z.enum(['set', 'incPct', 'decPct']).optional().describe('set (euro), incPct or decPct; not for a multiplier schedule'),
        value: z.coerce.number().min(0).max(100_000).describe('the euro amount, the percent, or the multiplier (×)'),
      })).max(168).describe('every window of the schedule (it replaces them all)'),
    }).optional().describe('budget-schedule: its windows'),
    harvestPolicy: z.object({
      scopeGrain: z.enum(['account', 'market', 'line', 'portfolio', 'campaign', 'adGroup']).describe('where the policy binds'),
      scopeId: z.string().trim().min(1).max(64).optional().describe('the market code, product line id, portfolio id, campaign id or ad group id; not for account'),
      minOrders: z.coerce.number().int().min(1).max(100).optional().describe('orders a term needs'),
      minClicks: z.coerce.number().int().min(0).max(10_000).optional().describe('clicks a term needs'),
      maxAcosPct: z.coerce.number().int().min(1).max(1000).nullable().optional().describe('the highest ACOS a term may have, in %; null = none'),
      windowDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional().describe('the window read: 30, 60 or 90 days'),
      excludeExactMatched: z.boolean().optional().describe('leave out terms already matched exactly'),
      inherit: z.boolean().optional().describe('true removes this scope\'s own policy, so it inherits again'),
    }).optional().describe('harvest-policy: the scope and the criteria to change'),
    ebayCampaignPolicy: z.object({
      posture: z.enum(['INHERIT', 'OFF', 'SUGGEST', 'AUTO']).optional().describe('INHERIT, OFF (no rule acts), SUGGEST (rules only propose) or AUTO'),
      protected: z.boolean().optional().describe('true: no rule acts on it'),
      rateCapPct: z.coerce.number().min(0).max(100).nullable().optional().describe('the highest ad rate a rule may set, in %'),
      rateFloorPct: z.coerce.number().min(0).max(100).nullable().optional().describe('the lowest ad rate a rule may set, in %'),
      bidCapCents: CENTS.nullable().optional().describe('the highest keyword bid, in cents'),
      bidFloorCents: CENTS.nullable().optional().describe('the lowest keyword bid, in cents'),
    }).optional().describe('ebay-campaign-policy: the fields to change'),
    accountTargetAcos: z.object({
      targetAcosPct: z.coerce.number().int().min(1).max(500).nullable().describe('the account default target ACOS in %; null clears it'),
    }).optional().describe('account-target-acos: the new default'),
    breaker: z.object({
      maxHourlySpendCentsEur: CENTS.nullable().optional().describe('the hourly spend that trips the breaker, in euro cents; null = the default (€500)'),
      maxActionsPerHour: z.coerce.number().int().min(1).max(100_000).nullable().optional().describe('the actions an hour that trip the breaker; null = the default (250)'),
    }).optional().describe('breaker: the limits to change'),
  }),
  async handler(args, ctx) {
    const input = tuneInputOf(args)
    const refusal = tunePermitted(ctx, input.setting)
    if (refusal) return { ok: false, error: refusal }
    const planned = await planTune(input)
    if ('error' in planned) return { ok: false, error: planned.error }
    // AA-W2-11 — what the business's rule is judged on: the ads strategy where the setting acts.
    const byRule = await automationFacts(await tuneScope(input.setting, input.subjectId, input.values), 'tune-ad-engine', ctx.approvalId, planned.plan.subject.id ? [planned.plan.subject.id] : [])
    return { ok: true, preview: { ...planned.plan, ...byRule } }
  },
  async execute(args, ctx) {
    const input = tuneInputOf(args)
    const refusal = tunePermitted(ctx, input.setting)
    if (refusal) return { ok: false, error: refusal }
    const out = await applyTune(input, ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return { ok: true, data: { setting: out.plan.setting, subject: out.plan.subject, changes: out.plan.changes }, change: { before: out.before, after: out.after } }
  },
}

// ── R15 — steer-fleet ────────────────────────────────────────────────────────────────────────────────────

const steerFleet: AgentTool = {
  name: 'steer-fleet',
  title: 'Steer the agent fleet',
  category: 'automation',
  description:
    'Steer the agent fleet\'s workers (charters, from list-automations F1): run one now (run-now, or one assignment by ' +
    'assignmentId), pause one until a time (pause, with until and reason), resume it, set its level (set-level: OFF, OBSERVE, ' +
    'PROPOSE, AUTO — up only to its charter\'s cap, AUTO only once earned), give it an assignment (assign: targetKind + ' +
    'targetIds) or cancel one that never ran. Every move waits for a person: approved in Nexus, or confirmed in Claude with the ' +
    'asker\'s authenticator code when the business set it so — none runs by rule. Once this tool may run by rule, a pause, a level ' +
    'down or a cancel may run inside a business\'s limits; a run, a resume, a level up or an assignment spends AI money and stays ' +
    'with a person. Never edits a worker\'s prompt, revisions, tools, model or budget.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: the workers propose; what they find waits in Approvals. Their cost is AI spend.
  openWorld: false,
  requires: [F.aiRun, F.aiView],
  // A run cannot be taken back (its AI spend is spent); every other move can.
  reversibility: 'partial',
  // Confirm at most, so its limits are never read today (claude-trust.service.ts reads them only at auto); they are kept
  // for the day this tool may run by rule.
  maxClaudeTrust: 'confirm',
  limits: z.object({ allowAiSpend: z.boolean().default(false).describe('once this tool may run by rule: let a run, a resume, a level up or an assignment go without a person; never by default') }),
  withinLimits(preview, limits) {
    const p = preview as { steer?: string; needsPerson?: string | null } | null
    if (!p?.steer) return 'there is no preview of this fleet change to check'
    return p.needsPerson && !limits.allowAiSpend ? `${p.needsPerson}: a person decides` : null
  },
  undo: {
    async current(change) {
      const after = change.after as SteerRecord
      if (after.steer === 'charter') return charterStateNow(after.charterKey)
      if (after.steer === 'run-now') return after
      return assignmentStateNow(after)
    },
    request: (change) => steerUndoOf(change.before as SteerRecord, change.after as SteerRecord),
  },
  input: z.object({
    action: z.enum(STEER_ACTIONS).describe('run-now, pause, resume, set-level, assign or cancel-assignment'),
    charterKey: z.string().trim().min(1).max(64).optional().describe('the worker (its charter key, e.g. amazon-bid-tuner), from list-automations F1'),
    assignmentId: ID.optional().describe('run-now / cancel-assignment: the assignment (from automation-detail F1)'),
    until: z.string().trim().max(40).optional().describe('pause: until when (ISO date-time, in the future)'),
    reason: z.string().trim().min(3).max(200).optional().describe('pause: why — shown on the worker and in its control history'),
    level: z.enum(STEER_LEVELS).optional().describe('set-level: OFF, OBSERVE, PROPOSE or AUTO'),
    targetKind: z.enum(['CAMPAIGN', 'MARKETPLACE', 'PORTFOLIO']).optional().describe('assign: what it works on'),
    targetIds: z.array(ID).max(25).optional().describe('assign: the campaign ids, portfolio ids or the one market code'),
    wantBack: z.string().trim().max(500).optional().describe('assign: what you want back'),
    dueAt: z.string().trim().max(40).optional().describe('assign: when it is due (ISO date)'),
    title: z.string().trim().min(1).max(120).optional().describe('assign: its title (default: the worker and its targets)'),
  }),
  async handler(args) {
    const planned = await planSteer(args as unknown as SteerInput)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: planned.plan }
  },
  async execute(args, ctx) {
    const out = await applySteer(args as unknown as SteerInput, ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return { ok: true, data: { steer: out.plan.steer, worker: out.plan.worker, changes: out.plan.changes, ...(out.data ?? {}) }, change: { before: out.before, after: out.after } }
  },
}

// ── R17 — save-price-rule ────────────────────────────────────────────────────────────────────────────────

type PriceRuleConfig = import('../../repricing-rule-save.service.js').PriceRuleConfig

/** save-price-rule's arguments that put an edited rule back as it was. */
function priceRuleArgsOf(config: PriceRuleConfig): Record<string, unknown> {
  return {
    priceRuleId: config.priceRuleId, minPrice: config.minPrice, maxPrice: config.maxPrice, strategy: config.strategy,
    beatPct: config.beatPct, beatAmount: config.beatAmount, activeFromHour: config.activeFromHour, activeToHour: config.activeToHour,
    activeDays: config.activeDays, notes: config.notes,
  }
}

export const SAVE_PRICE_RULE_UNDO: ToolUndo = {
  async current(change) {
    const { priceRuleNow } = await import('../../repricing-rule-save.service.js')
    return priceRuleNow((change.after as PriceRuleConfig).priceRuleId!)
  },
  request(change) {
    const before = change.before as PriceRuleConfig | { created: true; sku: string }
    if ('created' in before) return { refusal: `the rule for ${before.sku} was created switched off; removing it is a person's click in Nexus.` }
    return { tool: 'save-price-rule', args: priceRuleArgsOf(before) }
  },
}

const PRICE = z.coerce.number().min(0).max(1_000_000)
const saveIdOrNew = (args: Record<string, unknown>) => args as import('../../repricing-rule-save.service.js').PriceRuleInput

const savePriceRule: AgentTool = {
  name: 'save-price-rule',
  title: 'Save a repricing rule',
  category: 'automation',
  description:
    'Create or edit a repricing rule: the min/max range, strategy (match_buy_box, beat_lowest_by_pct, beat_lowest_by_amount, ' +
    'fixed_to_buy_box_minus, manual) and hours the repricer prices one product on one channel and market inside. Always waits ' +
    'for a person to approve it in Nexus. A new rule is born OFF (turn-up-automation N1 switches it on, with a person). The ' +
    'range must sit inside the product\'s own pricing floor and ceiling — refused, never clamped. The preview shows what the ' +
    'rule would pick now and applies nothing. Give priceRuleId to edit (channel, market and product never change).',
  riskTier: 'high',
  alwaysAsk: true,
  readOnly: false,
  requiresApprovalDefault: true,
  // Once switched on, a rule prices the listing on the channel (live with NEXUS_REPRICER_LIVE=1).
  openWorld: true,
  requires: [F.repricingRulesManage, F.pricingView],
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SAVE_PRICE_RULE_UNDO,
  input: z.object({
    priceRuleId: ID.optional().describe('the repricing rule to edit (from automation-detail N1); omit to create one'),
    productId: ID.optional().describe('the product a new rule prices (Nexus id)'),
    channel: z.enum(['AMAZON', 'EBAY', 'SHOPIFY']).optional().describe('a new rule\'s channel'),
    marketplace: z.string().trim().min(2).max(10).nullable().optional().describe('a new rule\'s market, e.g. IT; null = every market of the channel (refused when the product has a floor or ceiling)'),
    minPrice: PRICE.optional().describe('the lowest price it may set, in the market\'s currency'),
    maxPrice: PRICE.optional().describe('the highest price it may set, in the market\'s currency'),
    strategy: z.enum(['match_buy_box', 'beat_lowest_by_pct', 'beat_lowest_by_amount', 'fixed_to_buy_box_minus', 'manual']).optional().describe('how it picks a price'),
    beatPct: z.coerce.number().min(0).max(100).nullable().optional().describe('beat_lowest_by_pct: by how many percent'),
    beatAmount: PRICE.nullable().optional().describe('beat_lowest_by_amount / fixed_to_buy_box_minus: by how much'),
    activeFromHour: z.coerce.number().int().min(0).max(23).nullable().optional().describe('UTC hour it starts (null = always)'),
    activeToHour: z.coerce.number().int().min(0).max(23).nullable().optional().describe('UTC hour it stops (null = always)'),
    activeDays: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional().describe('days it runs, 0 = Sunday; empty = every day'),
    notes: z.string().max(500).nullable().optional().describe('why, kept on the rule'),
  }),
  async handler(args) {
    const { planPriceRuleSave } = await import('../../repricing-rule-save.service.js')
    const planned = await planPriceRuleSave(saveIdOrNew(args))
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: planned.plan }
  },
  async execute(args, ctx) {
    const { applyPriceRuleSave } = await import('../../repricing-rule-save.service.js')
    const out = await applyPriceRuleSave(saveIdOrNew(args), ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return { ok: true, data: { priceRuleId: out.after.priceRuleId, rule: out.plan.rule, changes: out.plan.changes }, change: { before: out.before, after: out.after } }
  },
}

// ── R18 — save-ops-rule ──────────────────────────────────────────────────────────────────────────────────

type OpsRuleConfig = import('../../automation/ops-rule-save.service.js').OpsRuleConfig
type OpsCreated = { created: true; domain: OpsRuleConfig['domain']; opsRuleId: string; name: string; born: string }

/** save-ops-rule's arguments that put an edited rule back as it was. */
function opsRuleArgsOf(config: OpsRuleConfig): Record<string, unknown> {
  return {
    domain: config.domain, opsRuleId: config.opsRuleId, name: config.name, description: config.description, trigger: config.trigger,
    conditions: config.conditions, actions: config.actions, maxExecutionsPerDay: config.maxExecutionsPerDay, maxValueCentsEur: config.maxValueCentsEur,
  }
}

const OPS_AUTOMATION: Record<OpsRuleConfig['domain'], string> = { listings: 'N5', replenishment: 'N6', reviews: 'N7', 'bulk-operations': 'N9' }

/** C2 — undo of save-ops-rule: save the rule as it was; a rule it created is retired to OFF, never deleted. */
export const SAVE_OPS_RULE_UNDO: ToolUndo = {
  async current(change) {
    const after = change.after as OpsRuleConfig
    const { opsRuleNow } = await import('../../automation/ops-rule-save.service.js')
    return opsRuleNow(after.domain, after.opsRuleId!)
  },
  request(change) {
    const before = change.before as OpsRuleConfig | OpsCreated
    if ('created' in before) {
      if (before.born === 'OFF') return { refusal: `"${before.name}" was created switched off; removing it is a person's click in Nexus.` }
      return { tool: 'turn-down-automation', args: { automation: OPS_AUTOMATION[before.domain], rowId: before.opsRuleId, level: 'OFF' } }
    }
    return { tool: 'save-ops-rule', args: opsRuleArgsOf(before) }
  },
}

const OPS_DOMAIN_PERMISSION: Record<OpsRuleConfig['domain'], string> = {
  listings: F.listingsEdit, replenishment: F.replenishmentRun, reviews: F.reviewsManage, 'bulk-operations': F.productsBulkRun,
}
const opsPermitted = (ctx: ToolContext, domain: OpsRuleConfig['domain']): string | null =>
  ctx.can(OPS_DOMAIN_PERMISSION[domain] as never) ? null : `Saving a ${domain} rule needs the ${OPS_DOMAIN_PERMISSION[domain]} permission.`

const saveOpsRule: AgentTool = {
  name: 'save-ops-rule',
  title: 'Save an operations rule',
  category: 'automation',
  description:
    'Create or edit an operations rule — listings (price / stock sync, translation), replenishment (approve a recommendation, ' +
    'draft a purchase order), reviews (bullet and A+ ideas from a review spike) or bulk-operations (apply a template, create a ' +
    'bulk job). Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when ' +
    'the business set it so. A new rule is born OBSERVE — it records what it would do and does ' +
    'nothing (a review rule is born OFF: its actions call the AI even in a dry run; listing rules are never scheduled). It climbs ' +
    'with turn-up-automation. Refused, in words: any pause (a rule Claude saves never pauses), a trigger or action outside the domain\'s own, ' +
    'no conditions, no daily run cap, and for replenishment no value cap. Editing an AUTO rule drops it to PROPOSE. Each domain ' +
    'needs its own permission. Give opsRuleId to edit: fields left out keep the rule\'s own.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: a saved rule acts only once a person turns it up.
  openWorld: false,
  // The floor (as the Fleet and automation tools); each domain's own permission is checked per call.
  requires: [F.aiRun, F.aiView],
  restrictedFields: AUTOMATION_RESTRICTED_FIELDS,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SAVE_OPS_RULE_UNDO,
  input: z.object({
    domain: z.enum(['listings', 'replenishment', 'reviews', 'bulk-operations']).describe('listings, replenishment, reviews or bulk-operations'),
    opsRuleId: ID.optional().describe('the rule to edit (from automation-detail N5, N6, N7 or N9); omit to create one'),
    name: z.string().trim().min(1).max(120).optional().describe('its name; required for a new rule'),
    description: z.string().max(500).nullable().optional().describe('what it is for'),
    trigger: z.string().trim().min(1).max(64).optional().describe("the domain's trigger, e.g. inventory_low (listings), recommendation_generated (replenishment), REVIEW_SPIKE_DETECTED, bulk_job_completed"),
    conditions: z.union([z.array(JSON_OBJECT).max(50), JSON_OBJECT]).optional().describe('[{ field, op, value }] (or an AND / OR tree) on what the trigger hands the rule; at least one'),
    actions: z.array(JSON_OBJECT).max(10).optional().describe("[{ type, … }] — the domain's own actions, notify or log_only"),
    maxExecutionsPerDay: z.coerce.number().int().min(1).max(10_000).nullable().optional().describe('runs per day it may act on; required, above 0'),
    maxValueCentsEur: z.coerce.number().int().min(1).max(1_000_000_000).nullable().optional().describe('euro cents one run may commit; required for replenishment'),
  }),
  async handler(args, ctx) {
    const input = args as unknown as import('../../automation/ops-rule-save.service.js').OpsRuleInput
    const refusal = opsPermitted(ctx, input.domain)
    if (refusal) return { ok: false, error: refusal }
    const { planOpsRuleSave } = await import('../../automation/ops-rule-save.service.js')
    const planned = await planOpsRuleSave(input)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: planned.plan }
  },
  async execute(args, ctx) {
    const input = args as unknown as import('../../automation/ops-rule-save.service.js').OpsRuleInput
    const refusal = opsPermitted(ctx, input.domain)
    if (refusal) return { ok: false, error: refusal }
    const { applyOpsRuleSave } = await import('../../automation/ops-rule-save.service.js')
    const out = await applyOpsRuleSave(input, ctx.userId ?? null)
    if ('error' in out) return { ok: false, error: out.error }
    return { ok: true, data: { opsRuleId: out.after.opsRuleId, rule: out.plan.rule, level: out.plan.level, changes: out.plan.changes }, change: { before: out.before, after: out.after } }
  },
}

export const AUTOMATION_CHANGE_TOOLS: AgentTool[] = [saveAdRule, switchTool('up'), switchTool('down'), decideSuggestions, stopTool('stop'), stopTool('resume'), setAdGuardrail, tuneAdEngine, steerFleet, savePriceRule, saveOpsRule]
