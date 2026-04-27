import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import ProfileClient from './ProfileClient'

export const dynamic = 'force-dynamic'

export default async function ProfilePage() {
  const profile = await (prisma as any).userProfile.findFirst()

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
