/**
 * R5 (MCP full control, part 06 §1) — one adapter per automation kind, all 39 (the Amazon ads ones live in the
 * advertising context, services/advertising/ads-automation-adapters.ts, and eBay's in services/marketing/, because they
 * read that context's own tables): what it is, what the server lets it do
 * (env), what this business set (its rows), its scope, schedule and caps.
 *
 * Read-only by construction: every query here is a find, count or groupBy in the caller's business (row-level
 * security scopes it). Where a service's own "read" creates a missing row (the ads dial's `getAutomationState`, the
 * review mailer's `readReviewMailerState`), the adapter reads the row directly instead, so listing automations never
 * writes. Env is read, never written, and no env VALUE is ever returned — only whether a flag lets it act.
 *
 * The env checks mirror the code that actually runs, not a summary of it: where the Control Room reads a flag with
 * `envEnabled` but the job checks `=== '1'` (budget enforcement, rank-defend), the job's check is used, because that is
 * what decides whether anything happens.
 */
import { FEATURES } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { ADS_AUTOMATION_ADAPTERS, adsCron } from '../advertising/ads-automation-adapters.js'
import { E1 } from '../marketing/ebay-automation-adapters.js'
import {
  aiKill, envVerdict, flagOn, fromRows, isOne, isTrue, iso, noEnv, notZero, on, outboundEmails, ruleDetail, ruleExplain, rulesOf,
  previewSavedRule, ruleLevelSwitch,
  type AutomationAdapter, type AutomationLevel, type ExplainFacts, type ExplainOptions, type PreviewInput, type PreviewOutcome, type SwitchRow, type WritesFact,
} from './automation-levels.js'


// ── R7 — writes of the non-ads automations, by their exact actor strings ─────────────────────────────

function writesFact(source: string, actors: string[], rows: Array<{ at: Date; action: string; entityType: string; entityId: string; status?: string | null }>, total: number, byAction: Record<string, number>, lastEver: Date | null): WritesFact {
  return {
    source, actors, total, byAction,
    lastAt: rows[0] ? rows[0].at.toISOString() : null,
    everWritten: lastEver != null, lastEverAt: iso(lastEver),
    last: rows.slice(0, 10).map((r) => ({ at: r.at.toISOString(), action: r.action, entityType: r.entityType, entityId: r.entityId, status: r.status ?? null })),
  }
}

/** Marketing campaign changes (CampaignAction) by exact actor. */
async function campaignActionWrites(actors: string[], since: Date): Promise<WritesFact> {
  const [grouped, last, ever] = await Promise.all([
    prisma.campaignAction.groupBy({ by: ['actionType'], where: { userId: { in: actors }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.campaignAction.findMany({ where: { userId: { in: actors }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, actionType: true, entityType: true, entityId: true, channelResponseStatus: true } }),
    prisma.campaignAction.findFirst({ where: { userId: { in: actors } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  return writesFact('CampaignAction', actors, last.map((r) => ({ at: r.createdAt, action: r.actionType, entityType: r.entityType, entityId: r.entityId, status: r.channelResponseStatus })),
    grouped.reduce((n, g) => n + g._count._all, 0), Object.fromEntries(grouped.map((g) => [g.actionType, g._count._all])), ever?.createdAt ?? null)
}

/** Restock recommendations a replenishment rule approved (actedByUserId = automation:<ruleId>). */
async function recommendationWrites(actors: string[], since: Date): Promise<WritesFact> {
  const [count, last, ever] = await Promise.all([
    prisma.replenishmentRecommendation.count({ where: { actedByUserId: { in: actors }, actedAt: { gte: since } } }),
    prisma.replenishmentRecommendation.findMany({ where: { actedByUserId: { in: actors }, actedAt: { gte: since } }, orderBy: { actedAt: 'desc' }, take: 10, select: { id: true, actedAt: true, sku: true } }),
    prisma.replenishmentRecommendation.findFirst({ where: { actedByUserId: { in: actors } }, orderBy: { actedAt: 'desc' }, select: { actedAt: true } }),
  ])
  return writesFact('ReplenishmentRecommendation (acted)', actors, last.map((r) => ({ at: r.actedAt ?? new Date(0), action: 'approve_recommendation', entityType: 'RECOMMENDATION', entityId: r.id })),
    count, { approve_recommendation: count }, ever?.actedAt ?? null)
}

/** Bulk jobs a bulk-operation rule started (createdBy = automation:<ruleId>). */
async function bulkJobWrites(actors: string[], since: Date): Promise<WritesFact> {
  const [grouped, last, ever] = await Promise.all([
    prisma.bulkActionJob.groupBy({ by: ['status'], where: { createdBy: { in: actors }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.bulkActionJob.findMany({ where: { createdBy: { in: actors }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, createdAt: true, status: true } }),
    prisma.bulkActionJob.findFirst({ where: { createdBy: { in: actors } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])
  return writesFact('BulkActionJob', actors, last.map((r) => ({ at: r.createdAt, action: 'bulk_job', entityType: 'BULK_JOB', entityId: r.id, status: r.status })),
    grouped.reduce((n, g) => n + g._count._all, 0), { bulk_job: grouped.reduce((n, g) => n + g._count._all, 0) }, ever?.createdAt ?? null)
}

/** Agent runs (AgentRun) of these agent keys. */
async function agentRunsExplain(keys: string[], opts: ExplainOptions, subject: ExplainFacts['subject']): Promise<ExplainFacts> {
  const where = { agentKey: { in: keys }, createdAt: { gte: opts.since } }
  const [grouped, last] = await Promise.all([
    prisma.agentRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.agentRun.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, status: true, agentKey: true, findingCount: true, errorMessage: true } }),
  ])
  return {
    subject,
    runs: {
      source: 'AgentRun', total: grouped.reduce((n, g) => n + g._count._all, 0), byStatus: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      last: last.map((r) => ({ at: r.createdAt.toISOString(), status: r.status, summary: r.errorMessage ? r.errorMessage.slice(0, 200) : `${r.agentKey}: ${r.findingCount} findings` })),
    },
    writes: null, refusals: null,
    notes: ['What an agent asks for waits in Approvals; approval-status follows one up.'],
  }
}

const exactActors = (ids: string[]) => ids.map((id) => `automation:${id}`)

// ── E — marketing rules (eBay's adapter: services/marketing/ebay-automation-adapters.ts) ──────────────────

const E2: AutomationAdapter = {
  id: 'E2', key: 'marketing-rules', name: 'Marketing campaign rules',
  what: 'ACOS breach and under-pacing rules on unified marketing campaigns.',
  area: 'marketing', writesTo: ['channels'], view: FEATURES.marketingView, claude: 'full', preview: 'saved',
  previewNote: "A saved rule against the campaigns its trigger would hand it now (or a context you give); no run row, no counter.",
  crons: ['marketing-rule-evaluator'], schedule: '*/15 * * * *',
  // Started only inside the Amazon ads cron block (runtime/scheduler.ts).
  env: () => envVerdict([adsCron()]),
  rows: () => rulesOf('marketing'),
  get: (rowId: string) => ruleDetail('marketing', rowId),
  async state() { return fromRows(await this.rows!(), 'No marketing rules.') },
  explain: (opts: ExplainOptions) => ruleExplain('marketing', opts, (ids) => campaignActionWrites(exactActors(ids), opts.since)),
  runPreview: (input: PreviewInput) => previewSavedRule('marketing', input, async (rule) => {
    const { marketingContextsFor } = await import('../../jobs/marketing-rule-evaluator.job.js')
    // As the tick: only contexts inside the rule's market scope.
    return (await marketingContextsFor(rule.trigger)).filter((c) => !rule.scopeMarketplace || c.marketplace === rule.scopeMarketplace)
  }, () => import('../marketing/marketing-action-handlers.js')),
  levelSwitch: ruleLevelSwitch('marketing', FEATURES.marketingAutomationManage, (actions) =>
    (Array.isArray(actions) ? actions : []).some((a) => String((a as { type?: unknown })?.type) === 'mkt_adjust_budget' && Number((a as { deltaPct?: unknown }).deltaPct) < 0)
      ? 'it lowers budgets: turning it down can raise spend' : null),
}

// ── F — the agent fleet and the autonomous agents ─────────────────────────────────────────────────────

const F1: AutomationAdapter = {
  id: 'F1', key: 'agent-fleet', name: 'Agent fleet',
  what: 'Analysts find, a director plans, a critic checks; the council queues ad changes for a person.',
  area: 'agents', writesTo: ['nexus', 'ai-spend'], view: FEATURES.aiView, claude: 'steer', preview: 'none',
  previewNote: "A charter's preview calls the model (AI spend) and records a run: not offered.",
  crons: ['fleet-sweep', 'fleet-council'], schedule: process.env.NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *',
  env: () => envVerdict([
    flagOn('NEXUS_ENABLE_FLEET_SWEEP_CRON', isOne('NEXUS_ENABLE_FLEET_SWEEP_CRON'), 'OFF', 'NEXUS_ENABLE_FLEET_SWEEP_CRON is not 1 — the fleet does not run.', 'The fleet sweep runs.'),
    aiKill(),
  ]),
  async rows() {
    const { listCharters } = await import('../agent-fleet/charter-registry.js')
    const charters = await listCharters()
    return charters.map((c) => ({ id: c.key, name: c.name, level: (c.enabled ? c.autonomyLevel : 'OFF') as AutomationLevel, cap: c.autonomyCap, tier: c.tier, pausedUntil: iso(c.pausedUntil ?? null), degraded: c.degraded }))
  },
  async state() {
    const [rows, fleet] = await Promise.all([this.rows!(), prisma.agentFleetState.findFirst()])
    const base = fromRows(rows, 'No charters.')
    if (fleet?.halted) return { ...base, level: 'OFF', reason: `The fleet is halted${fleet.haltReason ? `: ${fleet.haltReason}` : ''}.` }
    return base
  },
  // R15 — one worker as steer-fleet steers it: its level and cap, its pause, its scope and AI budget, and what it did
  // (last runs, open findings, plans, assignments). Its prompt is not shown: Claude never edits it (D R-3).
  async get(rowId: string) {
    const { listCharters } = await import('../agent-fleet/charter-registry.js')
    const c = (await listCharters()).find((x) => x.key === rowId)
    if (!c) return null
    const [runs, findings, openFindings, plans, assignments] = await Promise.all([
      prisma.agentRun.findMany({ where: { agentKey: c.key }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, createdAt: true, trigger: true, status: true, findingCount: true, errorMessage: true } }),
      prisma.agentFinding.findMany({ where: { charterKey: c.key, status: 'open' }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, kind: true, severity: true, entityType: true, entityName: true, proposedTool: true, createdAt: true } }),
      prisma.agentFinding.count({ where: { charterKey: c.key, status: 'open' } }),
      prisma.agentPlan.findMany({ where: { charterKey: c.key }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, headline: true, status: true, criticVerdict: true, createdAt: true } }),
      prisma.agentAssignment.findMany({ where: { charterKey: c.key, state: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, title: true, state: true, targetKind: true, targetLabels: true, dueAt: true } }),
    ])
    return {
      id: c.key, name: c.name, tier: c.tier, domain: c.domain, what: c.description ?? null,
      level: (c.enabled ? c.autonomyLevel : 'OFF') as AutomationLevel, cap: c.autonomyCap, enabled: c.enabled,
      pausedUntil: iso(c.pausedUntil ?? null), pausedReason: c.pausedReason ?? null, degraded: c.degraded, provisioned: c.provisioned,
      scope: { marketplaces: c.scopeMarketplaces, portfolioIds: c.scopePortfolioIds, campaignIds: c.scopeCampaignIds },
      aiBudget: { dailyBudgetUSD: c.dailyBudgetUSD, maxTokensPerRun: c.maxTokensPerRun, maxFindingsPerRun: c.maxFindingsPerRun },
      runs: runs.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), trigger: r.trigger, status: r.status, findings: r.findingCount, error: r.errorMessage ? r.errorMessage.slice(0, 200) : null })),
      openFindings: { total: openFindings, latest: findings.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })) },
      plans: plans.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      assignments: assignments.map((a) => ({ ...a, dueAt: iso(a.dueAt) })),
      steer: 'steer-fleet: run-now, pause, resume, set-level (up to the cap), assign, cancel-assignment',
    }
  },
  async explain(opts: ExplainOptions) {
    const rows = await this.rows!()
    const chosen = opts.rowId ? rows.filter((r) => r.id === opts.rowId) : rows
    if (opts.rowId && !chosen.length) return null
    const row = opts.rowId ? chosen[0] : null
    return agentRunsExplain(chosen.map((r) => r.id), opts, row ? { id: row.id, name: row.name, level: row.level } : null)
  },
  // R16 — the nightly sweep's per-business switch (no rowId). Each worker is steered with steer-fleet.
  engine: 'fleet-analysts',
  noSwitch: 'each worker is steered with steer-fleet (run-now, pause, resume, levels up to the cap of each charter, assignments) — the sweep itself switches with no rowId',
}

const F2_AGENTS = [
  { key: 'pricing-watchdog', flag: 'NEXUS_ENABLE_PRICING_WATCHDOG', name: 'Pricing watchdog (queues set-price for a person)' },
  { key: 'listing-quality-keeper', flag: 'NEXUS_ENABLE_LISTING_QUALITY_KEEPER', name: 'Listing quality keeper (queues apply-content for a person)' },
] as const

const F2: AutomationAdapter = {
  id: 'F2', key: 'autonomous-agents', name: 'Autonomous agents',
  what: 'The pricing watchdog and the listing-quality keeper: up to 5 changes per run, each queued for approval.',
  area: 'agents', writesTo: ['nexus', 'ai-spend'], view: FEATURES.aiView, claude: 'switch', preview: 'none',
  previewNote: 'Their only run is a real one (it may queue approvals).',
  crons: ['pricing-watchdog', 'listing-quality-keeper'], schedule: 'daily 07:00 / 06:45',
  env: () => envVerdict([aiKill()]),
  async rows() {
    const defs = await prisma.agentDefinition.findMany({ where: { key: { in: F2_AGENTS.map((a) => a.key) } }, select: { key: true, enabled: true } })
    const enabled = new Map(defs.map((d) => [d.key, d.enabled]))
    return F2_AGENTS.map((a) => {
      const envOn = notZero(a.flag)
      return { id: a.key, name: a.name, level: (enabled.get(a.key) && envOn ? 'PROPOSE' : 'OFF') as AutomationLevel, enabled: enabled.get(a.key) ?? false, env: { flag: a.flag, allows: envOn } }
    })
  },
  async state() { return fromRows(await this.rows!(), 'No autonomous agents.') },
  async explain(opts: ExplainOptions) {
    const rows = await this.rows!()
    const chosen = opts.rowId ? rows.filter((r) => r.id === opts.rowId) : rows
    if (opts.rowId && !chosen.length) return null
    const row = opts.rowId ? chosen[0] : null
    return agentRunsExplain(chosen.map((r) => r.id), opts, row ? { id: row.id, name: row.name, level: row.level } : null)
  },
  levelSwitch: {
    levels: ['OFF', 'PROPOSE'], needsRow: true, manage: FEATURES.aiRun,
    async read(rowId) {
      const agent = F2_AGENTS.find((a) => a.key === rowId)
      if (!agent) return null
      const def = await prisma.agentDefinition.findFirst({ where: { key: agent.key }, select: { enabled: true, updatedAt: true } })
      return { id: agent.key, name: agent.name, level: def?.enabled ? 'PROPOSE' : 'OFF', basis: def?.updatedAt.toISOString() ?? null, brake: null }
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      const { setAgentEnabled } = await import('../agents/autonomous-agent.service.js')
      const out = await setAgentEnabled(row.id, level !== 'OFF')
      if (!out.ok) return out.error ?? 'not switched'
      const { auditLogService } = await import('../audit-log.service.js')
      await auditLogService.write({ userId: actorUserId, entityType: 'AgentDefinition', entityId: row.id, action: 'set_level', before: { level: row.level }, after: { level } })
      return null
    },
  },
}

// ── N — pricing, products, listings, stock, reviews, bulk, alerts ─────────────────────────────────────

const N1: AutomationAdapter = {
  id: 'N1', key: 'repricing-rules', name: 'Repricing rules',
  what: 'Beats a competitor price inside a min/max, on a listing.',
  area: 'pricing', writesTo: ['channels'], view: FEATURES.repricingView, claude: 'full', preview: 'saved',
  previewNote: 'The price a saved rule would pick now; no decision row, never applied.',
  crons: ['repricing-evaluator'], schedule: process.env.NEXUS_REPRICING_EVALUATOR_SCHEDULE ?? '*/5 * * * *',
  env: () => envVerdict([
    flagOn('NEXUS_ENABLE_REPRICING_EVALUATOR', notZero('NEXUS_ENABLE_REPRICING_EVALUATOR'), 'OFF', 'NEXUS_ENABLE_REPRICING_EVALUATOR is 0 — the repricer does not run.', 'The repricer evaluates every rule.'),
    flagOn('NEXUS_REPRICER_LIVE', isOne('NEXUS_REPRICER_LIVE'), 'OBSERVE', 'NEXUS_REPRICER_LIVE is not 1 — it records decisions and writes no price.', 'The repricer writes prices.'),
  ]),
  async rows() {
    const rules = await prisma.repricingRule.findMany({ select: { id: true, enabled: true, strategy: true, channel: true, marketplace: true, minPrice: true, maxPrice: true, lastEvaluatedAt: true, lastDecisionReason: true, product: { select: { sku: true } } }, orderBy: { createdAt: 'asc' } })
    return rules.map((r) => ({
      id: r.id, name: `${r.product.sku} on ${r.channel}${r.marketplace ? ` ${r.marketplace}` : ''} (${r.strategy})`, level: on(r.enabled),
      priceBounds: { min: Number(r.minPrice), max: Number(r.maxPrice) }, lastEvaluatedAt: iso(r.lastEvaluatedAt), lastDecisionReason: r.lastDecisionReason,
    }))
  },
  async state() { return fromRows(await this.rows!(), 'No repricing rules.') },
  async explain(opts: ExplainOptions) {
    const rows = await this.rows!()
    const chosen = opts.rowId ? rows.filter((r) => r.id === opts.rowId) : rows
    if (opts.rowId && !chosen.length) return null
    const ids = chosen.map((r) => r.id)
    const where = { ruleId: { in: ids }, createdAt: { gte: opts.since } }
    const [grouped, last, everApplied] = await Promise.all([
      prisma.repricingDecision.groupBy({ by: ['applied'], where, _count: { _all: true } }),
      prisma.repricingDecision.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, applied: true, reason: true, capped: true, ruleId: true } }),
      prisma.repricingDecision.findFirst({ where: { ruleId: { in: ids }, applied: true }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    const total = grouped.reduce((n, g) => n + g._count._all, 0)
    const applied = grouped.find((g) => g.applied)?._count._all ?? 0
    const lastApplied = last.filter((d) => d.applied)
    const row = opts.rowId ? chosen[0] : null
    return {
      subject: row ? { id: row.id, name: row.name, level: row.level } : null,
      runs: { source: 'RepricingDecision', total, byStatus: { applied, notApplied: total - applied }, last: last.map((d) => ({ at: d.createdAt.toISOString(), status: d.applied ? 'applied' : 'not applied', summary: `${d.reason}${d.capped ? ` (held at its ${d.capped})` : ''}`.slice(0, 200) })) },
      writes: {
        source: 'RepricingDecision (applied: a price written)', actors: ids.map((id) => `repricer:${id}`), total: applied, byAction: { set_price: applied },
        lastAt: lastApplied[0] ? lastApplied[0].createdAt.toISOString() : null, everWritten: everApplied != null, lastEverAt: iso(everApplied?.createdAt ?? null),
        last: lastApplied.map((d) => ({ at: d.createdAt.toISOString(), action: 'set_price', entityType: 'REPRICING_RULE', entityId: d.ruleId })),
      },
      refusals: null,
    }
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    if (!input.rowId) return { refused: 'Name the repricing rule to preview (rowId).' }
    const rule = await prisma.repricingRule.findUnique({ where: { id: input.rowId }, include: { product: { select: { sku: true } } } })
    if (!rule) return { refused: 'not found', notFound: true }
    const { repricingMarketFor, repricingWindows } = await import('../../jobs/repricing-evaluator.job.js')
    const { pickPrice } = await import('../repricing-engine.service.js')
    const subject = { id: rule.id, name: `${rule.product.sku} on ${rule.channel}${rule.marketplace ? ` ${rule.marketplace}` : ''} (${rule.strategy})` }
    const found = await repricingMarketFor(rule, repricingWindows())
    if (!found) return { kind: 'saved', subject, result: { listing: null, says: "No listing matches this rule's channel and market: it would do nothing." } }
    const decision = pickPrice({
      strategy: rule.strategy as never, minPrice: Number(rule.minPrice), maxPrice: Number(rule.maxPrice),
      beatPct: rule.beatPct == null ? null : Number(rule.beatPct), beatAmount: rule.beatAmount == null ? null : Number(rule.beatAmount),
      activeFromHour: rule.activeFromHour, activeToHour: rule.activeToHour, activeDays: rule.activeDays,
    }, found.market)
    return {
      kind: 'saved', subject,
      result: { listingId: found.listingId, market: found.market, recentObservation: found.observed, decision, enabled: rule.enabled },
      notes: ['The price its own rule would pick now; no decision row is written and nothing is applied.'],
    }
  },
  levelSwitch: {
    levels: ['OFF', 'AUTO'], needsRow: true, manage: FEATURES.repricingRulesManage,
    async read(rowId) {
      const r = rowId ? await prisma.repricingRule.findUnique({ where: { id: rowId }, include: { product: { select: { sku: true } } } }) : null
      return r ? { id: r.id, name: `${r.product.sku} on ${r.channel}${r.marketplace ? ` ${r.marketplace}` : ''} (${r.strategy})`, level: (r.enabled ? 'AUTO' : 'OFF') as AutomationLevel, basis: r.updatedAt.toISOString(), brake: null } : null
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      await prisma.repricingRule.update({ where: { id: row.id }, data: { enabled: level !== 'OFF' } })
      const { auditLogService } = await import('../audit-log.service.js')
      await auditLogService.write({ userId: actorUserId, entityType: 'RepricingRule', entityId: row.id, action: 'set_level', before: { enabled: row.level !== 'OFF' }, after: { enabled: level !== 'OFF' } })
      return null
    },
  },
}

const repricerCronAllowed = () => !['off', '0', 'false'].includes((process.env.NEXUS_REPRICER_CRON ?? '').toLowerCase())

const N2: AutomationAdapter = {
  id: 'N2', key: 'pricing-rules', name: 'Snapshot repricer and pricing rules',
  what: 'Pushes computed prices that drifted from what a channel shows.',
  area: 'pricing', writesTo: ['channels'], view: FEATURES.pricingView, claude: 'switch', preview: 'none',
  previewNote: 'The repricer tick has no mode that writes nothing (a dry run still records its run).',
  crons: ['repricer'], schedule: '*/30 * * * *',
  env: () => envVerdict([
    flagOn('NEXUS_ENABLE_PRICING_CRON', isOne('NEXUS_ENABLE_PRICING_CRON'), 'OFF', 'NEXUS_ENABLE_PRICING_CRON is not 1 — the pricing crons are not started.', 'The pricing crons run.'),
    flagOn('NEXUS_REPRICER_CRON', repricerCronAllowed(), 'OFF', 'NEXUS_REPRICER_CRON is off — the snapshot repricer does not run.', 'The snapshot repricer is not switched off.'),
    flagOn('NEXUS_REPRICER_LIVE', isOne('NEXUS_REPRICER_LIVE'), 'OBSERVE', 'NEXUS_REPRICER_LIVE is not 1 — it records what it would push and pushes nothing.', 'The repricer writes prices.'),
  ]),
  async rows() {
    const rules = await prisma.pricingRule.findMany({ select: { id: true, name: true, type: true, isActive: true, priority: true }, orderBy: [{ priority: 'asc' }, { name: 'asc' }] })
    return rules.map((r) => ({ id: r.id, name: r.name, level: on(r.isActive), type: r.type, priority: r.priority }))
  },
  async state() { return fromRows(await this.rows!(), 'No pricing rules.') },
  // R16 — the snapshot repricer's per-business switch, under the env.
  engine: 'repricer',
  noSwitch: 'pricing rules are switched in Nexus — the snapshot repricer itself switches with no rowId',
}

const N3: AutomationAdapter = {
  id: 'N3', key: 'promotion-scheduler', name: 'Promotion scheduler',
  what: 'Sets sale prices on retail event dates and takes them off after.',
  area: 'pricing', writesTo: ['channels'], view: FEATURES.pricingView, claude: 'switch', preview: 'none',
  previewNote: 'Its run-now is a real run.',
  crons: ['pricing-promotion-scheduler'], schedule: process.env.NEXUS_PROMOTION_SCHEDULER_CRON ?? '0 * * * *',
  env: () => envVerdict([flagOn('NEXUS_ENABLE_PRICING_CRON', isOne('NEXUS_ENABLE_PRICING_CRON'), 'OFF', 'NEXUS_ENABLE_PRICING_CRON is not 1 — the promotion scheduler is not started.', 'The pricing crons run.')]),
  async rows() {
    const events = await prisma.retailEvent.findMany({ where: { endDate: { gte: new Date() } }, select: { id: true, name: true, isActive: true, startDate: true, endDate: true, channel: true, marketplace: true }, orderBy: { startDate: 'asc' }, take: 200 })
    return events.map((e) => ({ id: e.id, name: e.name, level: on(e.isActive), startDate: iso(e.startDate), endDate: iso(e.endDate), channel: e.channel, marketplace: e.marketplace }))
  },
  async state() { return fromRows(await this.rows!(), 'No current or future retail events.') },
  noSwitch: 'the promotion scheduler is switched by the server env only',
}

const N4: AutomationAdapter = {
  id: 'N4', key: 'scheduled-changes', name: 'Scheduled product changes',
  what: 'Applies a future price or status change at its time.',
  area: 'products', writesTo: ['channels'], view: FEATURES.productsView, claude: 'see', preview: 'none',
  previewNote: 'Each change is itself the plan: what and when.',
  crons: ['scheduled-changes'], schedule: process.env.NEXUS_SCHEDULED_CHANGES_SCHEDULE ?? '* * * * *',
  env: () => envVerdict([flagOn('NEXUS_ENABLE_SCHEDULED_CHANGES', notZero('NEXUS_ENABLE_SCHEDULED_CHANGES'), 'OFF', 'NEXUS_ENABLE_SCHEDULED_CHANGES is 0 — scheduled changes do not apply.', 'Due changes apply every minute.')]),
  async rows() {
    const pending = await prisma.scheduledProductChange.findMany({ where: { status: 'PENDING' }, select: { id: true, kind: true, productId: true, scheduledFor: true }, orderBy: { scheduledFor: 'asc' }, take: 200 })
    return pending.map((c) => ({ id: c.id, name: `${c.kind} change for product ${c.productId}`, level: 'AUTO' as const, scheduledFor: iso(c.scheduledFor) }))
  },
  async state() {
    const pending = await prisma.scheduledProductChange.count({ where: { status: 'PENDING' } })
    return { level: 'AUTO', reason: 'Applies every due change by itself.', state: `${pending} changes waiting for their time.`, rows: { total: pending, byLevel: { AUTO: pending } } }
  },
  noSwitch: 'a scheduled change is cancelled in Nexus, not switched',
}

const N5: AutomationAdapter = {
  id: 'N5', key: 'listing-rules', name: 'Listing rules',
  what: 'Price and stock sync and translation when a product changes.',
  area: 'listings', writesTo: ['channels'], view: FEATURES.listingsView, claude: 'full', preview: 'saved',
  previewNote: 'A saved rule against a context you give (as the rule page\'s dry run); no run row, no counter.',
  crons: ['listing-automation-evaluator'], schedule: null,
  env: noEnv,
  rows: () => rulesOf('listings'),
  get: (rowId: string) => ruleDetail('listings', rowId),
  async state() {
    const base = fromRows(await this.rows!(), 'No listing rules.')
    // Never scheduled: the evaluator runs only when a person triggers it (jobs/cron-registry.ts).
    return { ...base, level: base.rows?.total ? 'OFF' : base.level, reason: 'Never scheduled: listing rules run only when a person presses Run.' }
  },
  async explain(opts: ExplainOptions) {
    const facts = await ruleExplain('listings', opts)
    return facts && { ...facts, notes: ['Its writes are channel pushes in the outbound queue, which do not name the rule.'] }
  },
  runPreview: (input: PreviewInput) => previewSavedRule('listings', input, async () => [], () => import('../listing-automation/action-handlers.js')),
  levelSwitch: ruleLevelSwitch('listings', FEATURES.listingsEdit),
}

const N6: AutomationAdapter = {
  id: 'N6', key: 'replenishment-rules', name: 'Replenishment rules',
  what: 'Approves restock recommendations and drafts purchase orders.',
  area: 'replenishment', writesTo: ['nexus'], view: FEATURES.replenishmentView, claude: 'full', preview: 'saved',
  previewNote: 'A saved rule against the open recommendations it would see now (or a context you give); no run row, no counter.',
  crons: ['automation-rule-evaluator'], schedule: process.env.NEXUS_AUTOMATION_RULE_SCHEDULE ?? '*/15 * * * *',
  env: () => envVerdict([flagOn('NEXUS_ENABLE_AUTOMATION_RULE_CRON', isOne('NEXUS_ENABLE_AUTOMATION_RULE_CRON'), 'OFF', 'NEXUS_ENABLE_AUTOMATION_RULE_CRON is not 1 — replenishment rules do not run.', 'Replenishment rules run.')]),
  rows: () => rulesOf('replenishment'),
  get: (rowId: string) => ruleDetail('replenishment', rowId),
  async state() { return fromRows(await this.rows!(), 'No replenishment rules.') },
  explain: (opts: ExplainOptions) => ruleExplain('replenishment', opts, (ids) => recommendationWrites(exactActors(ids), opts.since)),
  runPreview: (input: PreviewInput) => previewSavedRule('replenishment', input, async (rule) => {
    const { replenishmentContextsFor } = await import('../../jobs/automation-rule-evaluator.job.js')
    return replenishmentContextsFor(rule.trigger)
  }),
  levelSwitch: ruleLevelSwitch('replenishment', FEATURES.replenishmentRun),
}

const reviewIngest = () => flagOn('NEXUS_ENABLE_REVIEW_INGEST', isOne('NEXUS_ENABLE_REVIEW_INGEST'), 'OFF', 'NEXUS_ENABLE_REVIEW_INGEST is not 1 — the review crons are not started.', 'The review crons run.')

const N7: AutomationAdapter = {
  id: 'N7', key: 'review-rules', name: 'Review rules',
  what: 'Drafts bullet and A+ ideas from review spikes.',
  area: 'reviews', writesTo: ['nexus', 'ai-spend'], view: FEATURES.reviewsView, claude: 'full', preview: 'none',
  previewNote: 'Its actions call the AI even in a dry run (spend): no preview.',
  crons: ['review-rule-evaluator'], schedule: process.env.NEXUS_REVIEW_RULE_SCHEDULE ?? '*/15 * * * *',
  env: () => envVerdict([reviewIngest()]),
  rows: () => rulesOf('reviews'),
  get: (rowId: string) => ruleDetail('reviews', rowId),
  async state() { return fromRows(await this.rows!(), 'No review rules.') },
  async explain(opts: ExplainOptions) {
    const facts = await ruleExplain('reviews', opts)
    return facts && { ...facts, notes: ['Its drafts are content ideas; they are not recorded under the rule.'] }
  },
  levelSwitch: ruleLevelSwitch('reviews', FEATURES.reviewsManage),
}

const N8: AutomationAdapter = {
  id: 'N8', key: 'review-request-mailer', name: 'Review request mailer',
  what: 'Asks buyers for a review: Amazon solicitations and e-mails.',
  area: 'reviews', writesTo: ['email', 'amazon'], view: FEATURES.reviewsView, claude: 'switch', preview: 'none',
  previewNote: 'Its dry run lists buyer orders; buyer data stays with the orders part. Claude may only pause or resume it.',
  crons: ['review-request-mailer'], schedule: process.env.NEXUS_REVIEW_MAILER_SCHEDULE ?? '0 * * * *',
  env: () => envVerdict([
    reviewIngest(), outboundEmails(),
    flagOn('NEXUS_ENABLE_AMAZON_SOLICITATIONS', isTrue('NEXUS_ENABLE_AMAZON_SOLICITATIONS'), 'AUTO', 'NEXUS_ENABLE_AMAZON_SOLICITATIONS is not true — no Amazon solicitation is sent.', 'Amazon solicitations are sent.'),
  ]),
  async rows() {
    const rules = await prisma.reviewRule.findMany({ select: { id: true, name: true, isActive: true, marketplace: true, minDaysSinceDelivery: true, maxDaysSinceDelivery: true }, orderBy: { name: 'asc' } })
    return rules.map((r) => ({ id: r.id, name: r.name, level: on(r.isActive), marketplace: r.marketplace, daysSinceDelivery: [r.minDaysSinceDelivery, r.maxDaysSinceDelivery] }))
  },
  async state() {
    const { findReviewMailerState } = await import('../reviews/review-mailer-state.service.js')
    const [rows, mailer] = await Promise.all([this.rows!(), findReviewMailerState()])
    const base = fromRows(rows, 'No review request rules.')
    if (mailer?.isPaused) return { ...base, level: 'OFF', reason: 'The mailer is paused.' }
    return base
  },
  noSwitch: 'the review mailer is paused and resumed (stop-automation / resume-automation)',
}

const N9: AutomationAdapter = {
  id: 'N9', key: 'bulk-rules', name: 'Bulk-operation rules',
  what: 'Runs bulk templates on triggers (every 15 minutes, on a schedule, after a bulk job).',
  area: 'bulk', writesTo: ['channels'], view: FEATURES.productsView, claude: 'full', preview: 'saved',
  previewNote: "A saved rule against a context you give (or a cron tick's); no run row, no counter.",
  crons: ['bulk-automation-tick'], schedule: 'every 15 min (always on)',
  env: noEnv,
  rows: () => rulesOf('bulk-operations'),
  get: (rowId: string) => ruleDetail('bulk-operations', rowId),
  async state() { return fromRows(await this.rows!(), 'No bulk-operation rules.') },
  explain: (opts: ExplainOptions) => ruleExplain('bulk-operations', opts, (ids) => bulkJobWrites(exactActors(ids), opts.since)),
  runPreview: (input: PreviewInput) => previewSavedRule('bulk-operations', input,
    async (rule) => (rule.trigger === 'bulk_cron_tick' ? [{ tickAt: new Date().toISOString() }] : []),
    async () => (await import('./bulk-ops-actions.js')).registerBulkOpsActions()),
  levelSwitch: ruleLevelSwitch('bulk-operations', FEATURES.productsBulkRun),
}

const N10: AutomationAdapter = {
  id: 'N10', key: 'scheduled-jobs', name: 'Scheduled bulk actions, imports and exports',
  what: 'Runs saved bulk actions, imports and exports on a clock.',
  area: 'bulk', writesTo: ['channels', 'nexus'], view: FEATURES.productsView, claude: 'see', preview: 'none',
  previewNote: 'Each schedule names its job; a run is real.',
  crons: ['scheduled-bulk-action', 'scheduled-import', 'scheduled-export'], schedule: 'every 1–5 min (always on)',
  env: noEnv,
  async rows() {
    const [bulk, imports, exports] = await Promise.all([
      prisma.scheduledBulkAction.findMany({ select: { id: true, name: true, enabled: true, actionType: true, nextRunAt: true, lastStatus: true } }),
      prisma.scheduledImport.findMany({ select: { id: true, name: true, enabled: true, targetEntity: true, nextRunAt: true, lastStatus: true } }),
      prisma.scheduledExport.findMany({ select: { id: true, name: true, enabled: true, targetEntity: true, nextRunAt: true, lastStatus: true } }),
    ])
    return [
      ...bulk.map((b) => ({ id: b.id, name: `Bulk: ${b.name}`, level: on(b.enabled), kind: 'bulk-action', actionType: b.actionType, nextRunAt: iso(b.nextRunAt), lastStatus: b.lastStatus })),
      ...imports.map((i) => ({ id: i.id, name: `Import: ${i.name}`, level: on(i.enabled), kind: 'import', target: i.targetEntity, nextRunAt: iso(i.nextRunAt), lastStatus: i.lastStatus })),
      ...exports.map((e) => ({ id: e.id, name: `Export: ${e.name}`, level: on(e.enabled), kind: 'export', target: e.targetEntity, nextRunAt: iso(e.nextRunAt), lastStatus: e.lastStatus })),
    ]
  },
  async state() { return fromRows(await this.rows!(), 'No scheduled bulk actions, imports or exports.') },
  noSwitch: 'scheduled jobs are switched in Nexus',
}

const N11: AutomationAdapter = {
  id: 'N11', key: 'scheduled-publish', name: 'Scheduled image and wizard publish',
  what: 'Publishes photos or a listing wizard on a date.',
  area: 'listings', writesTo: ['channels'], view: FEATURES.listingsView, claude: 'see', preview: 'none',
  previewNote: 'Each schedule names what it publishes and when.',
  crons: [], schedule: 'every minute',
  env: () => {
    const image = isOne('NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH')
    const wizard = isOne('NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH')
    const flags = [
      { flag: 'NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH', allows: image, says: image ? 'Scheduled photo publishes run.' : 'NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH is not 1 — scheduled photo publishes do not run.' },
      { flag: 'NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH', allows: wizard, says: wizard ? 'Scheduled wizard publishes run.' : 'NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH is not 1 — scheduled wizard publishes do not run.' },
    ]
    return image || wizard
      ? { ceiling: 'AUTO', flags, reason: null }
      : { ceiling: 'OFF', flags, reason: 'Both NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH and NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH are not 1 — nothing scheduled is published.' }
  },
  async rows() {
    const [images, wizards] = await Promise.all([
      prisma.scheduledImagePublish.findMany({ where: { status: 'PENDING' }, select: { id: true, productId: true, channel: true, marketplace: true, scheduledFor: true }, orderBy: { scheduledFor: 'asc' }, take: 200 }),
      prisma.scheduledWizardPublish.findMany({ where: { status: 'PENDING' }, select: { id: true, wizardId: true, scheduledFor: true }, orderBy: { scheduledFor: 'asc' }, take: 200 }),
    ])
    const image = isOne('NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH')
    const wizard = isOne('NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH')
    return [
      ...images.map((i) => ({ id: i.id, name: `Photos of product ${i.productId} to ${i.channel}${i.marketplace ? ` ${i.marketplace}` : ''}`, level: on(image), scheduledFor: iso(i.scheduledFor) })),
      ...wizards.map((w) => ({ id: w.id, name: `Listing wizard ${w.wizardId}`, level: on(wizard), scheduledFor: iso(w.scheduledFor) })),
    ]
  },
  async state() {
    const base = fromRows(await this.rows!(), 'Nothing scheduled to publish.')
    // These ticks keep no CronRun.
    return { ...base, lastRun: null }
  },
  noSwitch: 'scheduled publishes are switched by the server env only',
}

const N12: AutomationAdapter = {
  id: 'N12', key: 'shopify-linked-automation', name: 'Shopify linked automation',
  what: 'Keeps linked Shopify listings in step (AUTOMATIC) or reports what changed (MONITOR).',
  area: 'listings', writesTo: ['shopify'], view: FEATURES.listingsView, claude: 'switch', preview: 'none',
  previewNote: 'Its preview reads Shopify; read tools never call a marketplace.',
  crons: ['shopify-linked-automation'], schedule: '*/5 * * * * (always on)',
  env: noEnv,
  async rows() {
    const mode = (value: string) => ({ channel: 'SHOPIFY', platformAttributes: { path: ['_nexusLinkedAutomation', 'mode'], equals: value } })
    const [automatic, monitor] = await Promise.all([
      prisma.channelListing.findMany({ where: mode('AUTOMATIC'), select: { id: true, product: { select: { sku: true } } }, take: 200 }),
      prisma.channelListing.findMany({ where: mode('MONITOR'), select: { id: true, product: { select: { sku: true } } }, take: 200 }),
    ])
    return [
      ...automatic.map((l) => ({ id: l.id, name: `${l.product.sku} on Shopify`, level: 'AUTO' as const, mode: 'AUTOMATIC' })),
      ...monitor.map((l) => ({ id: l.id, name: `${l.product.sku} on Shopify`, level: 'OBSERVE' as const, mode: 'MONITOR' })),
    ]
  },
  async state() { return fromRows(await this.rows!(), 'No Shopify listing is in MONITOR or AUTOMATIC mode.') },
  noSwitch: 'Shopify linked automation is set per listing in Nexus',
}

const N13: AutomationAdapter = {
  id: 'N13', key: 'auto-po', name: 'Auto-PO and scheduled purchase orders',
  what: 'Drafts purchase orders: for opted-in suppliers (up to their caps), and from PO templates on a cadence.',
  area: 'replenishment', writesTo: ['nexus'], view: FEATURES.replenishmentView, claude: 'see', preview: 'none',
  previewNote: 'Its dry run still writes a run log row.',
  crons: ['auto-po'], schedule: process.env.NEXUS_AUTO_PO_SCHEDULE ?? '0 5 * * *',
  env: () => envVerdict([flagOn('NEXUS_ENABLE_AUTO_PO_CRON', notZero('NEXUS_ENABLE_AUTO_PO_CRON'), 'OFF', 'NEXUS_ENABLE_AUTO_PO_CRON is 0 — auto-PO does not run.', 'Auto-PO runs.')]),
  async rows() {
    const [suppliers, schedules] = await Promise.all([
      prisma.supplier.findMany({ where: { autoTriggerEnabled: true }, select: { id: true, name: true, autoTriggerMaxQtyPerPo: true, autoTriggerMaxCostCentsPerPo: true } }),
      prisma.poSchedule.findMany({ select: { id: true, cadence: true, cadenceInterval: true, isActive: true, nextRunAt: true } }),
    ])
    const scheduled = isOne('NEXUS_ENABLE_SCHEDULED_PO')
    return [
      ...suppliers.map((s) => ({ id: s.id, name: `Auto-PO for ${s.name}`, level: 'AUTO' as const, kind: 'supplier', caps: { autoTriggerMaxQtyPerPo: s.autoTriggerMaxQtyPerPo, autoTriggerMaxCostCentsPerPo: s.autoTriggerMaxCostCentsPerPo } })),
      ...schedules.map((p) => ({ id: p.id, name: `PO template every ${p.cadenceInterval} ${p.cadence}`, level: on(p.isActive && scheduled), kind: 'po-schedule', nextRunAt: iso(p.nextRunAt), env: { flag: 'NEXUS_ENABLE_SCHEDULED_PO', allows: scheduled } })),
    ]
  },
  async state() { return fromRows(await this.rows!(), 'No supplier opted into auto-PO and no PO schedule.') },
  noSwitch: 'auto-PO is opted into per supplier in Nexus',
}

const N14: AutomationAdapter = {
  id: 'N14', key: 'fba-guard', name: 'FBA flip guard and drift detector',
  what: 'Detects listings that left FBA at Amazon and restores FBA fulfilment.',
  area: 'detectors', writesTo: ['amazon'], view: FEATURES.inventoryView, claude: 'see', preview: 'none',
  previewNote: 'FBA is untouchable: Claude only reads it.',
  crons: ['fba-flip-guard', 'fba-drift-detector'], schedule: '*/10 * * * * / daily 05:00',
  env: () => envVerdict([
    flagOn('NEXUS_ENABLE_FBA_FLIP_GUARD', notZero('NEXUS_ENABLE_FBA_FLIP_GUARD'), 'OFF', 'NEXUS_ENABLE_FBA_FLIP_GUARD is 0 — the flip guard does not run.', 'The flip guard runs.'),
    flagOn('NEXUS_FBA_AUTO_RESTORE', notZero('NEXUS_FBA_AUTO_RESTORE'), 'OBSERVE', 'NEXUS_FBA_AUTO_RESTORE is 0 — it detects and never restores.', 'It restores FBA by itself.'),
  ]),
  async state() { return { level: 'AUTO', reason: 'A detector with an automatic restore; no settings of its own.' } },
  noSwitch: 'FBA is untouchable: Claude only reads it',
}

const N15: AutomationAdapter = {
  id: 'N15', key: 'ebay-label-guard', name: 'eBay label guard',
  what: 'Writes eBay custom labels so each listing carries its SKU.',
  area: 'detectors', writesTo: ['ebay'], view: FEATURES.listingsView, claude: 'see', preview: 'none',
  previewNote: 'It has no dry run.',
  crons: ['ebay-label-guard'], schedule: process.env.NEXUS_EBAY_LABEL_GUARD_SCHEDULE || '15 */6 * * *',
  env: () => {
    const raw = process.env.NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON
    const allows = raw !== undefined && raw !== '' ? ['1', 'true'].includes(raw) : isTrue('NEXUS_EBAY_REAL_API')
    return envVerdict([flagOn('NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON', allows, 'OFF', 'NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON (or, unset, NEXUS_EBAY_REAL_API) is off — the label guard does not run.', 'The label guard runs.')])
  },
  async state() { return { level: 'AUTO', reason: 'A guard with no settings of its own.' } },
  noSwitch: 'the label guard is switched by the server env only',
}

const N16: AutomationAdapter = {
  id: 'N16', key: 'operator-alerts', name: 'Operator alerts',
  what: 'Alert rules and saved-view alerts that notify the operator.',
  area: 'alerts', writesTo: ['email', 'nexus'], view: FEATURES.adminView, claude: 'see', preview: 'none',
  previewNote: 'An evaluation writes its result: no clean preview.',
  crons: ['alert-evaluator', 'saved-view-alerts'], schedule: process.env.NEXUS_ALERT_EVALUATOR_SCHEDULE ?? '* * * * *',
  env: () => envVerdict([
    flagOn('NEXUS_DISABLE_ALERT_EVALUATOR', process.env.NEXUS_DISABLE_ALERT_EVALUATOR !== '1', 'OFF', 'NEXUS_DISABLE_ALERT_EVALUATOR is 1 — alert rules are not evaluated.', 'Alert rules are evaluated.'),
  ]),
  async rows() {
    const savedViewsOn = notZero('NEXUS_ENABLE_SAVED_VIEW_ALERTS_CRON')
    const [rules, views] = await Promise.all([
      prisma.alertRule.findMany({ select: { id: true, name: true, enabled: true, metric: true, lastEvaluatedAt: true, lastFired: true }, orderBy: { name: 'asc' } }),
      prisma.savedViewAlert.findMany({ select: { id: true, name: true, isActive: true, lastCheckedAt: true, lastFiredAt: true }, orderBy: { name: 'asc' } }),
    ])
    return [
      ...rules.map((r) => ({ id: r.id, name: r.name, level: on(r.enabled), kind: 'alert-rule', metric: r.metric, lastEvaluatedAt: iso(r.lastEvaluatedAt), lastFired: r.lastFired })),
      ...views.map((v) => ({ id: v.id, name: v.name, level: on(v.isActive && savedViewsOn), kind: 'saved-view-alert', lastCheckedAt: iso(v.lastCheckedAt), lastFiredAt: iso(v.lastFiredAt) })),
    ]
  },
  async state() { return fromRows(await this.rows!(), 'No alert rules or saved-view alerts.') },
  noSwitch: 'alerts are switched in Nexus',
}

const DETECTORS = [
  { id: 'stockout-detector', name: 'Stockout detector', allows: () => notZero('NEXUS_ENABLE_STOCKOUT_DETECTOR_CRON'), flag: 'NEXUS_ENABLE_STOCKOUT_DETECTOR_CRON' },
  { id: 'sync-drift-detection', name: 'Sync drift detection', allows: () => notZero('NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON'), flag: 'NEXUS_ENABLE_SYNC_DRIFT_DETECTION_CRON' },
  { id: 'sales-drift-detector', name: 'Sales drift detector', allows: () => isOne('NEXUS_ENABLE_SALES_DRIFT_DETECTOR'), flag: 'NEXUS_ENABLE_SALES_DRIFT_DETECTOR' },
  { id: 'latency-watchdog', name: 'Latency watchdog', allows: () => process.env.NEXUS_LATENCY_WATCHDOG !== '0', flag: 'NEXUS_LATENCY_WATCHDOG' },
] as const

const N17: AutomationAdapter = {
  id: 'N17', key: 'detectors', name: 'Nexus-only detectors',
  what: 'Stockouts, sync drift, sales drift and latency: findings in Nexus, nothing sent to a channel.',
  area: 'detectors', writesTo: ['nexus'], view: FEATURES.inventoryView, claude: 'see', preview: 'none',
  previewNote: 'They only record findings.',
  crons: DETECTORS.map((d) => d.id), schedule: 'per detector',
  env: noEnv,
  async rows() {
    return DETECTORS.map((d) => ({ id: d.id, name: d.name, level: (d.allows() ? 'OBSERVE' : 'OFF') as AutomationLevel, env: { flag: d.flag, allows: d.allows() } }))
  },
  async state() { return fromRows(await this.rows!(), 'No detectors.') },
  noSwitch: 'the detectors are switched by the server env only',
}

/** All 39, in the inventory's order (plan part 06 §1). */
export const AUTOMATION_ADAPTERS: readonly AutomationAdapter[] = [
  ...ADS_AUTOMATION_ADAPTERS,
  E1, E2, F1, F2,
  N1, N2, N3, N4, N5, N6, N7, N8, N9, N10, N11, N12, N13, N14, N15, N16, N17,
]

