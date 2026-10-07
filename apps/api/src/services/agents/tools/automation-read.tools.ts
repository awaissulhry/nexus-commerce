/**
 * MCP full control R6 (plan part 06 §3) — Claude sees every automation: `list-automations` lists all 39 (rules,
 * engines, schedules, the agent fleet, repricing, operations rules, detectors), `automation-detail` opens one and,
 * with `rowId`, one of its rules, plans or schedules.
 *
 * Read-only, Nexus only: they read the automation catalog (services/automation/automation-catalog.service.ts) in
 * the caller's business — no marketplace call, no write (not even the create-on-read some state services do). The
 * business is the one call-tool.ts bound; no argument names one.
 *
 * Who sees what:
 *   · each automation needs its own area's view permission (ads.view for Amazon and eBay ads, repricing.view for the
 *     repricer, replenishment.view for replenishment rules …). One the caller may not see is left out and counted
 *     in `hidden`, never named; automation-detail refuses it.
 *   · money (caps, budgets, bid bounds, ceilings) needs financials.adspend.view: `restrictedFields` names the keys
 *     the shared registry does not, and the door strips them for a caller without it.
 *   · env is reported as whether each flag lets the automation act — never a value.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, FieldPermission, ToolContext } from '../tool-types.js'
import { AREAS, AUTOMATION_IDS, LEVELS, type AutomationLevel } from '../../automation/automation-levels.js'
import { automationAdapter, getAutomationCatalog, getAutomationDetail, listAdapters } from '../../automation/automation-catalog.service.js'
import { explainAutomation, MAX_EXPLAIN_DAYS } from '../../automation/automation-explain.service.js'
import { previewAutomation } from '../../automation/automation-preview.service.js'

/** Money keys in automation output that lib/auth/financial-fields.ts does not name; all ad-spend grain. */
const ADSPEND_KEYS = [
  'maxValueCentsEur', 'perExecutionCents', 'perDayCents', 'defaultTargetAcosPct', 'dailySpendCapCents', 'dailyCapCents',
  'minBidCents', 'maxBidCents', 'monthlyCapCents', 'targetAcosPct', 'bidMinCents', 'bidMaxCents', 'budgetMinCents',
  'budgetMaxCents', 'maxDailySpendCents', 'bidFloorCents', 'bidCapCents', 'dailyBudgetUSD', 'dailyCeilingUSD',
] as const
export const AUTOMATION_RESTRICTED_FIELDS: Readonly<Record<string, FieldPermission>> = Object.fromEntries(
  ADSPEND_KEYS.map((key) => [key, FIELDS.financialsAdspendView]),
)

const KEYS = listAdapters().map((a) => a.key)
/** An automation by its inventory number (A1, N6 …) or its key (ads-rules …). A1 first: the most used. */
export const AUTOMATION = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.enum([...AUTOMATION_IDS, ...KEYS] as [string, ...string[]]),
)

const MAX_ROWS = 100

function visibleAdapter(ctx: ToolContext, automation: string) {
  const adapter = automationAdapter(automation)
  if (!adapter) return { error: `There is no automation "${automation}".` }
  if (!ctx.can(adapter.view)) return { error: `${adapter.name} needs the ${adapter.view} permission.` }
  return { adapter }
}

const listAutomations: AgentTool = {
  name: 'list-automations',
  title: 'List automations',
  category: 'automation',
  description:
    'Every automation in this business — Amazon and eBay ads rules and engines, budget schedules and pools, the hourly bid plans (rank-defend), ' +
    'the agent fleet, repricing, listing, replenishment, review and bulk rules, scheduled jobs, alerts and detectors — ' +
    'each with how far it may go now (OFF, OBSERVE, PROPOSE or AUTO: the lower of what the server allows and what this ' +
    'business set, with the reason), its scope, schedule, caps, last run and up to 5 of its rules or plans. ' +
    'An automation the server switches off reads OFF and names the env flag. Settings and brakes (guardrails, ' +
    'protected terms, harvest policy, the suggestions queue) have no level, only what is in force. ' +
    'Use automation-detail for one automation and its rows.',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  requires: [F.aiView],
  input: z.object({
    area: z.enum(AREAS).optional().describe('only this area, e.g. amazon-ads, ebay-ads, pricing, replenishment'),
    level: z.enum(LEVELS).optional().describe('only automations at this effective level, e.g. AUTO for everything that acts by itself'),
  }),
  restrictedFields: AUTOMATION_RESTRICTED_FIELDS,
  async handler(args, ctx) {
    const area = args.area as string | undefined
    const level = args.level as AutomationLevel | undefined
    const all = listAdapters()
    const hidden = all.filter((a) => !ctx.can(a.view)).length
    const entries = await getAutomationCatalog((a) => ctx.can(a.view) && (!area || a.area === area))
    const items = level ? entries.filter((e) => e.level === level) : entries
    return {
      ok: true,
      data: {
        items,
        total: items.length,
        // Never named: an automation the caller may not see.
        hidden,
        ...(hidden ? { hiddenNote: `${hidden} automation${hidden === 1 ? '' : 's'} of other areas need permissions this person does not hold.` } : {}),
      },
    }
  },
}

const automationDetail: AgentTool = {
  name: 'automation-detail',
  title: 'Automation detail',
  category: 'automation',
  description:
    'One automation in full: its level and why, every env flag that bears on it (whether it lets it act, never a value), ' +
    'what this business set, scope, schedule, caps, last run and its rows (rules, plans, schedules, pools …, up to 100). ' +
    'With rowId, one row in full: an ads rule with its conditions in words, window, caps, reach and graduation gate ' +
    '(the road to AUTO, which a person still clicks); an eBay rule with its versions and last runs; a row of the hourly ' +
    'bid plans (or a plan\'s id) names its plan, whose week ad-hourly-plans shows hour by hour. ' +
    'Name the automation by its number (A1 … N17) or key from list-automations.',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  requires: [F.aiView],
  input: z.object({
    automation: AUTOMATION.describe('the automation: its number from list-automations (A1 … A18, E1, E2, F1, F2, N1 … N17) or its key (e.g. ads-rules)'),
    rowId: z.string().trim().min(1).max(64).optional().describe('one of its rows (a rule, plan, schedule …) by id, from this tool or list-automations'),
  }),
  restrictedFields: AUTOMATION_RESTRICTED_FIELDS,
  async handler(args, ctx) {
    const found = visibleAdapter(ctx, String(args.automation))
    if (!('adapter' in found) || !found.adapter) return { ok: false, error: found.error }
    const adapter = found.adapter
    const rowId = args.rowId as string | undefined
    const { entry, rows } = await getAutomationDetail(adapter)
    if (rowId) {
      const row = adapter.get ? await adapter.get(rowId) : (rows ?? []).find((r) => r.id === rowId) ?? null
      // W4-1 — a row of the hourly bid plans names its plan: its hours, members and switch are ad-hourly-plans' and
      // set-hourly-bid-plan's.
      const plan = adapter.key === 'ads-rank-defend' ? await (await import('../../advertising/rank-schedule-group.service.js')).hourlyPlanOfRow(rowId) : null
      const hourlyPlan = plan ? { planId: plan.planId, name: plan.name, on: plan.enabled, read: `ad-hourly-plans {"planId":"${plan.planId}"} shows its week hour by hour`, change: 'set-hourly-bid-plan changes it (paint, members, switch, values)' } : null
      if (!row) {
        if (hourlyPlan) return { ok: true, data: { automation: entry, hourlyPlan } }
        return { ok: false, error: `${adapter.name} has no row ${rowId} in this business (not found).` }
      }
      return { ok: true, data: { automation: entry, row, ...(hourlyPlan ? { hourlyPlan } : {}) } }
    }
    const shown = (rows ?? []).slice(0, MAX_ROWS)
    return {
      ok: true,
      data: {
        automation: entry,
        rows: rows ? shown : null,
        ...(rows && rows.length > MAX_ROWS ? { more: `${rows.length} rows; the first ${MAX_ROWS} are shown, the most active first in list-automations' sample.` } : {}),
        ...(rows ? {} : { rowsNote: `${adapter.name} has no rows of its own: it is configured by env and the account dial.` }),
      },
    }
  },
}


const automationActivity: AgentTool = {
  name: 'automation-activity',
  title: 'Automation activity',
  category: 'automation',
  description:
    'What an automation (or one of its rules, plans or schedules) did in the last days: its runs, what it WROTE — ' +
    "matched by its own exact actor (an ads rule's automation:<ruleId>, auto-bid's automation:auto-bid …), never another " +
    "engine's work — whether it has ever written anything, and what refused it (its own daily or write cap, a value " +
    'cap). It says plainly when a rule ran at AUTO and never wrote, when its cap and not its conditions decide how much ' +
    'it reaches, when it is OFF and why, and when it has not run. Use it to answer "why did it do X" or "why did ' +
    'nothing happen". Read-only.',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  requires: [F.aiView],
  input: z.object({
    automation: AUTOMATION.describe('the automation: its number from list-automations (A1 … N17) or its key (e.g. ads-rules)'),
    rowId: z.string().trim().min(1).max(64).optional().describe('one of its rows (a rule, plan, schedule …) by id; omit for the automation as a whole'),
    days: z.coerce.number().int().min(1).max(MAX_EXPLAIN_DAYS).optional().describe(`how many UTC days back, today included (default 7, max ${MAX_EXPLAIN_DAYS})`),
  }),
  restrictedFields: AUTOMATION_RESTRICTED_FIELDS,
  async handler(args, ctx) {
    const found = visibleAdapter(ctx, String(args.automation))
    if (!('adapter' in found) || !found.adapter) return { ok: false, error: found.error }
    const rowId = args.rowId as string | undefined
    const activity = await explainAutomation(found.adapter, { rowId, days: args.days as number | undefined })
    if (!activity) return { ok: false, error: `${found.adapter.name} has no row ${rowId} in this business (not found).` }
    return { ok: true, data: activity }
  },
}

/** The areas whose previews are ad spend top to bottom (bids, budgets, placements): they need the money permission. */
const SPEND_AREAS: ReadonlySet<string> = new Set(['amazon-ads', 'ebay-ads', 'marketing'])

/**
 * The money filter of the other previews (listing, replenishment, review, bulk, repricing …): the shared registry plus
 * the automation keys, plus the value an action reports and a recommendation's order total — a cost, not a spend.
 */
const PREVIEW_RESTRICTED_FIELDS: Readonly<Record<string, FieldPermission>> = {
  ...AUTOMATION_RESTRICTED_FIELDS,
  estimatedValueCentsEur: FIELDS.financialsCostsView,
  totalCents: FIELDS.financialsCostsView,
}

/** A draft or a context: a plain object, held to a size a person could have typed. */
const JSON_OBJECT = z.record(z.string().max(64), z.unknown()).refine((value) => JSON.stringify(value).length <= 20_000, 'at most 20,000 characters as JSON')

const previewAutomationTool: AgentTool = {
  name: 'preview-automation',
  title: 'Preview automation',
  category: 'automation',
  description:
    'What an automation would do now, writing nothing. A draft before it is saved (an Amazon ads rule in the rule ' +
    "builder's shape, an eBay ads rule) or a saved row: an ads rule against what its next tick would see, a " +
    'marketing, replenishment, listing or bulk rule against its trigger\'s contexts or a context you give, the price a ' +
    "repricing rule would pick, auto-bid's bids, this month's budget enforcement, a pool's next rebalance, the hourly bid plans (rank-defend) " +
    'and top-of-search as dry runs, a coverage set, an autopilot backtest. Says "no preview" for kinds without one. ' +
    'No run row, no counter, no proposal, no notification, nothing sent anywhere. A rule that pauses (or carries ' +
    'another action Claude may not automate) is shown as it would run and marked as refused when saved, with the ' +
    'substitute (lower bids: a rule never pauses).',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  // Per kind (lead decision, R8 review): an ads or marketing preview is bids, budgets and spend and needs
  // financials.adspend.view (checked in the handler); a listing, replenishment, review or bulk preview needs only its
  // own area's view and gets the shared money filter (restrictedFields, applied by the door).
  requires: [F.aiView],
  input: z.object({
    automation: AUTOMATION.describe('the automation: its number from list-automations (A1 … N17) or its key (e.g. ads-rules)'),
    rowId: z.string().trim().min(1).max(64).optional().describe('a saved row to preview (rule, plan, pool, coverage set …) by id'),
    draft: JSON_OBJECT.optional().describe("an unsaved rule: for A1 { actions, conditions, scopeMarketplace? } in the rule builder's shape; for E1 { name, trigger, action, guardrails?, scope?, marketplace?, cooldownHours? }"),
    context: JSON_OBJECT.optional().describe('for a saved marketing, listing, replenishment or bulk rule: the context to evaluate it against (otherwise its trigger builds them from current data)'),
  }),
  restrictedFields: PREVIEW_RESTRICTED_FIELDS,
  async handler(args, ctx) {
    const found = visibleAdapter(ctx, String(args.automation))
    if (!('adapter' in found) || !found.adapter) return { ok: false, error: found.error }
    if (SPEND_AREAS.has(found.adapter.area) && !ctx.can(FIELDS.financialsAdspendView)) {
      return { ok: false, error: `Previewing ${found.adapter.name} shows bids, budgets and spend: it needs the ${FIELDS.financialsAdspendView} permission.` }
    }
    return previewAutomation(found.adapter, {
      rowId: args.rowId as string | undefined,
      draft: args.draft as Record<string, unknown> | undefined,
      context: args.context as Record<string, unknown> | undefined,
    })
  },
}

export const AUTOMATION_READ_TOOLS: AgentTool[] = [listAutomations, automationDetail, automationActivity, previewAutomationTool]
