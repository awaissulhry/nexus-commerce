'use client'

import { EmptyState, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { QuoteSpeed } from '../../../reports/api'
import { speedTiles, tileHref, type SpeedCan } from '../model'
import '../speed.css'

export type SpeedRead = { status: 'loading' } | { status: 'ready'; value: QuoteSpeed } | { status: 'error'; problem: string }

/** SCR-428 — Quote speed's view model (the strip draws it and fetches nothing). */
export interface QuoteSpeedModel {
  readonly prefix: string
  readonly can: SpeedCan
  readonly read: SpeedRead
}

/**
 * Sales › Quotes › Quote speed (design sales.quotes sec quotes.speed; B-W2b-348): "How fast we answer and how often we win, this
 * month" — the median working time from new (the inquiry's arrival, else the quote's making) to the first send, the median time
 * from send to the customer's answer, the win rate (accepted ÷ decided; expired apart) and the value won (only with the price
 * grain). Each tile opens Sales reports for the same month (only with sales.reports.view). Loading: tile skeletons.
 */
export function QuoteSpeedStrip({ model, onRetry }: { model: QuoteSpeedModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['sales-reports']}>
      <Strip model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Strip({ model, onRetry }: { model: QuoteSpeedModel; onRetry?: (() => void) | undefined }) {
  const t = useT('sales-reports')
  const locale = useLocale()
  if (!model.can.quotes) return null
  const head = (
    <div className="fw-qsp-head">
      <h2 className="fw-qsp-h2" id="qsp-title">
        {t('speed.title')}
      </h2>
      <p className="fw-qsp-hint">{t('speed.hint')}</p>
    </div>
  )
  if (model.read.status === 'loading') {
    return (
      <section className="fw-qsp" aria-labelledby="qsp-title">
        {head}
        <div className="fw-qsp-shape" role="status" aria-label={t('speed.loading')}>
          {Array.from({ length: model.can.price ? 4 : 3 }, (_, index) => (
            <Skeleton key={index} height={84} radius={8} />
          ))}
        </div>
      </section>
    )
  }
  if (model.read.status === 'error') {
    return (
      <section className="fw-qsp" aria-labelledby="qsp-title">
        {head}
        <EmptyState
          title={t('speed.failed')}
          description={t(model.read.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('speed.retry')}
            </Button>
          }
        />
      </section>
    )
  }
  const answer = model.read.value
  const href = tileHref(model.prefix, model.can, { from: answer.from, to: answer.to })
  const metrics: Metric[] = speedTiles(answer, model.can, locale).map((tile) => {
    const value = 'text' in tile.value ? tile.value.text : t(tile.value.key, tile.value.params)
    const base = { label: t(`speed.tile.${tile.key}`), value, hint: t(tile.hint.key, tile.hint.params) }
    return href ? { ...base, href } : base
  })
  return (
    <section className="fw-qsp" aria-labelledby="qsp-title">
      {head}
      <MetricStrip metrics={metrics} minTileWidth={180} />
      <p className="fw-qsp-hint">{[t('speed.definition'), href ? t('speed.opens') : t('speed.noReports'), answer.complete ? null : t('speed.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
