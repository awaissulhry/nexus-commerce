import type { Prisma } from '@nexus/factory-db'
import { ALERTS_VIEW } from '@nexus/factory-domain/alerts/permissions'
import { ROUTE_REFUSALS, ROUTES_PER_RULE, routeInsideRule, routeKey, type RouteRefusal, type RouteScope } from '@nexus/factory-domain/alert-routes/rules'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayManage } from '../rules'
import { officeOf, RULE_SCOPE, type Reader } from '../store'

/**
 * Alert routes (B-W2b-435; ANA-041 "alert routing by place and role"; design home.alerts › Rules "goes to (role and place: 'Quality
 * at Plant 1')"): who an exception rule tells at one place of it — a company, a site, a line of a site, or a customer — and an
 * office role (its holders there, through the same scopes as their permissions) or one office person. An alert a route covers
 * goes to the routes' people only; an alert no route covers to the rule's own role (./recipients.ts, at send time).
 *
 *   GET    /alerts/rules/:id/routes     alerts.view over the rule's place: its routes in words (place, whom), whether I may change
 *                                       them and — when I may — the roles, people and places a route may name
 *   POST   /alerts/rules/:id/routes     alerts.rules.manage over the rule's place: a route {scope, scopeId, roleId | userId} —
 *                                       command alerts.addRoute (409 in words: wider than the rule, twice, too many, not an
 *                                       office role, not an active office person, no such place)
 *   DELETE /alerts/routes/:routeId      alerts.rules.manage over its rule's place — command alerts.removeRoute
 *
 * A route is added and removed, never changed (the database holds the same: …_insights_depth_w2b_guards).
 */

const refused = (code: RouteRefusal, path: string): DomainError => new DomainError('conflict', ROUTE_REFUSALS[code], [{ path, message: ROUTE_REFUSALS[code] }])

const ROUTE = { id: true, ruleId: true, scope: true, scopeId: true, roleId: true, userId: true, createdAt: true } as const satisfies Prisma.AlertRouteSelect
type RouteRow = Prisma.AlertRouteGetPayload<{ select: typeof ROUTE }>

const RULE = { id: true, companyId: true, siteId: true, recipientRoleId: true } as const satisfies Prisma.AlertRuleSelect

async function visibleRule(db: Reader, actor: Actor, id: string) {
  const rule = isUuid(id) ? await db.alertRule.findFirst({ where: { AND: [{ id }, scopeWhere(actor, ALERTS_VIEW, RULE_SCOPE) as Prisma.AlertRuleWhereInput] }, select: RULE }) : null
  if (!rule) throw new NotFoundError('Rule not found.')
  return rule
}

const companyName = (row: { readonly tradeName: string | null; readonly legalName: string }) => row.tradeName ?? row.legalName

/** A place as the database checks it: its own company and site, and its words. */
async function placeOf(db: Reader, scope: RouteScope, scopeId: string): Promise<{ readonly companyId: string | null; readonly siteId: string | null; readonly label: string; readonly code: string | null } | null> {
  switch (scope) {
    case 'COMPANY': {
      const row = await db.company.findUnique({ where: { id: scopeId }, select: { id: true, code: true, tradeName: true, legalName: true } })
      return row ? { companyId: row.id, siteId: null, label: companyName(row), code: row.code } : null
    }
    case 'SITE': {
      const row = await db.site.findUnique({ where: { id: scopeId }, select: { id: true, companyId: true, code: true, name: true } })
      return row ? { companyId: row.companyId, siteId: row.id, label: row.name, code: row.code } : null
    }
    case 'LINE': {
      const row = await db.line.findUnique({ where: { id: scopeId }, select: { id: true, companyId: true, siteId: true, code: true, name: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, label: row.name, code: row.code } : null
    }
    case 'CUSTOMER': {
      const row = await db.party.findFirst({ where: { id: scopeId, roles: { hasSome: ['CUSTOMER', 'BRAND'] } }, select: { id: true, companyId: true, code: true, legalName: true, tradeName: true } })
      return row ? { companyId: row.companyId, siteId: null, label: row.tradeName ?? row.legalName, code: row.code } : null
    }
  }
}

/** The routes of rules in words: place and whom (names of roles and people), oldest first. */
export async function routeViews(db: Reader, rows: readonly RouteRow[]) {
  const roles = new Map((await db.role.findMany({ where: { id: { in: rows.flatMap((row) => (row.roleId ? [row.roleId] : [])) } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
  const people = new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((row) => (row.userId ? [row.userId] : [])) } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
  const out = []
  for (const row of rows) {
    const place = await placeOf(db, row.scope, row.scopeId)
    out.push({
      id: row.id,
      ruleId: row.ruleId,
      scope: row.scope,
      scopeId: row.scopeId,
      place: { label: place?.label ?? '', code: place?.code ?? null },
      who: row.roleId ? { kind: 'ROLE' as const, id: row.roleId, name: roles.get(row.roleId) ?? '' } : { kind: 'PERSON' as const, id: row.userId!, name: people.get(row.userId!) ?? '' },
      createdAt: toUtcIso(row.createdAt),
    })
  }
  return out
}

/** The roles, people and places a route of this rule may name (only inside the rule's place). */
async function choicesFor(db: Reader, rule: { readonly companyId: string | null; readonly siteId: string | null }) {
  const roles = await db.role.findMany({ where: { audience: 'OFFICE', archivedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, name: true, key: true } })
  const people = await db.user.findMany({ where: { audience: 'OFFICE', status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 500, select: { id: true, displayName: true } })
  const companies = await db.company.findMany({
    where: { status: 'ACTIVE', ...(rule.companyId ? { id: rule.companyId } : {}) },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    take: 200,
    select: {
      id: true,
      code: true,
      tradeName: true,
      legalName: true,
      sites: {
        where: { status: 'ACTIVE', ...(rule.siteId ? { id: rule.siteId } : {}) },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        select: { id: true, code: true, name: true, lines: { where: { status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true } } },
      },
    },
  })
  const customers = await db.party.findMany({
    where: { status: 'ACTIVE', roles: { hasSome: ['CUSTOMER', 'BRAND'] }, ...(rule.companyId ? { OR: [{ companyId: rule.companyId }, { companyId: null }] } : {}) },
    orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
    take: 501,
    select: { id: true, code: true, legalName: true, tradeName: true },
  })
  return {
    roles,
    people: people.map((row) => ({ id: row.id, name: row.displayName })),
    // A site's rule never routes a whole company.
    companies: companies.map((row) => ({ id: row.id, code: row.code, name: companyName(row), whole: rule.siteId === null, sites: row.sites })),
    customers: customers.slice(0, 500).map((row) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })),
    customersComplete: customers.length <= 500,
  }
}

/** GET /alerts/rules/:id/routes */
export async function listRuleRoutes(caller: CommandCaller, ruleId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const rule = await visibleRule(db, actor, ruleId)
    const rows = await db.alertRoute.findMany({ where: { ruleId: rule.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: ROUTE })
    const canChange = mayManage(actor, rule)
    return { ruleId: rule.id, routes: await routeViews(db, rows), canChange, max: ROUTES_PER_RULE, choices: canChange ? await choicesFor(db, rule) : null }
  })
}

export interface AddRouteBody {
  readonly scope: RouteScope
  readonly scopeId: string
  readonly roleId?: string | null | undefined
  readonly userId?: string | null | undefined
}

/** POST /alerts/rules/:id/routes (command alerts.addRoute). */
export async function addRuleRoute(caller: CommandCaller, ruleId: string, body: AddRouteBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const roleId = body.roleId ?? null
  const userId = body.userId ?? null
  if ((roleId === null) === (userId === null)) throw new ValidationError(ROUTE_REFUSALS.EXACTLY_ONE, [{ path: 'body/roleId', message: ROUTE_REFUSALS.EXACTLY_ONE }])
  const { result } = await command(caller, { name: 'alerts.addRoute', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx } = tools
    const rule = await visibleRule(tx, actor, ruleId)
    if (!mayManage(actor, rule)) throw new DomainError('forbidden', 'You may not change the rules of this place.', [{ path: 'permission/alerts.rules.manage', message: 'Not over this rule’s place.' }])
    // One route at a time per rule (the count and the key are read under it).
    await tx.$queryRaw`SELECT id FROM "AlertRule" WHERE id = ${rule.id}::uuid FOR UPDATE`
    const place = await placeOf(tx, body.scope, body.scopeId)
    if (!place) throw refused('PLACE_UNKNOWN', 'route/PLACE')
    if (!routeInsideRule(rule, { scope: body.scope, companyId: place.companyId, siteId: place.siteId })) throw refused('WIDER', 'route/WIDER')
    if (roleId !== null) {
      const role = await tx.role.findUnique({ where: { id: roleId }, select: { audience: true, archivedAt: true } })
      if (!role || role.audience !== 'OFFICE' || role.archivedAt !== null) throw refused('NOT_OFFICE_ROLE', 'body/roleId')
    } else {
      const user = await tx.user.findUnique({ where: { id: userId! }, select: { audience: true, status: true } })
      if (!user || user.audience !== 'OFFICE' || user.status !== 'ACTIVE') throw refused('NOT_ACTIVE_PERSON', 'body/userId')
    }
    const key = routeKey(rule.id, body.scope, body.scopeId, roleId !== null ? { roleId } : { userId: userId! })
    if (await tx.alertRoute.findFirst({ where: { key }, select: { id: true } })) throw refused('DUPLICATE', 'route/DUPLICATE')
    if ((await tx.alertRoute.count({ where: { ruleId: rule.id } })) >= ROUTES_PER_RULE) throw refused('TOO_MANY', 'route/TOO_MANY')
    const id = newId()
    const row = await tx.alertRoute.create({ data: { id, ruleId: rule.id, scope: body.scope, scopeId: body.scopeId, roleId, userId, key, createdAt: tools.now, createdById: context.actorId }, select: ROUTE })
    tools.audit({ recordType: 'AlertRule', recordId: rule.id, companyId: rule.companyId, ...(rule.siteId ? { siteId: rule.siteId } : {}), after: { route: { id, scope: body.scope, scopeId: body.scopeId, roleId, userId } } })
    tools.emit({ type: 'alert.route_added', subject: rule.id, ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.siteId ? { siteId: rule.siteId } : {}), payload: { routeId: id, ruleId: rule.id, scope: body.scope, scopeId: body.scopeId } })
    return (await routeViews(tx, [row]))[0]!
  })
  return { route: result }
}

/** DELETE /alerts/routes/:routeId (command alerts.removeRoute). */
export async function removeRuleRoute(caller: CommandCaller, routeId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  await command(caller, { name: 'alerts.removeRoute', idempotencyKey, input: { routeId } }, async (tools) => {
    const { tx } = tools
    const route = isUuid(routeId) ? await tx.alertRoute.findUnique({ where: { id: routeId }, select: ROUTE }) : null
    if (!route) throw new NotFoundError('Route not found.')
    const rule = await visibleRule(tx, actor, route.ruleId)
    if (!mayManage(actor, rule)) throw new DomainError('forbidden', 'You may not change the rules of this place.', [{ path: 'permission/alerts.rules.manage', message: 'Not over this rule’s place.' }])
    await tx.$queryRaw`SELECT id FROM "AlertRule" WHERE id = ${rule.id}::uuid FOR UPDATE`
    await tx.alertRoute.delete({ where: { id: route.id } })
    tools.audit({ recordType: 'AlertRule', recordId: rule.id, companyId: rule.companyId, ...(rule.siteId ? { siteId: rule.siteId } : {}), before: { route: { id: route.id, scope: route.scope, scopeId: route.scopeId, roleId: route.roleId, userId: route.userId } }, after: null })
    tools.emit({ type: 'alert.route_removed', subject: rule.id, ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.siteId ? { siteId: rule.siteId } : {}), payload: { routeId: route.id, ruleId: rule.id, scope: route.scope, scopeId: route.scopeId } })
    return null
  })
  return { removed: true }
}
