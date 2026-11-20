'use client'

import { Factory } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money, unitPrice } from '../../../../quotes/model'
import type { Order } from '../../../api'
import { extraChoicesOf, heldWordsOf, issuePhrases, outcomeHeld, stripWorkOrderOf, workOrderWords, type CellFloors } from '../../../daily-model'
import { frozenOffer, frozenProblemsOf } from '../../../depth/model'
import type { Freeze } from '../../../depth/api'
import { ExtraPieces } from '../../../../../home/approvals/requests/view/ExtraPieces'
import { ConversationTick } from '../../../../../home/approvals/requests/view/ConversationTick'
import { askDefaultOf, bodyLinesOf, feeProblem, piecesBeforeAfter, reasonOf, reviewEntriesOf, WHY_PICKS, type LinesDraft } from '../../lines-draft'
import type { LinesTabActions, ReviewState } from '../../lines-tab-model'
import { lineNameOf } from './StyleTable'

/**
 * F-OL-03 (Order LINES lane; 10-design-tab §12 as settled by 18-lead-settles F10, F22, F25) — "Review and save": ONE centred window
 * before anything is saved — what changes per line (sizes before → after; the price and line totals only for price readers), the
 * order total before → after (Sales: the pieces only, and at most "the amount changes": never which way), what production does (the
 * preview's work orders), pieces already cut beyond the new figures pre-picked "Keep for this customer", Why (optional) with quick
 * picks, ONE tick "Ask {customer} to accept the new order" (price readers: on when the total goes up; Sales: on when the amount
 * changes; a company lock asks it by its rule), words for the customer + "Also write it in the order's conversation", Back · Save
 * changes. A change a company rule froze is the SAME window (its fee optional, 0 allowed; Sales saves it with no money: the customer
 * is asked). Someone saved meanwhile: it says so at the top and asks its preview again. Fetches nothing.
 */
export function ReviewSave({ order, draft, review, seesPrices, freeze, floors, portalGone, saving, actions }: { order: Order; draft: LinesDraft; review: ReviewState; seesPrices: boolean; freeze: Freeze | null; floors: CellFloors; portalGone: boolean; saving: boolean; actions?: LinesTabActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const preview = review.phase === 'ready' ? review.preview : null
  const entries = reviewEntriesOf(draft, order, { seesPrices, floors })
  const diff = preview?.diff ?? null
  const customer = order.party?.legalName ?? ''
  // The freeze rules' refusals are the priced path (the same window); the rest are said by place.
  const frozen = preview && !preview.ok ? frozenProblemsOf(preview.problems) : []
  const offer = frozen.length > 0 ? frozenOffer(frozen, freeze) : null
  const priced = offer === 'priced'
  const body = bodyLinesOf(draft, order)
  const label = (index: number) => {
    const line = body[index]
    if (!line) return null
    return 'id' in line ? lineNameOf(order, draft, line.id) : (draft.added.find((entry) => entry.styleId === line.styleId && entry.colourwayId === line.colourwayId)?.colour ?? null)
  }
  const problems = preview && !preview.ok ? issuePhrases(preview.problems.filter((issue) => frozenProblemsOf([issue]).length === 0), label) : []
  const ask = priced ? true : (review.ask ?? askDefaultOf(preview, seesPrices))
  const extraHeld = preview ? outcomeHeld(preview.workOrders, review.extraOutcome) : null
  const held = saving
    ? t('held.busy')
    : review.phase === 'reading'
      ? t('review.held.reading')
      : review.phase === 'failed'
        ? t('review.held.failed')
        : problems.length > 0
          ? t('review.held.problems')
          : offer === 'blocked'
            ? t('review.held.blocked')
            : priced && seesPrices && feeProblem(review.fee)
              ? t('review.held.fee')
              : extraHeld
                ? heldWordsOf(extraHeld, t, locale)
                : null
  const why = (pick: (typeof WHY_PICKS)[number]) => t(`review.whyPick.${pick}`)
  const go = () => actions?.onSave?.({ reason: reasonOf(review.why, review.words, why), question: review.tell.words.trim() || t('review.question', { number: order.number }) })
  const pieces = piecesBeforeAfter(draft, order)
  const vat = order.priceBasis === 'GROSS' || (order.vatAmount ?? 0) > 0
  const before = vat ? diff?.grossAmountBefore : diff?.netAmountBefore
  const after = vat ? diff?.grossAmountAfter : diff?.netAmountAfter
  const signed = (delta: number, text: (n: number) => string) => `${delta >= 0 ? '+' : '−'}${text(Math.abs(delta))}`
  const workOrders = (preview?.workOrders?.plan ?? []).map(stripWorkOrderOf)
  const tick = { chosen: review.tell.chosen, reach: portalGone ? ('none' as const) : ('portal' as const) }
  const priceOf = (lineId: string | null) => (lineId ? (diff?.prices ?? []).find((entry) => entry.lineId === lineId) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onReviewClose?.()}
      title={t('review.title', { number: order.number })}
      size="lg"
      footer={
        <>
          <span className="fw-so-hint">{t('review.nothingSent')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onReviewClose?.()}>
            {t('review.back')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {saving ? t('save.saving') : t('review.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lt-review"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            go()
          }
        }}
      >
        {review.changedMeanwhile && <Banner tone="info" title={t('review.changed')} />}
        {review.problem && <Banner tone="danger" title={t(review.problem.key, review.problem.params)} />}
        <section aria-label={t('review.what')}>
          <h3 className="fw-so-h3">{t('review.what')}</h3>
          <ul className="fw-so-list">
            {entries.map((entry) => {
              const name = lineNameOf(order, draft, entry.key)
              if (entry.kind === 'added') {
                const added = draft.added.find((line) => line.key === entry.key)
                const own = diff?.lines.find((line) => line.change === 'ADDED' && line.styleId === added?.styleId && line.colourwayId === added?.colourwayId)
                const price = priceOf(own?.lineId ?? null)
                return (
                  <li key={entry.key}>
                    <strong>{`${added?.style.code ?? ''} ${name}`.trim()}</strong> · {t('review.added', { count: entry.pieces })}
                    {seesPrices && price && ` · ${money(price.netAfter, order.currency, locale)}`}
                  </li>
                )
              }
              const line = order.lines.find((row) => row.id === entry.key)
              const title = t('review.line', { seq: entry.seq, name: `${line?.style?.code ?? ''} ${name}`.trim() })
              if (entry.kind === 'removed')
                return (
                  <li key={entry.key}>
                    <strong>{title}</strong> · {t(entry.closesShort ? 'review.closesShort' : 'review.removed')}
                  </li>
                )
              const price = priceOf(entry.key)
              const parts = [
                ...(entry.sizes.length > 0 ? [entry.sizes.map((size) => `${size.size}: ${size.before} → ${size.after}`).join(' · ')] : []),
                ...(entry.price ? [t('review.price', { before: unitPrice(entry.price.before, order.currency, locale), after: unitPrice(entry.price.after, order.currency, locale) })] : []),
                ...(entry.notes ? [t('review.notes')] : []),
              ]
              return (
                <li key={entry.key}>
                  <strong>{title}</strong> · {parts.join(' · ')}
                  {entry.piecesBefore !== entry.piecesAfter && ` · ${t('review.pieces', { before: entry.piecesBefore, after: entry.piecesAfter, delta: signed(entry.piecesAfter - entry.piecesBefore, String) })}`}
                  {seesPrices && price && price.netBefore !== price.netAfter && ` · ${money(price.netBefore, order.currency, locale)} → ${money(price.netAfter, order.currency, locale)}`}
                </li>
              )
            })}
          </ul>
        </section>
        <div className="fw-lt-review-total">
          {seesPrices ? (
            before !== undefined && after !== undefined ? (
              <span>{t(vat ? 'review.totalVat' : 'review.total', { before: money(before, order.currency, locale), after: money(after, order.currency, locale), delta: signed(after - before, (n) => money(n, order.currency, locale)) })}</span>
            ) : review.phase === 'reading' ? (
              <span className="fw-so-hint" role="status">
                <Spinner size={12} /> {t('review.held.reading')}
              </span>
            ) : null
          ) : (
            <>
              <span>{t('review.pieces', { before: pieces.before, after: pieces.after, delta: signed(pieces.after - pieces.before, String) })}</span>
              {preview?.amountChanges && <span className="fw-so-hint">{t('review.amountNeutral')}</span>}
            </>
          )}
        </div>
        {!seesPrices && <p className="fw-so-hint">{t('held.noPrice')}</p>}
        {review.phase === 'failed' && (
          <p className="fw-so-hint" role="alert">
            {t('review.held.failed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onReviewRetry?.()}>
              {t('common.retry')}
            </Button>
          </p>
        )}
        {problems.length > 0 && (
          <Banner tone="danger" title={t('review.problems', { count: problems.length })}>
            <ul className="fw-so-list">
              {problems.map((entry, index) => (
                <li key={`${entry.key}-${index}`}>{t(entry.key, entry.params)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {offer === 'blocked' && <Banner tone="danger" title={t('review.blocked')} />}
        {priced && <Banner tone="warning" title={t('review.priced')} />}
        {preview && (
          <section aria-label={t('review.production')}>
            <h3 className="fw-so-h3">
              <Factory size={14} aria-hidden /> {t('review.production')}
            </h3>
            {workOrders.length === 0 ? (
              <p className="fw-so-hint">{t('review.noWo')}</p>
            ) : (
              <ul className="fw-so-list">
                {workOrders.map((wo) => (
                  <li key={wo.key}>{workOrderWords(wo, t, locale)}</li>
                ))}
              </ul>
            )}
          </section>
        )}
        {preview?.workOrders && preview.workOrders.extra.length > 0 && <ExtraPieces name={`fw-lt-extra-${order.id}`} {...extraChoicesOf(preview.workOrders, order, seesPrices)} chosen={review.extraOutcome} onChoose={actions?.onReviewOutcome} />}
        {priced && seesPrices && (
          <Field label={t('review.fee')} hint={t('review.feeHint', { currency: order.currency })} error={feeProblem(review.fee) ? t('review.held.fee') : undefined}>
            <Input value={review.fee} inputMode="decimal" placeholder="0,00" autoComplete="off" onChange={(event) => actions?.onReviewFee?.(event.target.value)} />
          </Field>
        )}
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend">{t('review.why')}</legend>
          <span className="fw-lt-chips">
            {WHY_PICKS.map((pick) => (
              <Pill key={pick} tone={review.why === pick ? 'info' : 'neutral'} pressed={review.why === pick} onClick={() => actions?.onReviewWhy?.(review.why === pick ? null : pick)}>
                {why(pick)}
              </Pill>
            ))}
          </span>
          <Textarea rows={1} honourRows value={review.words} maxLength={1000} aria-label={t('review.whyWords')} placeholder={t('review.whyWords')} onChange={(event) => actions?.onReviewWords?.(event.target.value)} />
          <span className="fw-so-hint">{t('review.whyHint')}</span>
        </fieldset>
        {order.party && (
          <fieldset className="fw-so-choices">
            <legend className="fw-so-legend">{t('review.customer')}</legend>
            {priced ? (
              <p className="fw-so-hint">{t('review.askRule')}</p>
            ) : (
              <>
                <Checkbox checked={ask} onChange={(event) => actions?.onReviewAsk?.(event.target.checked)} label={t('review.ask', { customer })} />
                <span className="fw-so-hint">{ask ? (review.ask === null ? t(seesPrices ? 'review.askUp' : 'review.askChanges') : t('review.askOn')) : t('review.askOff')}</span>
              </>
            )}
            <Field label={t('amend.tell.words')} hint={t('amend.tell.hint')}>
              <Textarea rows={2} honourRows value={review.tell.words} maxLength={2000} onChange={(event) => actions?.onReviewTell?.({ words: event.target.value })} />
            </Field>
            <ConversationTick id={`lines-review-${order.id}`} tick={tick} words={review.tell.words} customer={customer} onTick={(on) => actions?.onReviewTell?.({ chosen: on })} />
          </fieldset>
        )}
      </div>
    </Modal>
  )
}
