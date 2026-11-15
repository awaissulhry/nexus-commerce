import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { RouteChoices, RouteScope } from './api'

/** Alert routes' rules on screen (B-W2b-435; ANA-041), pure. Words: `home-digest` keys (`routes.*`). */

export interface RouteDraft {
  readonly scope: RouteScope
  readonly scopeId: string
  readonly who: 'ROLE' | 'PERSON'
  readonly roleId: string
  readonly userId: string
}

export interface PlaceOption {
  readonly value: string
  readonly label: string
}

/** The places of a scope a route of this rule may name (inside its place; a site's rule never names a whole company). */
export function placeOptions(choices: RouteChoices, scope: RouteScope): PlaceOption[] {
  switch (scope) {
    case 'COMPANY':
      return choices.companies.filter((company) => company.whole).map((company) => ({ value: company.id, label: company.name }))
    case 'SITE':
      return choices.companies.flatMap((company) => company.sites.map((site) => ({ value: site.id, label: `${site.code} · ${site.name}` })))
    case 'LINE':
      return choices.companies.flatMap((company) => company.sites.flatMap((site) => site.lines.map((line) => ({ value: line.id, label: `${site.code} › ${line.code} · ${line.name}` }))))
    case 'CUSTOMER':
      return choices.customers.map((customer) => ({ value: customer.id, label: `${customer.code} · ${customer.name}` }))
  }
}

/** The scopes that have at least one place to offer. */
export const scopesOffered = (choices: RouteChoices): RouteScope[] => (['COMPANY', 'SITE', 'LINE', 'CUSTOMER'] as const).filter((scope) => placeOptions(choices, scope).length > 0)

/** A fresh draft: the first scope offered and its first place, the first role. */
export function newRouteDraft(choices: RouteChoices): RouteDraft | null {
  const scope = scopesOffered(choices)[0]
  if (!scope) return null
  return { scope, scopeId: placeOptions(choices, scope)[0]?.value ?? '', who: 'ROLE', roleId: choices.roles[0]?.id ?? '', userId: choices.people[0]?.id ?? '' }
}

/** Why Add waits (a message key), or null. */
export function routeHeld(draft: RouteDraft | null, state: { readonly count: number; readonly max: number; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (state.offline) return 'routes.held.offline'
  if (state.busy) return 'routes.held.busy'
  if (state.count >= state.max) return 'routes.held.tooMany'
  if (!draft || draft.scopeId === '') return 'routes.held.place'
  if (draft.who === 'ROLE' ? draft.roleId === '' : draft.userId === '') return 'routes.held.who'
  return null
}

/** A refused add or remove as a message key. */
export function routeProblem(error: unknown): string {
  if (!isApiError(error)) return 'routes.error.save'
  const paths = error.issues.map(issuePath)
  if (paths.includes('route/DUPLICATE')) return 'routes.error.duplicate'
  if (paths.includes('route/WIDER') || paths.includes('route/PLACE')) return 'routes.error.place'
  if (paths.includes('route/TOO_MANY')) return 'routes.held.tooMany'
  if (paths.includes('body/roleId')) return 'routes.error.role'
  if (paths.includes('body/userId')) return 'routes.error.person'
  if (error.kind === 'forbidden') return 'routes.error.forbidden'
  if (error.kind === 'not_found') return 'routes.error.gone'
  if (error.kind === 'unavailable') return 'routes.error.offline'
  if (error.kind === 'conflict') return 'routes.error.conflict'
  return 'routes.error.save'
}

export function routesReadProblem(error: unknown): string {
  if (!isApiError(error)) return 'routes.error.read'
  if (error.kind === 'unavailable') return 'routes.error.offline'
  return 'routes.error.read'
}
