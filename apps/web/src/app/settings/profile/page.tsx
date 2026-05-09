import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import ProfileClient from './ProfileClient'

export const dynamic = 'force-dynamic'

export default async function ProfilePage() {
  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let profile: any = null
  try {
    profile = await (prisma as any).userProfile.findFirst()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/profile] prisma error:', err)
  }

  return (
    <div>
      <PageHeader
        title="User Profile"
        subtitle="Manage your personal information and security"
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'Profile' },
        ]}
      />

      <ProfileClient
        profile={profile ? {
          displayName: profile.displayName,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
          hasPassword: !!profile.passwordHash,
        } : null}
      />
    </div>
  )
}
