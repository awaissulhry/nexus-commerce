'use client'

import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'

export default function PricingError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const { t } = useTranslations()
  return (
    <div className="p-8 text-center max-w-lg mx-auto">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-50 text-rose-700 mb-3">
        <AlertCircle size={24} />
      </div>
      <h2 className="text-xl font-semibold text-rose-700 mb-2">
        {t('pricing.error.title')}
      </h2>
      <p className="text-slate-500 mb-4 text-base">{error.message}</p>
      <Button
        variant="primary"
        size="md"
        onClick={reset}
        icon={<RefreshCw size={12} />}
      >
        {t('pricing.error.retry')}
      </Button>
    </div>
  )
}
