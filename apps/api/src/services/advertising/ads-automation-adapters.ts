/**
 * R5 (MCP full control, part 06 §1) — the adapters of the 18 Amazon ads automations (A1–A18), for the automation
 * catalog (services/automation/automation-catalog.service.ts).
 *
 * In the advertising context on purpose: they read advertising's own tables (the dial, plans, schedules, pools,
 * coverage sets, guardrails …), which only this context may touch (scripts/check-context-boundary.mjs). Read-only:
 * the dial is read with findUnique, never through `getAutomationState`, whose read creates a missing row.
 */
import { FEATURES } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { envEnabled } from '../../utils/env-flag.js'
import {
  capsOfRule, cronRunsFact, envVerdict, flagOn, fromRows, gateOfCounts, isOne, iso, lowest, noEnv, on, outboundEmails, ruleDetail, ruleIdsFor,
  ruleRefusalsFact, ruleRunsFact, summarise,
  type AutomationAdapter, type AutomationLevel, type AutomationRow, type BusinessState, type EnvCheck, type ExplainFacts,
  type ExplainOptions, type GateEvidence, type LevelSwitch, type PreviewInput, type PreviewOutcome, type SwitchRow, type WritesFact,
} from '../automation/automation-levels.js'
import { isRefused } from '../automation/service-outcome.js'
import { breakerLimits, breakerLimitsText, engineCaps, type EngineKey } from './ads-engine-actors.js'
import { engineCapsText } from './ads-engine-guard.js'

// ── Env checks every Amazon ads engine shares ─────────────────────────────────────────────────────────

// ── Shared env checks ─────────────────────────────────────────────────────────────────────────────────

export const adsCron = (): EnvCheck => ({
  flag: 'NEXUS_ENABLE_AMAZON_ADS_CRON', allows: envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON'), whenNot: 'OFF',
  not: 'NEXUS_ENABLE_AMAZON_ADS_CRON is off on this server — no Amazon ads engine runs.',
  yes: 'The Amazon ads crons run on this server.',
})
export const adsKill = (): EnvCheck => ({
  flag: 'NEXUS_ADS_AUTOMATION_KILL', allows: process.env.NEXUS_ADS_AUTOMATION_KILL !== '1', whenNot: 'OFF',
  not: 'NEXUS_ADS_AUTOMATION_KILL is set — all ads automation is stopped.',
  yes: 'The ads kill switch is not set.',
})
export const adsLive = (): EnvCheck => ({
  flag: 'NEXUS_AMAZON_ADS_MODE', allows: (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live', whenNot: 'OBSERVE',
  not: "NEXUS_AMAZON_ADS_MODE is not live — writes go to Amazon's sandbox, never to your account.",
  yes: 'Amazon ads writes are live.',
})
export const amazonAds = (...more: EnvCheck[]) => envVerdict([adsCron(), adsKill(), adsLive(), ...more])
// ── The business's ads dial (AdsAutomationState), read without creating it ─────────────────────────────

interface AdsDial { autonomy: string; halted: boolean; haltReason: string | null; maxActionsPerHour: number | null; maxHourlySpendCentsEur: number | null; defaultTargetAcosPct: number | null; set: boolean }

async function adsDial(): Promise<AdsDial> {
  // The workspace client stores this business's row as `<workspaceId>:singleton` (legacy: `singleton`).
  const row = await prisma.adsAutomationState.findUnique({ where: { id: 'singleton' } })
  return {
    // The service's fail-safe and the schema default: propose, never act.
    autonomy: row?.autonomy ?? 'SUGGEST',
    halted: row?.halted ?? false,
    haltReason: row?.haltReason ?? null,
    maxActionsPerHour: row?.maxActionsPerHour ?? null,
    maxHourlySpendCentsEur: row?.maxHourlySpendCentsEur ?? null,
    defaultTargetAcosPct: row?.defaultTargetAcosPct ?? null,
    set: row != null,
  }
}

/**
 * 1c / 1d — the engines that read the dial through ads-engine-guard.ts, and what each still does under it: under
 * SUGGEST nothing new is written (some still give back their own state); while halted or OFF only bid floors may
 * land, everything else waiting for Resume. Each keeps its own caps per run and per day.
 */
type GuardedEngine = 'rank-defend' | 'dayparting' | 'budget-schedules' | 'budget-enforce' | 'budget-pools' | 'tos-defense' | 'coverage-engine' | 'autopilot'
const FLOOR_ENGINE: { suggest: string; stopped: string } = {
  suggest: 'it computes and writes nothing new, but still gives back its own floors.',
  stopped: ' It only lowers bids to their floors; restores wait for Resume.',
}
const GUARDED_WORDS: Record<GuardedEngine, { suggest: string; stopped: string }> = {
  'rank-defend': FLOOR_ENGINE,
  dayparting: FLOOR_ENGINE,
  'budget-schedules': {
    suggest: 'it enters no window and writes nothing new, but still gives back a budget it set when that window closes.',
    stopped: ' It writes nothing; windows and give-backs wait for Resume.',
  },
  'budget-enforce': {
    suggest: 'it writes no pacing and no new floors, but still restores bids it floored over the cap.',
    stopped: ' It only floors bids when a cap is reached; restores and budget pacing wait for Resume.',
  },
  'budget-pools': { suggest: 'each due rebalance is recorded as a dry run; nothing is written.', stopped: ' It writes nothing; rebalances wait for Resume.' },
  'tos-defense': { suggest: 'it computes and writes nothing.', stopped: ' It writes nothing; placement moves wait for Resume.' },
  'coverage-engine': { suggest: 'it logs the bids it would set and writes nothing.', stopped: ' It logs the bids it would set and writes nothing until Resume.' },
  autopilot: { suggest: 'AUTO plans record proposals and write nothing.', stopped: ' AUTO plans record proposals and write nothing until Resume.' },
}

/**
 * How the dial bears on an ads automation.
 *   rules    the rule evaluator: a halt or OFF skips the tick; SUGGEST demotes AUTO rules to proposals
 *   honours  auto-bid: a halt or OFF stands it down; SUGGEST makes it a dry run that only reports
 *   <engine> a guarded engine (GUARDED_WORDS above): it says what it still does under the dial
 */
type DialEffect = 'rules' | 'honours' | GuardedEngine
function dialCap(dial: AdsDial, effect: DialEffect): { cap: AutomationLevel; why: string | null } {
  const words = effect === 'rules' || effect === 'honours' ? null : GUARDED_WORDS[effect]
  if (dial.halted) return { cap: 'OFF', why: `Ads automation is halted${dial.haltReason ? `: ${dial.haltReason}` : ''}.${words?.stopped ?? ''}` }
  if (dial.autonomy === 'OFF') return { cap: 'OFF', why: `The account ads dial is OFF.${words?.stopped ?? ''}` }
  if (dial.autonomy === 'SUGGEST') {
    return { cap: 'PROPOSE', why: `The account ads dial is SUGGEST${dial.set ? '' : ' (never set)'} — ${words?.suggest ?? 'it proposes, nothing acts.'}` }
  }
  return { cap: 'AUTO', why: null }
}

/** 1c — an engine that keeps its own caps says them, beside its level and in its reason. */
function withEngineCaps(s: BusinessState, engine: EngineKey): BusinessState {
  const { perTick, perDay } = engineCaps(engine)
  return { ...s, reason: `${s.reason} Honours the account dial; ${engineCapsText(engine)}.`, caps: { ...(s.caps ?? {}), changesPerRun: perTick, changesPerDay: perDay } }
}

/** A business state whose level is the rows' highest, held under the dial. */
function underDial(rows: AutomationRow[], dial: AdsDial, effect: DialEffect, none: string, extra: Partial<BusinessState> = {}): BusinessState {
  const s = summarise(rows)
  const { cap, why } = dialCap(dial, effect)
  const level = lowest(s.level, cap)
  const reason = !rows.length ? none : level !== s.level && why ? why : s.level === 'OFF' ? 'Every one is switched off.' : `The most active is at ${s.level}.`
  return { level, reason, rows: s.rows, sample: s.sample, ...extra }
}

async function allowlistScope(): Promise<string> {
  // 7b — the census every screen counts campaigns from (ads-census.service.ts).
  const { campaignCensus } = await import('./ads-census.service.js')
  const { allowlisted, total } = await campaignCensus()
  return `May write to ${allowlisted} of ${total} campaigns (the live-write allowlist).`
}


// ── R7 — what an ads automation wrote, by its exact actor strings ───────────────────────────────────

/**
 * Ads writes (AdvertisingActionLog) by EXACT actor strings — never a prefix: `automation:rank-defend-*` is 54 of 56
 * `automation:` actors, and a prefix match would hand a rule another engine's work (the B4 warning). `actionType`
 * instead of actors for a writer that records none (the external bidding engine).
 */
async function adsWrites(actors: string[], since: Date, extra: { actionType?: string; entityIds?: string[] } = {}): Promise<WritesFact> {
  const base = {
    ...(extra.actionType ? { actionType: extra.actionType } : { userId: { in: actors } }),
    ...(extra.entityIds ? { entityId: { in: extra.entityIds } } : {}),
  }
  const inWindow = { ...base, createdAt: { gte: since } }
  const [grouped, last, lastEver] = await Promise.all([
    prisma.advertisingActionLog.groupBy({ by: ['actionType'], where: inWindow, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.advertisingActionLog.findMany({ where: inWindow, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, actionType: true, entityType: true, entityId: true, amazonResponseStatus: true } }),
    prisma.advertisingActionLog.findFirst({ where: base, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  const lastAt = grouped.reduce<Date | null>((at, g) => (g._max.createdAt && (!at || g._max.createdAt > at) ? g._max.createdAt : at), null)
  return {
    source: extra.actionType ? `AdvertisingActionLog (action ${extra.actionType})` : 'AdvertisingActionLog',
    actors,
    total: grouped.reduce((n, g) => n + g._count._all, 0),
    byAction: Object.fromEntries(grouped.map((g) => [g.actionType, g._count._all])),
    lastAt: iso(lastAt),
    everWritten: lastEver != null,
    lastEverAt: iso(lastEver?.createdAt),
    last: last.map((r) => ({ at: r.createdAt.toISOString(), action: r.actionType, entityType: r.entityType, entityId: r.entityId, status: r.amazonResponseStatus })),
  }
}

/** An engine with fixed actors: its cron runs and its writes. */
async function engineExplain(crons: readonly string[], actors: string[], opts: ExplainOptions, notes: string[] = []): Promise<ExplainFacts> {
  const [runs, writes] = await Promise.all([cronRunsFact(crons, opts.since), adsWrites(actors, opts.since)])
  return { subject: null, runs, writes, refusals: null, ...(notes.length ? { notes } : {}) }
}

/** An engine whose actor names the row it acts for (`automation:dayparting-<scheduleId>` …). */
async function perRowExplain(adapter: AutomationAdapter, opts: ExplainOptions, actorOf: (row: AutomationRow) => string | null, notes: string[] = []): Promise<ExplainFacts | null> {
  const rows = await adapter.rows!()
  const chosen = opts.rowId ? rows.filter((r) => r.id === opts.rowId) : rows
  if (opts.rowId && !chosen.length) return null
  const actors = chosen.map(actorOf).filter((a): a is string => !!a)
  const [runs, writes] = await Promise.all([cronRunsFact(adapter.crons, opts.since), adsWrites(actors, opts.since)])
  const row = opts.rowId ? chosen[0] : null
  return { subject: row ? { id: row.id, name: row.name, level: row.level } : null, runs, writes, refusals: null, ...(notes.length ? { notes } : {}) }
}


// ── R10 — switches ────────────────────────────────────────────────────────────────────────────────────

/** Actions that hold spend down: a rule carrying one is a brake — turning it down can raise spend (part 06 §3). */
const SPEND_REDUCERS = new Set(['bid_down', 'lower_bid_to_floor', 'retail_guard', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'harvest_and_negate', 'isolate_product_terms', 'pace_budget'])
export function adsRuleBrake(actions: unknown): string | null {
  const list = (Array.isArray(actions) ? actions : []) as Array<Record<string, unknown>>
  const reducers = list.filter((a) => SPEND_REDUCERS.has(String(a?.type)) || (['adjust_ad_budget', 'budget_apply'].includes(String(a?.type)) && Number(a?.percent ?? a?.value ?? 0) < 0)).map((a) => String(a.type))
  return reducers.length ? `it holds spend down (${[...new Set(reducers)].join(', ')}): turning it down can raise spend` : null
}

/** An audit row of a switch moved, in the ads action log; it never fails the move it describes. */
async function auditSwitch(actorUserId: string | null, entityType: string, entityId: string, from: AutomationLevel, to: AutomationLevel, note: string): Promise<void> {
  await prisma.advertisingActionLog.create({
    data: {
      userId: `user:${actorUserId ?? 'anonymous'}`, actionType: 'set_automation_level', entityType, entityId,
      payloadBefore: { level: from }, payloadAfter: { level: to }, amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_autonomy', note },
    },
  }).catch(() => { /* an audit row must never fail the write it describes */ })
}

/** A switch of rows that are on (AUTO) or off. */
function onOffSwitch(opts: {
  read: (rowId: string) => Promise<{ id: string; name: string; on: boolean; updatedAt: Date } | null>
  write: (rowId: string, on: boolean, actorUserId: string | null) => Promise<string | null | { note: string }>
  entityType: string
  /** A fixed sentence, or one read for the row now (2a: what switching it off would give back). */
  brake?: string | ((rowId: string) => Promise<string>)
  /** AA-W2-11 — the row's graduation gate (LevelSwitch.gateEvidence). */
  gateEvidence?: (row: SwitchRow) => Promise<GateEvidence>
}): LevelSwitch {
  return {
    levels: ['OFF', 'AUTO'], needsRow: true, manage: FEATURES.adsAutomationManage,
    ...(opts.gateEvidence ? { gateEvidence: opts.gateEvidence } : {}),
    async read(rowId) {
      const r = rowId ? await opts.read(rowId) : null
      const brake = typeof opts.brake === 'function' ? (r ? await opts.brake(r.id) : null) : opts.brake ?? null
      return r ? { id: r.id, name: r.name, level: r.on ? 'AUTO' : 'OFF', basis: r.updatedAt.toISOString(), brake } : null
    },
    async write(row, level, actorUserId) {
      const written = await opts.write(row.id, level === 'AUTO', actorUserId)
      if (typeof written !== 'string') await auditSwitch(actorUserId, opts.entityType, row.id, row.level, level, `${row.name} → ${level}`)
      return written
    },
  }
}

/**
 * AA-W2-11 — the gate of a kind that is on or off with no dry run (classic dayparting, budget schedules): the writes it
 * made while it was on, by its exact actor. Each write is a run that found something to do.
 */
async function writesGate(made: Promise<{ createdAt: Date } | null>, actor: string, from: string): Promise<GateEvidence> {
  const [row, writes] = await Promise.all([made, prisma.advertisingActionLog.count({ where: { userId: actor } })])
  return gateOfCounts({ createdAt: row?.createdAt ?? new Date(), runs: writes, matches: writes, runsAre: 'writes', matchesAre: 'writes', from })
}

// ── A — Amazon ads ────────────────────────────────────────────────────────────────────────────────────

const A1: AutomationAdapter = {
  id: 'A1', key: 'ads-rules', name: 'Amazon ads rules',
  what: 'IF a metric crosses a threshold THEN move a bid, budget or placement, add a negative, harvest a term or notify.',
  area: 'amazon-ads', writesTo: ['nexus', 'amazon'], view: FEATURES.adsView, claude: 'full', preview: 'draft-and-saved',
  previewNote: 'A draft built in the rule builder (budget, bid, placement, share of voice, keyword tracker), or a saved rule against what it would see on its next tick.',
  crons: ['advertising-rule-evaluator'], schedule: process.env.NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*/15 * * * *',
  env: () => amazonAds(),
  async rows() {
    const { listAdsRuleBoard } = await import('./ads-rule-list.service.js')
    const board = await listAdsRuleBoard()
    return board.items.map((r) => ({
      id: r.id, name: r.name, level: r.level as AutomationLevel, runsAs: r.runsAs, runsAsReason: r.runsAsReason, ceiling: r.ceiling, trigger: r.trigger, writes: r.writes,
      reach: r.reach, scope: r.scope, caps: r.caps, week: r.week, lastEvaluatedAt: r.lastEvaluatedAt, lastExecutedAt: r.lastExecutedAt,
    }))
  },
  async get(rowId: string) {
    const row = (await this.rows!()).find((r) => r.id === rowId)
    if (!row) return null
    const [detail, gate] = await Promise.all([ruleDetail('advertising', rowId), (await import('./ads-rule-crud.service.js')).adsRuleGateStatus(rowId)])
    // The graduation gate (D-R1): the road to AUTO, which a person still clicks.
    return { ...detail, ...row, graduationGate: isRefused(gate) ? null : gate.value }
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    const wholeAccount = rows.filter((r) => (r.scope as { kind?: string } | undefined)?.kind === 'account' && !(r.scope as { product?: unknown }).product).length
    return underDial(rows, dial, 'rules', 'No ads rules.', { scope: `${rows.length} rules; ${wholeAccount} reach the whole account.` })
  },
  async explain(opts: ExplainOptions) {
    const scope = await ruleIdsFor('advertising', opts.rowId)
    if (!scope) return null
    // A rule writes as automation:<ruleId>. Its placement actions wrote as automation:rule-<ruleId> until the part 06
    // fix (its write cap never counted them): matched too, so its history stays whole.
    const actors = scope.ids.flatMap((id) => [`automation:${id}`, `automation:rule-${id}`])
    const [runs, refusals, writes] = await Promise.all([ruleRunsFact(scope.ids, opts.since), ruleRefusalsFact(scope.ids, opts.days), adsWrites(actors, opts.since)])
    return {
      subject: scope.subject, runs, writes, refusals,
      notes: ['A rule matched and acted leaves a run; what it wrote to Amazon is in its writes. A run with no write is a dry run, a proposal, a refusal at the write gate or a write that changed nothing.'],
    }
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    const { producedActionTypes } = await import('./ads-rule-adapter.service.js')
    if (input.draft) {
      const { previewAdsRuleDraft } = await import('./ads-rule-preview.service.js')
      const draft = {
        actions: input.draft.actions, conditions: input.draft.conditions,
        scopeMarketplace: (input.draft.scopeMarketplace as string | null | undefined) ?? null,
        // The portfolio scope narrows the preview exactly as the tick does (campaign → portfolio).
        scopePortfolioId: (input.draft.scopePortfolioId as string | null | undefined) ?? null,
      }
      return {
        kind: 'draft', subject: null, result: await previewAdsRuleDraft(draft), actionTypes: producedActionTypes(draft),
        notes: ["A draft in the rule builder's shape (actions[0].type budget, bid, placement, sov or keyword-tracker), run through the real engine as a dry run, inside its scopeMarketplace and scopePortfolioId. A sov draft with no campaigns picked runs over that whole scope, as the engine would. An engine-native rule is previewed once saved."],
      }
    }
    if (!input.rowId) return { refused: 'Give a draft, or name a saved rule (rowId).' }
    const rule = await prisma.automationRule.findFirst({ where: { id: input.rowId, domain: 'advertising' }, select: { id: true, name: true, actions: true, conditions: true } })
    if (!rule) return { refused: 'not found', notFound: true }
    const { simulateOneRule } = await import('../../jobs/advertising-rule-evaluator.job.js')
    return {
      kind: 'saved', subject: { id: rule.id, name: rule.name }, result: await simulateOneRule(rule.id), actionTypes: producedActionTypes(rule),
      notes: ['Against the contexts its trigger builds from current data, inside its own scope, as its next tick would — whether it is switched on or not.'],
    }
  },
  levelSwitch: {
    levels: ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'], needsRow: true, manage: FEATURES.adsAutomationManage,
    async read(rowId) {
      const r = rowId ? await prisma.automationRule.findFirst({ where: { id: rowId, domain: 'advertising' } }) : null
      const { resolveAutonomy } = await import('./ads-autonomy.js')
      return r ? { id: r.id, name: r.name, level: resolveAutonomy(r), basis: r.updatedAt.toISOString(), brake: adsRuleBrake(r.actions) } : null
    },
    // The graduation ceiling, a contested placement lane, and for AUTO the graduation gate (D-R1) — the level dial's own checks.
    async refusal(row: SwitchRow, level: AutomationLevel) {
      const { adsRuleLevelRefusal } = await import('./ads-rule-crud.service.js')
      const out = await adsRuleLevelRefusal(row.id, level)
      return out.ok ? null : String((out as { body: Record<string, unknown> }).body.message ?? (out as { body: Record<string, unknown> }).body.error)
    },
    // AA-W2-11 — the gate status the Control Room shows (its eight checks), and the rule's own caps.
    async gateEvidence(row: SwitchRow): Promise<GateEvidence> {
      const { adsRuleGateStatus } = await import('./ads-rule-crud.service.js')
      const [status, rule] = await Promise.all([
        adsRuleGateStatus(row.id),
        prisma.automationRule.findUnique({ where: { id: row.id }, select: { maxWritesPerDay: true, maxValueCentsEur: true } }),
      ])
      const caps = rule ? capsOfRule(rule) : { maxWritesPerDay: null, maxValueCentsEur: null }
      if (isRefused(status)) return { open: false, from: 'the rule\'s graduation gate', checks: [{ check: 'the rule', passed: false, detail: 'not found' }], caps }
      return { open: status.value.gateOpen, from: 'the rule\'s graduation gate (the Control Room\'s gate status)', checks: status.value.checks.map((c) => ({ check: c.label, passed: c.passed, detail: c.detail })), caps }
    },
    // W4-12b — a rule's Manual/Automate setting moves with the level (controlMove).
    async alsoChanges(row: SwitchRow, level: AutomationLevel) {
      const move = await controlMove(row, level)
      return move ? { field: 'control', from: move.from, to: move.to, words: move.words } : null
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      const { setAdsRuleLevel, updateAdsRule } = await import('./ads-rule-crud.service.js')
      const actor = `user:${actorUserId ?? 'anonymous'}` as const
      const why = (out: unknown) => String((out as { body: Record<string, unknown> }).body.message ?? (out as { body: Record<string, unknown> }).body.error)
      // W4-12b — as the Rules screen (RulesGrid.tsx setAutomation): the setting goes to Automate FIRST, through the rule
      // drawer's own save and audit (updateAdsRule, PATCH /advertising/automation-rules/:id), so AUTO never stands beside
      // Manual; it goes back to Manual if the level is refused.
      const move = await controlMove(row, level)
      const note = `Manual/Automate set to ${move?.to === 'automate' ? 'Automate' : 'Manual'} with the level ${level} ${LEVEL_MOVE_MARK}`
      if (move?.to === 'automate') {
        const set = await updateAdsRule(row.id, { actions: move.actions }, actor, { note })
        if (!set.ok) return `its Manual/Automate setting could not be set to Automate (${why(set)}), so it stays ${row.level}`
      }
      const out = await setAdsRuleLevel(row.id, level, actor as never)
      if (!out.ok) {
        if (move?.to === 'automate') await updateAdsRule(row.id, { actions: move.before }, actor, { note: `Manual/Automate put back to Manual: the level ${level} was refused` }).catch(() => undefined)
        return why(out)
      }
      // Down from AUTO: back to Manual after the level, when a level move set it to Automate (best-effort, as on the
      // screen: below AUTO the level alone keeps the rule proposing). Said when it could not be.
      if (move?.to === 'manual') {
        const back = await updateAdsRule(row.id, { actions: move.actions }, actor, { note }).catch(() => null)
        if (!back?.ok) return { note: `its Manual/Automate setting stayed on Automate (${back ? why(back) : 'the save failed'}); at ${level} it proposes anyway` }
      }
      return null
    },
  },
}

/** W4-12b — in the audit note of a Manual/Automate change a level move made (and only there). */
const LEVEL_MOVE_MARK = '(by a level move)'

/**
 * W4-12b — whether the rule's Manual/Automate setting was last changed by a level move, from Manual to Automate: the
 * latest `update_rule` audit row (the drawer's save, updateAdsRule) whose actions[0].control changed. A person's radio
 * in the rule builder, or the Rules screen's own flip, leaves no mark: then the setting is theirs and is left alone.
 */
async function automateSetByLevelMove(ruleId: string): Promise<boolean> {
  const rows = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'RULE', entityId: ruleId, actionType: 'update_rule' },
    orderBy: { createdAt: 'desc' }, take: 50, select: { payloadBefore: true, payloadAfter: true, evidence: true },
  })
  const controlOf = (payload: unknown) => ((payload as { actions?: Array<{ control?: unknown }> } | null)?.actions?.[0]?.control) ?? null
  const last = rows.find((r) => controlOf(r.payloadBefore) !== controlOf(r.payloadAfter))
  if (!last) return false
  const note = String((last.evidence as { note?: unknown } | null)?.note ?? '')
  return controlOf(last.payloadBefore) === 'manual' && controlOf(last.payloadAfter) === 'automate' && note.includes(LEVEL_MOVE_MARK)
}

/**
 * W4-12b — an Amazon ads rule's Manual/Automate setting (`actions[0].control`, the rule builder's radio) as a level move
 * changes it. On Manual the engine runs the rule as a dry run whatever its level (automation-rule.service.ts EA3): it
 * only proposes. The Rules screen keeps it in step when a person switches Auto (RulesGrid.tsx setAutomation, BP.P1):
 * Automate when the rule goes to AUTO, Manual when Auto is switched off. A move of Claude's sets Automate the same way,
 * so a rule raised to AUTO acts; turned down from AUTO it goes back to Manual only when a level move set Automate
 * (automateSetByLevelMove) — a setting a person chose stays theirs (below AUTO the rule proposes either way). A rule
 * with no setting is left as it is. (A rule a builder made Manual on purpose — a Harvest & Negate, a playbook's
 * isolation — cannot reach AUTO: its graduation ceiling holds it at PROPOSE, refused before this.) Null: nothing to
 * change.
 */
async function controlMove(row: SwitchRow, level: AutomationLevel): Promise<{ from: string; to: 'manual' | 'automate'; words: string; actions: object[]; before: object[] } | null> {
  const rule = await prisma.automationRule.findFirst({ where: { id: row.id, domain: 'advertising' }, select: { actions: true } })
  if (!rule || !Array.isArray(rule.actions)) return null
  const before = rule.actions as Array<Record<string, unknown>>
  const control = before[0]?.control
  const to = level === 'AUTO' && control === 'manual' ? 'automate' as const
    : row.level === 'AUTO' && level !== 'AUTO' && control === 'automate' && (await automateSetByLevelMove(row.id)) ? 'manual' as const
      : null
  if (!to) return null
  const words = to === 'automate'
    ? 'Its Manual/Automate setting goes from Manual to Automate with it, as the Rules screen does when a person sets Auto: on Manual a rule only proposes, whatever its level.'
    : 'Its Manual/Automate setting goes back from Automate to Manual, where it was before a level move set Automate, as the Rules screen does when Auto is switched off.'
  return { from: String(control), to, words, actions: before.map((a, i) => (i === 0 ? { ...a, control: to } : a)), before }
}

const A2: AutomationAdapter = {
  id: 'A2', key: 'ads-suggestions', name: 'Ads rule suggestions',
  what: 'What PROPOSE rules want to change, waiting for a person to apply or dismiss.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'decide', preview: 'none',
  previewNote: 'A suggestion is itself the preview: it says what would change.',
  crons: [], schedule: null,
  env: noEnv,
  async rows() {
    const { familyOfRow } = await import('./ads-suggestions.service.js')
    const pending = await prisma.adsRuleSuggestion.findMany({
      where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, ruleId: true, ruleName: true, entityName: true, entityType: true, marketplace: true, proposedAction: true, proposedKey: true, createdAt: true },
    })
    return pending.map((s) => ({
      id: s.id, name: `${s.ruleName ?? 'a rule'}: ${s.entityName ?? s.entityType}`, level: 'PROPOSE' as const,
      ruleId: s.ruleId, family: familyOfRow(s), marketplace: s.marketplace, createdAt: iso(s.createdAt),
    }))
  },
  async state() {
    const total = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
    return { level: null, reason: 'A person decides each one.', state: `${total} waiting for a decision.`, rows: { total, byLevel: { PROPOSE: total } } }
  },
  async explain(opts: ExplainOptions) {
    const grouped = await prisma.adsRuleSuggestion.groupBy({ by: ['status'], where: { OR: [{ decidedAt: { gte: opts.since } }, { status: 'pending' }] }, _count: { _all: true } })
    const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]))
    return { subject: null, runs: null, writes: null, refusals: null, notes: [`In ${opts.days} days: ${by.applied ?? 0} applied, ${by.dismissed ?? 0} dismissed; ${by.pending ?? 0} waiting.`] }
  },
  noSwitch: 'its suggestions are decided one by one (decide-automation-suggestions), not switched',
}

const A3: AutomationAdapter = {
  id: 'A3', key: 'ads-dial', name: 'Ads dial, halt and anomaly breaker',
  what: 'One dial for all ads automation; the breaker stops it account-wide when rule actions, one engine\'s changes or hourly ad spend pass their limits.',
  area: 'amazon-ads', writesTo: ['nexus'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'none',
  previewNote: 'The dial and the breaker have nothing to preview: they are the brakes.',
  crons: ['ads-anomaly-guard'], schedule: process.env.NEXUS_ADS_ANOMALY_GUARD_SCHEDULE ?? '*/10 * * * *',
  env: () => envVerdict([adsCron(), adsKill()]),
  async state() {
    const dial = await adsDial()
    const level: AutomationLevel = dial.halted || dial.autonomy === 'OFF' ? 'OFF' : dial.autonomy === 'AUTO' ? 'AUTO' : 'PROPOSE'
    return {
      level,
      reason: dial.halted ? `Halted${dial.haltReason ? `: ${dial.haltReason}` : ''}.` : `The dial is ${dial.autonomy}${dial.set ? '' : ' (never set)'}.`,
      state: `Dial ${dial.autonomy}${dial.halted ? ', HALTED' : ''}; the breaker trips at ${dial.maxActionsPerHour ?? 250} rule actions an hour, €${((dial.maxHourlySpendCentsEur ?? 50_000) / 100).toFixed(0)} of ad spend in one hour, or when one engine passes its own hourly limit of changes (${breakerLimitsText()}).`,
      caps: { maxActionsPerHour: dial.maxActionsPerHour ?? 250, maxHourlySpendCentsEur: dial.maxHourlySpendCentsEur ?? 50_000, engineChangesPerHour: breakerLimits(), defaultTargetAcosPct: dial.defaultTargetAcosPct },
    }
  },
  levelSwitch: {
    levels: ['OFF', 'PROPOSE', 'AUTO'], needsRow: false, manage: FEATURES.adsAutomationManage,
    async read() {
      const row = await prisma.adsAutomationState.findUnique({ where: { id: 'singleton' } })
      const dial = await adsDial()
      const level: AutomationLevel = dial.autonomy === 'OFF' ? 'OFF' : dial.autonomy === 'AUTO' ? 'AUTO' : 'PROPOSE'
      return { id: 'ads-dial', name: 'The account ads dial', level, basis: row?.updatedAt.toISOString() ?? null, brake: null }
    },
    async refusal(_row: SwitchRow, level: AutomationLevel) {
      const dial = await adsDial()
      return dial.halted && level !== 'OFF' ? `Ads automation is halted${dial.haltReason ? ` (${dial.haltReason})` : ''}: resume it first (resume-automation); the dial does not lift a halt.` : null
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      const { setAutonomy } = await import('./ads-automation-state.service.js')
      await setAutonomy(level === 'PROPOSE' ? 'SUGGEST' : level === 'AUTO' ? 'AUTO' : 'OFF', `user:${actorUserId ?? 'anonymous'}`)
      await auditSwitch(actorUserId, 'ADS_DIAL', 'ads-dial', row.level, level, `ads dial → ${level === 'PROPOSE' ? 'SUGGEST' : level}`)
      return null
    },
  },
}

const A4: AutomationAdapter = {
  id: 'A4', key: 'ads-auto-bid', name: 'Auto-bid (the bid optimiser)',
  // Owner targets only — the rule in AUTO_BID_SCOPE_WORDS' words (ads-auto-bid.service.ts).
  what: 'Moves target bids toward a target ACoS, at most −50 % / +25 % per pass, never below 5¢. It moves only bids where you set a target ACoS (campaign, ads strategy or account default) and leaves bids an hourly plan, a goal plan, a person or a pin holds.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'saved',
  previewNote: 'The bids it would set now, chosen as a run chooses them (with what it leaves alone, and why), computed and not written.',
  crons: ['ads-auto-bid'], schedule: process.env.NEXUS_ADS_AUTO_BID_SCHEDULE ?? '20 */6 * * *',
  env: () => amazonAds(),
  async state() {
    const [dial, scope] = await Promise.all([adsDial(), allowlistScope()])
    const { cap, why } = dialCap(dial, 'honours')
    // 1d — and its own caps per run and per day.
    const { perTick, perDay } = engineCaps('auto-bid')
    return { level: cap, reason: `${why ?? 'Runs on the account dial, which is AUTO.'} It keeps its own caps: ${engineCapsText('auto-bid')}.`, scope, caps: { defaultTargetAcosPct: dial.defaultTargetAcosPct, changesPerRun: perTick, changesPerDay: perDay } }
  },
  explain: (opts: ExplainOptions) => engineExplain(['ads-auto-bid'], ['automation:auto-bid'], opts),
  async runPreview(): Promise<PreviewOutcome> {
    // W0 — with the run's own options. Owner targets only — and the run's own choice (planAutoBid): the bids toward a
    // target the Owner set that nobody else holds, so the preview is the run; what it leaves alone is counted per reason.
    const { planAutoBid, leftAloneTotal, leftAloneWords, AUTO_BID_SCOPE_WORDS } = await import('./ads-auto-bid.service.js')
    const { preview: out, moves, leftAlone } = await planAutoBid()
    const alone = leftAloneTotal(leftAlone)
    return {
      kind: 'saved', subject: null,
      result: {
        targetAcos: out.targetAcos, profitMode: out.profitMode, bayesian: out.bayesian, proposals: moves.slice(0, 100), total: moves.length,
        leftAlone, leftAloneNote: alone ? `${alone} left alone (${leftAloneWords(leftAlone)}): ${AUTO_BID_SCOPE_WORDS}.` : `Nothing left alone: ${AUTO_BID_SCOPE_WORDS}.`,
      },
    }
  },
  // R16 — its per-business switch, under the env and the account dial (A3).
  engine: 'auto-bid',
}

const A5: AutomationAdapter = {
  id: 'A5', key: 'ads-autopilot', name: 'Autopilot plans',
  what: 'Per plan: bids, budgets and placements toward a goal; creates the harvest and negate rules it needs.',
  area: 'amazon-ads', writesTo: ['nexus', 'amazon'], view: FEATURES.adsView, claude: 'switch', preview: 'saved',
  previewNote: "A saved plan's backtest over its campaigns' history; nothing is written.",
  crons: ['ad-autopilot'], schedule: '*/15 * * * *',
  env: () => amazonAds(),
  async rows() {
    const plans = await prisma.autopilotPlan.findMany({ select: { id: true, name: true, enabled: true, autonomy: true, marketplace: true, goal: true, stage: true, campaignIds: true, lastEvaluatedAt: true }, orderBy: { name: 'asc' } })
    return plans.map((p) => ({
      id: p.id, name: p.name,
      level: (!p.enabled || p.autonomy === 'OFF' ? 'OFF' : p.autonomy === 'AUTO' ? 'AUTO' : 'PROPOSE') as AutomationLevel,
      marketplace: p.marketplace, goal: p.goal, stage: p.stage, campaigns: Array.isArray(p.campaignIds) ? p.campaignIds.length : 0, lastEvaluatedAt: iso(p.lastEvaluatedAt),
    }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'autopilot', 'No autopilot plans.'), 'autopilot')
  },
  explain(opts: ExplainOptions) {
    return perRowExplain(this, opts, (row) => `automation:autopilot-${row.id}`, ['A plan writes as automation:autopilot-<planId>; its top-of-search step writes as automation:autopilot (not counted per plan).'])
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    if (!input.rowId) return { refused: 'Name the autopilot plan to backtest (rowId).' }
    const plan = await prisma.autopilotPlan.findUnique({ where: { id: input.rowId } })
    if (!plan) return { refused: 'not found', notFound: true }
    const { backtestPlan } = await import('./autopilot/backtest.js')
    const campaignIds = Array.isArray(plan.campaignIds) ? (plan.campaignIds as string[]) : []
    const result = await backtestPlan({ campaignIds, goal: plan.goal as never, guardrails: (plan.guardrails ?? {}) as never, modules: (plan.modules ?? {}) as never, days: 30, marketplace: plan.marketplace })
    return { kind: 'saved', subject: { id: plan.id, name: plan.name }, result, notes: ["A backtest over its campaigns' last 30 days."] }
  },
  levelSwitch: {
    levels: ['OFF', 'PROPOSE', 'AUTO'], needsRow: true, manage: FEATURES.adsAutomationManage,
    async read(rowId) {
      const p = rowId ? await prisma.autopilotPlan.findUnique({ where: { id: rowId } }) : null
      return p ? { id: p.id, name: p.name, level: (!p.enabled || p.autonomy === 'OFF' ? 'OFF' : p.autonomy === 'AUTO' ? 'AUTO' : 'PROPOSE') as AutomationLevel, basis: p.updatedAt.toISOString(), brake: null } : null
    },
    // AA-W2-11 — what a plan at PROPOSE leaves behind: its decisions with an outcome (waiting ones are re-made every tick
    // and not counted); one a person or the plan applied is a decision.
    async gateEvidence(row: SwitchRow): Promise<GateEvidence> {
      const [plan, decided, applied] = await Promise.all([
        prisma.autopilotPlan.findUnique({ where: { id: row.id }, select: { createdAt: true } }),
        prisma.autopilotDecision.count({ where: { planId: row.id, status: { not: 'PROPOSED' } } }),
        prisma.autopilotDecision.count({ where: { planId: row.id, status: 'APPLIED' } }),
      ])
      return gateOfCounts({ createdAt: plan?.createdAt ?? new Date(), runs: decided, matches: applied, runsAre: 'decisions with an outcome', matchesAre: 'applied', from: "the plan's decisions (AutopilotDecision): a waiting proposal is re-made every tick and not counted" })
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      await prisma.autopilotPlan.update({ where: { id: row.id }, data: level === 'OFF' ? { enabled: false } : { enabled: true, autonomy: level === 'AUTO' ? 'AUTO' : 'SUGGEST' } })
      await auditSwitch(actorUserId, 'AUTOPILOT_PLAN', row.id, row.level, level, `${row.name} → ${level}`)
      return null
    },
  },
}

const A6: AutomationAdapter = {
  id: 'A6', key: 'ads-dayparting', name: 'Classic dayparting',
  what: 'Hour windows: 2¢ suppression while a window is closed, a bid multiplier while open.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch', preview: 'none',
  previewNote: 'It has no dry run; its run-now is live.',
  crons: ['ad-dayparting'], schedule: '*/15 * * * *',
  env: () => amazonAds(),
  async rows() {
    const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
    const schedules = await prisma.adSchedule.findMany({ select: { id: true, name: true, enabled: true, campaignId: true, windows: true, defaultTargetKey: true, lastApplied: true, lastEvaluatedAt: true }, orderBy: { name: 'asc' } })
    return schedules.filter((s) => !isGoalMode(s.windows, s.defaultTargetKey))
      .map((s) => ({ id: s.id, name: s.name, level: on(s.enabled), campaignId: s.campaignId, lastApplied: s.lastApplied, lastEvaluatedAt: iso(s.lastEvaluatedAt) }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'dayparting', 'No classic dayparting schedules (goal-mode schedules belong to rank-defend).'), 'dayparting')
  },
  explain(opts: ExplainOptions) {
    return perRowExplain(this, opts, (row) => `automation:dayparting-${row.id}`)
  },
  levelSwitch: onOffSwitch({
    entityType: 'SCHEDULE',
    // AA-W2-11 — on or off, with no dry run: its record is what it wrote while it was on.
    gateEvidence: (row) => writesGate(prisma.adSchedule.findUnique({ where: { id: row.id }, select: { createdAt: true } }), `automation:dayparting-${row.id}`, 'the windows it applied while it was on (its writes as automation:dayparting-<id>): it has no level that only watches'),
    // 2a — read from the release preview: switching it off gives back what it floored; the campaign keeps its status
    // (the old resume that re-enabled a paused campaign is gone, review 3.3).
    brake: async (rowId) => (await import('./rank-release.service.js')).scheduleSwitchBrake(rowId),
    async read(rowId) {
      const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
      const s = await prisma.adSchedule.findUnique({ where: { id: rowId } })
      return s && !isGoalMode(s.windows, s.defaultTargetKey) ? { id: s.id, name: s.name, on: s.enabled, updatedAt: s.updatedAt } : null
    },
    async write(rowId, on) {
      const { patchAdSchedule } = await import('./ads-schedule.service.js')
      const out = await patchAdSchedule(rowId, { enabled: on })
      return out.ok ? null : 'not found'
    },
  }),
}

const A7: AutomationAdapter = {
  id: 'A7', key: 'ads-budget-schedules', name: 'Budget schedules',
  what: 'Sets a daily budget per time window.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'none',
  previewNote: 'It has no dry run.',
  crons: ['ad-budget-schedule'], schedule: '*/15 * * * *',
  env: () => amazonAds(),
  async rows() {
    const schedules = await prisma.budgetSchedule.findMany({ where: { kind: 'BUDGET' }, select: { id: true, name: true, enabled: true, type: true, campaigns: true, lastEvaluatedAt: true }, orderBy: { name: 'asc' } })
    return schedules.map((s) => ({ id: s.id, name: s.name, level: on(s.enabled), type: s.type, campaigns: Array.isArray(s.campaigns) ? s.campaigns.length : 0, lastEvaluatedAt: iso(s.lastEvaluatedAt) }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'budget-schedules', 'No budget schedules.'), 'budget-schedules')
  },
  explain(opts: ExplainOptions) {
    return perRowExplain(this, opts, (row) => `automation:budget-schedule-${row.id}`)
  },
  levelSwitch: onOffSwitch({
    entityType: 'BUDGET_SCHEDULE',
    // AA-W2-11 — on or off, with no dry run: its record is what it wrote while it was on.
    gateEvidence: (row) => writesGate(prisma.budgetSchedule.findUnique({ where: { id: row.id }, select: { createdAt: true } }), `automation:budget-schedule-${row.id}`, 'the budgets it set while it was on (its writes as automation:budget-schedule-<id>): it has no level that only watches'),
    brake: 'its windows may hold budgets down: switching it off gives each campaign it holds its base budget back',
    async read(rowId) {
      const s = await prisma.budgetSchedule.findFirst({ where: { id: rowId, kind: 'BUDGET' } })
      return s ? { id: s.id, name: s.name, on: s.enabled, updatedAt: s.updatedAt } : null
    },
    // R14 — through the route's own edit (ads-budget-schedule.service.ts): switched off, it gives back the budgets it
    // holds (W4), and says how many it could not.
    async write(rowId, on, actorUserId) {
      const { patchBudgetSchedule } = await import('./ads-budget-schedule.service.js')
      const out = await patchBudgetSchedule(rowId, { enabled: on }, `user:${actorUserId ?? 'anonymous'}`)
      if (!out) return 'not found'
      if ('conflict' in out) return out.conflict.error // 3c — switched back on, a campaign would be in two schedules
      if ('invalid' in out) return out.invalid.error // 4b — answers a windows edit only; a switch sends none
      if (!out.restore) return null
      const { restored, kept, refused } = out.restore
      return { note: `gave back the base budget of ${restored} campaign(s)${kept ? `; ${kept} kept a budget someone changed since` : ''}${refused ? `; ${refused} kept the schedule's budget because the restore was refused` : ''}` }
    },
  }),
}

const A8: AutomationAdapter = {
  id: 'A8', key: 'ads-budget-manager', name: 'Budget manager',
  what: 'Paces a monthly budget and suppresses over-spending campaigns (never pauses).',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch', preview: 'saved',
  previewNote: "This month's enforcement as it would run now, computed and not written.",
  crons: ['ad-budget-enforce'], schedule: process.env.NEXUS_BUDGET_ENFORCE_SCHEDULE ?? '*/30 * * * *',
  // The job applies only with exactly '1' (jobs/ad-budget-enforce.job.ts); otherwise it computes and never applies.
  env: () => amazonAds(flagOn('NEXUS_BUDGET_ENFORCE_APPLY', isOne('NEXUS_BUDGET_ENFORCE_APPLY'), 'OBSERVE',
    'NEXUS_BUDGET_ENFORCE_APPLY is not 1 — it computes and never applies.', 'Budget enforcement applies.')),
  async rows() {
    const month = new Date().toISOString().slice(0, 7)
    const plans = await prisma.adBudgetPlan.findMany({ where: { month }, select: { id: true, marketplace: true, tag: true, month: true, monthlyBudgetCents: true, autoPacing: true, stopOverSpend: true }, orderBy: { marketplace: 'asc' } })
    return plans.map((p) => ({ id: p.id, name: `${p.marketplace}${p.tag ? ` · ${p.tag}` : ''} ${p.month}`, level: on(p.autoPacing || p.stopOverSpend), autoPacing: p.autoPacing, stopOverSpend: p.stopOverSpend, monthlyBudgetCents: p.monthlyBudgetCents }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'budget-enforce', 'No budget plan for this month.'), 'budget-enforce')
  },
  explain: (opts: ExplainOptions) => engineExplain(['ad-budget-enforce'], ['automation:budget-manager-cron', 'automation:budget-manager'], opts),
  async runPreview(): Promise<PreviewOutcome> {
    const { computeBudgetEnforcement } = await import('./ads-budget-enforce.service.js')
    return { kind: 'saved', subject: null, result: await computeBudgetEnforcement() }
  },
  // R16 — the engine's per-business switch (a brake: switched down, nothing catches the next over-spend). Its budget plans
  // are set in Nexus (the Budget Manager), or by a Claude request a person approves (W4-7: set-monthly-ad-budget).
  engine: 'budget-enforce',
  noSwitch: 'its budget plans are set in Nexus (the Budget Manager) or with set-monthly-ad-budget — the engine itself switches with no rowId',
}

const A9: AutomationAdapter = {
  id: 'A9', key: 'ads-budget-pools', name: 'Budget pools',
  what: 'Moves daily budget between the campaigns of a pool.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'saved',
  previewNote: "A saved pool's next rebalance, computed and not written.",
  crons: ['budget-pool-rebalance'], schedule: process.env.NEXUS_BUDGET_POOL_REBALANCE_SCHEDULE ?? '*/15 * * * *',
  env: () => amazonAds(),
  async rows() {
    const pools = await prisma.budgetPool.findMany({ select: { id: true, name: true, enabled: true, dryRun: true, strategy: true, totalDailyBudgetCents: true, maxShiftPerRebalancePct: true, coolDownMinutes: true, lastRebalancedAt: true }, orderBy: { name: 'asc' } })
    return pools.map((p) => ({
      id: p.id, name: p.name, level: (!p.enabled ? 'OFF' : p.dryRun ? 'OBSERVE' : 'AUTO') as AutomationLevel,
      strategy: p.strategy, caps: { totalDailyBudgetCents: p.totalDailyBudgetCents, maxShiftPerRebalancePct: p.maxShiftPerRebalancePct, coolDownMinutes: p.coolDownMinutes },
      lastRebalancedAt: iso(p.lastRebalancedAt),
    }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'budget-pools', 'No budget pools.'), 'budget-pools')
  },
  async explain(opts: ExplainOptions) {
    const actors = ['automation:budget-pool-rebalance', 'user:cron-budget-pool']
    if (!opts.rowId) return engineExplain(this.crons, actors, opts, ['user:cron-budget-pool is the actor the pool cron wrote before R2.'])
    const pool = await prisma.budgetPool.findUnique({ where: { id: opts.rowId }, select: { id: true, name: true, enabled: true, dryRun: true } })
    if (!pool) return null
    const [rebalances, allocations] = await Promise.all([
      prisma.budgetPoolRebalance.findMany({ where: { budgetPoolId: pool.id, createdAt: { gte: opts.since } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, dryRun: true, appliedAt: true, triggeredBy: true } }),
      prisma.budgetPoolAllocation.findMany({ where: { budgetPoolId: pool.id }, select: { campaignId: true } }),
    ])
    const campaigns = allocations.map((a) => a.campaignId).filter((c): c is string => !!c)
    const writes = await adsWrites(actors, opts.since, { entityIds: campaigns })
    const applied = rebalances.filter((r) => r.appliedAt).length
    return {
      subject: { id: pool.id, name: pool.name, level: (!pool.enabled ? 'OFF' : pool.dryRun ? 'OBSERVE' : 'AUTO') as AutomationLevel },
      runs: { source: 'BudgetPoolRebalance', total: rebalances.length, byStatus: { applied, dryRun: rebalances.length - applied }, last: rebalances.slice(0, 10).map((r) => ({ at: r.createdAt.toISOString(), status: r.appliedAt ? 'applied' : 'dry run', summary: r.triggeredBy })) },
      writes, refusals: null,
      notes: ["The pool's writes are its rebalancer's writes on the pool's own campaigns."],
    }
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    if (!input.rowId) return { refused: 'Name the pool to preview (rowId).' }
    const pool = await prisma.budgetPool.findUnique({ where: { id: input.rowId }, select: { id: true, name: true } })
    if (!pool) return { refused: 'not found', notFound: true }
    const { computeRebalance } = await import('./budget-pool-rebalancer.service.js')
    return { kind: 'saved', subject: pool, result: await computeRebalance({ poolId: pool.id, triggeredBy: 'preview', ignoreCoolDown: true }), notes: ['Its next rebalance, ignoring the cool-down; nothing written.'] }
  },
  levelSwitch: {
    levels: ['OFF', 'OBSERVE', 'AUTO'], needsRow: true, manage: FEATURES.adsAutomationManage,
    async read(rowId) {
      const p = rowId ? await prisma.budgetPool.findUnique({ where: { id: rowId } }) : null
      return p ? { id: p.id, name: p.name, level: (!p.enabled ? 'OFF' : p.dryRun ? 'OBSERVE' : 'AUTO') as AutomationLevel, basis: p.updatedAt.toISOString(), brake: null } : null
    },
    // AA-W2-11 — its rebalances (an OBSERVE pool records them as dry runs); one that would move budget is a match.
    async gateEvidence(row: SwitchRow): Promise<GateEvidence> {
      const [pool, runs, moved] = await Promise.all([
        prisma.budgetPool.findUnique({ where: { id: row.id }, select: { createdAt: true } }),
        prisma.budgetPoolRebalance.count({ where: { budgetPoolId: row.id } }),
        prisma.budgetPoolRebalance.count({ where: { budgetPoolId: row.id, totalShiftCents: { gt: 0 } } }),
      ])
      return gateOfCounts({ createdAt: pool?.createdAt ?? new Date(), runs, matches: moved, runsAre: 'rebalances (dry runs included)', matchesAre: 'that would move budget', from: "the pool's rebalances (BudgetPoolRebalance)" })
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      await prisma.budgetPool.update({ where: { id: row.id }, data: { enabled: level !== 'OFF', dryRun: level !== 'AUTO' } })
      await auditSwitch(actorUserId, 'BUDGET_POOL', row.id, row.level, level, `${row.name} → ${level}`)
      return null
    },
  },
}

const A10: AutomationAdapter = {
  id: 'A10', key: 'ads-rank-defend', name: 'Hourly bid plans (schedules and product plans)',
  // 2e (Owner D1 = A) — an hour-of-day bid plan: it reads no rank or share signal and chases no goal.
  what: 'Sets each campaign to the values its hour-of-week plan holds: placement percentages, a Min-bid floor (bids floored, campaign stays live, bids restored after) and a base bid. Writes only when the hour\'s value changes; reads no rank or share signal.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'saved',
  previewNote: 'One run of every enabled schedule and plan (or one plan), as a dry run: decisions only, nothing written.',
  crons: ['ad-rank-defend'], schedule: process.env.NEXUS_RANK_DEFEND_SCHEDULE ?? '*/15 * * * *',
  // The job runs only with exactly '1' (jobs/ad-rank-defend.job.ts).
  env: () => amazonAds(flagOn('NEXUS_ENABLE_RANK_DEFEND', isOne('NEXUS_ENABLE_RANK_DEFEND'), 'OFF',
    'NEXUS_ENABLE_RANK_DEFEND is not 1 — the hourly bid plans do not run.', 'The hourly bid plans run.')),
  async rows() {
    // 7b — the same read as the coverage strip's campaign counts (ads-census.service.ts), so "33 of 47 switched on" and
    // "N of 220 campaigns under rank control" come from one place.
    const { rankCensus } = await import('./ads-census.service.js')
    const { schedules, plans } = await rankCensus()
    return [
      ...schedules.map((s) => ({ id: s.id, name: `Schedule ${s.name}`, level: on(s.enabled), kind: 'schedule', campaignId: s.campaignId, lastEvaluatedAt: iso(s.lastEvaluatedAt) })),
      ...plans.map((p) => ({
        id: p.id, name: `Plan ${p.marketplace} · product ${p.productId}`, level: on(p.on), kind: 'plan',
        manualOnly: p.manualOnly, pausedAt: iso(p.pausedAt), caps: { maxCampaigns: p.maxCampaigns, familyDailyBudgetCents: p.familyDailyBudgetCents, familyAcosCapPct: p.familyAcosCapPct }, lastEvaluatedAt: iso(p.lastEvaluatedAt),
      })),
    ]
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'rank-defend', 'No goal-mode schedules or product rank plans.', await (await import('./rank-release.service.js')).enabledOrphanScope()), 'rank-defend')
  },
  explain(opts: ExplainOptions) {
    return perRowExplain(this, opts, (row) => (row.kind === 'plan' ? `automation:rank-plan-${row.id}` : `automation:rank-defend-${row.id}`))
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    const { runRankDefendOnce } = await import('../../jobs/ad-rank-defend.job.js')
    if (input.rowId) {
      const plan = await prisma.productRankPlan.findUnique({ where: { id: input.rowId }, select: { id: true, marketplace: true, productId: true } })
      if (!plan) {
        const schedule = await prisma.adSchedule.findUnique({ where: { id: input.rowId }, select: { id: true } })
        return schedule ? { refused: 'A rank-defend schedule is previewed with all of them: omit rowId.' } : { refused: 'not found', notFound: true }
      }
      return { kind: 'saved', subject: { id: plan.id, name: `Plan ${plan.marketplace} · product ${plan.productId}` }, result: await runRankDefendOnce({ dryRun: true, onlyPlanId: plan.id }) }
    }
    return { kind: 'saved', subject: null, result: await runRankDefendOnce({ dryRun: true }), notes: ['One run of every enabled goal-mode schedule and product plan, as a dry run.'] }
  },
  // R16 — the engine's per-business switch. Its plans and goal schedules are switched in Nexus.
  engine: 'rank-defend',
  // W4-1 — ONE hourly bid plan (a rank-schedule group) switches with set-hourly-bid-plan op switch.
  noSwitch: 'one hourly bid plan is switched with set-hourly-bid-plan op switch (its planId: ad-hourly-plans; switching it off gives back the bids it floored, 2a); a product rank plan is switched in Nexus — the engine itself switches with no rowId',
}

const A11: AutomationAdapter = {
  id: 'A11', key: 'ads-top-of-search', name: 'Top-of-search defense',
  what: 'Nudges the top-of-search placement percentage toward a target impression share, allowlisted campaigns only.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch', preview: 'saved',
  previewNote: 'The placement changes it would make now, as a dry run.',
  crons: ['top-of-search-defense'], schedule: '*/30 * * * *',
  env: () => amazonAds(flagOn('NEXUS_ENABLE_TOS_DEFENSE_CRON', envEnabled('NEXUS_ENABLE_TOS_DEFENSE_CRON'), 'OFF',
    'NEXUS_ENABLE_TOS_DEFENSE_CRON is off — top-of-search defense does not run.', 'Top-of-search defense runs.')),
  async state() {
    const [dial, scope] = await Promise.all([adsDial(), allowlistScope()])
    const { cap, why } = dialCap(dial, 'tos-defense')
    return withEngineCaps({ level: cap, reason: why ?? 'Configured by env only; acts on allowlisted campaigns.', scope }, 'tos-defense')
  },
  explain: (opts: ExplainOptions) => engineExplain(['top-of-search-defense'], ['automation:tos-optimizer'], opts, ['A rule\'s defend_top_of_search action writes as that rule (it wrote as automation:tos-optimizer before the part 06 fix).']),
  async runPreview(): Promise<PreviewOutcome> {
    const { defendTopOfSearch } = await import('./ads-top-of-search.service.js')
    return {
      kind: 'saved', subject: null, result: await defendTopOfSearch({ dryRun: true, allowlistedOnly: true }),
      notes: ['The counts include campaigns not on the live-write allowlist, which a real run skips.'],
    }
  },
  // R16 — its per-business switch, under the env.
  engine: 'tos-defense',
}

const A12: AutomationAdapter = {
  id: 'A12', key: 'ads-coverage', name: 'Coverage engine',
  what: "A bid ladder holding each term of an enabled coverage set at its share, inside the set's caps.",
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'switch-tune', preview: 'saved',
  previewNote: "A saved coverage set's next run, with zero writes.",
  crons: ['ads-coverage-engine'], schedule: process.env.NEXUS_COVERAGE_ENGINE_SCHEDULE ?? '10 7 * * *',
  env: () => {
    const mode = (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase()
    return amazonAds(flagOn('NEXUS_COVERAGE_ENGINE_MODE', mode === 'auto', mode === 'off' ? 'OFF' : 'OBSERVE',
      mode === 'off' ? 'NEXUS_COVERAGE_ENGINE_MODE is off — the coverage engine does not run.' : 'NEXUS_COVERAGE_ENGINE_MODE is observe — it logs the bids it would set and writes none.',
      'NEXUS_COVERAGE_ENGINE_MODE is auto — it writes.'))
  },
  async rows() {
    const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, name: true, enabled: true, marketplace: true, portfolioId: true, dailySpendCapCents: true, acosCapPct: true }, orderBy: { name: 'asc' } })
    return sets.map((s) => ({ id: s.id, name: s.name, level: on(s.enabled), marketplace: s.marketplace, portfolioId: s.portfolioId, caps: { dailySpendCapCents: s.dailySpendCapCents, acosCapPct: s.acosCapPct == null ? null : Number(s.acosCapPct) } }))
  },
  async state() {
    const [rows, dial] = await Promise.all([this.rows!(), adsDial()])
    return withEngineCaps(underDial(rows, dial, 'coverage-engine', 'No coverage sets.'), 'coverage-engine')
  },
  async explain(opts: ExplainOptions) {
    const [facts, observed] = await Promise.all([
      engineExplain(['ads-coverage-engine'], ['automation:coverage-engine'], opts),
      prisma.advertisingActionLog.count({ where: { actionType: 'coverage_engine_observe', createdAt: { gte: opts.since } } }),
    ])
    return { ...facts, notes: [`In observe mode it records what it would do (${observed} records in ${opts.days} days, no actor) and writes nothing.`] }
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    if (!input.rowId) return { refused: 'Name the coverage set to preview (rowId).' }
    const set = await prisma.keywordCoverageSet.findUnique({ where: { id: input.rowId }, select: { id: true, name: true } })
    if (!set) return { refused: 'not found', notFound: true }
    const { runCoverageEngineOnce } = await import('./ads-coverage-engine.service.js')
    return { kind: 'saved', subject: set, result: await runCoverageEngineOnce({ previewSetId: set.id }) }
  },
  // R16 — the engine's per-business switch (no rowId); a coverage set's own switch takes its rowId.
  engine: 'coverage-engine',
  levelSwitch: onOffSwitch({
    entityType: 'COVERAGE_SET',
    // AA-W2-11 — what the engine recorded for the set's terms (a would-do in observe mode, a bid it set in auto); a run
    // that holds records nothing and is not counted.
    async gateEvidence(row) {
      const set = await prisma.keywordCoverageSet.findUnique({ where: { id: row.id }, select: { createdAt: true, portfolioId: true, terms: { select: { term: true } } } })
      const terms = set ? [...new Set(set.terms.map((t) => t.term))] : []
      const targets = terms.length
        ? await prisma.adTarget.findMany({ where: { isNegative: false, expressionValue: { in: terms, mode: 'insensitive' }, adGroup: { campaign: { portfolioId: set!.portfolioId } } }, select: { id: true } })
        : []
      const runs = targets.length
        ? await prisma.advertisingActionLog.count({ where: { entityType: 'AD_TARGET', entityId: { in: targets.map((t) => t.id) }, OR: [{ actionType: 'coverage_engine_observe' }, { userId: 'automation:coverage-engine' }] } })
        : 0
      return gateOfCounts({ createdAt: set?.createdAt ?? new Date(), runs, matches: runs, runsAre: 'bids it would set or set for its terms', matchesAre: 'of them', from: "the coverage engine's records for the set's terms (a would-do in observe mode, a bid in auto)" })
    },
    async read(rowId) {
      const s = await prisma.keywordCoverageSet.findUnique({ where: { id: rowId } })
      return s ? { id: s.id, name: s.name, on: s.enabled, updatedAt: s.updatedAt } : null
    },
    async write(rowId, on) {
      await prisma.keywordCoverageSet.update({ where: { id: rowId }, data: { enabled: on } })
      return null
    },
  }),
}

const A13: AutomationAdapter = {
  id: 'A13', key: 'ads-guardrails', name: 'Ads guardrails',
  what: 'Bid bounds and daily spend ceilings the write gate holds every Nexus ads write to (a spend ceiling caps a day\'s budget increases, not what Amazon spends), plus the live-write allowlist.',
  area: 'amazon-ads', writesTo: ['nexus'], view: FEATURES.adsView, claude: 'tune', preview: 'none',
  previewNote: 'Guardrails are brakes; the write gate applies them to every write.',
  crons: [], schedule: null,
  env: noEnv,
  async rows() {
    const [ceilings, policies] = await Promise.all([
      prisma.adSpendCeiling.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] }),
      prisma.adBidPolicy.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] }),
    ])
    return [
      ...ceilings.map((c) => ({ id: c.id, name: `Spend ceiling ${c.grain} ${c.label}`, level: on(c.enabled), kind: 'spend-ceiling', grain: c.grain, scopeId: c.scopeId, dailyCapCents: c.dailyCapCents })),
      ...policies.map((p) => ({ id: p.id, name: `Bid policy ${p.grain} ${p.label}`, level: on(p.enabled), kind: 'bid-policy', grain: p.grain, scopeId: p.scopeId, minBidCents: p.minBidCents, maxBidCents: p.maxBidCents })),
    ]
  },
  async state() {
    const [rows, managed, total, bounded] = await Promise.all([
      this.rows!(),
      prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
      prisma.campaign.count(),
      prisma.campaign.count({ where: { OR: [{ minBidCents: { not: null } }, { maxBidCents: { not: null } }] } }),
    ])
    const s = summarise(rows)
    const inForce = rows.filter((r) => r.level !== 'OFF').length
    return {
      level: null, reason: 'Brakes: they never act, they bind.',
      state: `${inForce} of ${rows.length} ceilings and bid policies in force; ${bounded} campaigns carry their own bid bounds; ${managed} of ${total} campaigns allowlisted for live writes.`,
      rows: s.rows, sample: s.sample,
    }
  },
  noSwitch: 'guardrails are set, not switched (set-ad-guardrail)',
}

const A14: AutomationAdapter = {
  id: 'A14', key: 'ads-harvest-policy', name: 'Harvest policy and destinations',
  what: 'The thresholds and target ad group harvest rules use to graduate a search term.',
  area: 'amazon-ads', writesTo: ['nexus'], view: FEATURES.adsView, claude: 'tune', preview: 'none',
  previewNote: 'Settings read by harvest rules; preview the rules instead.',
  crons: [], schedule: null,
  env: noEnv,
  async rows() {
    const [policies, destinations] = await Promise.all([
      prisma.adsHarvestPolicy.findMany({ orderBy: [{ scopeGrain: 'asc' }, { scopeId: 'asc' }] }),
      prisma.adsHarvestDestination.findMany({ orderBy: [{ scopeGrain: 'asc' }, { scopeId: 'asc' }] }),
    ])
    return [
      ...policies.map((p) => ({ id: p.id, name: `Policy ${p.kind} ${p.scopeGrain} ${p.scopeId}`, level: 'AUTO' as const, kind: 'policy', minOrders: p.minOrders, minClicks: p.minClicks, maxAcosPct: p.maxAcosPct, windowDays: p.windowDays })),
      ...destinations.map((d) => ({ id: d.id, name: `Destination ${d.scopeGrain} ${d.scopeId} ${d.matchType}`, level: 'AUTO' as const, kind: 'destination', adGroupId: d.adGroupId, negateAtSource: d.negateAtSource })),
    ]
  },
  async state() {
    const rows = await this.rows!()
    const policies = rows.filter((r) => r.kind === 'policy').length
    return { level: null, reason: 'Settings: they never act on their own.', state: `${policies} policies and ${rows.length - policies} destinations set; the code's defaults apply elsewhere.`, rows: { total: rows.length, byLevel: {} } }
  },
  noSwitch: 'harvest policy is tuned, not switched (tune-ad-engine)',
}

const A15: AutomationAdapter = {
  id: 'A15', key: 'ads-protected-terms', name: 'Protected terms',
  what: 'Terms no rule may negate.',
  area: 'amazon-ads', writesTo: ['nexus'], view: FEATURES.adsView, claude: 'tune', preview: 'none',
  previewNote: 'Settings enforced at the write gate.',
  crons: [], schedule: null,
  env: noEnv,
  async rows() {
    // Ads fix 5c — WHITELIST only: "always negate" (BLACKLIST) was removed and no engine ever read it.
    const terms = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, orderBy: { term: 'asc' }, take: 500 })
    return terms.map((t) => ({ id: t.id, name: t.term, level: 'AUTO' as const, mode: t.mode, matchType: t.matchType, isPrefix: t.isPrefix, marketplace: t.marketplace, campaignId: t.campaignId }))
  },
  async state() {
    const white = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
    return { level: null, reason: 'Settings: they never act on their own.', state: `${white} protected terms.`, rows: { total: white, byLevel: {} } }
  },
  noSwitch: 'protected terms are set, not switched (set-ad-guardrail)',
}

const A16: AutomationAdapter = {
  id: 'A16', key: 'ads-ai-goals', name: 'AI goals',
  what: 'Turns a product goal into campaigns and rules (rules start disabled, as dry runs).',
  area: 'amazon-ads', writesTo: ['nexus'], view: FEATURES.adsView, claude: 'see', preview: 'none',
  // B-2 — Claude asks for a goal and its campaigns with create-ai-goal-campaigns (a person approves it).
  previewNote: 'Claude reads goals here; it asks for a new one with create-ai-goal-campaigns, which a person approves.',
  crons: [], schedule: null,
  env: noEnv,
  async rows() {
    const goals = await prisma.adProductGoal.findMany({ select: { id: true, name: true, status: true, marketplace: true, materializedAt: true, campaignIds: true }, orderBy: { name: 'asc' } })
    return goals.map((g) => ({ id: g.id, name: g.name, level: (g.status === 'ACTIVE' ? 'AUTO' : 'OFF') as AutomationLevel, status: g.status, marketplace: g.marketplace, materializedAt: iso(g.materializedAt), campaigns: Array.isArray(g.campaignIds) ? g.campaignIds.length : 0 }))
  },
  async state() {
    const rows = await this.rows!()
    const active = rows.filter((r) => r.status === 'ACTIVE').length
    return { level: null, reason: 'A person materialises a goal; nothing runs on a clock.', state: `${rows.length} goals, ${active} active.`, rows: { total: rows.length, byLevel: {} } }
  },
  noSwitch: 'AI goals are materialised in Nexus, by a person or by a Claude request a person approves',
}

const A17: AutomationAdapter = {
  id: 'A17', key: 'ads-report-schedules', name: 'Ads report schedules',
  what: 'E-mails saved ads reports on a schedule.',
  area: 'amazon-ads', writesTo: ['email'], view: FEATURES.adsView, claude: 'see', preview: 'none',
  previewNote: 'A run sends (or records a dry run) and writes a delivery row: no clean preview.',
  crons: ['ads-report-schedule'], schedule: '5 * * * *',
  env: () => envVerdict([
    flagOn('NEXUS_ENABLE_DASHBOARD_DIGEST_CRON', isOne('NEXUS_ENABLE_DASHBOARD_DIGEST_CRON'), 'OFF', 'NEXUS_ENABLE_DASHBOARD_DIGEST_CRON is not 1 — the report crons are not started.', 'The digest crons are started.'),
    flagOn('NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON', isOne('NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON'), 'OFF', 'NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON is not 1 — scheduled reports do not run.', 'Scheduled reports run.'),
    outboundEmails(),
  ]),
  async rows() {
    const schedules = await prisma.reportSchedule.findMany({ select: { id: true, frequency: true, format: true, isActive: true, lastSentAt: true, lastStatus: true }, orderBy: { createdAt: 'asc' } })
    return schedules.map((s) => ({ id: s.id, name: `${s.frequency} ${s.format} report`, level: on(s.isActive), lastSentAt: iso(s.lastSentAt), lastStatus: s.lastStatus }))
  },
  async state() { return fromRows(await this.rows!(), 'No report schedules.') },
  noSwitch: 'report schedules are switched in Nexus',
}

const A18: AutomationAdapter = {
  id: 'A18', key: 'ads-bidding-engine', name: 'External bidding engine',
  what: 'A separate service that sets bids from contexts it pulls — outside every Nexus brake when its dry run is off.',
  area: 'amazon-ads', writesTo: ['amazon'], view: FEATURES.adsView, claude: 'see', preview: 'none',
  previewNote: 'It runs outside Nexus; Claude reads its log only.',
  crons: [], schedule: null,
  env: noEnv,
  async state() {
    const last = await prisma.advertisingActionLog.findFirst({ where: { actionType: 'bid_set_by_engine' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, amazonResponseStatus: true } })
    return {
      level: null,
      reason: 'A separate service: its switch (BIDDING_DRY_RUN) is set on that service and Nexus cannot read it.',
      state: last ? `Its last reported bid: ${last.createdAt.toISOString()} (${last.amazonResponseStatus ?? 'no status'}).` : 'It has never reported a bid here.',
      lastRun: last ? { at: last.createdAt.toISOString(), status: last.amazonResponseStatus, summary: 'bid_set_by_engine' } : null,
    }
  },
  async explain(opts: ExplainOptions) {
    const writes = await adsWrites([], opts.since, { actionType: 'bid_set_by_engine' })
    return { subject: null, runs: null, writes, refusals: null, notes: ['It records its bids with no actor; matched by its action type. A dry-run report is recorded too (status PENDING).'] }
  },
  noSwitch: 'the external bidding engine runs outside Nexus',
}

/** A1–A18, in the inventory's order. */
export const ADS_AUTOMATION_ADAPTERS: readonly AutomationAdapter[] = [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18]
