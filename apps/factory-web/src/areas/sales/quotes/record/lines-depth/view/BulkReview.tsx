'use client'

import { Field } from '@nexus/ui/components'
import type { ReviewPanelChange } from '@nexus/ui/patterns'
import { Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, ReviewChangesModal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { percent, unitPrice } from '../../../model'
import type { GoalAnswer } from '../../goalseek/api'
import { SIZE_CHANGE_KINDS, type FillAnswer, type SizeChangeKind, type SizeCurve, type SizesAnswer } from '../api'
import { bulkProblemWords, movesText, reviewStateOf, sizesText, type DepthReviewState, type Words } from '../model'
import { useDepthWords } from '../words'

export type BulkReviewKind = 'fill' | 'price' | 'discount' | 'sizes' | 'delivery' | 'remove'

export interface BulkLine {
  id: string
  /** "10 · SEED-JKT-01 BLK" */
  label: string
  sizes: Record<string, number>
  /** The style's sizes in order. */
  order: readonly string[]
  /** The line's delivery now: null = everything at the promise date. */
  delivery: { first: string; count: number } | null
}

export interface BulkReviewModel {
  kind: BulkReviewKind
  /** The lines it reaches. */
  lines: readonly BulkLine[]
  currency: string
  /** The value typed above the table: a price, a percent, pieces or a day. */
  value: string
  sizeKind: SizeChangeKind
  /** Fill by curve: the curves of the style's scale, the one picked, the total per line. */
  curves?: { status: 'loading' | 'ready' | 'error'; items: readonly SizeCurve[] }
  curveId?: string
  totals?: Readonly<Record<string, string>>
  /** The plan the API answered (price / discount: goal-seek; sizes; fill) for the value typed; null until asked. */
  preview: GoalAnswer | SizesAnswer | FillAnswer | null
  /** The review's state (reading while the plan is asked, then ready; saving; done with a result per line). */
  state: DepthReviewState
  /** Why Save waits on the form (the host's words), or null. */
  leadHeld: Words | null
  today: string
  grains: { price: boolean; margin: boolean }
}

export interface BulkReviewActions {
  onValue?: (value: string) => void
  onSizeKind?: (kind: SizeChangeKind) => void
  onCurve?: (curveId: string) => void
  onTotal?: (lineId: string, value: string) => void
  onSave?: () => void
  onClose?: () => void
  onRetry?: () => void
}

const isGoal = (answer: BulkReviewModel['preview']): answer is GoalAnswer => !!answer && 'held' in answer
const isFill = (answer: BulkReviewModel['preview']): answer is FillAnswer => !!answer && 'source' in answer

/**
 * The review every bulk change of the quote's lines goes through before it writes (design quote.lines.table "through
 * ReviewChangesModal (old → new, Done)", quote.lines.blocks "Fill by curve"): the form above the table (a price, a discount,
 * how the sizes change, a curve and its totals, a delivery day), the table old → new per line from the API's preview (the
 * same call writes it without `preview`), the lines a rule holds as problems in this screen's words, then Save and Done.
 */
export function BulkReview({ model, actions }: { model: BulkReviewModel; actions?: BulkReviewActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const labelOf = (lineId: string) => model.lines.find((line) => line.id === lineId)?.label ?? '—'
  const orderOf = (lineId: string) => model.lines.find((line) => line.id === lineId)?.order ?? []
  const deliveryWords = (line: BulkLine) => (line.delivery ? t(line.delivery.count > 1 ? 'table.deliveryMany' : 'table.deliveryOne', { date: day(line.delivery.first), count: line.delivery.count }) : t('table.atPromise'))

  let changes: ReviewPanelChange[] = []
  let problems: string[] = []
  const preview = model.preview
  if ((model.kind === 'price' || model.kind === 'discount') && isGoal(preview)) {
    changes = preview.lines.map((line) => ({
      id: line.lineId,
      where: labelOf(line.lineId),
      what: t('review.what.unitPrice'),
      now: unitPrice(line.from.unitPrice, model.currency, locale),
      next: unitPrice(line.to.unitPrice, model.currency, locale),
      note: [
        line.discountPct ? t(Number(line.discountPct) < 0 ? 'review.raise' : 'review.discount', { pct: percent(String(Math.abs(Number(line.discountPct))), locale) }) : null,
        model.grains.margin && line.to.marginPct !== undefined && line.to.marginPct !== null ? t('review.margin', { pct: percent(line.to.marginPct, locale) }) : null,
        line.belowFloor ? sales('lines.belowFloor') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    }))
    problems = preview.held.map((held) => t(`review.held.${held.code}`, { line: labelOf(held.lineId) }))
  } else if ((model.kind === 'sizes' || model.kind === 'fill') && preview && !isGoal(preview)) {
    changes = preview.lines
      .filter((line) => line.moves.length > 0)
      .map((line) => {
        const fill = isFill(preview) ? preview.lines.find((entry) => entry.lineId === line.lineId)?.fill ?? null : null
        return {
          id: line.lineId,
          where: labelOf(line.lineId),
          what: t('review.what.sizes'),
          now: sizesText(line.before, orderOf(line.lineId)) || '—',
          next: sizesText(line.after, orderOf(line.lineId)) || '—',
          note: [
            movesText(line.moves),
            t('review.pieces', { from: line.pieces.before, to: line.pieces.after }),
            fill && fill.leftOut.length > 0 ? t('review.leftOutSizes', { sizes: fill.leftOut.join(' · ') }) : null,
            fill?.remainder ? t('review.remainder', { size: fill.remainder.size, pieces: fill.remainder.pieces }) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      })
    problems = preview.lines.flatMap((line) => line.problems.map((problem) => say(bulkProblemWords(problem, labelOf(line.lineId)))))
  } else if (model.kind === 'delivery' && /^\d{4}-\d{2}-\d{2}$/.test(model.value)) {
    changes = model.lines.map((line) => ({ id: line.id, where: line.label, what: t('review.what.delivery'), now: deliveryWords(line), next: t('review.allOn', { date: day(model.value) }) }))
  } else if (model.kind === 'remove') {
    changes = model.lines.map((line) => ({ id: line.id, where: line.label, what: t('review.what.line'), now: sizesText(line.sizes, line.order) || '—', next: t('review.removed') }))
  }

  const lead = (() => {
    switch (model.kind) {
      case 'price':
        return (
          <Field label={t('review.lead.price')} hint={t('review.lead.priceHint')}>
            <Input inputMode="decimal" value={model.value} onChange={(event) => actions?.onValue?.(event.target.value)} autoFocus />
          </Field>
        )
      case 'discount':
        return (
          <Field label={t('review.lead.discount')} hint={t('review.lead.discountHint')}>
            <Input inputMode="decimal" value={model.value} onChange={(event) => actions?.onValue?.(event.target.value)} autoFocus />
          </Field>
        )
      case 'sizes':
        return (
          <div className="fw-qd-lead">
            <SegmentedControl ariaLabel={t('review.lead.sizeKind')} value={model.sizeKind} onChange={(value) => actions?.onSizeKind?.(value as SizeChangeKind)} options={SIZE_CHANGE_KINDS.map((kind) => ({ value: kind, label: t(`review.sizeKind.${kind}`) }))} />
            <Field label={t(`review.lead.sizeValue.${model.sizeKind}`)} hint={t(`review.lead.sizeHint.${model.sizeKind}`)}>
              <Input inputMode="decimal" value={model.value} onChange={(event) => actions?.onValue?.(event.target.value)} />
            </Field>
          </div>
        )
      case 'fill':
        return (
          <div className="fw-qd-lead">
            <Field label={t('fill.curve')} hint={model.curves?.status === 'ready' && model.curves.items.length === 0 ? t('fill.noCurves') : t('fill.curveHint')}>
              {model.curves?.status === 'loading' ? (
                <span className="fw-q-hint" role="status">
                  <Spinner size={14} /> {t('common.loading')}
                </span>
              ) : (
                <Select value={model.curveId ?? ''} onChange={(event) => actions?.onCurve?.(event.target.value)} disabled={model.curves?.status !== 'ready' || model.curves.items.length === 0}>
                  <option value="">{t('fill.pick')}</option>
                  {(model.curves?.items ?? []).map((curve) => (
                    <option key={curve.id} value={curve.id}>
                      {curve.name} · {Object.entries(curve.shares).map(([size, share]) => `${size} ${percent(share, locale)}`).join(' · ')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="fw-qd-totals">
              {model.lines.map((line) => (
                <Field key={line.id} label={t('fill.totalOf', { line: line.label })}>
                  <Input inputMode="numeric" value={model.totals?.[line.id] ?? ''} onChange={(event) => actions?.onTotal?.(line.id, event.target.value)} />
                </Field>
              ))}
            </div>
            <p className="fw-q-hint">{t('fill.editable')}</p>
          </div>
        )
      case 'delivery':
        return (
          <Field label={t('review.lead.delivery')} hint={t('review.lead.deliveryHint')}>
            <DateField value={model.value} onChange={(value) => actions?.onValue?.(value)} locale={INTL_LOCALE[locale]} min={model.today} />
          </Field>
        )
      default:
        return undefined
    }
  })()

  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onClose?.()}
      title={t(`review.title.${model.kind}`, { count: model.lines.length })}
      summary={t('review.summary')}
      changes={changes}
      state={reviewStateOf(model.state, say)}
      problems={problems}
      lead={lead}
      leadHeld={model.leadHeld ? say(model.leadHeld) : null}
      saveLabel={t(`review.save.${model.kind}`, { count: changes.length })}
      onSave={() => actions?.onSave?.()}
      onRetry={() => actions?.onRetry?.()}
      doneVerb={t(model.kind === 'remove' ? 'review.verb.removed' : 'review.verb.saved')}
    />
  )
}
