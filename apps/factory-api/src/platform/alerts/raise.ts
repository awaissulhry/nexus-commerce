import type { Prisma } from '@nexus/factory-db'
import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import type { AlertSeverity } from '@nexus/factory-domain/alerts/kinds'
import type { Finding } from '@nexus/factory-domain/alerts/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import type { CommandTools } from '../../core/command'

/**
 * The ONE place a stored alert is raised or cleared by the system (B-W2a-33; the scheduler's evaluation, a timer's
 * firing, a recheck after an event). Raising = the Alert row OPEN with nothing done + its RAISED history row with the
 * facts, in the caller's command (the …_platform_w2a_guards triggers: born OPEN, one unresolved alert per key, the
 * history at commit) + `alert.raised` (the notification centre tells the rule's recipients). Clearing = RESOLVED, CLEARED,
 * by nobody, with its RESOLVED history row (actor null, no note) + `alert.resolved`. The caller holds the kind's lock.
 */

const [alertRaised, , , , alertResolved] = alertEvents

const requestIdOf = (tools: CommandTools): string => tools.context.requestId

export interface Raise {
  readonly rule: { readonly id: string; readonly severity: AlertSeverity }
  readonly kind: string
  readonly finding: Finding
  readonly dedupeKey: string
  readonly occurrence: number
}

/** Raises one alert; its id. */
export async function raiseInCommand(tools: CommandTools, raise: Raise): Promise<string> {
  const { tx, now } = tools
  const { finding } = raise
  const id = newId()
  const facts = finding.facts as Prisma.InputJsonValue
  await tx.alert.create({
    data: {
      id,
      ruleId: raise.rule.id,
      ruleKind: raise.kind,
      severity: raise.rule.severity,
      companyId: finding.scope.companyId,
      siteId: finding.scope.siteId,
      partyId: finding.scope.partyId,
      recordType: finding.recordType,
      recordId: finding.recordId,
      recordLabel: finding.label,
      dedupeKey: raise.dedupeKey,
      occurrence: raise.occurrence,
      facts,
      raisedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  })
  await tx.alertEvent.create({ data: { id: newId(), alertId: id, verb: 'RAISED', facts, at: now, requestId: requestIdOf(tools), createdAt: now }, select: { id: true } })
  tools.audit({ action: 'alerts.raise', recordType: 'Alert', recordId: id, companyId: finding.scope.companyId, siteId: finding.scope.siteId, after: { ruleId: raise.rule.id, ruleKind: raise.kind, recordType: finding.recordType, recordId: finding.recordId, occurrence: raise.occurrence } })
  tools.emit(
    eventFor(alertRaised, {
      subject: id,
      companyId: finding.scope.companyId,
      siteId: finding.scope.siteId,
      payload: { alertId: id, ruleKind: raise.kind, recordType: finding.recordType, recordId: finding.recordId, ruleId: raise.rule.id, severity: raise.rule.severity, occurrence: raise.occurrence },
    }),
  )
  return id
}

/** Clears an unresolved alert (its condition no longer holds). False: it was resolved meanwhile. */
export async function clearInCommand(tools: CommandTools, alertId: string): Promise<boolean> {
  const { tx, now } = tools
  await tx.$queryRaw`SELECT id FROM "Alert" WHERE id = ${alertId}::uuid FOR UPDATE`
  const row = await tx.alert.findUnique({ where: { id: alertId }, select: { id: true, state: true, version: true, ruleKind: true, recordType: true, recordId: true, companyId: true, siteId: true } })
  if (!row || row.state === 'RESOLVED') return false
  await tx.alertEvent.create({ data: { id: newId(), alertId, verb: 'RESOLVED', at: now, requestId: requestIdOf(tools), createdAt: now }, select: { id: true } })
  await tx.alert.update({ where: { id: alertId }, data: { state: 'RESOLVED', resolvedAt: now, resolution: 'CLEARED', version: row.version + 1, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'alerts.clear', recordType: 'Alert', recordId: alertId, companyId: row.companyId, siteId: row.siteId, before: { state: row.state }, after: { state: 'RESOLVED', resolution: 'CLEARED' } })
  tools.emit(
    eventFor(alertResolved, {
      subject: alertId,
      companyId: row.companyId,
      siteId: row.siteId,
      payload: { alertId, ruleKind: row.ruleKind, recordType: row.recordType, recordId: row.recordId, resolution: 'CLEARED' },
    }),
  )
  return true
}
