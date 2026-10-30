import type { Prisma } from '@nexus/factory-db'
import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { KINDS, RULE_KINDS, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { newId } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import { runCommand, type CommandCaller, type CommandSettings } from '../../core/command'
import { tenantIdOf, type Reader } from './store'

/**
 * The built-in rules (B-W2a-33; design home.alerts "the factory's exceptions ship ready"; the platform schema's note "a
 * real tenant needs them made, as roles' syncSystemRoles"): every tenant gets one rule per kind, switched on, everywhere,
 * telling the holders of the kind's system role (planner, quality inspector, buyer, finance) by the bell, at most once a
 * day per record. A tenant edits a built-in rule and switches it off; it is never removed (the trigger), and never made
 * twice (a kind with a built-in rule is skipped, whatever its state). Made by the scheduler's evaluation pass, in ONE
 * system command per tenant, only when a kind lacks its built-in rule.
 */

const [, , , , , ruleChanged] = alertEvents

/** The kinds that have no built-in rule yet in this tenant. */
export async function missingBuiltIns(db: Reader): Promise<RuleKind[]> {
  const present = new Set((await db.alertRule.findMany({ where: { builtIn: true }, select: { ruleKind: true } })).map((rule) => rule.ruleKind))
  return RULE_KINDS.filter((kind) => !present.has(kind))
}

/** Makes the missing built-in rules (a no-op when none is missing); how many were made. */
export async function ensureBuiltInRules(caller: CommandCaller, settings: CommandSettings): Promise<number> {
  const missing = await caller.withClient((db) => missingBuiltIns(db))
  if (missing.length === 0) return 0
  const { result } = await runCommand(
    caller,
    { name: 'alerts.builtInRules', input: { kinds: missing } },
    async (tools) => {
      const { tx, now } = tools
      // Read again inside the transaction: another pass may have made them meanwhile.
      const still = await missingBuiltIns(tx)
      const roles = new Map((await tx.role.findMany({ where: { system: true, audience: 'OFFICE', key: { in: still.map((kind) => KINDS[kind].builtIn.recipientRole) } }, select: { id: true, key: true } })).map((role) => [role.key, role.id]))
      let made = 0
      for (const kind of still) {
        const spec = KINDS[kind]
        const id = newId()
        await tx.alertRule.create({
          data: {
            id,
            ruleKind: kind,
            trigger: spec.trigger,
            name: spec.builtIn.name.en,
            threshold: spec.builtIn.threshold as Prisma.InputJsonValue,
            severity: spec.builtIn.severity,
            recipientRoleId: roles.get(spec.builtIn.recipientRole) ?? null,
            channels: ['IN_APP'],
            cooldownMinutes: spec.builtIn.cooldownMinutes,
            enabled: true,
            builtIn: true,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        })
        tools.audit({ action: 'alerts.builtInRule', recordType: 'AlertRule', recordId: id, companyId: null, after: { ruleKind: kind, recipientRole: spec.builtIn.recipientRole, threshold: spec.builtIn.threshold } })
        tools.emit(eventFor(ruleChanged, { subject: id, payload: { ruleId: id, ruleKind: kind, enabled: true, fields: ['created'] } }))
        made++
      }
      if (made === 0) tools.audit({ action: 'alerts.builtInRule', recordType: 'Tenant', recordId: tenantIdOf(tools.context), after: { made: 0 } })
      return made
    },
    settings,
  )
  return result
}
