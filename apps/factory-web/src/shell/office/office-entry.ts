import { redirect } from 'next/navigation'
import { loadOfficeSession, SIGN_IN_PATH } from '../../lib/session/server'
import { companyPrefix, permissionCheck } from '../../lib/session/session'
import { firstOfficePage, officeNavFor } from '../nav/office-nav'

/**
 * An office entry address (`/w/<company>`, an area's own address such as `/w/<company>/home`; the brand link and a new
 * session go there): a server redirect to the first page this person may open, in the navigation's order, inside the
 * area first when it names one (`firstOfficePage`). While no area page is built (W0), that is My profile. No session:
 * sign-in; a company the person may not open: nothing here, the company layout says why.
 */
export async function openOfficeEntry(params: Promise<{ company: string }>, areaId?: string): Promise<null> {
  const { company } = await params
  const code = decodeURIComponent(company)
  const load = await loadOfficeSession(code)
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind !== 'signed_in') return null
  const nav = officeNavFor(permissionCheck(load.session.permissions))
  redirect(`${companyPrefix(load.session.company?.code ?? code)}${firstOfficePage(nav, { areaId })}`)
}
