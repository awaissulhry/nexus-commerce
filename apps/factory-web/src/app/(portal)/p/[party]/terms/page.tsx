import { localeOfPerson } from '../../../../../portal/shell/model'
import { loadPortalSession, loadPortalTerms } from '../../../../../portal/shell/server'
import { PortalTerms } from '../../../../../portal/shell/terms/PortalTerms'

/** `/p/<party>/terms` — the portal terms in force, in the person's language (the foot opens it in a new tab). */
export default async function PortalTermsPage() {
  const load = await loadPortalSession()
  if (load.kind !== 'signed_in') return null
  return <PortalTerms terms={await loadPortalTerms(localeOfPerson(load.me.user.locale))} />
}
