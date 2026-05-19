import { getBackendUrl } from '@/lib/backend-url'
import SecurityClient from './SecurityClient'

export const dynamic = 'force-dynamic'

interface RawSession {
  id: string
  tokenPrefix: string
  userAgent: string | null
  ipAddress: string | null
  ipCity: string | null
  ipCountry: string | null
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
}

interface RawLoginEvent {
  id: string
  outcome: string
  userAgent: string | null
  ipAddress: string | null
  ipCity: string | null
  ipCountry: string | null
  emailTried: string | null
  createdAt: string
}

export default async function SecurityPage() {
  const backend = getBackendUrl()
  let twoFactor = {
    enabled: false,
    enrolledAt: null as string | null,
    recoveryCodesRemaining: 0,
  }
  let sessions: RawSession[] = []
  let loginEvents: RawLoginEvent[] = []
  let loadError: string | null = null

  try {
    const [twoFaRes, sessRes, histRes] = await Promise.all([
      fetch(`${backend}/api/settings/2fa/status`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/sessions`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/login-history`, { cache: 'no-store' }),
    ])
    if (twoFaRes.ok) twoFactor = await twoFaRes.json()
    if (sessRes.ok) {
      const data = (await sessRes.json()) as { sessions: RawSession[] }
      sessions = data.sessions ?? []
    }
    if (histRes.ok) {
      const data = (await histRes.json()) as { events: RawLoginEvent[] }
      loginEvents = data.events ?? []
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <SecurityClient
      twoFactor={twoFactor}
      sessions={sessions}
      loginEvents={loginEvents}
      initialError={loadError}
    />
  )
}
