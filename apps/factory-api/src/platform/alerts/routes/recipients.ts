import { roleReaches } from '@nexus/factory-domain/alerts/rules'
import { routedTo, type AlertPlace } from '@nexus/factory-domain/alert-routes/rules'
import type { CommandTx } from '../../../core/command'
import { liveAssignment } from '../../auth/roles/access'

/**
 * Who an alert goes to (B-W2b-435; ANA-041 "alerts go to the people responsible for that site, line or customer through their
 * scopes"): the routes of its rule that cover its place — its company, its site, its line (a work order's own line, or the line its
 * facts name) and its customer — or, when none covers it, the rule's own role (B-W2a-33). A role's holders are told only where
 * their live assignment reaches the alert's place (the same scopes as their permissions); a person named by a route is told as
 * themselves. The caller (the notifications fan-out) still checks each person may see the alert and reaches Home.
 */

export interface RoutedAlert {
  readonly ruleId: string
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  readonly facts: unknown
  readonly rule: { readonly recipientRoleId: string | null }
}

/** The line an alert is about: a work order's own line, else a `lineId` its facts carry, else none. */
export async function lineOfAlert(tx: CommandTx, alert: Pick<RoutedAlert, 'recordType' | 'recordId' | 'facts'>): Promise<string | null> {
  if (alert.recordType === 'WorkOrder') return (await tx.workOrder.findUnique({ where: { id: alert.recordId }, select: { lineId: true } }))?.lineId ?? null
  const facts = alert.facts as { lineId?: unknown } | null
  return typeof facts?.lineId === 'string' ? facts.lineId : null
}

/** The people an alert goes to (at most `max`): routed, or the rule's role; with `routed` saying which. */
export async function alertRecipients(tx: CommandTx, alert: RoutedAlert, now: Date, max: number): Promise<{ readonly people: Set<string>; readonly routed: boolean }> {
  const routes = await tx.alertRoute.findMany({ where: { ruleId: alert.ruleId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { scope: true, scopeId: true, roleId: true, userId: true } })
  const place: AlertPlace = { companyId: alert.companyId, siteId: alert.siteId, partyId: alert.partyId, lineId: routes.some((route) => route.scope === 'LINE') ? await lineOfAlert(tx, alert) : null }
  const to = routedTo(routes, place, alert.rule.recipientRoleId)
  const people = new Set<string>()
  const scope = { companyId: alert.companyId, siteId: alert.siteId, partyId: alert.partyId }
  if (to.roles.length > 0) {
    const held = await tx.roleAssignment.findMany({
      where: { roleId: { in: [...to.roles] }, ...liveAssignment(now), user: { status: 'ACTIVE' } },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      take: max * 4,
      select: { userId: true, roleId: true, allCompanies: true, companyIds: true, siteIds: true, partyIds: true },
    })
    for (const entry of held) {
      if (people.size >= max) break
      if (roleReaches({ roleId: entry.roleId, scope: { allCompanies: entry.allCompanies, companyIds: entry.companyIds, siteIds: entry.siteIds, partyIds: entry.partyIds } }, scope)) people.add(entry.userId)
    }
  }
  if (to.users.length > 0) {
    const active = await tx.user.findMany({ where: { id: { in: [...to.users] }, status: 'ACTIVE' }, select: { id: true } })
    for (const user of active) if (people.size < max) people.add(user.id)
  }
  return { people, routed: to.routed }
}
