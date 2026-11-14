'use client'

import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Grains } from '../../../model'
import { decimalText, moneyText } from '../../../model'
import type { BySizeView, VersionRow } from '../../versions/api'
import { CS_NS, type CostSheetAbilities, type Phrase, type Read } from '../../versions/model'
import { sizeRowsOf, surchargeHeld } from '../model'

export interface BySizeModel {
  readonly sheet: VersionRow | null
  readonly result: Read<BySizeView>
  readonly can: CostSheetAbilities
  readonly grains: Grains
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly notice: Phrase | null
}

export interface BySizeActions {
  onUse?: (row: { size: string; amount: string; currency: string }) => void
  onRetry?: () => void
}

/**
 * SCR-504 — Style › Cost › Cost by size with the suggested size surcharge for big sizes (design products.styles
 * style.cost.bysize; FIN-016): for the version in view, each size's cost, how far above the base size it is, the price
 * surcharge that keeps the version's target margin (rounded up to the cent; only for sizes at least the threshold above the
 * base size) and the style's own surcharge now. "Use this surcharge" sets the style's surcharge for that size (sales'
 * price rule; the price lists read it). Figures by grain: costs with the cost grain, surcharges with the price grain.
 */
export function BySizeCard({ model, actions }: { model: BySizeModel; actions?: BySizeActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const header = t('bysize.title')
  const sheet = model.sheet
  if (!sheet)
    return (
      <Card header={header}>
        <EmptyState title={t('goal.noVersion')} description={t('bysize.noVersionBody')} />
      </Card>
    )
  const part = model.result
  if (part.status === 'idle' || part.status === 'loading')
    return (
      <Card header={header} aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('bysize.loading')}
        </p>
      </Card>
    )
  if (part.status === 'error')
    return (
      <Card header={header}>
        <EmptyState title={t('bysize.failed')} description={t(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('csCommon.retry')}</Button>} />
      </Card>
    )
  const view = part.value
  const rows = sizeRowsOf(view)
  const cost = (value: string | null | undefined) => (model.grains.cost && value !== null && value !== undefined ? moneyText(value, view.sheet.currency, locale) : null)
  const price = (value: string | null | undefined, currency = view.sheet.currency) => (model.grains.price && value !== null && value !== undefined ? moneyText(value, currency, locale) : null)
  const currentWords = (current: (typeof rows)[number]['current']) => {
    if (!current || (!current.amount && !current.pct)) return t('bysize.noneNow')
    if (current.amount) return price(current.amount, current.currency ?? view.sheet.currency) ?? '·'
    return `+${decimalText(current.pct, locale, 2)} %`
  }
  const anySuggested = rows.some((row) => row.suggestedFor)
  return (
    <Card header={header} description={t('bysize.intro', { version: view.sheet.sheetVersion, pct: decimalText(view.fromPct, locale) })}>
      <div className="fw-st-stack">
        {model.notice && <Banner tone="success" title={t(model.notice.key, model.notice.params)} />}
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <SummaryTable
          label={header}
          density="roomy"
          stackOnPhone
          columns={[
            t('bysize.col.size'),
            ...(model.grains.cost ? [t('bysize.col.cost'), t('bysize.col.above')] : []),
            ...(model.grains.price ? [t('bysize.col.suggested'), t('bysize.col.now')] : []),
            ...(model.grains.price ? [t('bysize.col.use')] : []),
          ]}
          align={[undefined, ...(model.grains.cost ? (['right', 'right'] as const) : []), ...(model.grains.price ? (['right', 'right', 'right'] as const) : [])]}
          widths={model.grains.cost && model.grains.price ? ['13%', '15%', '20%', '17%', '17%', undefined] : undefined}
          rows={rows.map((row) => {
            const held = surchargeHeld(row, model.can, model.grains, view.sheet.currency, model.busy)
            return {
              id: row.size,
              cells: [
                <span key="s" className="fw-st-inline">
                  <b>{row.size}</b>
                  {row.base && <Tag tone="neutral">{t('bysize.base')}</Tag>}
                </span>,
                ...(model.grains.cost
                  ? [
                      row.complete ? (cost(row.total) ?? '·') : <span key="c" className="fw-st-hint">{t('ver.notKnown')}</span>,
                      row.base ? '—' : row.extraCost ? `+${cost(row.extraCost)} · +${decimalText(row.extraPct, locale, 2)} %` : <span key="e" className="fw-st-hint">{t('bysize.belowThreshold')}</span>,
                    ]
                  : []),
                ...(model.grains.price
                  ? [
                      row.suggested ? <b key="p">+{price(row.suggested)}</b> : row.suggestedFor ? <span key="p" className="fw-st-hint">{t('bysize.noTarget')}</span> : '—',
                      currentWords(row.current),
                      row.suggestedFor ? (
                        <Button key="u" size="sm" aria-label={t('bysize.useLabel', { size: row.size })} heldReason={held ? t(held.key, held.params) : null} onClick={() => row.suggested && actions?.onUse?.({ size: row.size, amount: row.suggested, currency: view.sheet.currency })}>
                          {t('bysize.use')}
                        </Button>
                      ) : (
                        ''
                      ),
                    ]
                  : []),
              ],
            }
          })}
        />
        {!anySuggested && <p className="fw-st-hint">{t('bysize.noneBig', { pct: decimalText(view.fromPct, locale) })}</p>}
        {model.grains.cost && view.weights.weighted && (
          <p className="fw-st-hint">{t('bysize.weighted', { amount: cost(view.weights.weighted) ?? '—' })}</p>
        )}
        {!model.grains.cost && !model.grains.price && <p className="fw-st-hint">{t('bysize.noGrain')}</p>}
      </div>
    </Card>
  )
}
