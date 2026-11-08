import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { addressFromCookie, addressOf, destinationOf, endedOf, portalAddress, PORTAL_ADDRESS_COOKIE, safeNext } from '../../../../portal/signin/model'
import { PortalSignIn } from '../../../../portal/signin/PortalSignIn'
import { loadSignInSession } from '../../../../portal/signin/server'

type Search = Promise<Record<string, string | string[] | undefined>>
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

/**
 * `/p/signin?tenant=<slug>&company=<code>&next=<portal path>&ended=idle|revoked` — the portal's sign-in (SCR-026). The
 * invitation mail names the portal (B-W2b-162); the frame sends a person without a session here with `next` (B-W2b-173);
 * a page without either uses the portal this device last signed in to. A portal session already open goes on at once (its
 * first visit, while the portal terms are due, happens here).
 */
export default async function PortalSignInPage({ searchParams }: { searchParams: Search }) {
  const search = await searchParams
  const next = safeNext(one(search.next))
  const session = await loadSignInSession()
  if (session && !session.termsDue) redirect(destinationOf(next, session.party))
  const given = portalAddress(one(search.tenant), one(search.company))
  const remembered = addressFromCookie((await cookies()).get(PORTAL_ADDRESS_COOKIE)?.value)
  return <PortalSignIn start={{ kind: 'email', address: addressOf(given, remembered), next, ended: endedOf(one(search.ended)), session }} />
}
