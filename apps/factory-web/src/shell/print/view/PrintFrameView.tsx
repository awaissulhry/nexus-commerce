'use client'

import { useEffect, type ReactNode } from 'react'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { PrintKind } from '../print-model'
import '../print.css'

/**
 * B-W2b-05 (PLT-171) — the print view of any Office page, in its own tab (design shell.panels tab:print, shell.lists
 * tab:print-view): no rail, no top bar, no Pages, no bottom bar. On screen a strip with Print and "Back to the view"
 * (never on paper); on paper the company and site, the page's place, who printed it and when, then the page itself —
 * a list with every row it has loaded and its filters as the page shows them, a record with its band (number, state,
 * version) and every panel — and the page numbers at the foot of each sheet. Always light: paper is white.
 */

export interface PrintFrameModel {
  kind: PrintKind
  /** The company's name and code. */
  company: { name: string; code: string } | null
  /** The site the page reads: its name, all sites, or nothing to say (a company of one site or none). */
  site: { kind: 'site'; name: string } | { kind: 'all'; limited: boolean } | null
  /** Where the page sits ("Sales › Orders"). */
  place: string
  printedBy: string
  /** When the view was opened (UTC; shown in the site's zone). */
  printedAt: string
  /** The same address without the print view. */
  backHref: string
}

export function PrintFrameView({ model, children }: { model: PrintFrameModel; children?: ReactNode }) {
  const t = useT('shell')
  const locale = useLocale()
  // Paper is white: the print view is drawn light whatever the person's theme, and their theme comes back after.
  useEffect(() => {
    const root = document.documentElement
    const dark = root.classList.contains('dark')
    root.classList.remove('dark')
    return () => {
      if (dark) root.classList.add('dark')
    }
  }, [])
  const site =
    model.site === null ? null : model.site.kind === 'site' ? t('print.site', { site: model.site.name }) : t(model.site.limited ? 'print.allMySites' : 'print.allSites')
  return (
    <div className="fw-print" data-print-kind={model.kind}>
      <div className="fw-print-toolbar" role="region" aria-label={t('print.toolbar')}>
        <Button variant="primary" size="sm" onClick={() => window.print()}>
          <Printer size={14} aria-hidden /> {t('print.print')}
        </Button>
        <Button asChild variant="quiet" size="sm">
          <a href={model.backHref}>
            <ArrowLeft size={14} aria-hidden /> {t('print.back')}
          </a>
        </Button>
        <span className="fw-print-hint">{t(model.kind === 'record' ? 'print.hint.record' : 'print.hint.view')}</span>
      </div>
      <header className="fw-print-head">
        <div className="fw-print-company">
          <strong>{model.company?.name ?? t('switcher.noCompany')}</strong>
          {model.company && <span className="fw-print-code">{model.company.code}</span>}
          {site && <span className="fw-print-site">{site}</span>}
        </div>
        <h1 className="fw-print-title">{model.place}</h1>
        <p className="fw-print-meta">
          {t('print.printedBy', { name: model.printedBy, when: formatDateTime(model.printedAt, { locale }) })}
        </p>
      </header>
      <main id="main-content" tabIndex={-1} className="fw-print-body">
        {children}
      </main>
    </div>
  )
}
