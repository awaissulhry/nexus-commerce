'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side these fetches 401'd into
// "2FA disabled / no sessions / no login history" for everyone.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import SecurityClient from './SecurityClient'

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

interface InitialData {
  twoFactor: {
    enabled: boolean
    enrolledAt: string | null
    recoveryCodesRemaining: number
  }
  sessions: RawSession[]
  loginEvents: RawLoginEvent[]
  loadError: string | null
}

async function fetchInitialData(): Promise<InitialData> {
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

  return { twoFactor, sessions, loginEvents, loadError }
}

export default function SecurityPage() {
  const [data, setData] = useState<InitialData | null>(null)

  useEffect(() => {
    let alive = true
    fetchInitialData().then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="max-w-3xl space-y-6" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <SecurityClient
      twoFactor={data.twoFactor}
      sessions={data.sessions}
      loginEvents={data.loginEvents}
      initialError={data.loadError}
    />
  )
}
