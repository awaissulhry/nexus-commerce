'use client'

// UI.5 — Shared sub-navigation for /pricing/*. Renders one tab per
// surface and routes via next/navigation.
//
// Active tab is derived from pathname so the tabs stay in sync with
// browser-initiated navigation (back button, deep links, sidebar
// click). Tab labels flow through useTranslations().

import { usePathname, useRouter } from 'next/navigation'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import { useTranslations } from '@/lib/i18n/use-translations'

const TAB_TO_HREF: Record<string, string> = {
  matrix: '/pricing',
  rules: '/pricing/rules',
  promotions: '/pricing/promotions',
  buybox: '/pricing/buybox',
  alerts: '/pricing/alerts',
}

function activeTabFromPath(pathname: string): string {
  if (pathname.startsWith('/pricing/rules')) return 'rules'
  if (pathname.startsWith('/pricing/promotions')) return 'promotions'
  if (pathname.startsWith('/pricing/buybox')) return 'buybox'
  if (pathname.startsWith('/pricing/alerts')) return 'alerts'
  return 'matrix'
}

export default function PricingTabs() {
  const pathname = usePathname()
  const router = useRouter()
  const { t } = useTranslations()

  const tabs: Tab[] = [
    { id: 'matrix', label: t('pricing.tabs.matrix') },
    { id: 'rules', label: t('pricing.tabs.rules') },
    { id: 'promotions', label: t('pricing.tabs.promotions') },
    { id: 'buybox', label: t('pricing.tabs.buybox') },
    { id: 'alerts', label: t('pricing.tabs.alerts') },
  ]

  return (
    <Tabs
      tabs={tabs}
      activeTab={activeTabFromPath(pathname)}
      onChange={(id) => router.push(TAB_TO_HREF[id])}
    />
  )
}
