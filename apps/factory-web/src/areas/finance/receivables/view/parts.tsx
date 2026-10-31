'use client'

import { formatDate } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { AgeingBucket } from '../api'
import { ageSegments, moneyText, RECEIVABLES_NAMESPACE } from '../model'

/**
 * AgeBar — the design's "NEW BarList" of finance.receivables (one area needs it, so it lives here, plan §7): a
 * customer's balance split by age as one bar (not due · 1–30 · 31–60 · 61–90 · over 90 days), each part as wide as its
 * share, with the amounts in words beside it for the screen reader and the legend under it (`legend`). Drawn only with
 * the price grain (the shares are amounts).
 */
export function AgeBar({ buckets, currency, legend = false }: { buckets: Readonly<Record<AgeingBucket, number>> | undefined; currency: string; legend?: boolean }) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const locale = useLocale()
  const segments = ageSegments(buckets)
  if (segments.length === 0) return <span className="fw-frv-muted">{t('bar.nothing')}</span>
  const said = segments
    .map((segment) =>
      t('bar.part', {
        bucket: t(`bucket.${segment.bucket}`),
        amount: moneyText(segment.amount, currency, locale),
      }),
    )
    .join(' · ')
  return (
    <span className="fw-frv-age" role="img" aria-label={said} title={said}>
      <span className="fw-frv-age-track">
        {segments.map((segment) => (
          <span key={segment.bucket} className={`fw-frv-age-part is-${segment.bucket}`} style={{ width: `${segment.pct}%` }} />
        ))}
      </span>
      {legend && (
        <span className="fw-frv-age-legend" aria-hidden>
          {segments.map((segment) => (
            <span key={segment.bucket} className={`fw-frv-age-key is-${segment.bucket}`}>
              {t(`bucket.${segment.bucket}`)} {moneyText(segment.amount, currency, locale)}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

/** A day (YYYY-MM-DD) in the person's format; '—' for none. */
export function dayText(day: string | null | undefined, locale: Locale): string {
  return day ? formatDate(`${day}T12:00:00Z`, { locale }) : '—'
}
