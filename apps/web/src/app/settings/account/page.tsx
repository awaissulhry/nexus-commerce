import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import AccountSettingsClient from './AccountSettingsClient'

export const dynamic = 'force-dynamic'

export default async function AccountSettingsPage() {
  // Defensive: Prisma engine availability on Vercel is fragile here
  // and was crashing the page with a 500. Show the empty form when
  // the DB call fails so the sidebar link lands on a usable page.
  let settings: any = null
  try {
    settings = await (prisma as any).accountSettings.findFirst()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/account] prisma error:', err)
    settings = null
  }

  return (
    <div>
      <PageHeader
        title="Account Settings"
        subtitle="Manage your business information and preferences"
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'Account' },
        ]}
      />

      <AccountSettingsClient
        settings={settings ? {
          businessName: settings.businessName,
          addressLine1: settings.addressLine1,
          addressLine2: settings.addressLine2,
          city: settings.city,
          state: settings.state,
          postalCode: settings.postalCode,
          country: settings.country,
          timezone: settings.timezone,
          currency: settings.currency,
          primaryMarketplace: settings.primaryMarketplace ?? null,
        } : null}
      />
    </div>
  )
}
