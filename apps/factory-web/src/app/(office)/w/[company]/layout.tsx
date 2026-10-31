import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { recallScope, SCOPE_COOKIE } from '../../../../lib/session/scope-memory'
import { companyPrefix } from '../../../../lib/session/session'
import { loadOfficeSession, SIGN_IN_PATH } from '../../../../lib/session/server'
import { OfficeShell } from '../../../../shell/office/OfficeShell'
import { OfficeUnavailable } from '../../../../shell/office/OfficeUnavailable'

/**
 * One company's Office (`/w/<company code>/…`; PLT-003, PLT-161 stable deep links). The company is in the address, so
 * a link from an email opens the right company. The API is asked with `x-factory-company` = the address's company: it
 * answers 403 when the person may not work there (or it is not one of the tenant's), and the shell then offers their
 * own. Every API call below this layout sends the same header (lib/api).
 */
export default async function CompanyLayout({ children, params }: { children: ReactNode; params: Promise<{ company: string }> }) {
  const { company } = await params
  const code = decodeURIComponent(company)
  const load = await loadOfficeSession(code)
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind === 'forbidden') {
    const own = await loadOfficeSession()
    const ownCode = own.kind === 'signed_in' ? (own.session.company?.code ?? own.session.companies[0]?.code) : null
    return <OfficeUnavailable code="forbidden" ownCompanyHref={ownCode && ownCode !== code ? `${companyPrefix(ownCode)}/home` : null} />
  }
  if (load.kind !== 'signed_in') return <OfficeUnavailable code={load.code} />
  // The address may name the company by id or in another case: the API's answer is the company's own code.
  const current = load.session.company?.code ?? code
  // B-W2b-05: the site this person last chose here (among the sites their roles reach), so the first paint shows it.
  const person = { tenantId: load.session.tenant.id, userId: load.session.user.id }
  const site = recallScope((await cookies()).get(SCOPE_COOKIE)?.value, person, { companies: [current], sites: load.session.sites.map((s) => s.id) })?.site ?? null
  return (
    <OfficeShell session={load.session} company={current} site={site}>
      {children}
    </OfficeShell>
  )
}
