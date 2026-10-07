/**
 * R5 (MCP full control, part 06 §1) — the adapter of the eBay ads rules (E1), for the automation catalog
 * (services/automation/automation-catalog.service.ts).
 *
 * In the marketing context on purpose: it reads eBay's rule, dial and spend-ceiling tables, which only the advertising
 * context may touch (scripts/check-context-boundary.mjs). Read-only: the dial is read with findFirst, never through
 * `getAutomationState`, whose read creates a missing row.
 */
import { FEATURES } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { settingsBasis } from '../automation/row-basis.js'
import {
  envVerdict, flagOn, isOne, iso, lowest, summarise,
  evidenceGate, gateOfCounts,
  type AutomationAdapter, type AutomationLevel, type EnvCheck, type ExplainOptions, type PreviewInput, type PreviewOutcome, type SwitchRow,
} from '../automation/automation-levels.js'

/** NEXUS_ENABLE_EBAY_ADS_SYNC: '0' off, '1' on, unset → on only in production (jobs/ebay-ads-sync.job.ts). */
const ebaySync = (): EnvCheck => {
  const raw = process.env.NEXUS_ENABLE_EBAY_ADS_SYNC
  const allows = raw === '1' || (raw !== '0' && raw === undefined && process.env.NODE_ENV === 'production')
  return flagOn('NEXUS_ENABLE_EBAY_ADS_SYNC', allows, 'OFF', 'NEXUS_ENABLE_EBAY_ADS_SYNC is off on this server — the eBay rule evaluation does not run.', 'The eBay ads crons run.')
}

export const E1: AutomationAdapter = {
  id: 'E1', key: 'ebay-ads-rules', name: 'eBay ads rules',
  what: 'Ad rates, keyword bids, promote or remove listings.',
  area: 'ebay-ads', writesTo: ['ebay'], view: FEATURES.adsView, claude: 'full', preview: 'draft-and-saved',
  previewNote: 'A draft or a saved rule against live data: counts and the first matches; nothing written.',
  crons: ['ebay-ads-automation-evaluate'], schedule: process.env.NEXUS_EBAY_ADS_EVALUATE_SCHEDULE ?? '45 5 * * *',
  env: () => envVerdict([ebaySync(), flagOn('NEXUS_MARKETING_WRITES_EBAY', isOne('NEXUS_MARKETING_WRITES_EBAY'), 'OBSERVE',
    "NEXUS_MARKETING_WRITES_EBAY is not 1 — writes go to eBay's sandbox, never to your listings.", 'eBay marketing writes are live.')]),
  async rows() {
    const rules = await prisma.ebayAdsRule.findMany({ select: { id: true, name: true, enabled: true, mode: true, marketplace: true, cooldownHours: true, version: true, lastEvaluatedAt: true }, orderBy: { name: 'asc' } })
    return rules.map((r) => ({ id: r.id, name: r.name, level: (!r.enabled ? 'OFF' : r.mode === 'AUTOPILOT' ? 'AUTO' : 'PROPOSE') as AutomationLevel, mode: r.mode, marketplace: r.marketplace, cooldownHours: r.cooldownHours, version: r.version, lastEvaluatedAt: iso(r.lastEvaluatedAt) }))
  },
  async get(rowId: string) {
    const rule = await prisma.ebayAdsRule.findUnique({ where: { id: rowId } })
    if (!rule) return null
    const [versions, executions] = await Promise.all([
      prisma.ebayAdsRuleVersion.findMany({ where: { ruleId: rowId }, orderBy: { version: 'desc' }, take: 5, select: { version: true, name: true, changedBy: true, createdAt: true, note: true } }),
      prisma.ebayAdsRuleExecution.findMany({ where: { ruleId: rowId }, orderBy: { createdAt: 'desc' }, take: 5, select: { status: true, evaluated: true, matched: true, proposed: true, applied: true, createdAt: true } }),
    ])
    return {
      id: rule.id, name: rule.name, level: (!rule.enabled ? 'OFF' : rule.mode === 'AUTOPILOT' ? 'AUTO' : 'PROPOSE') as AutomationLevel,
      enabled: rule.enabled, mode: rule.mode, marketplace: rule.marketplace, scope: rule.scope, trigger: rule.trigger, action: rule.action,
      guardrails: rule.guardrails, cooldownHours: rule.cooldownHours, version: rule.version,
      versions: versions.map((v) => ({ ...v, createdAt: iso(v.createdAt) })), executions: executions.map((e) => ({ ...e, createdAt: iso(e.createdAt) })),
    }
  },
  async state() {
    const [rows, dial, ceilings] = await Promise.all([
      this.rows!(),
      prisma.marketingAutomationState.findFirst({ where: { channel: 'EBAY' } }),
      prisma.marketingSpendCeiling.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, monthlyCapCents: true, killSwitch: true } }),
    ])
    const s = summarise(rows)
    const mode = dial?.globalMode ?? 'OFF'
    const cap: AutomationLevel = dial?.halted || mode === 'OFF' ? 'OFF' : mode === 'SUGGEST' ? 'PROPOSE' : 'AUTO'
    const level = lowest(s.level, cap)
    const reason = !rows.length ? 'No eBay ads rules.'
      : dial?.halted ? `eBay ads automation is halted${dial.haltReason ? `: ${dial.haltReason}` : ''}.`
        : level !== s.level ? `The eBay dial is ${mode}${dial ? '' : ' (never set)'}.`
          : s.level === 'OFF' ? 'Every one is switched off.' : `The most active is at ${s.level}.`
    return { level, reason, rows: s.rows, sample: s.sample, caps: { spendCeilings: ceilings.map((c) => ({ marketplace: c.marketplace, monthlyCapCents: c.monthlyCapCents, killSwitch: c.killSwitch })) } }
  },
  async explain(opts: ExplainOptions) {
    const rule = opts.rowId ? await prisma.ebayAdsRule.findUnique({ where: { id: opts.rowId }, select: { id: true, name: true, enabled: true, mode: true } }) : null
    if (opts.rowId && !rule) return null
    const ruleFilter = rule ? { ruleId: rule.id } : {}
    const [runs, lastRuns, applied, lastApplied, everApplied, refusedProposals] = await Promise.all([
      prisma.ebayAdsRuleExecution.groupBy({ by: ['status'], where: { ...ruleFilter, createdAt: { gte: opts.since } }, _count: { _all: true }, _sum: { evaluated: true, matched: true, proposed: true, applied: true } }),
      prisma.ebayAdsRuleExecution.findMany({ where: { ...ruleFilter, createdAt: { gte: opts.since } }, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, status: true, evaluated: true, matched: true, proposed: true, applied: true } }),
      prisma.ebayAdsProposal.groupBy({ by: ['kind'], where: { ...ruleFilter, status: 'APPLIED', decidedAt: { gte: opts.since } }, _count: { _all: true }, _max: { decidedAt: true } }),
      prisma.ebayAdsProposal.findMany({ where: { ...ruleFilter, status: 'APPLIED', decidedAt: { gte: opts.since } }, orderBy: { decidedAt: 'desc' }, take: 10, select: { decidedAt: true, kind: true, entityRef: true, decidedBy: true } }),
      prisma.ebayAdsProposal.findFirst({ where: { ...ruleFilter, status: 'APPLIED' }, orderBy: { decidedAt: 'desc' }, select: { decidedAt: true } }),
      prisma.ebayAdsProposal.count({ where: { ...ruleFilter, status: 'REJECTED', decidedAt: { gte: opts.since } } }),
    ])
    const sum = (k: 'evaluated' | 'matched' | 'proposed' | 'applied') => runs.reduce((n, g) => n + (g._sum[k] ?? 0), 0)
    const lastAt = applied.reduce<Date | null>((at, g) => (g._max.decidedAt && (!at || g._max.decidedAt > at) ? g._max.decidedAt : at), null)
    return {
      subject: rule ? { id: rule.id, name: rule.name, level: (!rule.enabled ? 'OFF' : rule.mode === 'AUTOPILOT' ? 'AUTO' : 'PROPOSE') as AutomationLevel } : null,
      runs: {
        source: 'EbayAdsRuleExecution', total: runs.reduce((n, g) => n + g._count._all, 0),
        byStatus: Object.fromEntries(runs.map((g) => [g.status, g._count._all])),
        last: lastRuns.map((r) => ({ at: r.createdAt.toISOString(), status: r.status, summary: `${r.evaluated} evaluated, ${r.matched} matched, ${r.proposed} proposed, ${r.applied} applied` })),
      },
      writes: {
        source: 'EbayAdsProposal (applied)', actors: ['automation:ebay-ads'],
        total: applied.reduce((n, g) => n + g._count._all, 0),
        byAction: Object.fromEntries(applied.map((g) => [g.kind, g._count._all])),
        lastAt: iso(lastAt), everWritten: everApplied != null, lastEverAt: iso(everApplied?.decidedAt ?? null),
        last: lastApplied.map((p) => ({ at: iso(p.decidedAt) ?? '', action: p.kind, entityType: 'EBAY_AD', entityId: JSON.stringify(p.entityRef).slice(0, 120), status: p.decidedBy })),
      },
      refusals: null,
      notes: [`In ${opts.days} days its runs evaluated ${sum('evaluated')}, matched ${sum('matched')}, proposed ${sum('proposed')} and applied ${sum('applied')}; ${refusedProposals} proposals were rejected.`],
    }
  },
  async runPreview(input: PreviewInput): Promise<PreviewOutcome> {
    const auto = await import('./ebay-ads-automation.service.js')
    const typeOf = (action: unknown) => [String((action as { type?: unknown } | null)?.type ?? '')].filter(Boolean)
    if (input.draft) {
      try {
        return { kind: 'draft', subject: null, result: await auto.previewRule(input.draft as never), actionTypes: typeOf(input.draft.action) }
      } catch (e) {
        return { refused: (e as Error).message }
      }
    }
    if (!input.rowId) return { refused: 'Give a draft, or name a saved rule (rowId).' }
    const rule = await prisma.ebayAdsRule.findUnique({ where: { id: input.rowId } })
    if (!rule) return { refused: 'not found', notFound: true }
    return { kind: 'saved', subject: { id: rule.id, name: rule.name }, result: await auto.previewRule(auto.ruleConfigOf(rule) as never), actionTypes: typeOf(rule.action) }
  },
  levelSwitch: {
    levels: ['OFF', 'PROPOSE', 'AUTO'], needsRow: true, manage: FEATURES.adsAutomationManage,
    async read(rowId) {
      const r = rowId ? await prisma.ebayAdsRule.findUnique({ where: { id: rowId } }) : null
      if (!r) return null
      const action = (r.action ?? {}) as { type?: unknown; deltaPct?: unknown; bidDeltaPct?: unknown }
      const type = String(action.type ?? '')
      const lowers = type === 'set_rate_to_breakeven_factor' || (type === 'adjust_ad_rate' && Number(action.deltaPct ?? -10) < 0) || type === 'bid_down_keyword'
      return {
        id: r.id, name: r.name, level: (!r.enabled ? 'OFF' : r.mode === 'AUTOPILOT' ? 'AUTO' : 'PROPOSE') as AutomationLevel,
        // Its settings, never the eBay ads automation's lastEvaluatedAt / cooldownUntil, which move updatedAt (row-basis.ts).
        basis: settingsBasis('ebayAdsRule', r),
        brake: lowers ? 'it lowers ad rates or bids: turning it down can raise spend' : null,
      }
    },
    // D-R1 — AUTO only after the graduation gate: 14 days, 10 real runs, 1 match, from the rule's own run record.
    async refusal(row: SwitchRow, level: AutomationLevel) {
      if (level !== 'AUTO') return null
      const r = await prisma.ebayAdsRule.findUnique({ where: { id: row.id }, select: { createdAt: true } })
      const runs = await prisma.ebayAdsRuleExecution.aggregate({ where: { ruleId: row.id }, _count: { _all: true }, _sum: { matched: true } })
      const failures = r ? evidenceGate({ createdAt: r.createdAt, evaluationCount: runs._count._all, matchCount: runs._sum.matched ?? 0 }) : ['not found']
      return failures.length ? `AUTO (AUTOPILOT) only after the graduation gate: ${failures.join(', ')}.` : null
    },
    // AA-W2-11 — the same counts, shown in turn-up-automation's preview.
    async gateEvidence(row: SwitchRow) {
      const r = await prisma.ebayAdsRule.findUnique({ where: { id: row.id }, select: { createdAt: true } })
      const runs = await prisma.ebayAdsRuleExecution.aggregate({ where: { ruleId: row.id }, _count: { _all: true }, _sum: { matched: true } })
      return gateOfCounts({ createdAt: r?.createdAt ?? new Date(), runs: runs._count._all, matches: runs._sum.matched ?? 0, runsAre: 'real runs', matchesAre: 'matches', from: "the rule's run record (EbayAdsRuleExecution)" })
    },
    async write(row: SwitchRow, level: AutomationLevel, actorUserId: string | null) {
      const { updateEbayAdsRule } = await import('./ebay-ads-rule-crud.service.js')
      const out = await updateEbayAdsRule(row.id, level === 'OFF' ? { enabled: false } : { enabled: true, mode: level === 'AUTO' ? 'AUTOPILOT' : 'PROPOSE' }, actorUserId)
      return out.ok ? null : String((out as { body: Record<string, unknown> }).body.error)
    },
  },
}

