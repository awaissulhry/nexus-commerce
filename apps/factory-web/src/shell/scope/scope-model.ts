import type { CompanyRef, SiteRef } from '../../lib/session/session'

/**
 * B-W2b-05 (PLT-008, design shell.scope) — the company and site every Office page works in. The company is the
 * address's (`/w/<company>/…`); the site is the top bar's choice, remembered per person (lib/session/scope-memory.ts)
 * and offered only among the sites the person's roles reach in that company (`GET /auth/office/me` sites). A page that
 * reads the site ("Site from the top bar", every W2b page) sends `siteId` to the API and reads again when it changes;
 * with "All sites" a list adds a Site column and says so in a chip. The API checks every read against the grants itself:
 * the scope only narrows.
 */

export interface OfficeScope {
  company: CompanyRef | null
  /** The sites the person may choose in this company, in the API's order. */
  sites: readonly SiteRef[]
  /** The chosen site; null = all sites (all of the person's own when their roles limit them). */
  site: SiteRef | null
  /** What a page sends the API: `site?.id ?? null`. */
  siteId: string | null
  /** No site chosen while there is more than one: a list adds a Site column and an "All sites" chip. */
  allSites: boolean
  /** The person's roles reach only some of the company's sites: "All sites" means all of theirs. */
  limited: boolean
  /** Exactly one site: nothing to choose, the page works in it. */
  fixed: boolean
}

export interface ScopeInput {
  company: CompanyRef | null
  sites: readonly SiteRef[]
  /** The person reaches every site of the company (`me.allSites`); absent = unknown, read as every site. */
  everySite?: boolean
  /** The remembered or chosen site id; null = all sites. */
  chosen: string | null
}

/** The scope for a company, its sites and the person's choice. A choice that is not one of the sites is all sites. */
export function scopeOf(input: ScopeInput): OfficeScope {
  const sites = input.sites
  const fixed = sites.length === 1
  const site = fixed ? sites[0]! : (sites.find((entry) => entry.id === input.chosen) ?? null)
  return {
    company: input.company,
    sites,
    site,
    siteId: site?.id ?? null,
    allSites: site === null && sites.length > 1,
    limited: input.everySite === false && sites.length > 0,
    fixed,
  }
}

/** Outside the Office shell (a test, a design case of a page): one company or none, no site. */
export const NO_SCOPE: OfficeScope = Object.freeze({ company: null, sites: [], site: null, siteId: null, allSites: false, limited: false, fixed: false })

/** A row's site name for the Site column ("All sites"); null when the row has none or it is not one of the person's. */
export function siteNameOf(scope: Pick<OfficeScope, 'sites'>, siteId: string | null | undefined): string | null {
  if (!siteId) return null
  return scope.sites.find((site) => site.id === siteId)?.name ?? null
}

/** What a list says about its site in its filter row: one site's name, all sites, or nothing (one site or none). */
export function scopeChip(scope: OfficeScope): { kind: 'site'; name: string } | { kind: 'all'; limited: boolean } | null {
  if (scope.sites.length <= 1) return null
  if (scope.site) return { kind: 'site', name: scope.site.name }
  return { kind: 'all', limited: scope.limited }
}

/** The API terms of the scope: `{ siteId }` while one site is chosen, nothing for all sites. */
export function scopeQuery(scope: Pick<OfficeScope, 'siteId'>): { siteId?: string } {
  return scope.siteId ? { siteId: scope.siteId } : {}
}
