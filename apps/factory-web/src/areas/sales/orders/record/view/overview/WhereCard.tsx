'use client'

import { Card } from '@nexus/ui/components'
import { Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { FreshnessLine } from '../../../../../../lib/production/view/FreshnessLine'
import { StageStrip } from '../../../../../../lib/production/view/StageStrip'
import type { Order } from '../../../api'
import type { Phrase } from '../../../model'
import { readOf, type WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE waiting list's state
import { headlineOf, stageStripOf, stagesShown } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import './where.css' // F-OO-103: the section 1 frame's own CSS

/**
 * F-OO-100 (order overview lane: one file per card) — "Where it is now".
 *
 * F-OO-103 (order overview §1.1, §1.6; review F8, F14): the section 1 frame. It keeps the title, "Live · as of 10:42", the headline
 * (the status and the stage, F-OO-101) with its quiet line, and the five stages with their link to Production's work orders and their
 * quiet line (F-OO-102). Between the headline and the stages sits the strips slot (one strip per hold or wait, most blocking first,
 * F-OO-104 / F-OO-105: they read OverviewTab's ONE waiting list, `waiting.holds`); under the stages the moves slot (the order's own
 * moves, F-OO-107). What left, each living on in ONE other place: Who acts next (Requests & changes' groups), Ex-factory and how it
 * moved (Next dates' Promised row), Health and the customer's Urgent (the band's chip and tag), Bundles in work (Progress by line's
 * counts), the deposit note on Preparing (the deposit strip).
 */
export function WhereCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /** OverviewTab's ONE waiting list: the strips slot reads its holds (F-OO-104). */ waiting: WaitingState }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the stages' door keeps the dock's scope
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const loading = !state || state.status === 'loading'
  // F-OO-101: the status word, then the stage word ("In production · Quality check"); dated words say their days in the page's way.
  const words = headlineOf(order, headline)
  const dated = (phrase: Phrase): string => t(phrase.key, Object.fromEntries(Object.entries(phrase.params ?? {}).map(([key, value]) => [key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const sentence = [words.status ? dated(words.status) : null, words.stage ? w.t(`parts.stage.${words.stage}`) : null].filter(Boolean).join(' · ')
  const quiet = words.note ? t(words.note.key, words.note.stage ? { stage: w.t(`parts.stage.${words.note.stage}`) } : undefined) : null
  const strip = stageStripOf(order, headline, read?.dates ?? null) // F-OO-102: the dots in the headline's own state
  // F-OP-301 (walk #2): section 1 names no wait at all now (Who acts next lives in Requests & changes' groups, F-OO-103), so it can
  // never say a stale "Waiting on us · 5 d" beside a card that says nothing waits — and it never reads the kept `headline.waiting`.
  return (
    <Card padded className="fw-so-where">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.where')}</h2>
        <FreshnessLine mode={model.liveState === 'live' ? 'live' : model.liveState === 'offline' ? 'offline' : 'connecting'} asOf={read?.asOf ?? null} />
      </div>
      <div className="fw-so-where-said">
        {loading ? <Skeleton width={260} height={24} /> : <p className="fw-so-headline">{sentence}</p>}
        {!loading && quiet ? <p className="fw-so-hint">{quiet}</p> : null}
      </div>
      {/* ---- F-OO-103: the strips slot — one strip per hold or wait, most blocking first, each with its real door (F-OO-104, F-OO-105) ---- */}
      {stagesShown(words.state) ? (
        <div className="fw-so-where-stages">
          {/* F-OP-104: the stages are one real link to Production's work orders. F-OO-102: drawn in the headline's own state. */}
          <StageStrip
            face="office"
            layout="auto"
            label={t('overview.where')}
            {...strip}
            stageHref={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#work-orders`}
            stageLinkLabel={words.state === 'ALL_DONE' ? t('where.stagesDone') : t('doors.stages', { stage: strip.stage ? w.t(`parts.stage.${strip.stage}`) : w.t('parts.stage.unknown') })}
            loading={loading}
            problem={state?.status === 'failed'}
            onRetry={() => actions?.onRetryProduction?.()}
          />
          {/* F-OO-102: derived, and it says so. */}
          {!loading && state?.status !== 'failed' ? <p className="fw-so-hint">{w.t('parts.stage.office.setBy')}</p> : null}
        </div>
      ) : null}
      {/* ---- F-OO-103: the moves slot — the order's own moves: Mark ready…, Hold the whole order…, More ▾ (F-OO-107, F-OO-108) ---- */}
    </Card>
  )
}
