import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ALERTS_VIEW } from '@nexus/factory-domain/alerts/permissions'
import { KINDS, RULE_KINDS, isRuleKind, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import type { HeldRole } from '@nexus/factory-domain/alerts/rules'
import { can, holds, scopeWhere, type Actor, type Permission, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller, CommandTx } from '../../core/command'
import type { OfficeContext, RequestContext } from '../../core/context'
import { heldRoles } from '../auth/roles/access'

/**
 * The stored alerts' reads (B-W2a-33): who sees which alert, the columns the lists and the record read, the rule rows,
 * and the names of people, places and roles. Every alert is behind TWO permissions: alerts.view, and its record's own view
 * permission (factory-domain alerts/kinds) over the alert's company, site and party (an order's alert only for who may
 * see the order). An alert of no company (a shared certificate) or no site (an order) belongs to every company or site.
 */

export type Reader = FactoryClient | CommandTx

/** The alert's scope columns: a null company or site means the record belongs to every one. */
export const ALERT_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true }, site: { field: 'siteId', nullable: true }, party: { field: 'partyId', nullable: true } }
/** A rule's place columns. */
export const RULE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true }, site: { field: 'siteId', nullable: true } }

export interface AlertScope {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
}

/** The alerts the actor may see: per kind, alerts.view and the record's view permission over the alert's place. */
export function visibleWhere(actor: Actor, permission: Permission = ALERTS_VIEW): Prisma.AlertWhereInput {
  if (!holds(actor, permission)) return { id: { in: [] } }
  const kinds = RULE_KINDS.filter((kind) => holds(actor, KINDS[kind].view))
  if (kinds.length === 0) return { id: { in: [] } }
  return {
    AND: [
      scopeWhere(actor, permission, ALERT_SCOPE) as Prisma.AlertWhereInput,
      { OR: kinds.map((kind) => ({ AND: [{ ruleKind: kind }, scopeWhere(actor, KINDS[kind].view, ALERT_SCOPE) as Prisma.AlertWhereInput] })) },
    ],
  }
}

/** Whether the actor may see this alert (the same two permissions over its place). */
export function maySee(actor: Actor, alert: { readonly ruleKind: string } & AlertScope, permission: Permission = ALERTS_VIEW): boolean {
  if (!isRuleKind(alert.ruleKind)) return false
  return can(actor, permission, alert) && can(actor, KINDS[alert.ruleKind].view, alert)
}

export const ALERT_COLUMNS = {
  id: true,
  ruleId: true,
  ruleKind: true,
  severity: true,
  companyId: true,
  siteId: true,
  partyId: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  dedupeKey: true,
  occurrence: true,
  facts: true,
  state: true,
  raisedAt: true,
  acknowledgedAt: true,
  acknowledgedById: true,
  assignedToId: true,
  assignedById: true,
  assignedAt: true,
  snoozedUntil: true,
  snoozedById: true,
  snoozedAt: true,
  resolvedAt: true,
  resolution: true,
  resolvedById: true,
  resolveNote: true,
  version: true,
  rule: { select: { name: true, recipientRoleId: true } },
} as const satisfies Prisma.AlertSelect
export type AlertRow = Prisma.AlertGetPayload<{ select: typeof ALERT_COLUMNS }>

export const RULE_COLUMNS = {
  id: true,
  ruleKind: true,
  trigger: true,
  name: true,
  threshold: true,
  severity: true,
  companyId: true,
  siteId: true,
  recipientRoleId: true,
  channels: true,
  cooldownMinutes: true,
  enabled: true,
  builtIn: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AlertRuleSelect
export type RuleRow = Prisma.AlertRuleGetPayload<{ select: typeof RULE_COLUMNS }>

/** A rule row's kind, or null for a kind this code does not know (never evaluated). */
export const kindOfRule = (rule: Pick<RuleRow, 'ruleKind'>): RuleKind | null => (isRuleKind(rule.ruleKind) ? rule.ruleKind : null)

/** Display names of office users by id. */
export async function peopleNames(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The names of companies, sites and roles the rules name. */
export async function placeNames(db: Reader, rules: readonly Pick<RuleRow, 'companyId' | 'siteId' | 'recipientRoleId'>[]): Promise<{ companies: Map<string, string>; sites: Map<string, string>; roles: Map<string, string> }> {
  const ids = (pick: (rule: Pick<RuleRow, 'companyId' | 'siteId' | 'recipientRoleId'>) => string | null) => [...new Set(rules.map(pick).filter((id): id is string => id !== null))]
  const companyIds = ids((rule) => rule.companyId)
  const siteIds = ids((rule) => rule.siteId)
  const roleIds = ids((rule) => rule.recipientRoleId)
  const companies = companyIds.length ? await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, tradeName: true, legalName: true } }) : []
  const sites = siteIds.length ? await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } }) : []
  const roles = roleIds.length ? await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : []
  return {
    companies: new Map(companies.map((row) => [row.id, row.tradeName ?? row.legalName])),
    sites: new Map(sites.map((row) => [row.id, row.name])),
    roles: new Map(roles.map((row) => [row.id, row.name])),
  }
}

/** A person's live office role assignments, as the recipient rule reads them. */
export async function heldOf(db: Reader, userId: string, now: Date): Promise<HeldRole[]> {
  return (await heldRoles(db, userId, now)).map((held) => ({ roleId: held.roleId, scope: held.scope }))
}

/** The kind's advisory lock (one evaluation, timer firing or recheck of a kind at a time per tenant). */
export async function lockKind(tx: CommandTx, tenantId: string, kind: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.alerts', ${tenantId}::uuid::text, ${kind}::text), 0))`
}

/** The tenant of a command's context (every context but the platform's has one). */
export function tenantIdOf(context: RequestContext): string {
  const tenantId = 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) throw new Error('alerts: a command outside a tenant')
  return tenantId
}

/** The office person of a request (floor, partner and link sessions are refused by the manifest's audience first). */
export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}
