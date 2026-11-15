'use client'

import { Pill } from '@nexus/ui/primitives'
import { Countdown } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { DataRequest } from '../api'
import { CLOCK_PILL, clockTone } from '../model'

/** The 30-day clock in words: a live countdown while open, late since the due day, or when it closed. */
export function Clock({ request, now, timeZone }: { request: DataRequest; now: number; timeZone: string }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const place = { locale, timeZone }
  const tone = clockTone(request)
  if (tone === 'closed') return <span className="fw-dprq-sub">{request.decidedAt ? t('dp.req.due.closed', { date: formatDate(request.decidedAt, place) }) : '—'}</span>
  return (
    <span className="fw-dprq-clock">
      <Pill tone={CLOCK_PILL[tone]}>
        {tone === 'late' ? (
          t('dp.req.due.late', { date: formatDate(request.dueAt, place) })
        ) : (
          <Countdown to={request.dueAt} now={now} announce={false} label={(left) => t('dp.req.due.in', { left })} doneLabel={t('dp.req.due.now')} />
        )}
      </Pill>
      {request.extended && <span className="fw-dprq-sub">{t('dp.req.due.extended')}</span>}
    </span>
  )
}
