'use client'

import { Box, Check, TriangleAlert } from 'lucide-react'
import { FloorButton, QuantityPad } from '@nexus/ui/floor'
import { formatNumber } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { HeldLine, TaskLine } from '../../../shared/view/TaskParts'
import type { BenchPackaging } from '../api'
import type { CloseChoice } from '../model'

/**
 * Close carton (B-W2b-387; design floor.pack "Scan into the carton": "Close carton (main) stores its contents (LOG-010) and
 * prints its marks (LOG-013)"): what the carton is packed in — big buttons of the cartons, boxes and pallets in use, the
 * default for its garments marked Suggested — and its weight on the pad; one tap closes it and sends its marks to the
 * station's label printer. Held with the reason (no packaging set up, none chosen, no weight, no network). Never a cost.
 */
export function CloseCarton({
  choice,
  types,
  suggestedId,
  held,
  overweightMax,
  t,
  locale,
  onPackaging,
  onWeight,
  onConfirm,
}: {
  choice: CloseChoice
  types: readonly BenchPackaging[]
  suggestedId: string | null
  /** Why Close waits (words), or null. */
  held: string | null
  /** The chosen packaging's most weight when the typed weight is above it. */
  overweightMax: string | null
  t: Translate
  locale: Locale
  onPackaging: (id: string) => void
  onWeight: (value: number | null) => void
  onConfirm: () => void
}) {
  const decimal = (text: string) => formatNumber(Number.parseFloat(text), locale, { maximumFractionDigits: 2 })
  return (
    <div className="fw-floor-stack">
      <p className="fw-floor-lead">{t('close.lead')}</p>
      <section className="fw-floor-stack" aria-labelledby="fw-pack-close-packaging">
        <h3 id="fw-pack-close-packaging" className="fw-floor-subtitle">
          {t('close.packaging')}
        </h3>
        {types.length === 0 ? (
          <HeldLine text={t('close.held.noPackaging')} />
        ) : (
          <div className="fw-pack-packaging" role="radiogroup" aria-labelledby="fw-pack-close-packaging">
            {types.map((type) => {
              const chosen = choice.packagingId === type.id
              const inner = type.innerLengthCm && type.innerWidthCm && type.innerHeightCm ? t('close.inner', { l: decimal(type.innerLengthCm), w: decimal(type.innerWidthCm), h: decimal(type.innerHeightCm) }) : null
              const upTo = type.maxWeightKg ? t('close.upTo', { weight: decimal(type.maxWeightKg) }) : null
              return (
                <FloorButton key={type.id} size="lg" variant={chosen ? 'primary' : 'secondary'} role="radio" aria-checked={chosen} icon={chosen ? <Check /> : <Box />} onClick={() => onPackaging(type.id)} className="fw-pack-packaging-option">
                  <span className="fw-pack-packaging-name">{type.name}</span>
                  <span className="fw-pack-packaging-meta">{[t(`kind.${type.kind}`), inner, upTo, type.id === suggestedId ? t('close.suggested') : null].filter(Boolean).join(' · ')}</span>
                </FloorButton>
              )
            })}
          </div>
        )}
      </section>
      <QuantityPad
        label={t('close.weight', { seq: choice.seq })}
        value={choice.weight}
        onChange={onWeight}
        unit={t('close.unit')}
        min={0.01}
        max={999}
        decimals={2}
        decimalSeparator={locale === 'it' ? ',' : '.'}
        separatorLabel={t('close.separator')}
        decrementLabel={t('pad.minus')}
        incrementLabel={t('pad.plus')}
        clearLabel={t('pad.clear')}
        backLabel={t('pad.back')}
        emptyLabel={t('close.empty')}
        rangeLabel={() => t('close.range')}
        onConfirm={onConfirm}
        confirmLabel={t('close.confirm')}
        confirmHeldReason={held}
        autoFocus
      />
      {overweightMax ? (
        <TaskLine tone="warning" icon={<TriangleAlert />}>
          {t('close.overweight', { weight: decimal(overweightMax) })}
        </TaskLine>
      ) : null}
    </div>
  )
}
