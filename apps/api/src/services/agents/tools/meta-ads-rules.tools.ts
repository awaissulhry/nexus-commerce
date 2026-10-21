/**
 * Meta ads changes, step 29 — Meta's own automated rules on the business's chosen Meta ad account:
 *   set-meta-ad-rule     action create (a schedule or a trigger rule — conditions on settings and results, advanced
 *                        fields, ROAS windows; any of the nine actions Meta documents; its schedule — ALWAYS made off
 *                        unless enable: true), update (any part; Meta needs the whole rule, so the parts not named go as
 *                        Meta has them), status (switch on / off), run (a schedule rule now) — RU-003 … RU-021, RU-023,
 *                        RU-025 … RU-027, RU-032; Meta's preview of a schedule rule (POST /<rule id>/preview, RU-031) is
 *                        part of the preview of a run, a switch-on and a change
 *   remove-meta-ad-rule  delete a rule, only on the person's explicit ask (confirmDelete) — RU-028
 * Not offered, with the proof in change-ad-rule.ts: RU-024 recommended_rule_key (no value documented anywhere) and RU-022
 * (the reference enum's other ten actions and is_once_off: no guide). Reads are meta-ad-rules (step 8).
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live rule, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it replaced (or says what has no way back on Meta).
 * Meta's own MCP has no tool for automated rules (RU-003 "Meta MCP tool" —): these beat it.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { liveRule, liveRuleGone, liveRulePreview, ruleWordsFor } from '../../marketing/meta-ads/live-rules.js'
import { adRuleDraft, removeRuleDraft, RuleRefusal, ruleStateOf, type AdRuleRequest, type RuleRecord } from '../../marketing/meta-ads/change-ad-rule.js'
import { MetaUnitError } from '../../marketing/meta-ads/settings-units.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import {
  CHANGE_UNITS, MAX_RULE_FILTERS, MAX_RULE_IDS, MAX_RULE_PEOPLE, MAX_SCHEDULE_ENTRIES, REBALANCE_TYPES, RULE_EVALUATION_KINDS, RULE_EXECUTION_TYPES,
  RULE_OPERATORS, RULE_SCHEDULE_TYPES, RULE_TRIGGER_TYPES,
} from '../../gateway/meta-ad-rule-rules.js'
import { META_NAME_TEXT } from '../../gateway/meta-settings-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers: their sentences quote budgets, bids, costs and spend, so they are money too. */
const META_RULE_CHANGE_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, steps: ADSPEND, rule: ADSPEND,
  valueCents: ADSPEND, valueAsMeta: ADSPEND, amountCents: ADSPEND, limitCents: ADSPEND, targetValueCents: ADSPEND, targetValueAsMeta: ADSPEND,
} as const

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────

const typedText = z.string().trim().min(1).max(400).regex(META_NAME_TEXT, 'no control or format characters')
const scalar = z.union([typedText, z.number().finite(), z.boolean()])
const plainValue = z.union([scalar, z.array(scalar).min(1).max(MAX_RULE_IDS)])
  .describe('a field on Nexus\'s plain list (settings, statuses, counts, rates, ids as text): a number, text, true / false, or a list (IN, NOT_IN, ANY, ALL, NONE)')
const centsValue = z.union([z.number().int().min(-100_000_000_000).max(100_000_000_000), z.array(z.number().int().min(0).max(100_000_000_000)).length(2)])
  .describe('a money field (spent, cost_per_…, cpc, cpm, cpa, budgets, bids): minor units of the account currency (cents for EUR), or [low, high] for IN_RANGE / NOT_IN_RANGE')
const asMetaValue = z.union([z.number().finite(), z.array(z.number().finite()).length(2)])
  .describe('any other field (website_purchase_roas, a ratio, a formula, aggregate(…), a field Nexus does not know): exactly as Meta reads it — a ROAS as a number (0.5), money in Meta\'s base unit of the currency')
const fieldArg = z.string().trim().min(1).max(200)
  .describe('Meta\'s field: a setting (entity_type, id, adset.id, name, objective, daily_budget, effective_status, hours_since_creation …), a result (impressions, spent, cost_per_purchase_fb, website_purchase_roas …) with optional prefixes (campaign., yesterday_, 7d_click:), aggregate(field), or a formula ("today_spent / adset.daily_budget")')
const conditionArg = z.object({
  field: fieldArg,
  operator: z.preprocess(upper, z.enum(RULE_OPERATORS)).describe('GREATER_THAN, LESS_THAN, EQUAL, NOT_EQUAL, IN_RANGE, NOT_IN_RANGE, IN, NOT_IN, CONTAIN, NOT_CONTAIN, ANY, ALL, NONE'),
  value: plainValue.optional(),
  valueCents: centsValue.optional(),
  valueAsMeta: asMetaValue.optional(),
}).describe('one condition (all are AND-ed): exactly one of value, valueCents, valueAsMeta — the one its field takes')
const triggerArg = z.object({
  type: z.preprocess(upper, z.enum(RULE_TRIGGER_TYPES)).describe('METADATA_CREATION (an object is made), METADATA_UPDATE (a setting changes), STATS_MILESTONE (each multiple of a number), STATS_CHANGE (a number crosses a threshold), DELIVERY_INSIGHTS_CHANGE (Meta beta)'),
  field: fieldArg.optional(),
  operator: z.preprocess(upper, z.enum(RULE_OPERATORS)).optional().describe('STATS_MILESTONE: EQUAL; STATS_CHANGE: GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE; METADATA_UPDATE: optional'),
  value: plainValue.optional(),
  valueCents: centsValue.optional(),
  valueAsMeta: asMetaValue.optional(),
}).describe('a trigger rule\'s one trigger')
const evaluationArg = z.object({
  type: z.preprocess(upper, z.enum(RULE_EVALUATION_KINDS)).optional().describe('SCHEDULE (checked on its schedule) or TRIGGER (real time; Ads Manager never shows it); update: default as it is'),
  filters: z.array(conditionArg).min(1).max(MAX_RULE_FILTERS).optional()
    .describe('ALL its conditions (an update replaces the whole list): an entity_type (AD, ADSET, CAMPAIGN) or an id filter, and a time_preset whenever a result is named'),
  trigger: triggerArg.optional(),
}).describe('which objects the rule acts on')
const executionArg = z.object({
  type: z.preprocess(upper, z.enum(RULE_EXECUTION_TYPES)).describe('NOTIFICATION, PAUSE, UNPAUSE (switch on: can spend), CHANGE_BUDGET (ad sets), CHANGE_CAMPAIGN_BUDGET (campaigns), CHANGE_BID (ad sets), ROTATE, REBALANCE_BUDGET (schedule rules), PING_ENDPOINT (trigger rules)'),
  change: z.object({
    unit: z.preprocess(upper, z.enum(CHANGE_UNITS)).optional().describe('ACCOUNT_CURRENCY (amountCents) or PERCENTAGE (amountPercent); none with a target'),
    amountCents: z.number().int().min(-100_000_000_000).max(100_000_000_000).optional().describe('by this many minor units (negative cuts)'),
    amountPercent: z.number().min(-100).max(1000).optional().describe('by this percentage (negative cuts)'),
    targetField: fieldArg.optional().describe('scale towards a target of this result (cost_per_purchase_fb, website_purchase_roas …): the bid or budget moves proportionally, up or down'),
    targetValue: z.number().positive().optional().describe('the target, for a plain field'),
    targetValueCents: z.number().int().positive().max(100_000_000_000).optional().describe('the target, for a money field (minor units)'),
    targetValueAsMeta: z.number().positive().optional().describe('the target, for any other field (a ROAS as a number)'),
    limitCents: z.union([z.number().int().positive().max(100_000_000_000), z.array(z.number().int().positive().max(100_000_000_000)).length(2)]).optional()
      .describe('the most a raise reaches / the least a cut leaves (minor units); with a target, [lowest, highest]'),
  }).optional().describe('CHANGE_BUDGET, CHANGE_CAMPAIGN_BUDGET, CHANGE_BID: how the budget or bid moves'),
  rebalance: z.object({
    type: z.preprocess(upper, z.enum(REBALANCE_TYPES)).describe('EVEN and PROPORTIONAL pause the ad sets that match and move their budget to the others; NO_PAUSE_PROPORTIONAL, MATCHED_ONLY_PROPORTIONAL move budget without pausing'),
    targetField: fieldArg.optional().describe('the result that ranks the ad sets (needed unless EVEN)'),
    targetCount: z.number().int().min(1).max(1000).optional().describe('only the best N receive budget'),
    crossCampaign: z.boolean().optional().describe('move budget across campaigns (default within each campaign)'),
    inverse: z.boolean().optional().describe('rank low values first (a cost)'),
  }).optional().describe('REBALANCE_BUDGET: how budget moves between ad sets'),
  notifyUserIds: z.array(z.string().trim().regex(/^\d{1,20}$/, 'a Facebook user id is digits only')).min(1).max(MAX_RULE_PEOPLE).optional()
    .describe('Facebook people Meta notifies (and, for a schedule rule, e-mails a daily summary); Nexus cannot check who they are'),
  maxActionsPerObject: z.number().int().min(1).max(100_000).optional().describe('budget or bid changes: at most this many per object (execution_count_limit)'),
  minMinutesBetweenActions: z.number().int().min(1).max(525_600).optional().describe('budget or bid changes: at least this many minutes between two on the same object (action_frequency)'),
}).describe('what the rule does to the objects that match (update: the whole action)')
const scheduleArg = z.object({
  type: z.preprocess(upper, z.enum(RULE_SCHEDULE_TYPES)).describe('DAILY (just after midnight, account time), HOURLY, SEMI_HOURLY, CUSTOM (times)'),
  times: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe('0 = Sunday … 6 = Saturday (default every day)'),
    startMinute: z.number().int().min(0).max(1440).optional().describe('minutes after midnight, a multiple of 30 (alone: that time; without it: every 30 minutes on the days)'),
    endMinute: z.number().int().min(0).max(1440).optional().describe('with startMinute: to this minute (a multiple of 30)'),
  })).min(1).max(MAX_SCHEDULE_ENTRIES).optional().describe('CUSTOM: the times (OR-ed)'),
}).describe('a schedule rule\'s schedule (update: the whole schedule)')

// ── shared ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A builder that turns a refusal of the live reads or of the draft into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof RuleRefusal || err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const specOf = (v: unknown): Record<string, unknown> | null => {
  if (typeof v === 'string') { try { const o = JSON.parse(v) as unknown; return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : null } catch { return null } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/** Meta's 2703 in plain words (reference adrules_library: "Rules that turn off ads can't have cost conditions"). */
function plainMetaWords(out: ToolResult): ToolResult {
  if (out.ok || typeof out.error !== 'string' || !/\(2703\b/.test(out.error)) return out
  return { ...out, error: `${out.error} In plain words: Meta does not take a rule that turns ads off together with a spend or cost condition — change the conditions (no spend or cost condition) or the action (notify instead), and ask again.` }
}

/** The run's record: what the change replaced, and the rule as Meta reads it back (its id, for a new one). */
function ruleFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>) {
  const before = draft.before as RuleRecord
  const planned = draft.after as RuleRecord
  const node = done[0]?.result.node ?? null
  if (planned.action === 'run') {
    return { data: { ruleId: planned.id, ran: true, sentence: 'Meta runs the rule now: what it did shows in meta-ad-rules view history (ruleId) within minutes.', noUndo: before.noUndo }, before, after: planned }
  }
  if (planned.action === 'remove') return { data: { ruleId: planned.id, deleted: true }, before, after: planned }
  const id = planned.id || (node && (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : '')
  const read = node && node.evaluation_spec !== undefined
    ? ruleStateOf(text(node.name), text(node.status), { evaluation: specOf(node.evaluation_spec), execution: specOf(node.execution_spec), schedule: specOf(node.schedule_spec) })
    : null
  const after: RuleRecord = { ...planned, id, ...(read ? { rule: read } : {}) }
  return {
    data: { ruleId: id || null, name: after.rule?.name ?? null, status: after.rule?.status ?? null, ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}), ...(read ? {} : { readBack: 'Meta\'s read-back held no specs: the record keeps the rule as Nexus sent it.' }) },
    before,
    after,
  }
}

/** Undo's "now": the rule as Meta has it, in the shape of the record's after. */
async function currentOf(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as RuleRecord & { accountId?: string; adAccountId?: string }
  if (after.action === 'run') return change.after
  const account = await recordAccount(after)
  if (!account || !after.id) return null
  if (after.exists === 'no') {
    const gone = await liveRuleGone(account, after.id)
    return gone === null ? null : gone ? after : { ...after, exists: 'yes' }
  }
  try {
    const live = await liveRule(account, after.id)
    if (live.status === 'DELETED') return { ...after, exists: 'no' }
    return { ...after, rule: ruleStateOf(live.name, live.status, live.specs) }
  } catch (err) {
    if (err instanceof MetaLiveRefusal && /not a rule of the ad account/.test(err.message)) return { ...after, exists: 'no', rule: undefined }
    // Not readable now (another account, a throttle, a lost token): undo says it cannot compare, and sends nothing.
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
    throw err
  }
}

// ── set-meta-ad-rule ────────────────────────────────────────────────────────────────────────────────────────────────

const ruleRequest = (args: Record<string, unknown>): AdRuleRequest => {
  const { connectionId: _c, why: _w, ...rest } = args
  return rest as unknown as AdRuleRequest
}

const buildRule = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = ruleRequest(args)
  const words = await ruleWordsFor(account)
  if (request.action === 'create') return adRuleDraft(request, { adAccountId: account.adAccountId, currency: account.currency, live: null, preview: null, words })
  if (!request.ruleId) return { refusal: `action ${request.action} names the rule (ruleId, from meta-ad-rules view list).` }
  const live = await liveRule(account, request.ruleId)
  // Meta previews schedule rules only (RU-031): for a run, a switch-on and a change of its parts.
  const wantsPreview = live.words.evaluationType === 'SCHEDULE' && live.status !== 'DELETED'
    && (request.action === 'run' || (request.action === 'status' && request.enabled === true) || (request.action === 'update' && (!!request.evaluation || !!request.execution || !!request.schedule)))
  const preview = wantsPreview ? await liveRulePreview(account, live.id) : null
  return adRuleDraft(request, { adAccountId: account.adAccountId, currency: account.currency, live, preview, words })
})

const setMetaAdRuleUndo: ToolUndo = {
  current: currentOf,
  request(change: ToolChange) {
    const before = (change.before ?? {}) as RuleRecord & { accountId?: string }
    const after = (change.after ?? {}) as RuleRecord
    const connection = before.accountId ? { connectionId: before.accountId } : {}
    if (before.action === 'create') {
      if (!after.id) return { refusal: 'The new rule\'s id was not recorded, so Nexus cannot delete it: meta-ad-rules view list shows it; remove-meta-ad-rule deletes it.' }
      return { tool: 'remove-meta-ad-rule', args: { ...connection, ruleId: after.id, confirmDelete: true, why: 'undo of an earlier Meta rule that Nexus made' } }
    }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
    return { tool: 'set-meta-ad-rule', args: { ...connection, ...before.undo, why: 'undo of an earlier Meta rule change' } }
  },
}

const setMetaAdRule: AgentTool = {
  name: 'set-meta-ad-rule',
  title: 'Make or change a Meta automated rule',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A new rule is deleted again, a change or a switch put back; a run cannot be taken back by Nexus (its history can).
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'run' ? { reversibility: 'none' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_RULE_CHANGE_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'update', 'status', 'run']).describe('create a rule; update any of its parts; status: switch it on or off; run a schedule rule now'),
    ruleId: metaIdArg('update, status, run: the rule (meta-ad-rules view list shows it)').optional(),
    name: typedText.optional().describe('create: its name (required); update: a new name'),
    evaluation: evaluationArg.optional(),
    execution: executionArg.optional(),
    schedule: scheduleArg.optional(),
    enable: z.boolean().optional().describe('create: true makes it ON at once (SPENDS MONEY when its action can raise spend); default: made OFF'),
    enabled: z.boolean().optional().describe('status: true switches it on (SPENDS MONEY when its action can raise spend), false off'),
    why: metaWhyArg,
  }),
  description:
    'Meta\'s own automated rules on the business\'s chosen Meta ad account (meta-ad-rules reads them). action create: a '
    + 'schedule rule (DAILY, HOURLY, SEMI_HOURLY or CUSTOM times) or a trigger rule (real time: an object made, a setting '
    + 'changed, a milestone, a threshold crossed — Ads Manager never shows trigger rules), with its conditions (all AND-ed: '
    + 'an entity_type or id, settings, results with a time_preset, prefixed, aggregate and formula fields, ROAS windows) and '
    + 'its action (notify people, pause, switch on, change ad set or campaign budgets or ad set bids by an amount, a percent '
    + 'or towards a target, rotate ads, rebalance budget, call the app\'s webhook). A new rule is ALWAYS made switched OFF '
    + 'unless enable is true. action update: any part — Meta needs the whole rule, so the parts not named are sent as Meta '
    + 'has them. action status: switch it on or off. action run: run a schedule rule now. The preview of a run, a switch-on '
    + 'and a change shows Meta\'s own preview of the objects the rule would act on now (a POST that only reads). Money in '
    + 'minor units of the account currency (valueCents, amountCents, limitCents, targetValueCents); a ROAS or a ratio '
    + 'exactly as Meta reads it (valueAsMeta). Switching on, making on or running a rule that can raise spend (switch on, a '
    + 'raise, a move towards a target, a rebalance) is SPENDS MONEY; so is switching off or changing a rule that is on and '
    + 'pauses or cuts (what it stops keeps spending). Meta has no check for rules. Not here: Meta\'s recommended rules '
    + '(recommended_rule_key: Meta documents no value) and the enum\'s undocumented actions. Undo deletes a new rule, puts '
    + 'back a change or a switch; a run has no undo (meta-ad-rules view history shows what it did). Deleting is '
    + 'remove-meta-ad-rule.'
    + META_CHANGE_RULES,
  undo: setMetaAdRuleUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRule(args)),
  execute: async (args, ctx) => plainMetaWords(await runMetaChange(args, ctx, buildRule(args), ruleFinish)),
}

// ── remove-meta-ad-rule ─────────────────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.confirmDelete !== true) return { refusal: 'Deleting a rule needs confirmDelete: true — only when the person asked to delete it.' }
  const words = await ruleWordsFor(account)
  const live = await liveRule(account, String(args.ruleId))
  return removeRuleDraft({ adAccountId: account.adAccountId, currency: account.currency, live, preview: null, words })
})

const removeMetaAdRuleUndo: ToolUndo = {
  current: currentOf,
  request(change: ToolChange) {
    const before = (change.before ?? {}) as RuleRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the rule was not recorded.'}` }
    return { tool: 'set-meta-ad-rule', args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...before.undo, why: 'undo of an earlier Meta rule deletion: the rule made again (a new id)' } }
  },
}

const removeMetaAdRule: AgentTool = {
  name: 'remove-meta-ad-rule',
  title: 'Delete a Meta automated rule',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Deleting is for good on Meta; undo makes a new rule like it (a new id, without this one's run history).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_RULE_CHANGE_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    ruleId: metaIdArg('the rule to delete (meta-ad-rules view list shows it)'),
    confirmDelete: z.literal(true).describe('true: the person asked to delete this rule — set it only on their explicit ask'),
    why: metaWhyArg,
  }),
  description:
    'Delete ONE of Meta\'s automated rules on the business\'s chosen Meta ad account (meta-ad-rules view list shows them) — '
    + 'only when the person explicitly asked to delete it (confirmDelete: true). Deleting is for good on Meta; undo makes a '
    + 'NEW rule with the same name, conditions, action, schedule and status (a new id; the deleted one\'s run history does '
    + 'not come back). Deleting a rule that is on and pauses ads or cuts budgets or bids is SPENDS MONEY: what it would have '
    + 'stopped keeps spending. To stop a rule for a while, switch it off instead (set-meta-ad-rule action status). Meta has '
    + 'no check for this change.'
    + META_CHANGE_RULES,
  undo: removeMetaAdRuleUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), ruleFinish),
}

export const META_ADS_RULES_TOOLS: AgentTool[] = [setMetaAdRule, removeMetaAdRule]
