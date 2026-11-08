'use client'

import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { PortalTerms as Terms } from '../api'
import { usePortalBand, usePortalFrame } from '../frame'
import { TermsView } from '../view/TermsView'

/**
 * The portal terms in force (design portal.frame › foot, tab:privacy "reading beside the page without losing work"): the
 * foot opens them in a new tab, read in the person's language (else the language the company published), with the version.
 */
export function PortalTerms({ terms }: { terms: Terms | null }) {
  const t = useT('portal')
  const locale = useLocale()
  const frame = usePortalFrame()
  usePortalBand({ title: t('terms.title'), back: { href: frame.prefix, label: t('nav.home') } })
  const notice = terms?.notice ?? null
  return (
    <TermsView
      model={
        terms === null
          ? { state: 'error' }
          : notice
            ? { state: 'ready', label: notice.label, published: notice.publishedAt ? formatDate(notice.publishedAt, { locale }) : null, body: notice.body, otherLanguage: !notice.languageReady || notice.locale !== locale, acknowledged: frame.me.preview ? null : terms.acknowledged }
            : { state: 'none' }
      }
    />
  )
}
