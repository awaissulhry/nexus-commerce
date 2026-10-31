'use client'

import { CircleHelp } from 'lucide-react'
import { tagIconSpec } from '@nexus/ui/primitives'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { WithMessages } from '../../../../record-panels/i18n'
import type { ReasonTone } from '../model'

/**
 * Why the lot is held (B-W2a-75; design floor.final pop "final.hold": a reason tile), as the DS icon reason grid (gap D20,
 * B-W2a-24) over the tenant's HOLD reasons (platform/reasons, the office's list in its order). The office's icon id is a
 * DS tag icon (`tagIconSpec`, platform/reasons REASON_ICONS), its colour a tone. A reason that asks a written note ("Other")
 * is held on the floor with the words: the office places that hold. The grid's own words come from the `reason-kit`
 * catalogue, given to this part alone (`WithMessages`).
 */

export interface HoldReasonModel {
  readonly code: string
  /** In the screen's language. */
  readonly label: string
  readonly icon: string | null
  readonly tone: ReasonTone
  /** Why it cannot be picked here ("Other" asks a written note), or null. */
  readonly heldReason: string | null
}

export interface HoldReasonsProps {
  label: string
  reasons: readonly HoldReasonModel[]
  value: string | null
  onChange: (code: string) => void
}

export function HoldReasons(props: HoldReasonsProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Grid {...props} />
    </WithMessages>
  )
}

function Grid({ label, reasons, value, onChange }: HoldReasonsProps) {
  const locale = useLocale()
  const kit = useReasonWords()
  const tiles: ReasonTile[] = reasons.map((reason) => {
    const Icon = tagIconSpec(reason.icon)?.Icon ?? CircleHelp
    return { id: reason.code, label: reason.label, icon: <Icon />, tone: reason.tone, heldReason: reason.heldReason }
  })
  return <ReasonGrid label={label} reasons={tiles} value={value} onChange={(id) => onChange(id)} words={kit} locale={INTL_LOCALE[locale]} />
}
