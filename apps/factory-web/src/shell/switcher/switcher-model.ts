import type { CompanyRef, SiteRef } from '../../lib/session/session'

/**
 * The company and site switcher (SCR-002; PLT-003 companies, PLT-004 sites, PLT-008 scope). The company is part of the
 * address (`/w/<company>/…`): choosing another is a NAVIGATION to the same page in that company, so a new tab, a
 * bookmark and the back button all work. The site narrows what the company's pages show; it is a remembered choice
 * (lib/session/scope-memory.ts), not part of the address. Both are remembered per person.
 */

export interface SwitcherState {
  companies: readonly CompanyRef[]
  /** The current company's code. */
  company: string
  sites: readonly SiteRef[]
  /** The current site; null = all sites. */
  site: string | null
  /** The current page without its `/w/<company>` prefix: switching company keeps it. */
  path: string
  /**
   * B-W2b-05: the person's roles reach only some of the company's sites — "All sites" then says "All my sites". With one
   * site there is nothing to choose: the trigger names it, the menu lists no sites.
   */
  limited?: boolean
  /** The menu starts open (design fixtures). */
  open?: boolean
  /** B-W2b-05: the company finder starts open, with this text (design fixtures; more than 7 companies). */
  finderQuery?: string
}

/** The same page in another company. A record page (`/sales/orders/<id>`) goes back to its list: a record id belongs to one company. */
export function companySwitchHref(code: string, path: string): string {
  const segments = path.split('/').filter(Boolean)
  const keep = segments.slice(0, 2).join('/')
  return `/w/${encodeURIComponent(code)}${keep ? `/${keep}` : ''}`
}

export function currentCompany(state: SwitcherState): CompanyRef | null {
  return state.companies.find((company) => company.code === state.company) ?? null
}

export function currentSite(state: SwitcherState): SiteRef | null {
  // B-W2b-05: one site only is the site the person works in (nothing to choose).
  if (state.sites.length === 1) return state.sites[0]!
  return state.site === null ? null : (state.sites.find((site) => site.id === state.site) ?? null)
}

/** Whether there is anything to switch: more than one company, or more than one site to narrow to (B-W2b-05: one site is no choice). */
export function switcherHasChoices(state: SwitcherState): { companies: boolean; sites: boolean } {
  return { companies: state.companies.length > 1, sites: state.sites.length > 1 }
}
