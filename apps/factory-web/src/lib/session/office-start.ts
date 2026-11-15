import { landingCompany } from './scope-memory'
import { companyPrefix, type OfficeSession } from './session'
import type { SessionLoad } from './server'

/**
 * B-W2b-F58: where the bare address `/` sends a person (the Owner opened http://localhost:3300/ and met the scaffold's
 * placeholder). Signed out: the sign-in. Signed in: their company's office entry `/w/<company>` — the same rule a new
 * session opens (the company they last worked in on this device when they may still open it, else the session's own, else
 * the first their roles reach) — whose own redirect (shell/office/office-entry.ts) opens their Home, or the first page
 * they may open. A person with no company to open goes to the sign-in, which says so. The API away: null (the page says it).
 */
export function officeStartOf(session: OfficeSession, scopeCookie: string | null | undefined): string | null {
  const own = session.company?.code ?? null
  const codes = session.companies.length > 0 ? session.companies.map((company) => company.code) : own ? [own] : []
  const company = landingCompany(scopeCookie, { tenantId: session.tenant.id, userId: session.user.id }, own, codes)
  return company ? companyPrefix(company) : null
}

/** The address `/` redirects to, or null when the API did not answer (the page shows why). */
export function rootDestination(load: SessionLoad, scopeCookie: string | null | undefined, signInPath: string): string | null {
  if (load.kind === 'signed_in') return officeStartOf(load.session, scopeCookie) ?? signInPath
  if (load.kind === 'unavailable') return null
  return signInPath
}
