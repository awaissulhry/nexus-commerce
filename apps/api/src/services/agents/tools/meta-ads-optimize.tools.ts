/**
 * Meta ads step 8 (2026-10-21) — Claude's reads of Meta's own optimisation surfaces. Read only: nothing here changes Meta,
 * and the gateway lets only GET through (marketing/meta-ads/live-optimize.ts has the Meta facts and where they were read).
 *
 *   meta-recommendations  the opportunity score now and its recommendations (like Meta's own ads_get_opportunity_score),
 *                         the business portfolio's read for the chosen account, the score day by day and why (IN-105,
 *                         RC-001…RC-004), and for each recommendation how to act on it (RC-023)
 *   meta-experiments      A/B tests, creative tests and lift studies that touch the chosen account: list, the portfolio's,
 *                         one study with its groups, goals and results, who may see it, whether an object is in a test,
 *                         brand lift, Meta-run lift, the chosen Page's video A/B tests (AD-019, EX-001…EX-010, EX-012,
 *                         EX-900, EX-903)
 *   meta-ad-rules         Meta's automated rules, trigger rules included (Ads Manager hides those), one rule, a rule's
 *                         and the account's run history, why a rule stopped; the preview is a POST, so it comes with
 *                         set-meta-ad-rule, a later Nexus step (RU-001, RU-002, RU-029…RU-031, RU-034)
 * Money in minor units (cents) of the account currency, each money key restricted to the ad-spend money permission.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import {
  EXPERIMENT_VIEWS, metaAdRules, metaExperiments, metaRecommendations, OBJECT_KINDS, RECOMMENDATION_STAGES, RECOMMENDATION_VIEWS, RESULT_BREAKDOWNS,
  RULE_EVALUATION_TYPES, RULE_HISTORY_ACTIONS, RULE_STATUSES, RULE_VIEWS, STUDY_STATES, STUDY_TYPES,
  type ExperimentInput, type RecommendationInput, type RuleInput,
} from '../../marketing/meta-ads/live-optimize.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Each tool's own money keys (minor units of the account currency, or Meta's own units where the key says AsMeta). */
export const RECOMMENDATION_MONEY = { budgetThenCents: ADSPEND, budgetNowCents: ADSPEND, moneyTextAsMeta: ADSPEND } as const
export const EXPERIMENT_MONEY = { moneyAsMeta: ADSPEND, snapshotsAsMeta: ADSPEND } as const
export const RULE_MONEY = {
  valueCents: ADSPEND, amountCents: ADSPEND, limitCents: ADSPEND, targetValueCents: ADSPEND, oldValueCents: ADSPEND, newValueCents: ADSPEND,
  // Review fix N1 — the value of every rule field not on Nexus's plain list (ROAS, ratios of spend, anything new).
  valueAsMeta: ADSPEND, targetValueAsMeta: ADSPEND, oldValueAsMeta: ADSPEND, newValueAsMeta: ADSPEND,
} as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD)`)
const metaIdArg = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const maxRowsArg = z.number().int().min(1).max(500).optional().describe('at most this many rows (default 200)')
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

// ── meta-recommendations ─────────────────────────────────────────────────────────────────────────────────────────

const metaRecommendationsTool: AgentTool = {
  name: 'meta-recommendations',
  title: 'Meta opportunity score',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: RECOMMENDATION_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(RECOMMENDATION_VIEWS)).default('overview')
      .describe('overview (default: the score now with the recommendations) | score | list | portfolio | history'),
    stage: z.preprocess(lower, z.enum(RECOMMENDATION_STAGES)).optional()
      .describe('overview, list, portfolio: only recommendations for objects that run now (mid_flight) or for a new campaign (pre_create)'),
    names: z.array(z.preprocess(lower, z.string().regex(/^[a-z0-9_]{1,80}$/))).max(50).optional()
      .describe('overview, list, portfolio: only these recommendation names, Meta\'s lower-case snake case (e.g. fragmentation, aplusc_standard_enhancements_bundle)'),
    locale: z.string().trim().regex(/^[a-z]{2}_[A-Z]{2}$/).optional().describe('portfolio: the language of Meta\'s texts, e.g. it_IT (default: Meta\'s choice)'),
    from: dayArg('history: first day (default: 14 days before to; at most 45 days before to)'),
    to: dayArg('history: last day (default: two days ago in the account\'s time zone, Meta\'s latency; never today)'),
    reasons: z.boolean().optional().describe('history: also what moved the score each day, per campaign (default true)'),
    connectionId: connectionArg,
  }),
  description:
    'Meta\'s opportunity score (0–100: how well the chosen ad account follows Meta\'s best practices) and its '
    + 'recommendations, read live from Meta. view overview (default): the score now with every recommendation, like '
    + 'Meta\'s own opportunity-score tool. score: the score only. list: each recommendation with its type, stage, the '
    + 'campaigns, ad sets or ads it is about (names where Nexus has read them), Meta\'s expected lift, the points it adds '
    + 'to the score, its Ads Manager link, and how to act on it: the types Meta applies by API will go through '
    + 'apply-meta-recommendations, which comes with a later Nexus step (step 28; a person approves; a budget raise SPENDS '
    + 'MONEY) — until then the Ads Manager link; the others name the Nexus tool that does the same or Meta\'s screens. '
    + 'The texts of budget recommendations can name amounts and need the ad-spend money permission. Nexus also applies '
    + 'the stage and name filters to what Meta answers. portfolio: the business portfolio\'s read, asked about the chosen '
    + 'account only. '
    + 'history: the score day by day for up to 45 days (by default ending two days ago: Meta\'s data is two days late), '
    + 'and per campaign what moved it (budgets, applied '
    + 'or newly eligible recommendations). Meta may list fewer recommendations than Ads Manager; a recommendation cannot '
    + 'be dismissed by API (only in Ads Manager). Read only; budgets in minor units (cents) of the account currency.',
  async handler(args): Promise<ToolResult> {
    const input: RecommendationInput = {
      connectionId: str(args.connectionId),
      view: (args.view ?? 'overview') as RecommendationInput['view'],
      stage: (args.stage ?? null) as RecommendationInput['stage'],
      names: Array.isArray(args.names) ? args.names as string[] : null,
      locale: str(args.locale),
      from: str(args.from),
      to: str(args.to),
      reasons: args.reasons !== false,
    }
    return guarded(() => metaRecommendations(input))
  },
}

// ── meta-experiments ─────────────────────────────────────────────────────────────────────────────────────────────

const metaExperimentsTool: AgentTool = {
  name: 'meta-experiments',
  title: 'Meta A/B tests and lift studies',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: EXPERIMENT_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(EXPERIMENT_VIEWS)).default('list')
      .describe('list (default) | portfolio | study | results | sharing | object | brand-lift | private-lift | page-video-tests | page-video-test'),
    studyId: metaIdArg('study, results, sharing, private-lift: the study (studyId from view list)'),
    objectiveId: metaIdArg('results: one objective of the study (default: each of its objectives, at most 10)'),
    breakdowns: z.array(z.preprocess(lower, z.enum(RESULT_BREAKDOWNS))).max(4).optional()
      .describe('study, results: how Meta splits the results — cell_id (default: per group), age, gender, country (country only with cell_id)'),
    ds: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('study, results: the results as they were on this day (Meta\'s ds, YYYY-MM-DD, within the last 30 days; default: the latest)'),
    withResults: z.boolean().optional().describe('study: also read each objective\'s results (default true)'),
    objectKind: z.preprocess(lower, z.enum(OBJECT_KINDS)).optional().describe('object: campaign | adset | ad'),
    objectId: metaIdArg('object: a campaign, ad set or ad of the chosen ad account (Meta\'s id)'),
    campaignId: metaIdArg('brand-lift: also this campaign of the chosen ad account (its brand lift studies)'),
    type: z.preprocess(upper, z.enum(STUDY_TYPES)).optional()
      .describe('list: only this kind — SPLIT_TEST (A/B test), SPLIT_TEST_V2 (creative test), LIFT, GEO_LIFT, CONTINUOUS_LIFT_CONFIG, BACKEND_AB_TESTING, CREATIVE_SPEND_ENFORCEMENT, PORTFOLIO_OPTIMIZER, VERSION_CONTROL'),
    state: z.preprocess(lower, z.enum(STUDY_STATES)).optional().describe('list: only studies that are planned | running | measuring | finished | cancelled'),
    nameContains: z.string().trim().min(1).max(100).optional().describe('list: only studies whose name holds this text'),
    testId: metaIdArg('page-video-test: the Page video test (testId from view page-video-tests)'),
    since: dayArg('page-video-tests: tests from this day'),
    until: dayArg('page-video-tests: tests up to and including this day (not before since)'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'Meta\'s A/B tests (split tests), creative tests and lift studies that touch the business\'s chosen ad account, read '
    + 'live from Meta. view list (default): every study with its kind and its state in words (planned, running, '
    + 'measuring, finished, cancelled — Meta keeps no status, Nexus reads it from the times), filtered by kind, state or '
    + 'name. portfolio: the business portfolio\'s own studies (one that does not touch the chosen account is its id '
    + 'only). study: one study with its groups (cells: split, campaigns, ad sets, ads, ad accounts), its goals '
    + '(objectives) and their results, like Meta\'s own get-test tools. results: an objective\'s results by group, age, '
    + 'gender or country, a creative test\'s high performers. sharing: who may see the study (Meta ids) and which ad '
    + 'accounts can use it. object: whether a campaign, ad set or ad is in a test — read it before changing one, a '
    + 'change can spoil the test. brand-lift: whether the account and a campaign can have a brand lift study, and a '
    + 'campaign\'s. private-lift: Meta-run lift computations. page-video-tests, page-video-test: the chosen Page\'s '
    + 'video A/B tests with each video\'s numbers and the declared winner. A study cannot be deleted; conversion lift '
    + 'needs Meta\'s grant and results need the Meta app above development access — Meta\'s refusal is passed on in '
    + 'plain words. Making, changing or ending a test (create-meta-experiment, set-meta-experiment, '
    + 'end-meta-experiment) comes with a later Nexus step (step 28). Read only; spend, cost, value and earnings — and any '
    + 'metric Nexus does not know — sit under moneyAsMeta (Meta\'s own units, ad-spend money permission). Filters Nexus '
    + 'applies itself read up to 10 pages and say so when more may match.',
  async handler(args): Promise<ToolResult> {
    const input: ExperimentInput = {
      connectionId: str(args.connectionId),
      view: (args.view ?? 'list') as ExperimentInput['view'],
      studyId: str(args.studyId),
      objectiveId: str(args.objectiveId),
      breakdowns: Array.isArray(args.breakdowns) ? args.breakdowns as ExperimentInput['breakdowns'] : null,
      ds: str(args.ds),
      withResults: args.withResults !== false,
      objectKind: (args.objectKind ?? null) as ExperimentInput['objectKind'],
      objectId: str(args.objectId),
      campaignId: str(args.campaignId),
      type: (args.type ?? null) as ExperimentInput['type'],
      state: (args.state ?? null) as ExperimentInput['state'],
      nameContains: str(args.nameContains),
      testId: str(args.testId),
      since: str(args.since),
      until: str(args.until),
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }
    return guarded(() => metaExperiments(input))
  },
}

// ── meta-ad-rules ────────────────────────────────────────────────────────────────────────────────────────────────

const metaAdRulesTool: AgentTool = {
  name: 'meta-ad-rules',
  title: 'Meta automated rules',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: RULE_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(RULE_VIEWS)).default('list').describe('list (default) | rule | history | account-history | preview'),
    ruleId: metaIdArg('rule, history: the rule (ruleId from view list)'),
    status: z.preprocess(upper, z.enum(RULE_STATUSES)).optional().describe('list: only rules ENABLED | DISABLED | HAS_ISSUES (stopped by Meta) | DELETED'),
    evaluationType: z.preprocess(upper, z.enum(RULE_EVALUATION_TYPES)).optional()
      .describe('list, account-history: only SCHEDULE or TRIGGER rules (trigger rules are invisible in Ads Manager)'),
    objectId: metaIdArg('history, account-history: only runs on this campaign, ad set or ad (Meta\'s id)'),
    action: z.preprocess(upper, z.enum(RULE_HISTORY_ACTIONS)).optional()
      .describe('history, account-history: only runs with this action (CHANGED_BUDGET, CHANGED_BID, PAUSED, UNPAUSED, NOT_CHANGED …)'),
    hideNoChanges: z.boolean().optional().describe('history, account-history: leave out runs that changed nothing'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'Meta\'s own automated rules on the business\'s chosen ad account, read live from Meta. view list (default): every '
    + 'rule — trigger rules too, which run on Meta but never show in Ads Manager — with its status in words, what it '
    + 'applies to, its conditions, its trigger or schedule, its action (pause, switch on, change budgets or bids, notify, '
    + '…) and whether it can raise spend; a rule Meta stopped shows hasIssues and Meta\'s code (Meta does not document '
    + 'the codes). rule: one rule. history: what one rule did at each run, to which object, with old and new values and '
    + 'the rule as it was then. account-history: every rule\'s runs, newest first. preview: Meta\'s preview of a rule is '
    + 'a POST request and Meta documents no read form, so it comes with set-meta-ad-rule (step 29). Making, changing, '
    + 'switching off, running or deleting a rule (set-meta-ad-rule, remove-meta-ad-rule) comes with a later Nexus step '
    + '(step 29). Filters Nexus applies itself read up to 10 pages and say so when more may match. Read only; money in '
    + 'conditions, actions and history in minor units (cents) of the account currency; ROAS and any value Nexus does not '
    + 'know as Meta gives it (…AsMeta); both need the ad-spend money permission.',
  async handler(args): Promise<ToolResult> {
    const input: RuleInput = {
      connectionId: str(args.connectionId),
      view: (args.view ?? 'list') as RuleInput['view'],
      ruleId: str(args.ruleId),
      status: (args.status ?? null) as RuleInput['status'],
      evaluationType: (args.evaluationType ?? null) as RuleInput['evaluationType'],
      objectId: str(args.objectId),
      action: (args.action ?? null) as RuleInput['action'],
      hideNoChanges: args.hideNoChanges === true,
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }
    return guarded(() => metaAdRules(input))
  },
}

export const META_ADS_OPTIMIZE_TOOLS: AgentTool[] = [metaRecommendationsTool, metaExperimentsTool, metaAdRulesTool]
