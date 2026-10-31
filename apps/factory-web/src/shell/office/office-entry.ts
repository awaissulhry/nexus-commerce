import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { recallStart, SCOPE_COOKIE } from '../../lib/session/scope-memory'
import { loadOfficeSession, SIGN_IN_PATH } from '../../lib/session/server'
import { companyPrefix, permissionCheck } from '../../lib/session/session'
import { firstOfficePage, officeNavFor } from '../nav/office-nav'
import { startPageFor } from '../scope/start/start-page'

/**
 * An office entry address (`/w/<company>`, an area's own address such as `/w/<company>/home`; the brand link and a new
 * session go there): a server redirect to the first page this person may open, in the navigation's order, inside the
 * area first when it names one (`firstOfficePage`). While no area page is built (W0), that is My profile. B-W2b-05: the
 * company's own entry opens the person's start page first, when they chose one (a saved view). No session:
 * sign-in; a company the person may not open: nothing here, the company layout says why.
 */
export async function openOfficeEntry(params: Promise<{ company: string }>, areaId?: string): Promise<null> {
  const { company } = await params
  const code = decodeURIComponent(company)
  const load = await loadOfficeSession(code)
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind !== 'signed_in') return null
  const nav = officeNavFor(permissionCheck(load.session.permissions))
  const prefix = companyPrefix(load.session.company?.code ?? code)
  // B-W2b-05 (design shell.scope sec:defaults): the company's own entry (after sign-in) opens the person's start page —
  // a saved view they picked on My profile — while they may still open its page; else Today, as before.
  if (!areaId) {
    const person = { tenantId: load.session.tenant.id, userId: load.session.user.id }
    const start = startPageFor(recallStart((await cookies()).get(SCOPE_COOKIE)?.value, person), nav)
    if (start) redirect(`${prefix}${start}`)
  }
  redirect(`${prefix}${firstOfficePage(nav, { areaId })}`)
}
