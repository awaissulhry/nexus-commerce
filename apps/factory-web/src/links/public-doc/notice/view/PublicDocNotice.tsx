'use client'

import { Fragment } from 'react'
import { Banner } from '@nexus/ui/components'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { noonOf, noticeWords, reachWords, type PublicSafetyNotice } from '../model'
import '../notice.css'

/**
 * links.doc › sec:recall (B-W2b-271; design "Safety notice — a recall or safety warning for this batch comes first",
 * GPSR): first on the public DoC page, one DS Banner (danger) per notice — what is wrong, what to do, whom to contact —
 * with the action's number to quote, the day it was published and what it calls back (this batch, the batches to check on
 * the label, the serial on the label, or every garment of the model). No notice: nothing is drawn. The page's own load
 * and error states cover it (the notices come with the page).
 */
export function PublicDocNotices({ notices, chain, batch }: { notices: readonly PublicSafetyNotice[]; chain: readonly string[]; batch: string | null }) {
  if (notices.length === 0) return null
  return (
    <WithMessages namespaces={['compliance-register-depth']}>
      <section className="fw-pdn" aria-labelledby="fw-pdn-title">
        <NoticesBody notices={notices} chain={chain} batch={batch} />
      </section>
    </WithMessages>
  )
}

function NoticesBody({ notices, chain, batch }: { notices: readonly PublicSafetyNotice[]; chain: readonly string[]; batch: string | null }) {
  const t = useT('compliance-register-depth')
  const locale = useLocale()
  return (
    <>
      <h2 className="fw-pdn-h2" id="fw-pdn-title">
        {t('publicNotice.heading', { count: notices.length })}
      </h2>
      {notices.map((notice) => {
        const shown = noticeWords(notice, chain)
        const reach = reachWords(notice, { batch })
        return (
          <Banner key={notice.number} tone="danger" title={shown?.words.title ?? t(`publicNotice.kind.${notice.kind}`)}>
            <div className="fw-pdn-body">
              <p className="fw-pdn-meta">
                {t(`publicNotice.kind.${notice.kind}`)} <span className="fw-pdn-mono">{notice.number}</span> · {t('publicNotice.published', { date: formatDate(noonOf(notice.publishedOn), { locale, timeZone: 'UTC' }) })}
              </p>
              <p className="fw-pdn-reach">{t(reach.key, reach.params)}</p>
              {shown && (
                <dl className="fw-pdn-words">
                  {(['problem', 'action', 'contact'] as const).map((part) => (
                    <Fragment key={part}>
                      <dt>{t(`publicNotice.${part}`)}</dt>
                      <dd>{shown.words[part]}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {shown && chain[0] !== undefined && shown.language.toLowerCase().split('-')[0] !== chain[0] && <p className="fw-pdn-meta">{t('publicNotice.otherLanguage', { language: shown.language.toUpperCase() })}</p>}
              <p className="fw-pdn-meta">{t('publicNotice.quote', { number: notice.number })}</p>
            </div>
          </Banner>
        )
      })}
    </>
  )
}
