'use client'

import { Hand, Scissors, Wrench } from 'lucide-react'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { WithMessages } from '../../../../record-panels/i18n'
import { SPLIT_REASONS, type SplitReason } from '../model'

/**
 * Why garments come off a bundle (B-W2a-75; design floor.bundles "Split a bundle": why (rework, recut, hold)), as the DS
 * icon reason grid (gap D20, B-W2a-24). The grid's own words come from the `reason-kit` catalogue, which the floor layout
 * does not load: `WithMessages` gives it to this part alone (the labels come translated from the screen).
 */

const ICONS: Readonly<Record<SplitReason, typeof Wrench>> = { REWORK: Wrench, RECUT: Scissors, HOLD: Hand }
const TONES: Readonly<Record<SplitReason, ReasonTile['tone']>> = { REWORK: 'warning', RECUT: 'info', HOLD: 'danger' }

export interface SplitReasonsProps {
  label: string
  /** Each reason's word and hint, in the screen's language. */
  words: Readonly<Record<SplitReason, { label: string; hint: string }>>
  value: SplitReason | null
  onChange: (reason: SplitReason) => void
  /** Why no reason may be picked now (no network, busy). */
  heldReason?: string | null
}

export function SplitReasons(props: SplitReasonsProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Grid {...props} />
    </WithMessages>
  )
}

function Grid({ label, words, value, onChange, heldReason }: SplitReasonsProps) {
  const locale = useLocale()
  const kit = useReasonWords()
  const reasons: ReasonTile[] = SPLIT_REASONS.map((reason) => {
    const Icon = ICONS[reason]
    return { id: reason, label: words[reason].label, hint: words[reason].hint, icon: <Icon />, tone: TONES[reason], heldReason: heldReason ?? null }
  })
  return <ReasonGrid label={label} reasons={reasons} value={value} onChange={(id) => onChange(id as SplitReason)} words={kit} locale={INTL_LOCALE[locale]} />
}
