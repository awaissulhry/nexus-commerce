'use client'

import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { leftWords, validityOf, type ValidityInput, type ValidityStage } from './validity'
import './validity.css'

/**
 * ValidityBar — a compliance area part (design "ValidityBar (new)": not in the DS yet; B-W2b-266, `compliance/_shared/validity`):
 * the validity span as a track, the part already gone, today's marker, the 180 / 90 / 30-day alert ticks, and the words under it
 * ("Valid 12 Mar 2024 – 11 Mar 2029 · 3 years 4 months left"). `mini` is the grid-cell form: a thin track and the words left.
 * The track is `role="img"` with the same words: never a colour alone. Its words live in `compliance-status` (`validity.*`).
 *
 *   <ValidityBar from="2024-03-12" to="2029-03-11" today="2026-11-10" />
 *   <ValidityBar mini from={null} to="2026-12-08" today="2026-11-10" />
 */
export function ValidityBar(props: ValidityInput & { readonly mini?: boolean; readonly label?: string }) {
  return (
    <WithMessages namespaces={['compliance-status']}>
      <Bar {...props} />
    </WithMessages>
  )
}

/** The words of what is left ("3 years 4 months left", "28 days left", "Ends today", "Ended 3 days ago"). */
export function useValidityWords(): (input: ValidityInput) => { left: string; stage: ValidityStage } {
  const t = useT('compliance-status')
  return (input) => {
    const validity = validityOf(input)
    const parts = leftWords(validity)
    const left = validity.daysLeft <= 0 ? t(parts[0]!.key, parts[0]!.params) : t('validity.left', { parts: parts.map((part) => t(part.key, part.params)).join(' ') })
    return { left, stage: validity.stage }
  }
}

function Bar({ from, to, today, mini = false, label }: ValidityInput & { readonly mini?: boolean; readonly label?: string | undefined }) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const words = useValidityWords()
  const validity = validityOf({ from, to, today })
  const { left } = words({ from, to, today })
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const span = from ? t('validity.span', { from: day(from), to: day(to) }) : t('validity.until', { to: day(to) })
  const stage = t(`validity.stage.${validity.stage}`)
  const said = [label, span, left, stage].filter(Boolean).join(' · ')
  // Without a first day the track is the alert window: today's place in the last 180 days.
  const gone = validity.todayAt ?? Math.min(100, Math.max(0, ((180 - Math.max(0, validity.daysLeft)) / 180) * 100))
  return (
    <span className={`fw-vb${mini ? ' fw-vb-mini' : ''}`} data-stage={validity.stage}>
      <span className="fw-vb-track" role="img" aria-label={said}>
        <span className="fw-vb-gone" style={{ width: `${gone}%` }} />
        {!mini && validity.alerts.map((alert) => <span key={alert.days} className="fw-vb-alert" style={{ left: `${alert.at}%` }} title={t('validity.alertAt', { days: alert.days })} />)}
        {validity.todayAt !== null || !from ? <span className="fw-vb-today" style={{ left: `${gone}%` }} /> : null}
      </span>
      <span className="fw-vb-words" aria-hidden>
        {mini ? (
          left
        ) : (
          <>
            <span>{span}</span>
            <span className="fw-vb-left">{left}</span>
            {validity.alert !== null ? <span>{t('validity.inAlert', { days: validity.alert })}</span> : null}
          </>
        )}
      </span>
    </span>
  )
}
