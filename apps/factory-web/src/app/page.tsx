import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { rootDestination } from '../lib/session/office-start'
import { SCOPE_COOKIE } from '../lib/session/scope-memory'
import { loadOfficeSession, SIGN_IN_PATH } from '../lib/session/server'
import { OfficeUnavailable } from '../shell/office/OfficeUnavailable'

/**
 * `/` — the bare address (B-W2b-F58): a signed-out person goes to the sign-in, a signed-in one to their company's Home (the
 * office entry `/w/<company>`, the same rule a new session opens: lib/session/office-start.ts). The API away: said, with Try
 * again.
 */
export default async function RootPage() {
  const load = await loadOfficeSession()
  const to = rootDestination(load, (await cookies()).get(SCOPE_COOKIE)?.value, SIGN_IN_PATH)
  if (to) redirect(to)
  return <OfficeUnavailable code={load.kind === 'unavailable' ? load.code : 'internal'} />
}
