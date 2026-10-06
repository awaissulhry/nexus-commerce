/**
 * ADS PLAYBOOK PB-6a — a rule a playbook compiles (its harvest rule, later its isolation rule), saved ONCE and linked to
 * the product's playbook row (AdsPlaybookLink kind 'harvestRule' | 'isolationRule'). The compile (PB-6b, PB-7) decides
 * the action; this writes it.
 *
 *   new       an AutomationRule { domain advertising, trigger SCHEDULE, dryRun, autonomyLevel PROPOSE, one run a day }
 *             and its link, in one transaction, born `enabled` as asked (off until the playbook starts).
 *   re-sync   changes the action and the name only. The rule's on/off and its autonomy level stay as they are: the
 *             Owner's switches. Unchanged → nothing written. A link whose rule is gone gets a new one.
 *   start     (`start: true`, only from a playbook START) switches the rule on — never over a switch-off made after the
 *             last start. Detected two ways, either one enough: the rule carries the time of the start that last
 *             switched it on (`startedAt` in its action, kept by this writer; nothing here ever switches a rule off, so
 *             a started rule that is off was switched off by someone since), or the rule's change log
 *             (AdvertisingActionLog, update_rule) names `enabled: false` after that start. Then it stays off, said.
 *
 * Every read and write goes through the business-scoped client: a business never sees another's rule or link.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'

/** One JSON text per value, keys sorted: a stored action (jsonb reorders keys) compares equal to the same compile. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** The stored action without this writer's own start mark. */
const compiledPart = (actions: unknown) => (Array.isArray(actions) ? actions.map((a) => {
  if (!a || typeof a !== 'object') return a
  const { startedAt: _mark, ...rest } = a as Record<string, unknown>
  return rest
}) : actions)
const startOf = (actions: unknown): string | null => {
  const mark = Array.isArray(actions) ? (actions[0] as { startedAt?: unknown } | undefined)?.startedAt : null
  return typeof mark === 'string' ? mark : null
}

export interface CompiledRuleResult {
  ruleId: string
  created: boolean
  changed: boolean
  /** The rule's on/off after this write. */
  enabled: boolean
  /** A start that left the rule off: who switched it off after the last start, in a sentence. */
  keptOff?: string
}

export async function ensureCompiledRule(args: {
  playbookId: string; kind: 'harvestRule' | 'isolationRule'; key: string; name: string
  action: Record<string, unknown>
  /** The new rule's on/off; a re-sync keeps the rule's own. */
  enabled: boolean
  /** True only from a playbook START: switch the rule on (never over a switch-off made since the last start). */
  start?: boolean
  compiledVersion: number; actor: string
}): Promise<CompiledRuleResult> {
  return prisma.$transaction(async (tx) => {
    const link = await tx.adsPlaybookLink.findUnique({
      where: { playbookId_kind_key: workspaceKey({ playbookId: args.playbookId, kind: args.kind, key: args.key }) },
      select: { id: true, refId: true, compiledVersion: true },
    })
    const rule = link ? await tx.automationRule.findUnique({ where: { id: link.refId }, select: { id: true, name: true, enabled: true, actions: true } }) : null
    const now = new Date()
    if (link && rule) {
      const lastStart = startOf(rule.actions)
      let enabled = rule.enabled
      let keptOff: string | undefined
      if (args.start && !rule.enabled) {
        const switchOff = (await tx.advertisingActionLog.findMany({
          where: { entityType: 'RULE', entityId: rule.id, actionType: 'update_rule', ...(lastStart ? { createdAt: { gt: new Date(lastStart) } } : {}) },
          orderBy: { createdAt: 'desc' }, take: 20, select: { userId: true, payloadAfter: true, createdAt: true },
        })).find((row) => (row.payloadAfter as { enabled?: unknown } | null)?.enabled === false)
        if (lastStart || switchOff) {
          keptOff = `It stays off: ${switchOff?.userId ? `${switchOff.userId} switched it off` : 'it was switched off'} after the playbook last started it${lastStart ? ` (${lastStart})` : ''}. Switch it on yourself to run it again.`
        } else enabled = true
      }
      const startedAt = enabled && !rule.enabled ? now.toISOString() : lastStart
      const actions = [{ ...args.action, ...(startedAt ? { startedAt } : {}) }]
      const changed = rule.name !== args.name || enabled !== rule.enabled || canonical(compiledPart(rule.actions)) !== canonical([args.action])
      if (changed) await tx.automationRule.update({ where: { id: rule.id }, data: { name: args.name, enabled, actions: actions as never } })
      if (enabled && !rule.enabled) {
        await tx.advertisingActionLog.create({
          data: {
            userId: args.actor, actionType: 'update_rule', entityType: 'RULE', entityId: rule.id, payloadBefore: { enabled: false }, payloadAfter: { enabled: true },
            amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_rule_edit', note: `${args.name} switched on by the playbook start` },
          },
        })
      }
      if (changed || link.compiledVersion !== args.compiledVersion) {
        await tx.adsPlaybookLink.update({ where: { id: link.id }, data: { compiledVersion: args.compiledVersion, updatedBy: args.actor } })
      }
      return { ruleId: rule.id, created: false, changed, enabled, ...(keptOff ? { keptOff } : {}) }
    }
    const enabled = args.enabled || args.start === true
    const made = await tx.automationRule.create({
      data: {
        name: args.name, description: 'Compiled by the ads playbook', domain: 'advertising', trigger: 'SCHEDULE',
        conditions: [] as never, actions: [{ ...args.action, ...(enabled ? { startedAt: now.toISOString() } : {}) }] as never,
        enabled, dryRun: true, autonomyLevel: 'PROPOSE', maxExecutionsPerDay: 1, createdBy: args.actor,
      },
      select: { id: true },
    })
    if (link) await tx.adsPlaybookLink.update({ where: { id: link.id }, data: { refId: made.id, compiledVersion: args.compiledVersion, updatedBy: args.actor } })
    else {
      await tx.adsPlaybookLink.create({
        data: { playbookId: args.playbookId, kind: args.kind, key: args.key, refId: made.id, origin: 'built', compiledVersion: args.compiledVersion, updatedBy: args.actor },
      })
    }
    return { ruleId: made.id, created: true, changed: true, enabled }
  })
}
