'use client'

import { ProgressBar } from '@nexus/ui/components'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import '../credit.css'

/**
 * The share of a credit limit used (B-W2b-304): the DS ProgressBar as a meter, filled to 100 at most, with the real
 * percentage beside it (a customer over the limit reads "106 %", never a capped 100) and the tone of the reading
 * (within, close from 80 %, over). Composed here: the DS meter prints the capped value.
 */
export function UsedMeter({ pct, label, over = false }: { pct: number | null; label: string; over?: boolean }) {
  const locale = useLocale()
  const tone = pct === null ? 'unknown' : over || pct > 100 ? 'missing' : pct >= 80 ? 'partial' : 'complete'
  return (
    <span className="fw-frc-meter">
      <ProgressBar ariaLabel={label} value={pct === null ? null : Math.min(pct, 100)} tone={tone} />
      <span className={`fw-frc-meter-num${tone === 'missing' ? ' fw-frv-tone is-danger' : ''}`}>{pct === null ? '—' : `${formatNumber(pct, locale)}%`}</span>
    </span>
  )
}
