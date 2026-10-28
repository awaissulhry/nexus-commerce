import type { OfficeMe } from '../api/office'

/**
 * The signed-in office person as the web's screens see them: who they are, which tenant and company they work in,
 * which companies they may switch to, and what their grants allow. Plain data (server → client props).
 *
 * The permission list only HIDES what a person cannot open (navigation, buttons); the API checks every call itself.
 */

export interface CompanyRef {
  id: string
  /** Unique in the tenant; the Office address `/w/<code>/…` uses it. */
  code: string
  name: string
}

export interface SiteRef {
  id: string
  name: string
}

export interface OfficeSession {
  user: { id: string; email: string; displayName: string; locale: string }
  tenant: { id: string; slug: string; name: string }
  /** The company the request works in (`x-factory-company`, else the session's starting one). */
  company: CompanyRef | null
  /**
   * The companies this person may switch to. W0: the API lists none yet (the Companies screen and its routes come
   * with B-W0-27), so this holds the current company only; the switcher already takes many.
   */
  companies: CompanyRef[]
  /** The current company's sites (W0: none listed by the API yet; the switcher then offers "All sites"). */
  sites: SiteRef[]
  permissions: readonly string[]
  mfa: { enabled: boolean; required: boolean; satisfied: boolean }
}

export function sessionFromMe(me: OfficeMe): OfficeSession {
  return {
    user: me.user,
    tenant: me.tenant,
    company: me.company,
    companies: me.company ? [me.company] : [],
    sites: [],
    permissions: me.permissions,
    mfa: { enabled: me.mfa.enabled, required: me.mfa.required, satisfied: me.mfa.satisfied },
  }
}

/** `can(permission)` for a permission list. */
export function permissionCheck(permissions: readonly string[]): (permission: string) => boolean {
  const held = new Set(permissions)
  return (permission) => held.has(permission)
}

/** The address prefix of a company's office pages. */
export function companyPrefix(code: string): string {
  return `/w/${encodeURIComponent(code)}`
}

/**
 * An office address split into its company and the company-free rest: `/w/ACME/admin/users` → `ACME`, `/admin/users`.
 * Navigation manifests use the rest; the shell adds the prefix back.
 */
export function splitOfficePath(pathname: string): { company: string | null; path: string } {
  const match = /^\/w\/([^/?#]+)(\/[^?#]*)?/.exec(pathname)
  if (!match) return { company: null, path: pathname || '/' }
  let company: string
  try {
    company = decodeURIComponent(match[1])
  } catch {
    company = match[1]
  }
  return { company, path: match[2] && match[2] !== '/' ? match[2].replace(/\/+$/, '') : '/' }
}
