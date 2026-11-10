import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { scanLanding } from '../../../../areas/products/styles/techpack/model'
import { landingCompany, SCOPE_COOKIE } from '../../../../lib/session/scope-memory'
import { loadOfficeSession, SIGN_IN_PATH } from '../../../../lib/session/server'
import { OfficeUnavailable } from '../../../../shell/office/OfficeUnavailable'

/**
 * `/tech-pack/<code>` — what the QR on every page of a tech pack PDF holds (B-W2b-230: FACTORY_WEB_ORIGIN + `/tech-pack/<code>`;
 * PRD-138). The address names no company: a signed-in office person lands in the PDF window of the company they work in (the
 * one they last chose, else their session's, else their first), which reads the scan and says whether that printed page is
 * current. No session: sign-in (the office layout above).
 */
export default async function TechPackScanPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const load = await loadOfficeSession()
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind !== 'signed_in') return null
  const person = { tenantId: load.session.tenant.id, userId: load.session.user.id }
  const company = landingCompany((await cookies()).get(SCOPE_COOKIE)?.value, person, load.session.company?.code ?? null, load.session.companies.map((entry) => entry.code))
  const address = scanLanding(safeDecode(code), company)
  if (!address) return <OfficeUnavailable code="forbidden" />
  redirect(address)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
