import { prisma } from '@nexus/database'
import { getBackendUrl } from '@/lib/backend-url'
import ProfileClient from './ProfileClient'

export const dynamic = 'force-dynamic'

export default async function ProfilePage() {
  // Defensive try/catch — see TECH_DEBT #61.
  let profile: any = null
  try {
    profile = await (prisma as any).userProfile.findFirst()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/profile] prisma error:', err)
  }

  // Pull 2FA status from the API so the security section knows
  // whether to render Enroll or "Enabled · regen / disable".
  let twoFactor = { enabled: false, enrolledAt: null as string | null, recoveryCodesRemaining: 0 }
  try {
    const res = await fetch(`${getBackendUrl()}/api/settings/2fa/status`, {
      cache: 'no-store',
    })
    if (res.ok) twoFactor = await res.json()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/profile] 2fa status fetch failed:', err)
  }

  return (
    <ProfileClient
      profile={profile ? {
        displayName: profile.displayName ?? '',
        email: profile.email ?? '',
        avatarUrl: profile.avatarUrl ?? '',
        phone: profile.phone ?? '',
        timezone: profile.timezone ?? '',
        language: profile.language ?? '',
        dateFormat: profile.dateFormat ?? '',
        weekStart: profile.weekStart ?? null,
        workingHoursStart: profile.workingHoursStart ?? '',
        workingHoursEnd: profile.workingHoursEnd ?? '',
        hasPassword: !!profile.passwordHash,
      } : null}
      twoFactor={twoFactor}
    />
  )
}
