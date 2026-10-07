/**
 * ADS AUTONOMY W4-8 (agent-results/6 §4 "W3-6b") — the engine settings a person changes on the ads screens, for Claude:
 *
 *   assign-ad-rules     which campaigns an Amazon ads rule acts on — add, remove or replace, up to 250 in one request —
 *                       through the screens' own paths (the rule drawer's picker save, the Apply Rules page's Apply:
 *                       ads-rule-assign.service.ts). The preview lists each campaign with its market and warns when it
 *                       is not the rule's market (its scope, else the market its name ends with).
 *   set-coverage-set    a coverage set's seed and its terms (lead ASIN, max CPC, target share, control, Active / Paused)
 *                       through the Family Cockpit's own service (ads-coverage-set-change.service.ts). Its caps stay in
 *                       tune-ad-engine; switching it is turn-up / turn-down-automation (A12).
 *   run-ad-engine-now   the Ads Control Room's Run now for one engine (ads-engine-run-now.service.ts): the same start, the
 *                       engine's own level, limits and write gate. The preview says when it last ran, that a run on the
 *                       same data takes one more step, and it is refused while the engine runs.
 *
 * Every one: default level ask, ceiling auto (D2 = B), strategy-bound as the ads strategy's `automation` kind (fields.ts),
 * limits that refuse by default. What can raise spend is said in `raises` and carries `stepUp` (the approver's
 * authenticator code); by rule a raise runs only where the business's limits allow it (allowRaise; for run-now, maxItems
 * 1 and the engines it lists). ONE helper per tool decides what raises (the Owner's open question can flip it there):
 * assignRaises, termRaise, runRaises. The two settings tools are Nexus only; run-now reaches Amazon through the engine.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, type KitItem } from './ads-autonomy-kit.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { STEP_UP_NEEDS, stepUpApproval, type StepUp } from '../step-up-approval.js'
import { ASSIGN_OPS, MAX_ASSIGN_CAMPAIGNS, applyRuleAssign, planRuleAssign, ruleBindingNow, type AssignInput, type AssignPlan, type BindingState } from '../../advertising/ads-rule-assign.service.js'
import { COVERAGE_OPS, MAX_TERM_EDITS, TERM_STATUSES, applyCoverageChange, coverageStateNow, planCoverageChange, type CoverageInput, type CoveragePlan, type CoverageState } from '../../advertising/ads-coverage-set-change.service.js'
import { RUN_NOW_ENGINE_KEYS, RUN_NOW_ENGINES, planEngineRun, startEngineRun, type EnginePlan, type RunNowEngine } from '../../advertising/ads-engine-run-now.service.js'

const ID = z.string().trim().min(1).max(64)
const WHY = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it')
const A_PERSON = 'a person decides'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** How a raise is approved, in one sentence (its stepUp). */
const RAISE_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked '
  + 'confirms it in Claude with theirs when the business set this tool to confirm in Claude. By rule only where the business\'s limits allow it.'

const stepUpOf = (what: string, raises: string[]): StepUp => ({ what, raises, needs: STEP_UP_NEEDS, how: RAISE_HOW })

/**
 * `execute` of a request whose fresh plan raises: by rule it ran because the business's limits let it (withinLimits judged
 * the fresh dry run at commit); a person's approval must carry the approver's code. Null when it may run.
 */
async function raiseGate(ctx: ToolContext, raises: readonly string[]): Promise<string | null> {
  if (!raises.length || ctx.decidedVia === 'auto') return null
  const coded = await stepUpApproval(ctx)
  return 'refusal' in coded ? coded.refusal : null
}

/** The actor and the audit words of an approved run (who approved it, the request), or why it may not run. */
function runAs(ctx: ToolContext, why: unknown, fallback: string): { actor: `user:${string}`; reason: string } | { refusal: string } {
  const run = approvedRun(ctx, String(why ?? '').trim() || fallback)
  if ('refusal' in run) return { refusal: `Not run: ${run.refusal}.` }
  return { actor: run.actor as `user:${string}`, reason: run.reason }
}

// ── assign-ad-rules ───────────────────────────────────────────────────────────────────────────────

/**
 * Limits: the kit's (maxItems 0 — every request waits for a person until he types a number) and whether a change that
 * can raise spend (an Auto rule's reach) may run by rule. A campaign outside the rule's market never runs by rule.
 */
const ASSIGN_LIMITS = adKitLimits({ maxItems: 0 }, {
  allowRaise: z.boolean().default(false)
    .describe('let a change of what a rule at Auto acts on run by rule when it can raise spend; never by default'),
})

type AssignPreview = Omit<AssignPlan, 'before' | 'after'> & { limitFacts?: unknown; stepUp?: StepUp }

function assignRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as AssignPreview | null
  if (p?.action !== 'assign-ad-rules') return `there is no preview of this rule assignment to check; ${A_PERSON}`
  // Its own checks first: a campaign outside the rule's market never runs by rule; a raise only with allowRaise.
  if (typeof p.totals?.otherMarketAfter !== 'number') return `the preview does not say which campaigns are outside the rule's market; ${A_PERSON}`
  if (p.totals.otherMarketAfter > 0) return `it binds "${p.rule.name}" to ${plural(p.totals.otherMarketAfter, 'campaign')} outside ${p.rule.market} (its ${p.rule.marketFrom}): ${A_PERSON}`
  if (!Array.isArray(p.raises)) return `the preview does not say whether it can raise spend; ${A_PERSON}`
  if (p.raises.length && limits.allowRaise !== true) return `it can raise spend (${p.raises.join('; ')}): ${A_PERSON}, with their authenticator code (allowRaise is off)`
  return commonRefusal(preview, limits)
}

function assignInput(args: Record<string, unknown>): AssignInput {
  return { ruleId: String(args.ruleId ?? ''), op: args.op as AssignInput['op'], campaignIds: (args.campaignIds as string[] | undefined) ?? [] }
}

/** The kit's facts: each campaign it adds or removes, placed where it lands; a raise as the rule at Auto moves it. */
async function assignFacts(plan: AssignPlan, approvalId?: string | null) {
  const auto = plan.rule.level === 'AUTO'
  const items: KitItem[] = [
    ...plan.added.map((id): KitItem => ({ entity: { kind: 'campaign', id }, change: { field: 'automation', raises: auto && plan.moves.up }, nexusOnly: true })),
    ...plan.removed.map((id): KitItem => ({ entity: { kind: 'campaign', id }, change: { field: 'automation', raises: auto && plan.moves.down }, nexusOnly: true })),
  ]
  return buildLimitFacts({ tool: 'assign-ad-rules', items, approvalId, exceptIds: [plan.rule.id] })
}

/** C2 — the undo asks this tool again for the list the rule had (replace); a rule that acted on every campaign is a person's edit. */
export const ASSIGN_UNDO: ToolUndo = {
  current: async (change) => ruleBindingNow((change.after as BindingState).ruleId),
  request(change) {
    const before = change.before as BindingState
    if (before.all) return { refusal: `Before this change "${before.name}" had no campaigns picked and acted on every campaign in its scope. Putting that back empties its list: a rule edit a person makes in the rule drawer in Nexus.` }
    return { tool: 'assign-ad-rules', args: { ruleId: before.ruleId, op: 'replace', campaignIds: before.campaignIds, why: 'undo of a rule assignment' } }
  },
}

const assignAdRules: AgentTool = {
  name: 'assign-ad-rules',
  title: 'Assign an ads rule to campaigns',
  category: 'automation',
  description:
    `Change which campaigns an Amazon ads rule acts on: add, remove or replace (up to ${MAX_ASSIGN_CAMPAIGNS} campaigns in one request), `
    + 'the way the rule drawer (a Budget, Bid, Share of voice, Keyword Tracker or Placement rule: its campaign picker) and the Apply Rules '
    + 'page (an engine budget rule) do it. The preview lists every campaign it adds or takes off with its market, the campaigns '
    + 'by market after the change, other rules and schedules already on the campaigns it adds, and WARNS when a campaign is not in '
    + 'the rule\'s market (its scope, else the market its name ends with, e.g. "… — DE"). Nexus only: the rule acts as itself, '
    + 'at its own level, on its next run. A person approves it in Nexus, or confirms it in Claude with their code when the '
    + 'business set it so — or it runs by the business\'s rule inside its limits and the ads strategy (none by default). '
    + 'Changing what a rule at Auto acts on can raise spend: the preview says so in raises, and approving it needs the '
    + 'approver\'s authenticator code (by rule only with allowRaise); a campaign outside the rule\'s market never runs by rule. '
    + 'Refused, and not queued: a rule that is not bound to campaigns (its scope decides: save-ad-rule), one the autopilot binds, '
    + 'a campaign not found, picks the rule drawer would refuse (outside the rule\'s market scope, a Placement pick that is not '
    + 'Sponsored Products), a request that would empty a Bid, SOV, Keyword Tracker or Placement rule (empty means every '
    + 'campaign: turn the rule down instead). undo-change puts the list back.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: the rule's campaign list. The rule acts on its next run, at its own level.
  openWorld: false,
  requires: [F.adsAutomationManage, F.adsCampaignsManage, FIELDS.financialsAdspendView],
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: ASSIGN_LIMITS,
  withinLimits: assignRefusal,
  undo: ASSIGN_UNDO,
  input: z.object({
    ruleId: ID.describe('the Amazon ads rule (its Nexus id, from list-automations A1 / automation-detail)'),
    op: z.enum(ASSIGN_OPS).describe('add (bind it to these campaigns too), remove (take these off it) or replace (exactly these)'),
    campaignIds: z.array(ID).max(MAX_ASSIGN_CAMPAIGNS).describe(`the campaigns (Nexus ids, from ad-campaigns), up to ${MAX_ASSIGN_CAMPAIGNS}; replace with [] unbinds a budget rule from every campaign`),
    why: WHY,
  }),
  async handler(args, ctx) {
    const planned = await planRuleAssign(assignInput(args))
    if ('error' in planned) return { ok: false, error: planned.error }
    const { before: _before, after: _after, ...plan } = planned.plan
    const limitFacts = await assignFacts(planned.plan, ctx.approvalId)
    return {
      ok: true,
      preview: {
        ...plan,
        limitFacts,
        ...(plan.raises.length ? { stepUp: stepUpOf(`changes what the ads rule "${plan.rule.name}" acts on at Auto`, ['Rule reach']) } : {}),
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const input = assignInput(args)
    const planned = await planRuleAssign(input)
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    // Never by rule: a campaign outside the rule's market (withinLimits refuses it; this holds an old or edited request).
    if (ctx.decidedVia === 'auto' && planned.plan.totals.otherMarketAfter > 0) return notRun(`Not run: it binds a campaign outside the rule's market, and that never runs by rule; ${A_PERSON}.`)
    const raised = await raiseGate(ctx, planned.plan.raises)
    if (raised) return notRun(raised)
    const run = runAs(ctx, args.why, `rule campaigns ${input.op}`)
    if ('refusal' in run) return notRun(run.refusal)
    const out = await applyRuleAssign(input, run.actor, run.reason)
    if ('error' in out) return notRun(`Not run: ${out.error}`)
    return {
      ok: true,
      data: { ruleId: out.plan.rule.id, rule: out.plan.rule.name, binding: out.plan.binding, added: out.plan.added.length, removed: out.plan.removed.length, campaigns: out.after.campaignIds.length, effect: out.plan.effect },
      change: { before: out.before, after: out.after },
    }
  },
}

// ── set-coverage-set ──────────────────────────────────────────────────────────────────────────────

const COVERAGE_LIMITS = adKitLimits({ maxItems: 0 }, {
  allowRaise: z.boolean().default(false)
    .describe('let a term edit that lets the coverage engine bid higher run by rule; never by default'),
})

type CoveragePreview = Omit<CoveragePlan, 'before' | 'after'> & { limitFacts?: unknown; stepUp?: StepUp }

function coverageRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as CoveragePreview | null
  if (p?.action !== 'set-coverage-set') return `there is no preview of this coverage set change to check; ${A_PERSON}`
  if (!Array.isArray(p.raises)) return `the preview does not say whether it can raise spend; ${A_PERSON}`
  if (p.raises.length && limits.allowRaise !== true) return `it lets the coverage engine bid higher (${p.raises.slice(0, 3).join('; ')}): ${A_PERSON}, with their authenticator code (allowRaise is off)`
  return commonRefusal(preview, limits)
}

function coverageInput(args: Record<string, unknown>): CoverageInput {
  return { op: args.op as CoverageInput['op'], portfolioId: args.portfolioId as string | undefined, setId: args.setId as string | undefined, terms: args.terms as CoverageInput['terms'] }
}

/** The kit's facts: one item per term it edits (one for a seed), where the set acts. */
async function coverageFacts(plan: CoveragePlan, approvalId?: string | null) {
  const { coverageSeedScope, automationEntity, tuneScope } = await import('../../advertising/ads-strategy/automation-scope.js')
  const scope = plan.set.id ? await tuneScope('coverage-set', plan.set.id, {}) : await coverageSeedScope(plan.set.portfolioId)
  const entity = await automationEntity(scope)
  const terms = plan.op === 'seed' ? [null] : (plan.basis as { terms: Array<{ to: { termId: string } }> }).terms.map((t) => t.to.termId)
  const items: KitItem[] = entity
    ? terms.map((termId): KitItem => ({ entity, change: { field: 'automation', raises: !!termId && plan.raisedTerms.includes(termId) }, nexusOnly: true }))
    : []
  const limitFacts = await buildLimitFacts({ tool: 'set-coverage-set', items, approvalId, exceptIds: plan.set.id ? [plan.set.id] : [] })
  // A set Nexus cannot place in one market's strategy is said as such (C1 refuses it by rule).
  if (!entity && 'unplaced' in scope) limitFacts.unplaced.push({ entity: `coverage-set:${plan.set.id ?? plan.set.portfolioId}`, why: scope.unplaced })
  return limitFacts
}

/** C2 — term edits are put back by this tool (the values they had); a seed's terms are paused (the set it made stays). */
export const COVERAGE_UNDO: ToolUndo = {
  current: (change) => coverageStateNow(change.after as CoverageState),
  request(change) {
    const after = change.after as CoverageState
    const before = change.before as CoverageState | { seeded: true; setId: string | null }
    if ('seeded' in before) {
      if (!after.terms.length) return { refusal: `That seed added no term${before.setId ? '' : `; the set "${after.name}" it created stays, switched off (nothing reads it)`}.` }
      return { tool: 'set-coverage-set', args: { op: 'edit-terms', setId: after.setId, terms: after.terms.map((t) => ({ termId: t.termId, status: 'PAUSED' })), why: 'undo of a coverage seed: its terms are paused' } }
    }
    return {
      tool: 'set-coverage-set',
      args: {
        op: 'edit-terms', setId: before.setId, why: 'undo of a coverage term edit',
        terms: before.terms.map((t) => ({ termId: t.termId, leadAsin: t.leadAsin, status: t.status, maxCpcCents: t.maxCpcCents, targetSharePct: t.targetSharePct, isControl: t.isControl })),
      },
    }
  },
}

const setCoverageSet: AgentTool = {
  name: 'set-coverage-set',
  title: 'Seed or edit a coverage set',
  category: 'automation',
  description:
    'Change a coverage set the way the Family Cockpit does: seed (op seed, a portfolio — top up its set from the family\'s measured '
    + 'Search Query Performance; existing terms keep their edits; a new set is a switched-off draft; a new term has no target share, '
    + `so the engine can only hold or lower its bid) or edit terms (op edit-terms, up to ${MAX_TERM_EDITS}: lead ASIN — one of the `
    + 'family\'s own, max CPC in cents, target share in %, control — held out of the engine, Active or Paused). The set\'s caps are '
    + 'tune-ad-engine (coverage-set); switching the set on or off is turn-up / turn-down-automation A12. Nexus only: the coverage '
    + 'engine reads the set on its next run and moves bids itself, at its own level (the preview says which). A person approves it '
    + 'in Nexus, or confirms it in Claude with their code when the business set it so — or it runs by the business\'s rule inside '
    + 'its limits and the ads strategy (none by default). An edit that lets the engine bid higher (a term Active again or handed '
    + 'back to the engine with a target, a higher target share, a higher or cleared max CPC) is listed in raises and needs the '
    + 'approver\'s authenticator code (by rule only with allowRaise). Refused, and not queued: a term not in the set, a retired '
    + 'term, a lead ASIN the family does not advertise, nothing to change. undo-change puts the values back (a seed: its terms '
    + 'are paused; a set it created stays as a draft).',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: the set. The coverage engine acts on its next run, at its own level.
  openWorld: false,
  requires: [F.adsAutomationManage, F.adsCampaignsManage, FIELDS.financialsAdspendView],
  // A seed's terms are paused by undo; a set it created stays (as a switched-off draft).
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: COVERAGE_LIMITS,
  withinLimits: coverageRefusal,
  undo: COVERAGE_UNDO,
  input: z.object({
    op: z.enum(COVERAGE_OPS).describe('seed (a portfolio\'s set, from its measured evidence) or edit-terms'),
    portfolioId: ID.optional().describe('seed: the portfolio (its Amazon portfolio id, as the cockpit and ad-campaigns show it)'),
    setId: ID.optional().describe('edit-terms: the coverage set (from automation-detail A12)'),
    terms: z.array(z.object({
      termId: ID.describe('the term (its id in the set)'),
      leadAsin: z.string().trim().min(10).max(10).nullable().optional().describe('the family ASIN that leads the term (one of the family\'s own); null = none'),
      status: z.enum(TERM_STATUSES).optional().describe('ACTIVE (the engine holds it) or PAUSED (the engine leaves it alone; nothing at Amazon is paused)'),
      maxCpcCents: z.coerce.number().int().min(1).max(100_000).nullable().optional().describe('the highest bid the engine may set for it, in cents of the market\'s currency; null = the engine\'s default'),
      targetSharePct: z.coerce.number().gt(0).max(100).nullable().optional().describe('the impression share it aims for, in % (e.g. 25); null = none (the engine only holds or lowers)'),
      isControl: z.boolean().optional().describe('true holds it out of the engine as a control; false hands it to the engine'),
    })).max(MAX_TERM_EDITS).optional().describe(`edit-terms: each term with only the fields that change, up to ${MAX_TERM_EDITS}`),
    why: WHY,
  }),
  async handler(args, ctx) {
    const planned = await planCoverageChange(coverageInput(args))
    if ('error' in planned) return { ok: false, error: planned.error }
    const { before: _before, after: _after, ...plan } = planned.plan
    const limitFacts = await coverageFacts(planned.plan, ctx.approvalId)
    return {
      ok: true,
      preview: {
        ...plan,
        limitFacts,
        ...(plan.raises.length ? { stepUp: stepUpOf(`lets the coverage engine bid higher on ${plural(plan.raises.length, 'term')} of "${plan.set.name}"`, ['Coverage bids']) } : {}),
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const input = coverageInput(args)
    const planned = await planCoverageChange(input)
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    const raised = await raiseGate(ctx, planned.plan.raises)
    if (raised) return notRun(raised)
    const run = runAs(ctx, args.why, `coverage set ${input.op}`)
    if ('refusal' in run) return notRun(run.refusal)
    const out = await applyCoverageChange(input, run.actor)
    if ('error' in out) return notRun(`Not run: ${out.error}`)
    return {
      ok: true,
      data: { op: out.plan.op, set: { id: out.after.setId, name: out.after.name }, terms: out.after.terms.length, effect: out.plan.effect },
      change: { before: out.before, after: out.after },
    }
  },
}

// ── run-ad-engine-now ─────────────────────────────────────────────────────────────────────────────

/**
 * Limits, by the irreversible tools' convention (tool-contract rule 7c: the default COUNT refuses): `maxItems` 0 — every
 * run waits for a person until he types 1; then only the engines he leaves on `engines`, and not sooner after the
 * engine's last run than `minHoursSinceLastRun` (a run on the same data takes one more step).
 */
const RUN_LIMITS = z.object({
  maxItems: z.number().int().min(0).max(1).default(0)
    .describe('the most engine runs one request may start by rule (a request starts one); 0 = every run waits for a person'),
  engines: z.array(z.enum(RUN_NOW_ENGINE_KEYS)).max(RUN_NOW_ENGINE_KEYS.length).default([...RUN_NOW_ENGINE_KEYS])
    .describe(`the engines Claude may run now by rule once maxItems is 1 (${RUN_NOW_ENGINE_KEYS.join(', ')}); fewer is tighter`),
  minHoursSinceLastRun: z.number().min(0).max(168).default(6)
    .describe('by rule only when the engine last ran at least this many hours ago: a run on the same data takes one more step'),
})

/**
 * ONE place decides what a run raises (the Owner's open question: it can flip here). At Auto an engine's run can raise
 * bids or budgets as any of its runs can — and on the same data it takes one more step; below Auto nothing reaches Amazon.
 */
export function runRaises(plan: Pick<EnginePlan, 'level' | 'name'>): string[] {
  return plan.level === 'AUTO' ? [`${plan.name} runs at Auto: it may raise bids or budgets on this run, and on the same data as its last run it takes one more step`] : []
}

type RunPreview = EnginePlan & { raises?: string[]; limitFacts?: unknown; stepUp?: StepUp }

function runRefusal(preview: unknown, limits: Record<string, unknown>, now = new Date()): string | null {
  const p = preview as RunPreview | null
  if (p?.action !== 'run-ad-engine-now') return `there is no preview of this engine run to check; ${A_PERSON}`
  if (!limitFactsOf(preview)) return commonRefusal(preview, limits)
  if (!(typeof limits.maxItems === 'number' && limits.maxItems >= 1)) return `this tool's limits let no engine run start by rule (maxItems 0: every run waits for a person); ${A_PERSON}`
  const listed = Array.isArray(limits.engines) ? (limits.engines as string[]) : []
  if (!listed.includes(p.engine)) return `${p.name} is not on the engines Claude may run now by rule (engines${listed.length ? `: ${listed.join(', ')}` : ' is empty'}); ${A_PERSON}`
  const min = typeof limits.minHoursSinceLastRun === 'number' ? limits.minHoursSinceLastRun : 6
  if (p.lastRun) {
    const hours = (now.getTime() - new Date(p.lastRun.at).getTime()) / 3600_000
    if (hours < min) return `${p.name} last ran ${Math.round(hours * 10) / 10} h ago, less than the ${min} h this tool's limits want between runs by rule (a run on the same data takes one more step); ${A_PERSON}`
  }
  return commonRefusal(preview, limits)
}

const runAdEngineNow: AgentTool = {
  name: 'run-ad-engine-now',
  title: 'Run an ads engine now',
  category: 'automation',
  description:
    `Run one Amazon ads engine now, once, for this business: ${RUN_NOW_ENGINE_KEYS.map((k) => `${k} (${RUN_NOW_ENGINES[k].name})`).join(', ')} — `
    + 'the Ads Control Room\'s own Run now (and the Sync Logs hub\'s). Harvesting runs as Keyword Harvesting rules (rules); budget '
    + 'pacing is budget-enforce. The run is the engine\'s own: its level, limits and Amazon\'s write gate decide every change, as on '
    + 'its scheduled run, and its changes are its own in the Change Log. The preview says what the engine may do now, when it last '
    + 'ran and how often it runs, and that a second run on the same data takes one more step (it does not remember that it just '
    + 'moved a bid). Refused, and not queued: while the engine runs (with when that run should end), and wherever the Control Room '
    + 'does not offer Run now (the engine off, or a live run its switch or the server would refuse). A person approves it in Nexus, '
    + 'or confirms it in Claude with their code when the business set it so — or it runs by the business\'s rule only once its '
    + 'limits allow a run (maxItems 1; none by default), for the engines they list, and not sooner than minHoursSinceLastRun after '
    + 'the engine\'s last run. A run at '
    + 'Auto can raise spend: approving it needs the approver\'s authenticator code. It cannot be called back.',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // The engine writes to Amazon itself, through the write gate.
  openWorld: true,
  requires: [F.adsAutomationManage, F.syncManage, FIELDS.financialsAdspendView],
  // A run cannot be called back: each change it makes is the engine's own, in the Change Log.
  reversibility: 'none',
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: RUN_LIMITS,
  withinLimits: (preview, limits) => runRefusal(preview, limits),
  input: z.object({
    engine: z.enum(RUN_NOW_ENGINE_KEYS).describe(`the engine: ${RUN_NOW_ENGINE_KEYS.join(', ')}`),
    why: WHY,
  }),
  async handler(args, ctx) {
    const planned = await planEngineRun(args.engine as RunNowEngine)
    if ('error' in planned) return { ok: false, error: planned.error }
    const raises = runRaises(planned.plan)
    // An engine runs for the whole account: the strategy's facts hold no item (the door takes the strictest level of
    // the business for the `automation` kind, ads-strategy/claude.ts).
    const limitFacts = await buildLimitFacts({ tool: 'run-ad-engine-now', items: [], approvalId: ctx.approvalId })
    return {
      ok: true,
      preview: {
        ...planned.plan,
        raises,
        limitFacts,
        ...(raises.length ? { stepUp: stepUpOf(`runs ${planned.plan.name} now, at Auto`, ['Bids', 'Budgets']) } : {}),
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const engine = args.engine as RunNowEngine
    const planned = await planEngineRun(engine)
    if ('error' in planned) return notRun(`Not run: ${planned.error.replace(/^Not queued: /, '')}`)
    const raised = await raiseGate(ctx, runRaises(planned.plan))
    if (raised) return notRun(raised)
    const run = runAs(ctx, args.why, 'run now')
    if ('refusal' in run) return notRun(run.refusal)
    const out = await startEngineRun(engine)
    if ('error' in out) return notRun(out.error)
    return {
      ok: true,
      data: {
        engine, name: out.plan.name, job: out.plan.job, level: out.plan.level, startedAt: out.startedAt, lastRunBefore: out.plan.lastRun,
        note: 'Started. The run goes on in the background; approval-status says how it went once it ends.',
      },
      change: { before: { engine, job: out.plan.job, lastRun: out.plan.lastRun }, after: { engine, job: out.plan.job, startedAt: out.startedAt, requestedBy: run.actor } },
    }
  },
}

export const ADS_ENGINE_SETTINGS_TOOLS: AgentTool[] = [assignAdRules, setCoverageSet, runAdEngineNow]
