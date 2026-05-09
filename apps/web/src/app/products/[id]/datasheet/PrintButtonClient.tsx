'use client'

/**
 * F.6 — Client-side trigger for window.print(). Lives in its own
 * file because the datasheet page itself is server-rendered (data
 * fetch via prisma); the print button is the only interactive
 * piece. W5.48 — i18n via useTranslations.
 */

import { Printer } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

export default function PrintButtonClient() {
  const { t } = useTranslations()
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 h-8 px-3 text-md font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
    >
      <Printer className="w-4 h-4" />
      {t('products.datasheet.print')}
    </button>
  )
}
