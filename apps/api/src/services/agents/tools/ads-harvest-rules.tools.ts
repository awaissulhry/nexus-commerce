/**
 * Keyword Harvest page rebuild (lane HMCP, round 2) — the page's Rules and Sources views in Claude's hands, on the engine's
 * own services (services/advertising/harvest/rules.ts, sources.ts): what the page reads and changes there, Claude reads
 * and asks for — one code path.
 *
 *   harvest-rules          read: the Rules view (GET /api/advertising/harvest/rules — every harvest rule in the Bid page's
 *                          row shape, the brain first), one rule's harvests (…/rules/:id/history) and what a rule, saved or
 *                          not, would harvest now (POST …/rules/preview: the engine's planner as a rule, writes nothing)
 *   set-harvest-rules      change: a rule's mode (POST …/rules/mode: the level dial AND a builder rule's Manual/Automate
 *                          setting, setHarvestRulesMode), archive or unarchive (…/rules/:id/archive | unarchive); Nexus only
 *   harvest-sources        read: the Sources view (GET …/sources): every ad group that feeds terms, its rules, its pause
 *   set-harvest-sources    change: assign or detach ad groups to a builder harvest rule, pause or resume harvesting from
 *                          them (POST …/sources/assign | detach | pause | resume): Nexus only
 *
 * A rule's mode goes through set-harvest-rules — the page's own service — never turn-up / turn-down-automation (A1), whose
 * Manual/Automate move differs (a builder rule set to Watch there would ask). A new or edited rule is save-ad-rule
 * (ads-rule-crud, the rule editor's own save). The brain's harvest level is set-ads-brain. Every change runs as an approved
 * request (approvedRun: the approver, the change set) and only on the preview it was approved on.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { BRAIN_ROW_ID, harvestRuleHistory, listHarvestRules, previewHarvestRule, setHarvestRuleArchived, setHarvestRulesMode } from '../../advertising/harvest/rules.js'
import { MAX_SOURCE_IDS, assignSources, detachSources, harvestSources, pauseSources, resumeSources } from '../../advertising/harvest/sources.js'
import { HARVEST_MONEY } from '../../advertising/harvest/constants.js'
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { fingerprint } from './ads-targeting-kit.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import type { AgentTool, FieldPermission, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'

export const HARVEST_RULE_TOOLS = { rules: 'harvest-rules', setRules: 'set-harvest-rules', sources: 'harvest-sources', setSources: 'set-harvest-sources' } as const

/** The engine's money keys, and a rule's before-and-after effect (ACoS, spend, orders). */
const MONEY: Readonly<Record<string, FieldPermission>> = {
  ...(HARVEST_MONEY as Readonly<Record<string, FieldPermission>>),
  bidWhy: FIELDS.financialsAdspendView,
  effect: FIELDS.financialsAdspendView,
}
const ID = z.string().trim().min(1).max(64)
const MARKET = z.string().trim().min(2).max(20)
/** At most this many ids in one request (the tool contract's bound for a list). */
const MAX_IDS = Math.min(250, MAX_SOURCE_IDS)
const WHY = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── harvest-rules (read) ─────────────────────────────────────────────────────────────────────────

const RULES_INPUT = z.object({
  view: z.enum(['list', 'history', 'preview']).default('list')
    .describe('list (default): every harvest rule, the brain first; history: one rule\'s (or the brain\'s) harvests; preview: what a rule — saved (ruleId) or not (actions and scope) — would harvest now'),
  market: MARKET.optional().describe('list, history: only this market (an Amazon code); default every market'),
  id: ID.optional().describe('history: the rule id (or brain)'),
  days: z.coerce.number().int().min(1).max(90).optional().describe('history: the last N days (default 7)'),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('history: at most this many harvests (default 50); preview: sample rows (default 25)'),
  ruleId: ID.optional().describe('preview: a saved harvest rule'),
  actions: z.array(z.record(z.string(), z.unknown())).max(10).optional()
    .describe('preview: a harvest rule\'s actions not saved yet (harvest_and_negate, promote_to_exact or keyword-harvesting, as save-ad-rule takes them), or a saved rule\'s actions changed'),
  scopeMarketplace: z.string().trim().max(20).nullable().optional().describe('preview: the rule\'s market scope'),
  scopePortfolioId: z.string().trim().max(64).nullable().optional().describe('preview: the rule\'s portfolio scope'),
  scopeCampaignId: z.string().trim().max(64).nullable().optional().describe('preview: the rule\'s campaign scope'),
  scopeProductId: z.string().trim().max(64).nullable().optional().describe('preview: the rule\'s product scope'),
})
type RulesArgs = z.infer<typeof RULES_INPUT>

const harvestRulesTool: AgentTool = {
  name: HARVEST_RULE_TOOLS.rules,
  title: 'Harvest rules',
  category: 'automation',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: MONEY,
  input: RULES_INPUT,
  description:
    'The Keyword Harvest page\'s Rules view, on the harvest engine. view list: every Amazon harvest rule (harvest_and_negate, '
    + 'promote_to_exact, keyword-harvesting), the ads brain first (id brain), each with its sentence, market, mode (Off, '
    + 'Watch, Ask me, Auto — and why Auto cannot be picked yet, or what holds it), scope, what it changed in 7 days, its '
    + 'asks waiting for a person, its runs and schedule, and archived; totals. view history (id): that rule\'s — or the '
    + 'brain\'s — harvests with their verdicts, as harvest-history. view preview (ruleId, or actions and scope): what the '
    + 'rule would harvest now, as a rule harvests (the brain\'s campaigns left to the brain, its source and funnel blocks, '
    + 'its daily keyword cap): how many, how many held and a sample with each term\'s place, start bid and hold. Writes '
    + 'nothing. Change a rule\'s mode, archive or unarchive it with set-harvest-rules (the Rules view\'s own service); '
    + 'create or edit it with save-ad-rule.',
  async handler(args): Promise<ToolResult> {
    const a = args as RulesArgs
    if (a.view === 'history') {
      if (!a.id) return { ok: false, error: 'id: name the rule (its id from view list, or brain).' }
      const got = await harvestRuleHistory(a.id, { days: a.days ?? 7, market: a.market ?? null, limit: a.limit ?? 50 })
      return 'error' in got ? { ok: false, error: got.error } : { ok: true, data: got.data }
    }
    if (a.view === 'preview') {
      if (!a.ruleId && !a.actions?.length) return { ok: false, error: 'Name the rule (ruleId), or give a harvest rule\'s actions to preview.' }
      const got = await previewHarvestRule({
        ruleId: a.ruleId, actions: a.actions, scopeMarketplace: a.scopeMarketplace, scopePortfolioId: a.scopePortfolioId,
        scopeCampaignId: a.scopeCampaignId, scopeProductId: a.scopeProductId, limit: a.limit,
      })
      return 'error' in got ? { ok: false, error: got.error } : { ok: true, data: got.data }
    }
    return { ok: true, data: await listHarvestRules({ market: a.market ?? null }) }
  },
}

// ── set-harvest-rules (change) ───────────────────────────────────────────────────────────────────

const MODES = ['OFF', 'WATCH', 'ASK', 'AUTO'] as const
type Mode = (typeof MODES)[number]
const RULES_SET_INPUT = z.object({
  op: z.enum(['mode', 'archive', 'unarchive'])
    .describe('mode: Off, Watch, Ask me or Auto, as the Rules view sets it (a builder rule\'s Manual/Automate setting moves with it); archive: the rules stop for good but are kept (their runs and harvests stay; their waiting asks expire); unarchive: back, at Off'),
  ids: z.array(ID).max(MAX_IDS).optional().describe('the harvest rules (their ids from harvest-rules view list)'),
  mode: z.enum(MODES).optional().describe('op mode: OFF, WATCH, ASK (Ask me) or AUTO, for every rule in ids'),
  rules: z.array(z.object({
    id: ID, mode: z.enum(MODES),
    belt: z.enum(['manual', 'automate']).nullable().optional().describe('an undo: the builder rule\'s own Manual/Automate as it was (null: none)'),
    marked: z.boolean().optional().describe('an undo: whether the rule had its harvest Auto mark (false never sets one: a rule put back at Auto without it keeps asking)'),
  })).max(MAX_IDS).optional()
    .describe('op mode: a mode per rule (instead of ids and mode; an undo puts each rule back this way, with its belt and mark)'),
  why: WHY,
})
type RulesSetArgs = z.infer<typeof RULES_SET_INPUT>
interface RulesSetPreview { action: string; op: RulesSetArgs['op']; rules: Array<{ id: string; mode: Mode | null }>; left: Array<{ id: string; why: string }>; basis: string }
interface RuleState { name: string; archived: boolean; mode: Mode }

/** Every harvest rule's mode and archived state (and name), by id, as the Rules view reads them. */
async function ruleStates(): Promise<Map<string, RuleState>> {
  const list = await listHarvestRules({ market: null })
  return new Map(list.rules.filter((r) => r.id !== BRAIN_ROW_ID).map((r) => [r.id, { name: r.name, archived: r.archived, mode: r.mode.set as Mode }]))
}

const modeWords = (m: Mode) => ({ OFF: 'Off', WATCH: 'Watch', ASK: 'Ask me', AUTO: 'Auto' }[m])

async function decideRules(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = RULES_SET_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: RulesSetArgs = parsed.data
  const asked: Array<{ id: string; mode: Mode | null }> = a.op === 'mode'
    ? (a.rules?.length ? a.rules : (a.ids ?? []).map((id) => ({ id, mode: a.mode ?? null })))
    : (a.ids ?? []).map((id) => ({ id, mode: null }))
  if (!asked.length) return { ok: false, error: a.op === 'mode' ? 'Name the rules: ids and mode, or rules (a mode per rule).' : 'ids: name the rules.' }
  if (a.op === 'mode' && asked.some((r) => !r.mode)) return { ok: false, error: 'mode: name the mode — OFF, WATCH, ASK or AUTO.' }
  const states = await ruleStates()
  const left: RulesSetPreview['left'] = []
  const changing: RulesSetPreview['rules'] = []
  const seen = new Set<string>()
  for (const r of asked) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const s = states.get(r.id)
    if (r.id === BRAIN_ROW_ID) left.push({ id: r.id, why: 'the brain is not a rule: its harvest level is set per product (set-ads-brain)' })
    else if (!s) left.push({ id: r.id, why: 'no harvest rule with this id in this business' })
    else if (a.op === 'mode' && s.archived) left.push({ id: r.id, why: 'it is archived: unarchive it first' })
    else if (a.op === 'mode' && s.mode === r.mode) left.push({ id: r.id, why: `it is ${modeWords(s.mode)} already` })
    else if (a.op !== 'mode' && s.archived === (a.op === 'archive')) left.push({ id: r.id, why: `it is ${s.archived ? 'archived' : 'not archived'} already` })
    else changing.push(r)
  }
  if (!changing.length) return { ok: false, error: `Nothing to change: ${left.slice(0, 5).map((l) => `${l.id}: ${l.why}`).join('; ')}.` }
  changing.sort((x, y) => x.id.localeCompare(y.id))
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const r of changing.slice(0, 20)) {
    const s = states.get(r.id)!
    changes[s.name] = a.op === 'mode' ? { from: modeWords(s.mode), to: modeWords(r.mode!) } : a.op === 'archive' ? { from: modeWords(s.mode), to: 'archived' } : { from: 'archived', to: 'Off (unarchived)' }
  }
  const raises = a.op === 'mode' ? changing.filter((r) => MODES.indexOf(r.mode!) > MODES.indexOf(states.get(r.id)!.mode)).map((r) => `${states.get(r.id)!.name}: ${modeWords(states.get(r.id)!.mode)} → ${modeWords(r.mode!)}`) : []
  const summary = a.op === 'mode'
    ? `Sets the mode of ${plural(changing.length, 'harvest rule')}, as the Rules view does (a builder rule's Manual/Automate setting moves with it: Automate for Watch and Auto, Manual for Ask me).`
    : a.op === 'archive'
      ? `Archives ${plural(changing.length, 'harvest rule')}: ${changing.length === 1 ? 'it stops' : 'they stop'} for good but ${changing.length === 1 ? 'is' : 'are'} kept (runs and harvests stay; waiting asks expire).`
      : `Unarchives ${plural(changing.length, 'harvest rule')}, back at Off.`
  return {
    ok: true,
    preview: {
      action: HARVEST_RULE_TOOLS.setRules, op: a.op, rules: changing, left, summary, changes, raises,
      totals: { changing: changing.length, left: left.length },
      basis: fingerprint({ op: a.op, rules: changing.map((r) => [r.id, r.mode, states.get(r.id)!.mode, states.get(r.id)!.archived]) }),
      note: 'Nexus only: nothing is sent to Amazon (a rule at Auto then acts by itself, inside its caps). Undoable (undo-change).',
    } satisfies RulesSetPreview & Record<string, unknown>,
  }
}

/** What the rules hold now, in the shape of `change.after` (the undo guard compares the two). */
async function rulesNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; rules?: Array<{ id?: unknown }> }
  if (!Array.isArray(after.rules)) return change.after
  const states = await ruleStates()
  return { op: after.op, rules: after.rules.map((r) => { const s = states.get(String(r.id)); return { id: String(r.id), mode: s?.mode ?? null, archived: s?.archived ?? null } }) }
}

/**
 * C2 — undo: a mode change sets each rule back to the mode it had (the same service); an archive unarchives (at Off: the
 * mode it had is set again with op mode); an unarchive archives again.
 */
export const RULES_UNDO: ToolUndo = {
  current: rulesNow,
  request(change) {
    const before = (change.before ?? {}) as { op?: unknown; rules?: Array<{ id?: unknown; mode?: unknown }> }
    const after = (change.after ?? {}) as { op?: unknown; rules?: Array<{ id?: unknown }> }
    if (!Array.isArray(after.rules) || !after.rules.length) return { refusal: 'This change does not name the rules it changed.' }
    const ids = after.rules.map((r) => String(r.id))
    if (after.op === 'mode') {
      // Delta review D1 — each rule back exactly: its mode, its own Manual/Automate and its harvest Auto mark as they were
      // (the service's own `before`), so a rule saved at Auto before the release is never put back acting alone.
      const rules = (before.rules ?? []).filter((r) => typeof r.mode === 'string').map((r) => {
        const b = r as { id?: unknown; mode?: unknown; belt?: unknown; marked?: unknown }
        return { id: String(b.id), mode: String(b.mode), ...(b.belt === null || b.belt === 'manual' || b.belt === 'automate' ? { belt: b.belt } : {}), ...(typeof b.marked === 'boolean' ? { marked: b.marked } : {}) }
      })
      if (!rules.length) return { refusal: 'This change does not record the modes it replaced.' }
      return { tool: HARVEST_RULE_TOOLS.setRules, args: { op: 'mode', rules, why: 'undo of a mode change: each rule back to its mode' } }
    }
    return { tool: HARVEST_RULE_TOOLS.setRules, args: { op: after.op === 'archive' ? 'unarchive' : 'archive', ids, why: `undo of an ${String(after.op)}` } }
  },
}

const setHarvestRules: AgentTool = {
  name: HARVEST_RULE_TOOLS.setRules,
  title: 'Set harvest rules',
  category: 'automation',
  riskTier: 'medium',
  readOnly: false,
  requires: [F.adsAutomationManage],
  input: RULES_SET_INPUT,
  requiresApprovalDefault: true,
  // Nexus only: a rule's setting. A rule at Auto then harvests by itself inside its caps (into Amazon): said in raises.
  openWorld: false,
  // An archive's undo brings the rules back at Off (op mode sets the mode they had again).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: RULES_UNDO,
  description:
    'Change harvest rules as the Keyword Harvest page\'s Rules view does, on its own service. op mode: Off, Watch, Ask me or '
    + 'Auto for the rules named (ids and mode, or rules with a mode each) — through the rule\'s level dial (its graduation '
    + 'gate and ceiling refuse an Auto it has not earned, named) and, for a builder rule (keyword-harvesting), its '
    + 'Manual/Automate setting with it (Automate for Watch and Auto, Manual for Ask me), so a rule set to Watch watches; '
    + 'a raise is listed in raises. op archive: the rules stop for good but are kept (runs and harvests stay; their asks '
    + 'waiting for a person expire); op unarchive: back at Off. ids from harvest-rules view list; the brain is not a rule '
    + '(set-ads-brain). A rule already so is left. Nexus only. Nothing changes until a person approves it in Nexus. Undo '
    + '(undo-change) puts each rule back (an unarchived rule returns at Off, then its mode).',
  async handler(args): Promise<ToolResult> {
    return decideRules(args)
  },
  async execute(args, ctx): Promise<ToolResult> {
    const fresh = await decideRules(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as RulesSetPreview & { summary: string }
    if ((ctx.approvedPreview as { basis?: unknown } | undefined)?.basis !== p.basis) return notRun('Not run: what you approved has moved since — a rule\'s mode or archive changed meanwhile. Ask for it again as it is now.')
    const run = approvedRun(ctx, String((args as { why?: unknown }).why ?? '') || p.summary)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const actor = run.actor as AdsActor
    const states = await ruleStates()
    const results: Array<{ id: string; ok: boolean; error?: string; before?: { mode: string; belt: string | null; marked: boolean } }> = []
    if (p.op === 'mode') {
      // One call per rule with what the request names for it (an undo's belt and mark), through the Rules view's service.
      const asked = new Map((((args as { rules?: Array<{ id: string; belt?: 'manual' | 'automate' | null; marked?: boolean }> }).rules) ?? []).map((r) => [r.id, r]))
      for (const r of p.rules) {
        const extra = asked.get(r.id)
        const out = await setHarvestRulesMode([r.id], r.mode!, actor, { ...(extra && extra.belt !== undefined ? { belt: extra.belt } : {}), ...(extra && extra.marked !== undefined ? { marked: extra.marked } : {}) })
        results.push(...out.results.map((x) => ({ id: x.id, ok: x.ok, ...(x.error ? { error: x.error } : {}), ...(x.before ? { before: x.before } : {}) })))
      }
    } else {
      for (const r of p.rules) {
        const out = await setHarvestRuleArchived(r.id, p.op === 'archive', actor)
        results.push('error' in out ? { id: r.id, ok: false, error: out.error } : { id: r.id, ok: true, before: out.data.before })
      }
    }
    const done = results.filter((r) => r.ok).map((r) => r.id).sort()
    if (!done.length) return notRun(`Not run: ${results.slice(0, 3).map((r) => `${r.id}: ${r.error}`).join('; ')}.`)
    const now = await ruleStates()
    return {
      ok: true,
      data: { op: p.op, results, changeSetId: run.changeSetId, note: 'Nexus only: nothing was sent to Amazon.' },
      change: {
        before: { op: p.op, rules: done.map((id) => { const b = results.find((x) => x.id === id && x.ok)?.before; return { id, mode: b?.mode ?? states.get(id)?.mode ?? null, archived: states.get(id)?.archived ?? null, ...(b ? { belt: b.belt, marked: b.marked } : {}) } }) },
        after: { op: p.op, rules: done.map((id) => ({ id, mode: now.get(id)?.mode ?? null, archived: now.get(id)?.archived ?? null })) },
      },
    }
  },
}

// ── harvest-sources (read) ───────────────────────────────────────────────────────────────────────

const SOURCES_INPUT = z.object({
  market: MARKET.describe('the market (an Amazon code)'),
  page: z.coerce.number().int().min(1).max(10_000).optional().describe('the page (default 1)'),
  pageSize: z.coerce.number().int().min(1).max(100).optional().describe('rows a page (default 50, at most 100)'),
})

const harvestSourcesTool: AgentTool = {
  name: HARVEST_RULE_TOOLS.sources,
  title: 'Harvest sources',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: MONEY,
  input: SOURCES_INPUT,
  description:
    'The Keyword Harvest page\'s Sources view, on the harvest engine: every Amazon ad group of the market that feeds search '
    + 'terms to harvest (automatic, broad, phrase and product-target ad groups), with its campaign, portfolio and product, '
    + 'its role, the harvest rules that read it, whether harvesting from it is paused (and by whom), and the terms it found, '
    + 'that sold and that were harvested over windowDays (the Terms view\'s window); totals over every source; page and pageSize (≤ 100). Change '
    + 'them with set-harvest-sources.',
  async handler(args): Promise<ToolResult> {
    const a = args as { market: string; page?: number; pageSize?: number }
    const got = await harvestSources({ market: a.market })
    if ('error' in got) return { ok: false, error: got.error }
    const page = a.page ?? 1
    const pageSize = a.pageSize ?? 50
    const total = got.data.rows.length
    const rows = got.data.rows.slice((page - 1) * pageSize, page * pageSize)
    return { ok: true, data: { ...got.data, rows, total, page, pageSize, ...(page * pageSize < total ? { nextPage: page + 1 } : {}) } }
  },
}

// ── set-harvest-sources (change) ─────────────────────────────────────────────────────────────────

const SET_SOURCES_INPUT = z.object({
  op: z.enum(['assign', 'detach', 'pause', 'resume'])
    .describe('assign: a builder harvest rule (keyword-harvesting) reads these ad groups too; detach: it reads them no more; pause: no harvest — the page, Claude, a rule or the brain — takes a term from them; resume: harvesting from them again'),
  market: MARKET.describe('the market of the ad groups (an Amazon code)'),
  adGroupIds: z.array(ID).min(1).max(MAX_IDS).describe('the source ad groups (their ids from harvest-sources)'),
  ruleId: ID.optional().describe('assign, detach: the builder harvest rule (harvest-rules view list)'),
  reason: z.string().trim().max(300).optional().describe('pause: why, kept on the pause'),
  why: WHY,
})
type SetSourcesArgs = z.infer<typeof SET_SOURCES_INPUT>
interface SourcesPreview { action: string; op: SetSourcesArgs['op']; market: string; ruleId: string | null; ids: string[]; left: Array<{ id: string; why: string }>; basis: string }
interface SourceState { rules: string[]; paused: boolean }

/** Each source ad group's rules and pause, as the Sources view reads them. */
async function sourceStates(market: string): Promise<Map<string, SourceState & { name: string }> | { error: string }> {
  const got = await harvestSources({ market })
  if ('error' in got) return { error: got.error }
  return new Map(got.data.rows.map((r) => [r.id, { name: `${r.adGroup.name} (${r.campaign.name})`, rules: r.rules.map((x) => x.id).sort(), paused: !!r.paused }]))
}

async function decideSources(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = SET_SOURCES_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: SetSourcesArgs = parsed.data
  if ((a.op === 'assign' || a.op === 'detach') && !a.ruleId) return { ok: false, error: `ruleId: name the builder harvest rule to ${a.op === 'assign' ? 'assign the ad groups to' : 'detach them from'} (harvest-rules view list).` }
  const states = await sourceStates(a.market)
  if ('error' in states) return { ok: false, error: states.error }
  const left: SourcesPreview['left'] = []
  const changing: string[] = []
  for (const id of [...new Set(a.adGroupIds)]) {
    const s = states.get(id)
    if (!s) left.push({ id, why: `not a source ad group of ${a.market} (harvest-sources)` })
    else if (a.op === 'assign' && s.rules.includes(a.ruleId!)) left.push({ id, why: 'the rule reads it already' })
    else if (a.op === 'detach' && !s.rules.includes(a.ruleId!)) left.push({ id, why: 'the rule does not read it' })
    else if (a.op === 'pause' && s.paused) left.push({ id, why: 'harvesting from it is paused already' })
    else if (a.op === 'resume' && !s.paused) left.push({ id, why: 'harvesting from it is not paused' })
    else changing.push(id)
  }
  if (!changing.length) return { ok: false, error: `Nothing to change: ${left.slice(0, 5).map((l) => `${l.id}: ${l.why}`).join('; ')}.` }
  changing.sort()
  const to = { assign: 'read by the rule', detach: 'not read by the rule', pause: 'harvest paused', resume: 'harvest on' }[a.op]
  const from = { assign: 'not read by the rule', detach: 'read by the rule', pause: 'harvest on', resume: 'harvest paused' }[a.op]
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const id of changing.slice(0, 20)) changes[states.get(id)!.name] = { from, to }
  const words = { assign: `Assigns ${plural(changing.length, 'source ad group')} to the harvest rule ${a.ruleId}`, detach: `Detaches ${plural(changing.length, 'source ad group')} from the harvest rule ${a.ruleId}`, pause: `Pauses harvesting from ${plural(changing.length, 'source ad group')}: no harvest takes a term from them`, resume: `Resumes harvesting from ${plural(changing.length, 'source ad group')}` }[a.op]
  return {
    ok: true,
    preview: {
      action: HARVEST_RULE_TOOLS.setSources, op: a.op, market: a.market, ruleId: a.ruleId ?? null, ids: changing, left,
      summary: `${words}.`, changes, totals: { changing: changing.length, left: left.length },
      basis: fingerprint({ op: a.op, ruleId: a.ruleId ?? null, ids: changing.map((id) => [id, states.get(id)!.rules, states.get(id)!.paused]) }),
      note: 'Nexus only: nothing is sent to Amazon. Undoable (undo-change).',
    } satisfies SourcesPreview & Record<string, unknown>,
  }
}

async function sourcesNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; market?: unknown; ruleId?: unknown; ids?: unknown }
  if (!Array.isArray(after.ids) || typeof after.market !== 'string') return change.after
  const states = await sourceStates(after.market)
  const of = (id: string) => ('error' in states ? null : states.get(id) ?? null)
  return { ...after, state: Object.fromEntries(after.ids.map((id) => { const s = of(String(id)); return [String(id), s ? { rules: s.rules, paused: s.paused } : null] })) }
}

const OPPOSITE = { assign: 'detach', detach: 'assign', pause: 'resume', resume: 'pause' } as const

/** C2 — undo: the opposite op on exactly the ad groups it changed (a pause's reason is not kept by its undo). */
export const SOURCES_UNDO: ToolUndo = {
  current: sourcesNow,
  request(change) {
    const after = (change.after ?? {}) as { op?: keyof typeof OPPOSITE; market?: unknown; ruleId?: unknown; ids?: unknown }
    if (!after.op || !OPPOSITE[after.op] || !Array.isArray(after.ids) || !after.ids.length || typeof after.market !== 'string') return { refusal: 'This change does not name the source ad groups it changed.' }
    return {
      tool: HARVEST_RULE_TOOLS.setSources,
      args: { op: OPPOSITE[after.op], market: after.market, adGroupIds: after.ids.map(String), ...(typeof after.ruleId === 'string' ? { ruleId: after.ruleId } : {}), why: `undo of a source ${after.op}` },
    }
  },
}

const setHarvestSources: AgentTool = {
  name: HARVEST_RULE_TOOLS.setSources,
  title: 'Set harvest sources',
  category: 'automation',
  riskTier: 'low',
  readOnly: false,
  requires: [F.adsAutomationManage],
  input: SET_SOURCES_INPUT,
  requiresApprovalDefault: true,
  openWorld: false,
  // A pause's undo resumes; a resume's undo pauses again without the first pause's reason.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SOURCES_UNDO,
  description:
    'Change the Keyword Harvest page\'s Sources, on the same service: assign source ad groups to a builder harvest rule '
    + '(keyword-harvesting: it reads them too) or detach them from it (a rule that reaches its sources by its scope — '
    + 'harvest_and_negate, promote_to_exact — is refused: edit its scope with save-ad-rule), or pause harvesting from '
    + 'them (no harvest — the page, Claude, a rule or the ads brain — takes a term from a paused source) or resume it. '
    + 'adGroupIds from harvest-sources, in one market; an ad group already in that state is left. Nexus only: nothing is '
    + 'sent to Amazon. Nothing changes until a person approves it in Nexus. Undo (undo-change) does the opposite on the '
    + 'same ad groups.',
  async handler(args): Promise<ToolResult> {
    return decideSources(args)
  },
  async execute(args, ctx): Promise<ToolResult> {
    const fresh = await decideSources(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as SourcesPreview
    if ((ctx.approvedPreview as { basis?: unknown } | undefined)?.basis !== p.basis) return notRun('Not run: what you approved has moved since — a source\'s rules or pause changed meanwhile. Ask for it again as it is now.')
    const run = approvedRun(ctx, String((args as { why?: unknown }).why ?? '') || String((fresh.preview as { summary?: unknown }).summary ?? ''))
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const actor = run.actor as AdsActor
    let result: unknown
    if (p.op === 'assign') {
      const out = await assignSources(p.ruleId!, p.ids, actor)
      if (!out.ok) return notRun(`Not run: ${(out as { error?: string }).error ?? 'the rule refused it'}.`)
      result = out
    } else if (p.op === 'detach') {
      const out = await detachSources(p.ruleId, p.ids, actor)
      const bad = out.results.find((r) => !r.ok)
      if (bad) return notRun(`Not run: ${(bad as { error?: string }).error ?? 'the rule refused it'}.`)
      result = out
    } else if (p.op === 'pause') result = await pauseSources(p.ids, actor, String((args as { reason?: unknown }).reason ?? '') || null)
    else result = await resumeSources(p.ids)
    const states = await sourceStates(p.market)
    const stateOf = (id: string) => ('error' in states ? null : states.get(id) ?? null)
    const after = { op: p.op, market: p.market, ...(p.ruleId ? { ruleId: p.ruleId } : {}), ids: p.ids }
    return {
      ok: true,
      data: { op: p.op, result, note: 'Nexus only: nothing was sent to Amazon.' },
      change: {
        before: { ...after },
        after: { ...after, state: Object.fromEntries(p.ids.map((id) => { const s = stateOf(id); return [id, s ? { rules: s.rules, paused: s.paused } : null] })) },
      },
    }
  },
}

export const ADS_HARVEST_RULE_TOOLS: AgentTool[] = [harvestRulesTool, setHarvestRules, harvestSourcesTool, setHarvestSources]
