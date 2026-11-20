'use client'

import { Card, KeyValue } from '@nexus/ui/components'
import { Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { FreshnessLine } from '../../../../../../lib/production/view/FreshnessLine'
import { HealthPill } from '../../../../../../lib/production/view/HealthPill'
import { StageStrip } from '../../../../../../lib/production/view/StageStrip'
import { WaitingOnPill } from '../../../../../../lib/production/view/WaitingOnPill'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { healthInputOf, readOf, rowWordsOf, type WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE waiting list's state
import { exFactoryOf, headlineOf, inWorkOf, preparingNote, stageStripOf } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { said } from '../../../../../home/approvals/requests/model' // F-OP-301: a Still to do row's words in Who acts next
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'

/**
 * F-OO-100 (order overview lane: one file per card) — "Where it is now", moved out of OverviewTab.tsx unchanged (F-SA-232: the plain
 * stage and "1 line ahead" — or before / after production the commercial words —, who acts next, the ex-factory date and how often
 * it moved, the health, the customer's own urgency, the bundles in work as counts, the five plain stages with the blocked mark,
 * "Live · as of 10:42"). The ONE waiting list comes from OverviewTab (its one call).
 */
export function WhereCard({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting: WaitingState }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the stages' door keeps the dock's scope
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const loading = !state || state.status === 'loading'
  const words = headlineOf(order, headline)
  const sentence =
    words.kind === 'stage'
      ? [w.t(`parts.stage.${words.stage}`), words.ahead ? t(words.ahead.key, words.ahead.params) : null].filter(Boolean).join(' · ')
      : words.kind === 'unknown'
        ? w.t('parts.stage.unknown')
        : t(words.phrase.key, Object.fromEntries(Object.entries(words.phrase.params ?? {}).map(([key, value]) => [key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const strip = stageStripOf(order, headline, read?.dates ?? null, locale)
  const preparing = preparingNote(order, headline)
  const exFactory = exFactoryOf(order, headline)
  const health = healthInputOf(order, headline, read?.dates ?? null)
  const inWork = inWorkOf(headline)
  // F-OP-103: who acts next is the ONE waiting list's first row (its since is the card's).
  // F-OP-301 (walk #2): else the card's oldest Still to do row, else the card's own "Nothing waits" — never the kept state alone.
  const next = waiting.status === 'ready' ? waiting.next : null
  const what = next?.row ? rowWordsOf(next.row, { t, kindWords: (kind) => w.t(`parts.request.kind.${kind}`), locale, customer: order.party?.legalName ?? '' }) : next?.still ? said(next.still.words, locale) : null
  const facts = [
    {
      label: t('overview.fact.who'),
      value:
        next?.who === null && !loading ? (
          <span className="fw-so-hint">{t('overview.requests.nothing')}</span>
        ) : (
          <WaitingOnPill face="office" loading={loading} who={next ? next.who : undefined} since={next?.since ?? null} kind={next?.kind ?? 'record'} what={what} />
        ),
    },
    ...(exFactory ? [{ label: t('overview.fact.exFactory'), value: t(exFactory.key, { ...exFactory.params, date: formatDate(dayInstant(String(exFactory.params?.date ?? '')), { locale }) }) }] : []),
    { label: t('overview.fact.health'), value: <HealthPill face="office" loading={loading} {...health} /> },
    ...(headline?.urgency.customer?.code === 'URGENT' ? [{ label: t('overview.fact.customer'), value: <Tag tone="warning">{t('board.customerUrgent')}</Tag> }] : []),
    ...(inWork ? [{ label: t('overview.fact.inWork'), value: t('overview.bundles', { count: inWork.count, stage: w.t(`parts.stage.${inWork.stage}`) }) }] : []),
  ]
  return (
    <Card padded className="fw-so-where">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.where')}</h2>
        <FreshnessLine mode={model.liveState === 'live' ? 'live' : model.liveState === 'offline' ? 'offline' : 'connecting'} asOf={read?.asOf ?? null} />
      </div>
      {loading ? <Skeleton width={260} height={24} /> : <p className="fw-so-headline">{sentence}</p>}
      <KeyValue dense labelCase="sentence" columns={2} items={facts} />
      {/* F-OP-104: the stages are one real link to Production's work orders (the ex-factory date and its moves are the facts' line). */}
      <StageStrip
        face="office"
        layout="auto"
        label={t('overview.where')}
        {...strip}
        note={preparing ? t(preparing.key) : (strip.note ?? null)}
        stageHref={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#work-orders`}
        stageLinkLabel={t('doors.stages', { stage: strip.stage ? w.t(`parts.stage.${strip.stage}`) : w.t('parts.stage.unknown') })}
        loading={loading}
        problem={state?.status === 'failed'}
        onRetry={() => actions?.onRetryProduction?.()}
      />
    </Card>
  )
}
