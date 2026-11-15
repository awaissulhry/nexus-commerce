/**
 * Alert routing by place and role (B-W2b-435; ANA-041; design home.alerts › Rules "goes to (role and place: 'Quality at Plant 1')"),
 * pure. An exception rule tells, by default, the holders of its own role wherever its place reaches (B-W2a-33). Its ROUTES name who
 * is responsible at one place of it: a company, a site, a line of a site, or a customer (a party we sell to, or a brand), and an
 * office role (its holders there, through the same scopes as their permissions) or one office person (factory-db AlertRoute,
 * B-W2b-381). An alert about a place that one or more routes cover goes to those routes' people only; an alert no route covers
 * goes to the rule's own role. Every recipient must still see the alert (alerts.view and its record's own view permission at its
 * place), checked at send time. A route never reaches wider than its rule; it is added and removed, never changed.
 */

export const ROUTE_SCOPES = ['COMPANY', 'SITE', 'LINE', 'CUSTOMER'] as const
export type RouteScope = (typeof ROUTE_SCOPES)[number]

/** The most routes one rule keeps. */
export const ROUTES_PER_RULE = 50

export const isRouteScope = (value: unknown): value is RouteScope => typeof value === 'string' && (ROUTE_SCOPES as readonly string[]).includes(value)

export type RouteWho = { readonly roleId: string; readonly userId?: null } | { readonly userId: string; readonly roleId?: null }

/** `route:<ruleId>:<scope>:<scopeId>:role:<roleId>` or `…:user:<userId>` (the database's key: each recipient once per rule and place). */
export function routeKey(ruleId: string, scope: RouteScope, scopeId: string, who: RouteWho): string {
  return who.roleId ? `route:${ruleId}:${scope}:${scopeId}:role:${who.roleId}` : `route:${ruleId}:${scope}:${scopeId}:user:${who.userId}`
}

/** Where an alert is: its record's company, site, line (a work order's) and customer. */
export interface AlertPlace {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly lineId: string | null
  readonly partyId: string | null
}

export interface RouteLike {
  readonly scope: RouteScope
  readonly scopeId: string
  readonly roleId: string | null
  readonly userId: string | null
}

/** Does a route cover an alert's place: its company, its site, its line, its customer. */
export function routeCovers(route: Pick<RouteLike, 'scope' | 'scopeId'>, place: AlertPlace): boolean {
  switch (route.scope) {
    case 'COMPANY':
      return place.companyId === route.scopeId
    case 'SITE':
      return place.siteId === route.scopeId
    case 'LINE':
      return place.lineId === route.scopeId
    case 'CUSTOMER':
      return place.partyId === route.scopeId
  }
}

export interface RoutedTo {
  /** The office roles whose holders at the place are told. */
  readonly roles: readonly string[]
  /** The office people told by name. */
  readonly users: readonly string[]
  /** True: routes decided; false: no route covers the place, the rule's own role (if any) is told. */
  readonly routed: boolean
}

/** Who a rule's alert about a place goes to: the routes covering the place, else the rule's own role. */
export function routedTo(routes: readonly RouteLike[], place: AlertPlace, ruleRoleId: string | null): RoutedTo {
  const covering = routes.filter((route) => routeCovers(route, place))
  if (covering.length === 0) return { roles: ruleRoleId ? [ruleRoleId] : [], users: [], routed: false }
  return {
    roles: [...new Set(covering.flatMap((route) => (route.roleId ? [route.roleId] : [])))],
    users: [...new Set(covering.flatMap((route) => (route.userId ? [route.userId] : [])))],
    routed: true,
  }
}

/** A route's place, as the database checks it against the rule: the place's own company and site (a customer: neither). */
export interface RoutePlace {
  readonly scope: RouteScope
  readonly companyId: string | null
  readonly siteId: string | null
}

/**
 * Does a route stay inside its rule's place (the database holds the same rule): a rule of every company takes any place; a
 * company's rule a place of that company or a customer (of that company, or of every company); a site's rule that site, a line
 * of it, or such a customer (never the whole company).
 */
export function routeInsideRule(rule: { readonly companyId: string | null; readonly siteId: string | null }, place: RoutePlace): boolean {
  if (rule.companyId === null) return true
  // A customer of every company (no company of its own) is inside any rule; one of another company is not.
  if (place.scope === 'CUSTOMER') return place.companyId === null || place.companyId === rule.companyId
  if (place.companyId !== rule.companyId) return false
  if (rule.siteId === null) return true
  if (place.scope === 'COMPANY') return false
  return place.siteId === rule.siteId
}

export const ROUTE_REFUSALS = Object.freeze({
  WIDER: 'A route never reaches wider than its rule: choose a place inside the rule’s company or site.',
  DUPLICATE: 'This rule already tells them at that place.',
  TOO_MANY: `A rule keeps at most ${ROUTES_PER_RULE} routes.`,
  NOT_OFFICE_ROLE: 'Choose an office role that is not archived.',
  NOT_ACTIVE_PERSON: 'Choose an active office person.',
  PLACE_UNKNOWN: 'That place does not exist (a customer is a party we sell to, or a brand).',
  EXACTLY_ONE: 'A route tells the holders of one role, or one person: choose one of the two.',
} as const)
export type RouteRefusal = keyof typeof ROUTE_REFUSALS
