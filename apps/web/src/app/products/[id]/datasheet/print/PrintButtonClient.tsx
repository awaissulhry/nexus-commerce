'use client'

/**
 * F.6 — Client-side trigger for window.print(). Lives in its own
 * file because the datasheet page itself is server-rendered (data
 * fetch via prisma); the print button is the only interactive
 * piece. W5.48 — i18n via useTranslations.
 *
 * DS.5 — Adds a "Download PDF" button alongside Print. Both invoke
 * the native print dialog; the difference is that Download PDF
 * temporarily swaps document.title for `${SKU}-datasheet-${date}`
 * so the browser's "Save as PDF" filename suggestion is meaningful
 * (instead of "Nexus Commerce.pdf"). Title is restored on
 * afterprint so the rest of the app sees no side effect. Full
 * server-side deterministic PDF generation (Puppeteer/Playwright)
 * is deferred to DS.5b when the Railway/Vercel deploy infra is
 * ready to ship Chromium binaries.
 */

import { useCallback, useEffect } from 'react'
import { Download, Printer } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

interface PrintButtonClientProps {
  /** Used to build the suggested PDF filename. */
  sku: string
}

export default function PrintButtonClient({ sku }: PrintButtonClientProps) {
  const { t } = useTranslations()

  // afterprint restores the original title in case the user
  // navigates away with the temporary one still attached.
  useEffect(() => {
    let originalTitle: string | null = null
    const onBefore = () => {
      if (originalTitle == null) originalTitle = document.title
    }
    const onAfter = () => {
      if (originalTitle != null) {
        document.title = originalTitle
        originalTitle = null
      }
    }
    window.addEventListener('beforeprint', onBefore)
    window.addEventListener('afterprint', onAfter)
    return () => {
      window.removeEventListener('beforeprint', onBefore)
      window.removeEventListener('afterprint', onAfter)
    }
  }, [])

  const onDownloadPdf = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    // Most browsers use document.title as the default "Save as PDF"
    // filename. Setting it just before print() biases the dialog
    // toward a useful name; the beforeprint listener above captures
    // the original so it's restored after the dialog closes.
    document.title = `${sku}-datasheet-${today}`
    window.print()
  }, [sku])

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 border border-slate-300 rounded-md hover:bg-slate-100 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <Printer className="w-4 h-4" />
        {t('products.datasheet.print')}
      </button>
      <button
        type="button"
        onClick={onDownloadPdf}
        className="inline-flex items-center gap-1.5 h-8 px-3 text-md font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
      >
        <Download className="w-4 h-4" />
        {t('products.datasheet.downloadPdf')}
      </button>
    </div>
  )
}
