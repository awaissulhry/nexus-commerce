'use client'

import { MetricStrip, type Metric } from '@nexus/ui/components'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { countText, pctText, quotesHref, valueText, workingTime } from '../model'
import { Head, NAMESPACE, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/**
 * Headline (design sec strip: "The period in five numbers" — order intake (value, units), backlog (value), quote win rate, median
 * quote speed, return rate; "Each tile opens the list filtered the same way"): the intake, backlog and return tiles open the
 * records they count (the lists take no period in their address); the quote tiles open Sales › Quotes (accepted, sent). A figure
 * of records outside the role says so, never 0; amounts only with the price grain (else pieces).
 */
export function HeadlinePanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.headline
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const head = <Head id="slr-strip" title={t('section.strip')} hint={t('strip.hint', { from: day(model.range.from), to: day(model.range.to) })} />
  const waiting = stateOf(read, t('strip.failed'), () => actions?.onRetry?.('strip'), { tiles: true })
  if (waiting || read.status !== 'ready') {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-strip">
        {head}
        {waiting}
      </section>
    )
  }
  const answer = read.value
  const price = answer.sight.values
  const outside = t('strip.notInRole')
  const time = workingTime(answer.quotes?.medianAnswerMinutes ?? null, locale)
  const decided = answer.quotes ? answer.quotes.accepted + answer.quotes.declined : 0
  const metrics: Metric[] = [
    answer.intake
      ? {
          label: t('strip.intake'),
          value: price ? valueText(answer.intake, locale) : t('common.pieces', { count: answer.intake.pieces }),
          hint: t('strip.intakeHint', { orders: countText(answer.intake.orders, locale), pieces: countText(answer.intake.pieces, locale) }),
          onClick: () => actions?.onDrill?.({ section: 'intake', bucket: null, group: null }),
        }
      : { label: t('strip.intake'), value: '—', hint: outside },
    answer.backlog
      ? {
          label: t('strip.backlog'),
          value: price ? valueText(answer.backlog, locale) : t('common.pieces', { count: answer.backlog.pieces }),
          hint: t('strip.backlogHint', { pieces: countText(answer.backlog.pieces, locale), late: countText(answer.backlog.late, locale) }),
          onClick: () => actions?.onDrill?.({ section: 'backlog', week: null, group: null, horizon: null }),
          ...(answer.backlog.late > 0 ? { accent: 'var(--nds-danger)' } : {}),
        }
      : { label: t('strip.backlog'), value: '—', hint: outside },
    answer.quotes
      ? {
          label: t('strip.winRate'),
          value: pctText(answer.quotes.winRatePct, locale),
          hint: decided > 0 ? t('strip.winHint', { accepted: answer.quotes.accepted, decided, expired: answer.quotes.expired }) : t('strip.winNone'),
          href: quotesHref(model.prefix, 'ACCEPTED'),
        }
      : { label: t('strip.winRate'), value: '—', hint: outside },
    answer.quotes
      ? {
          label: t('strip.speed'),
          value: time ? t(`time.${time.unit}`, { value: time.value }) : '—',
          hint: answer.quotes.answered > 0 ? t('strip.speedHint', { count: answer.quotes.answered }) : t('strip.speedNone'),
          href: quotesHref(model.prefix, 'SENT'),
        }
      : { label: t('strip.speed'), value: '—', hint: outside },
    answer.returns
      ? {
          label: t('strip.returnRate'),
          value: pctText(answer.returns.returnRatePct, locale),
          hint: answer.returns.shipped ? t('strip.returnHint', { pieces: countText(answer.returns.pieces, locale), shipped: countText(answer.returns.shipped, locale) }) : t('strip.returnNoShipped', { pieces: countText(answer.returns.pieces, locale) }),
          onClick: () => actions?.onDrill?.({ section: 'returns', by: null, key: null }),
        }
      : { label: t('strip.returnRate'), value: '—', hint: outside },
  ]
  return (
    <section className="fw-slr-panel" aria-labelledby="slr-strip">
      {head}
      <MetricStrip metrics={metrics} minTileWidth={180} />
      <p className="fw-slr-muted">{[price ? null : t('common.noPrice'), answer.complete ? null : t('common.incomplete')].filter(Boolean).join(' ') || t('strip.definition')}</p>
    </section>
  )
}
