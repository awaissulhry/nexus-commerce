/**
 * ADS PLAYBOOK PB-6a — a rule a playbook compiles (its harvest rule, later its isolation rule), saved ONCE and linked to
 * the product's playbook row (AdsPlaybookLink kind 'harvestRule' | 'isolationRule'). The compile (PB-6b, PB-7) decides
 * the action; this writes it.
 *
 *   new       an AutomationRule { domain advertising, trigger SCHEDULE, dryRun, autonomyLevel PROPOSE, one run a day }
 *             and its link, in one transaction. Born with `enabled` as asked (off until the playbook starts).
 *   re-save   changes the action, the name and `enabled` only — never the autonomy level (the Owner's dial) nor any
 *             other field a person set on the rule. Unchanged → nothing written. A link whose rule is gone gets a new one.
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

export async function ensureCompiledRule(args: {
  playbookId: string; kind: 'harvestRule' | 'isolationRule'; key: string; name: string
  action: Record<string, unknown>; enabled: boolean; compiledVersion: number; actor: string
}): Promise<{ ruleId: string; created: boolean; changed: boolean }> {
  const actions = [args.action]
  return prisma.$transaction(async (tx) => {
    const link = await tx.adsPlaybookLink.findUnique({
      where: { playbookId_kind_key: workspaceKey({ playbookId: args.playbookId, kind: args.kind, key: args.key }) },
      select: { id: true, refId: true, compiledVersion: true },
    })
    const rule = link ? await tx.automationRule.findUnique({ where: { id: link.refId }, select: { id: true, name: true, enabled: true, actions: true } }) : null
    if (link && rule) {
      const changed = rule.name !== args.name || rule.enabled !== args.enabled || canonical(rule.actions) !== canonical(actions)
      if (changed) await tx.automationRule.update({ where: { id: rule.id }, data: { name: args.name, enabled: args.enabled, actions: actions as never } })
      if (changed || link.compiledVersion !== args.compiledVersion) {
        await tx.adsPlaybookLink.update({ where: { id: link.id }, data: { compiledVersion: args.compiledVersion, updatedBy: args.actor } })
      }
      return { ruleId: rule.id, created: false, changed }
    }
    const made = await tx.automationRule.create({
      data: {
        name: args.name, description: 'Compiled by the ads playbook', domain: 'advertising', trigger: 'SCHEDULE',
        conditions: [] as never, actions: actions as never, enabled: args.enabled, dryRun: true, autonomyLevel: 'PROPOSE',
        maxExecutionsPerDay: 1, createdBy: args.actor,
      },
      select: { id: true },
    })
    if (link) await tx.adsPlaybookLink.update({ where: { id: link.id }, data: { refId: made.id, compiledVersion: args.compiledVersion, updatedBy: args.actor } })
    else {
      await tx.adsPlaybookLink.create({
        data: { playbookId: args.playbookId, kind: args.kind, key: args.key, refId: made.id, origin: 'built', compiledVersion: args.compiledVersion, updatedBy: args.actor },
      })
    }
    return { ruleId: made.id, created: true, changed: true }
  })
}
