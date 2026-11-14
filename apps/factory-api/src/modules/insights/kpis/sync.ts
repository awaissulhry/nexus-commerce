import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { kpiUseKey } from '@nexus/factory-domain/insights/kpis/checks'
import { kpiReaders, usesPlan } from '@nexus/factory-domain/insights/kpis/readers'
import { KPI_CATALOGUE } from '@nexus/factory-domain/insights/kpis/registry'
import { measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import { command, type CommandCaller } from '../../../core/command'
import { officeContextOf } from '../viewer'
import { USE_SELECT } from './store'

/**
 * POST /insights/kpis/sync (B-W2b-428; ANA-012, ANA-070): ONE command that
 *
 *   1. installs the standard KPIs: every KPI of the code catalogue the tenant has no version of gets version 1 from its file's
 *      words, owned by its template's system role, put in force by the person who asks (written as a DRAFT, then ACTIVE —
 *      the database's order); a KPI with any version already is left to its versions;
 *   2. keeps where KPIs are used in step with the readers' registries (factory-domain insights/kpis/readers): the uses they
 *      name of KPIs in force are added, the uses of readers they own and no longer name are removed.
 *
 * Safe to repeat: a second sync changes nothing (its audit row says so). Office only (an installed version names who put it
 * in force); nothing runs it by itself.
 */
export async function syncKpis(caller: CommandCaller, idempotencyKey: string | null | undefined) {
  officeContextOf(caller)
  const { result } = await command(caller, { name: 'insights.kpisSync', idempotencyKey, input: {} }, async (tools) => {
    const context = tools.context
    if (context.audience !== 'office') throw new ForbiddenError()
    await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.kpis-sync', ${context.tenantId}::text), 0))`
    const keys = new Set((await tools.tx.kpiDefinition.findMany({ select: { kpiKey: true }, distinct: ['kpiKey'] })).map((row) => row.kpiKey))
    const roles = new Map((await tools.tx.role.findMany({ where: { system: true, audience: 'OFFICE', archivedAt: null }, select: { id: true, key: true } })).map((role) => [role.key, role.id]))
    const installed: string[] = []
    const skipped: string[] = []
    for (const file of KPI_CATALOGUE) {
      if (keys.has(file.key)) continue
      const ownerRoleId = roles.get(file.ownerRole)
      if (!ownerRoleId) {
        skipped.push(file.key)
        continue
      }
      const id = newId()
      await tools.tx.kpiDefinition.create({
        data: { id, kpiKey: file.key, kpiVersion: 1, ...file.words, sourceRecords: [...file.sourceRecords], measureKeys: measuresOfCalc(file.calc), ownerRoleId, unit: file.unit, grain: file.grain, createdById: context.actorId, createdAt: tools.now, updatedAt: tools.now },
      })
      await tools.tx.kpiDefinition.updateMany({ where: { id, state: 'DRAFT' }, data: { state: 'ACTIVE', activatedAt: tools.now, activatedById: context.actorId, version: { increment: 1 }, updatedAt: tools.now } })
      tools.audit({ action: 'insights.kpiInstalled', recordType: 'KpiDefinition', recordId: id, after: { kpiKey: file.key, kpiVersion: 1, state: 'ACTIVE' } })
      tools.emit({ type: 'kpi.changed', subject: id, payload: { kpiKey: file.key, kpiVersion: 1, definitionId: id, action: 'INSTALLED', supersededId: null } })
      installed.push(file.key)
    }
    const inForce = new Set((await tools.tx.kpiDefinition.findMany({ where: { state: 'ACTIVE' }, select: { kpiKey: true } })).map((row) => row.kpiKey))
    const stored = await tools.tx.kpiUse.findMany({ select: USE_SELECT })
    const plan = usesPlan(stored, kpiReaders(), inForce)
    if (plan.add.length > 0) {
      await tools.tx.kpiUse.createMany({ data: plan.add.map((use) => ({ id: newId(), kpiKey: use.kpiKey, usedIn: use.usedIn, useKey: use.useKey, key: kpiUseKey(use.kpiKey, use.usedIn, use.useKey), createdAt: tools.now, createdById: context.actorId })) })
    }
    if (plan.remove.length > 0) await tools.tx.kpiUse.deleteMany({ where: { id: { in: plan.remove.map((use) => use.id) } } })
    const touched = [...new Set([...plan.add, ...plan.remove].map((use) => use.kpiKey))].sort()
    if (touched.length > 0) tools.emit({ type: 'kpi.uses_changed', subject: context.tenantId, payload: { added: plan.add.length, removed: plan.remove.length, kpiKeys: touched } })
    tools.audit({ action: 'insights.kpisSynced', recordType: 'Tenant', recordId: context.tenantId, after: { installed, skipped, usesAdded: plan.add.length, usesRemoved: plan.remove.length } })
    return { installed, skipped, usesAdded: plan.add.map((use) => ({ kpiKey: use.kpiKey, usedIn: use.usedIn, useKey: use.useKey })), usesRemoved: plan.remove.map((use) => ({ kpiKey: use.kpiKey, usedIn: use.usedIn, useKey: use.useKey })) }
  })
  return result
}
