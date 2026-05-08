'use client'

// UI.5 — Shared shell for all /pricing/* surfaces.
//
// Owns the page title + sub-navigation tabs so the 5 sub-routes
// (matrix, rules, promotions, buybox, alerts) share one consistent
// header. Each child page renders only its own body — the per-page
// PageHeaders that landed in UI.1 are stripped in the same commit.

import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import PricingTabs from './_components/PricingTabs'

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslations()
  return (
    <div>
      <PageHeader
        title={t('pricing.title')}
        subtitle={t('pricing.shellSubtitle')}
      />
      <div className="mb-4">
        <PricingTabs />
      </div>
      {children}
    </div>
  )
}
