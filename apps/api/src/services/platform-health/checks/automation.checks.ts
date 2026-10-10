/**
 * Platform health — approvals that do not run, and automation that cannot progress.
 *
 *   plan-steps        change-plan steps that ended skipped or failed in the last 24 h, their reasons grouped. Why: approved
 *                     steps were skipped as "the facts moved" because an engine bumped updatedAt — a spike of that one
 *                     reason is a basis bug, not a busy account.
 *   ads-rule-gates    Amazon ads rules whose graduation gate fails ONLY on its connection checks (production connection,
 *                     live writes, live mode) while every evidence check passes. Why: every rule's gate read a sandbox
 *                     connection, so no rule could ever reach AUTO, for weeks. Read through adsRuleGateStatus — the same
 *                     gate the Control Room shows and the level dial applies.
 *   ads-engines-idle  Amazon ads automations at AUTO that ran in the last 7 days and wrote nothing (automation-explain's
 *                     own verdicts: "never written", "not written in the window"). C1 (2026-10-10): an engine whose last
 *                     run says every campaign it evaluated is not enabled (the hourly bid plans' `paused=N` equal to
 *                     `evaluated=N`) writes nothing by design, and is ok with that note.
 */
import prisma from '../../../db.js'
import { HOUR, plural, withoutNumbers, type HealthCheck, type Verdict } from '../types.js'

// ── plan-steps ───────────────────────────────────────────────────────────────────────────────────────

export interface PlanStepFacts {
  steps: Array<{ status: string; reason: string | null; tool: string }>
}

/** PURE. A reason's family, for grouping: the words before its detail, numbers removed. */
export function reasonFamily(reason: string | null): string {
  if (!reason) return 'no reason recorded'
  if (/facts moved/i.test(reason)) return 'the facts moved since it was approved'
  const parts = reason.split(' — ')
  const head = parts[0] === 'not run' && parts[1] ? `not run — ${parts[1]}` : parts[0]
  return withoutNumbers(head.split(':')[0], 120)
}

export function judgePlanSteps(f: PlanStepFacts): Verdict {
  const ended = f.steps.length
  const done = f.steps.filter((s) => s.status === 'done').length
  const skipped = f.steps.filter((s) => s.status === 'skipped')
  const failed = f.steps.filter((s) => s.status === 'failed')
  const groups = new Map<string, { status: string; count: number; tools: Set<string> }>()
  for (const s of [...skipped, ...failed]) {
    const key = `${s.status}|${reasonFamily(s.reason)}`
    const g = groups.get(key) ?? { status: s.status, count: 0, tools: new Set<string>() }
    g.count++
    g.tools.add(s.tool)
    groups.set(key, g)
  }
  const reasons = [...groups.entries()]
    .map(([key, g]) => ({ status: g.status, reason: key.split('|')[1], count: g.count, tools: [...g.tools].slice(0, 6) }))
    .sort((a, b) => b.count - a.count)
  const factsMoved = skipped.filter((s) => /facts moved/i.test(s.reason ?? '')).length
  const evidence = { ended, done, skipped: skipped.length, failed: failed.length, factsMoved, reasons: reasons.slice(0, 10) }

  const basisBug = factsMoved >= 3 && factsMoved / Math.max(1, ended) >= 0.5
  const failing = failed.length >= 3 && failed.length / Math.max(1, ended) >= 0.3
  if (!skipped.length && !failed.length) {
    return { status: 'ok', message: ended ? `All ${plural(ended, 'change-plan step')} that ended in the last 24 h ran.` : 'No change-plan step ended in the last 24 h.', likelyCause: null, nextStep: null, evidence }
  }
  const message = `${done} of ${plural(ended, 'change-plan step')} that ended in the last 24 h ran; ${skipped.length} skipped, ${failed.length} failed. Most common: ${reasons.slice(0, 3).map((r) => `${r.reason} (${r.count})`).join('; ')}.`
  if (basisBug) {
    return {
      status: 'fail', message,
      likelyCause: `${factsMoved} of ${ended} steps were skipped as "the facts moved": that many real outside changes in a day is unlikely — a field an engine or a sync rewrites on its own is probably part of the approved basis.`,
      nextStep: 'Compare a skipped step\'s approved preview with the row now (approval-status shows both): the field that "moved" with no one changing it is the bug.',
      evidence,
    }
  }
  const status = failing ? 'fail' : failed.length >= 1 || skipped.length >= 3 ? 'warn' : 'ok'
  return {
    status,
    message,
    likelyCause: status === 'ok' ? null : failed.length ? 'A step\'s tool refused or threw when it ran: its reason says why.' : 'The steps\' facts changed or a rule or permission no longer allowed them.',
    nextStep: status === 'ok' ? null : 'Read approval-status for those plans: ask again only with fresh values, and only once.',
    evidence,
  }
}

export const planStepsCheck: HealthCheck<PlanStepFacts> = {
  id: 'plan-steps',
  subsystem: 'approvals',
  title: 'Approved change-plan steps',
  watches: 'Approved change-plan steps of the last 24 h ran; skipped and failed ones are grouped by reason, and a spike of "the facts moved" is flagged as a basis bug.',
  async gather(ctx) {
    const steps = await prisma.agentPlanStep.findMany({
      where: { endedAt: { gte: new Date(ctx.now.getTime() - 24 * HOUR) } },
      select: { status: true, reason: true, toolName: true },
      take: 5000,
    })
    return { steps: steps.map((s) => ({ status: s.status, reason: s.reason, tool: s.toolName })) }
  },
  judge: judgePlanSteps,
}

// ── ads-rule-gates ───────────────────────────────────────────────────────────────────────────────────

const names = (list: readonly string[], max = 5) => `${list.slice(0, max).join(', ')}${list.length > max ? ` and ${list.length - max} more` : ''}`

/** The gate checks about the connection and the live switch, not about the rule's own evidence. */
export const CONNECTION_CHECKS = new Set(['CONNECTION_PRODUCTION', 'WRITES_ENABLED', 'LIVE_MODE_ENV'])

export interface RuleGateFacts {
  rules: Array<{ id: string; name: string; failing: Array<{ id: string; detail: string }> }>
  /** Rules whose gate could not be read. */
  unreadable: number
}

export function judgeRuleGates(f: RuleGateFacts): Verdict {
  const open = f.rules.filter((r) => r.failing.length === 0)
  const blocked = f.rules.filter((r) => r.failing.length > 0 && r.failing.every((c) => CONNECTION_CHECKS.has(c.id)))
  const earned = open.length + blocked.length
  const evidence = {
    rulesAtGate: f.rules.length,
    gateOpen: open.length,
    blockedOnlyByConnection: blocked.slice(0, 20).map((r) => ({ id: r.id, name: r.name, failing: r.failing.map((c) => ({ check: c.id, detail: withoutNumbers(c.detail, 220) })) })),
    stillEarning: f.rules.length - earned,
    unreadable: f.unreadable,
  }
  if (!f.rules.length) {
    return { status: f.unreadable ? 'unknown' : 'ok', message: f.unreadable ? `Could not measure: ${plural(f.unreadable, 'rule gate')} could not be read.` : 'No Amazon ads rule waits at the graduation gate (none is enabled in dry run).', likelyCause: null, nextStep: null, evidence }
  }
  if (!blocked.length) {
    return {
      status: 'ok',
      message: `${plural(f.rules.length, 'ads rule')} at the graduation gate: ${open.length} open, ${f.rules.length - earned} still earning ${f.rules.length - earned === 1 ? 'its' : 'their'} evidence; none is held only by the connection checks.`,
      likelyCause: null, nextStep: null, evidence,
    }
  }
  const first = blocked[0].failing[0]
  return {
    status: blocked.length >= 2 && open.length === 0 ? 'fail' : 'warn',
    message: `${plural(blocked.length, 'ads rule')} earned AUTO on ${blocked.length === 1 ? 'its' : 'their'} own evidence but the graduation gate refuses ${blocked.length === 1 ? 'it' : 'them'} only on the connection checks (${names(blocked.map((r) => r.name))})${open.length === 0 ? ': no rule can reach AUTO' : ''}. First refusal: ${withoutNumbers(first.detail, 200)}`,
    likelyCause: 'The gate judges the rule on a connection that is not live: a sandbox or inactive connection, live writes not enabled, or the market of the rule\'s campaigns not served by a production connection.',
    nextStep: 'Open one rule\'s gate (automation-detail with its rowId, or the Control Room) and compare the connection it names with the market\'s live connection in channel-connections.',
    evidence,
  }
}

export const ruleGatesCheck: HealthCheck<RuleGateFacts> = {
  id: 'ads-rule-gates',
  subsystem: 'automation',
  title: 'Ads rule graduation gates',
  watches: 'No Amazon ads rule that earned AUTO on its own evidence is held back only by the gate\'s connection checks (production connection, live writes, live mode).',
  async gather() {
    const [{ adsRuleGateStatus }, { isRefused }] = await Promise.all([
      import('../../advertising/ads-rule-crud.service.js'),
      import('../../automation/service-outcome.js'),
    ])
    const rules = await prisma.automationRule.findMany({
      where: { domain: 'advertising', enabled: true, dryRun: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 200,
    })
    const out: RuleGateFacts = { rules: [], unreadable: 0 }
    for (const rule of rules) {
      try {
        const gate = await adsRuleGateStatus(rule.id)
        if (isRefused(gate)) { out.unreadable++; continue }
        out.rules.push({ id: rule.id, name: rule.name, failing: gate.value.checks.filter((c) => !c.passed).map((c) => ({ id: c.id, detail: c.detail })) })
      } catch {
        out.unreadable++
      }
    }
    return out
  },
  judge: judgeRuleGates,
}

// ── ads-engines-idle ─────────────────────────────────────────────────────────────────────────────────

export interface EngineFacts {
  days: number
  /** `lastSummary`: the newest run's summary line (CronRun), when it keeps one. */
  engines: Array<{ id: string; name: string; level: string | null; runs: number; writes: number | null; verdicts: string[]; lastEverAt: string | null; lastSummary?: string | null }>
  unreadable: string[]
}

const IDLE = new Set(['never-written', 'not-written-in-window'])

/** C1 — the words for an engine that writes nothing because every campaign it holds is paused or the brain's. */
export const IDLE_BY_DESIGN = 'idle by design: every campaign its plans hold is paused or the brain\'s'

/**
 * PURE. C1 — whether a run's summary line says it wrote nothing by design: the hourly bid plans' line counts the
 * campaigns it evaluated and, of those, the ones that are not enabled (`paused=N`, decided as a hold, never written).
 * When the two are equal and at least one campaign is paused or the bid brain's, there was nothing it could write.
 */
export function idleByDesign(summary: string | null | undefined): boolean {
  if (!summary) return false
  const count = (key: string): number | null => {
    const m = new RegExp(`(?:^|\\s)${key}=(\\d+)`).exec(summary)
    return m ? Number(m[1]) : null
  }
  const evaluated = count('evaluated')
  if (evaluated == null) return false
  const paused = count('paused') ?? 0
  const brainOwned = count('brain-owned') ?? 0
  return evaluated === paused && (paused > 0 || brainOwned > 0)
}

export function judgeEngines(f: EngineFacts): Verdict {
  const auto = f.engines.filter((e) => e.level === 'AUTO')
  const silent = auto.filter((e) => e.runs > 0 && e.verdicts.some((v) => IDLE.has(v)))
  const byDesign = silent.filter((e) => idleByDesign(e.lastSummary))
  const idle = silent.filter((e) => !byDesign.includes(e))
  const ran = auto.filter((e) => e.runs > 0 && !byDesign.includes(e))
  const evidence = {
    days: f.days,
    atAuto: auto.map((e) => ({ id: e.id, name: e.name, runs: e.runs, writes: e.writes, verdicts: e.verdicts, lastEverWrite: e.lastEverAt, ...(byDesign.includes(e) ? { note: IDLE_BY_DESIGN, lastRun: e.lastSummary } : {}) })),
    unreadable: f.unreadable,
  }
  if (!auto.length) {
    return { status: f.unreadable.length && !f.engines.length ? 'unknown' : 'ok', message: f.unreadable.length && !f.engines.length ? `Could not measure: ${f.unreadable.join(', ')}.` : 'No Amazon ads automation is at AUTO, so none is expected to write.', likelyCause: null, nextStep: null, evidence }
  }
  const designNote = byDesign.length ? ` ${byDesign.map((e) => `${e.name} (${e.id})`).join('; ')} wrote nothing — ${IDLE_BY_DESIGN}.` : ''
  if (!idle.length) {
    return { status: 'ok', message: `${plural(auto.length, 'Amazon ads automation')} at AUTO; each that ran in ${f.days} days also wrote${byDesign.length ? ', or had nothing it could write' : ''}.${designNote}`, likelyCause: null, nextStep: null, evidence }
  }
  return {
    status: idle.length >= 3 || (idle.length >= 2 && idle.length === ran.length) ? 'fail' : 'warn',
    message: `${plural(idle.length, 'Amazon ads automation')} at AUTO ran in the last ${f.days} days and wrote nothing: ${idle.map((e) => `${e.name} (${e.id}, ${plural(e.runs, 'run')}${e.lastEverAt ? `, last write ${e.lastEverAt.slice(0, 10)}` : ', never written'})`).join('; ')}.${designNote}`,
    likelyCause: 'Each run is refused at the write gate, finds nothing in its reach, or counts writes that never left (an engine summary is not proof — see Amazon ad writes).',
    nextStep: 'Read automation-activity for each one: its refusals and the gate reasons say which; one that cannot write should be turned down until it can.',
    evidence,
  }
}

export const enginesIdleCheck: HealthCheck<EngineFacts> = {
  id: 'ads-engines-idle',
  subsystem: 'automation',
  title: 'Ads automation at AUTO',
  watches: 'Every Amazon ads automation at AUTO that ran in the last 7 days also wrote something.',
  async gather() {
    const [{ listAdapters }, { explainAutomation }] = await Promise.all([
      import('../../automation/automation-catalog.service.js'),
      import('../../automation/automation-explain.service.js'),
    ])
    const days = 7
    const out: EngineFacts = { days, engines: [], unreadable: [] }
    for (const adapter of listAdapters().filter((a) => a.area === 'amazon-ads' && a.explain)) {
      try {
        const activity = await explainAutomation(adapter, { days })
        if (!activity) continue
        out.engines.push({
          id: adapter.id, name: adapter.name, level: activity.automation.level,
          runs: activity.runs?.total ?? 0, writes: activity.writes?.total ?? null,
          verdicts: activity.verdicts.map((v) => v.code), lastEverAt: activity.writes?.lastEverAt ?? null,
          lastSummary: activity.runs?.last?.[0]?.summary ?? null,
        })
      } catch (error) {
        out.unreadable.push(`${adapter.id} (${error instanceof Error ? error.message.slice(0, 80) : 'unreadable'})`)
      }
    }
    return out
  },
  judge: judgeEngines,
}
