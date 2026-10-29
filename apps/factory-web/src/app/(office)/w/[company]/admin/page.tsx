import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AdminOverview } from '../../../../../areas/admin/overview/AdminOverview'
import { loadOfficeSession, SIGN_IN_PATH } from '../../../../../lib/session/server'
import { companyPrefix, permissionCheck } from '../../../../../lib/session/session'
import { firstOfficePage, officeNavFor } from '../../../../../shell/nav/office-nav'

export const metadata: Metadata = { title: 'All settings · Nexus Factory' }

/**
 * `/w/<company>/admin` — Admin's own address and its first page, All settings (design 02 admin.overview; W0: the
 * "Get the factory ready" checklist, Owner O2). A person who may not open it (no companies.view) goes to the first Admin
 * page they may open, else their first page in the office (the rail and the brand link never land on a door that leads
 * nowhere). The company layout above has loaded the session and draws the Office shell.
 */
export default async function AdminPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params
  const code = decodeURIComponent(company)
  const load = await loadOfficeSession(code)
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind === 'signed_in') {
    const target = firstOfficePage(officeNavFor(permissionCheck(load.session.permissions)), { areaId: 'admin' })
    if (target !== '/admin') redirect(`${companyPrefix(load.session.company?.code ?? code)}${target}`)
  }
  return <AdminOverview />
}
