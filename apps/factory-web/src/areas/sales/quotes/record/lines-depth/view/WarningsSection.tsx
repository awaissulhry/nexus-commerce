'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../model'
import type { QuoteWarnings } from '../api'
import { overdueOf, SEVERITY_TONE, warningTarget, warningWords } from '../model'
import { useDepthWords } from '../words'

export interface WarningsModel {
  state: { status: 'loading' } | { status: 'ready'; value: QuoteWarnings } | { status: 'error' }
  /** `/w/<company>` */
  prefix: string
  /** The quote's record address with `?tab=lines&line=` (Fix on a line opens it in the drawer). */
  lineBase: string
  /** The person sees prices (the overdue amount is the price grain). */
  price: boolean
}

/**
 * Lines › Warnings (design quote.lines.warnings, SAL-147; B-W2b-294's GET …/warnings): what could stop this deal before anyone
 * sends it — BLOCKS first (it stops the send), then what to know, then facts — each in W1's send-check words (or this
 * catalogue's), the lines it names, and Fix / Open to the place that settles it. Nothing shown when there is nothing to say.
 */
export function WarningsSection({ model, onRetry }: { model: WarningsModel; onRetry?: () => void }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  if (model.state.status === 'loading') return null
  if (model.state.status === 'error')
    return (
      <Banner
        tone="warning"
        title={t('warn.failed')}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  const { warnings, counts } = model.state.value
  if (warnings.length === 0) return null
  return (
    <Card padded className="fw-qd-warnings">
      <div className="fw-qd-head">
        <h2 className="fw-q-h2">
          <AlertTriangle size={16} aria-hidden /> {t('warn.title')}
        </h2>
        <span className="fw-q-hint">{[counts.blocks > 0 ? t('warn.countBlocks', { count: counts.blocks }) : null, counts.warnings > 0 ? t('warn.countWarnings', { count: counts.warnings }) : null, counts.info > 0 ? t('warn.countInfo', { count: counts.info }) : null].filter(Boolean).join(' · ')}</span>
      </div>
      <ul className="fw-qd-warnlist" aria-label={t('warn.title')}>
        {warnings.map((warning, index) => {
          const target = warningTarget(warning, model.prefix, (lineId) => `${model.lineBase}${encodeURIComponent(lineId)}`)
          const overdue = overdueOf(warning)
          return (
            <li key={`${warning.code}-${index}`} className="fw-qd-warn">
              <Pill tone={SEVERITY_TONE[warning.severity]}>{t(`warn.severity.${warning.severity}`)}</Pill>
              <span className="fw-qd-warn-text">
                <span>{say(warningWords(warning))}</span>
                {warning.seqs.length > 0 && <span className="fw-q-hint">{t('warn.lines', { count: warning.seqs.length, lines: warning.seqs.join(' · ') })}</span>}
                {overdue && (
                  <span className="fw-q-hint">
                    {[
                      overdue.invoices !== null ? t('warn.overdue.invoices', { count: overdue.invoices }) : null,
                      overdue.daysLate !== null ? t('warn.overdue.days', { count: overdue.daysLate }) : null,
                      model.price && overdue.amounts.length > 0 ? overdue.amounts.map((entry) => money(entry.amount, entry.currency, locale)).join(' · ') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
              {target && (
                <Link className="fw-qd-warn-go" href={target.href}>
                  {t(target.kind === 'open' ? 'warn.open' : 'warn.fix')}
                </Link>
              )}
            </li>
          )
        })}
      </ul>
      <p className="fw-q-hint">{t('warn.feedsSend')}</p>
    </Card>
  )
}
