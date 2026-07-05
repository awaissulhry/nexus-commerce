'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the 2FA status MUST load client-side
// where the fetch patch adds credentials. Server-side that fetch 401'd and
// the security section always rendered "Enroll" even when 2FA was enabled.
// The profile row itself still comes from the server (direct prisma read —
// no API auth involved) and is passed down as a prop.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import ProfileClient from './ProfileClient'

// Structural copy of ProfileClient's (unexported) ProfileData prop shape.
interface ProfileData {
  displayName: string
  email: string
  avatarUrl: string
  phone: string
  timezone: string
  language: string
  dateFormat: string
  weekStart: number | null
  workingHoursStart: string
  workingHoursEnd: string
  hasPassword: boolean
}

interface TwoFactorStatus {
  enabled: boolean
  enrolledAt: string | null
  recoveryCodesRemaining: number
}

async function fetchTwoFactor(): Promise<TwoFactorStatus> {
  // Pull 2FA status from the API so the security section knows
  // whether to render Enroll or "Enabled · regen / disable".
  let twoFactor: TwoFactorStatus = {
    enabled: false,
    enrolledAt: null,
    recoveryCodesRemaining: 0,
  }
  try {
    const res = await fetch(`${getBackendUrl()}/api/settings/2fa/status`, {
      cache: 'no-store',
    })
    if (res.ok) twoFactor = await res.json()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/profile] 2fa status fetch failed:', err)
  }
  return twoFactor
}

export default function ProfilePageClient({
  profile,
}: {
  profile: ProfileData | null
}) {
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus | null>(null)

  useEffect(() => {
    let alive = true
    fetchTwoFactor().then((tf) => {
      if (alive) setTwoFactor(tf)
    })
    return () => { alive = false }
  }, [])

  if (!twoFactor) {
    return (
      <div className="max-w-3xl space-y-6" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-40 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return <ProfileClient profile={profile} twoFactor={twoFactor} />
}
