import { prisma } from '@nexus/database'
import ProfilePageClient from './ProfilePageClient'

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

  // 2FA status loads in ProfilePageClient (client-side): the API session
  // cookie lives on the API origin, so a server-side fetch can never
  // authenticate — it 401'd and the security section always showed "Enroll".
  return (
    <ProfilePageClient
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
    />
  )
}
