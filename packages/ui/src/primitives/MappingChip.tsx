'use client'

import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'

export interface MappingChipProps {
  /** The shared axis — the side the operator already knows. */
  from: ReactNode
  /**
   * The channel's target option. `null` renders the DS dash: an axis that is not mapped yet is a
   * fact the band must show, and inventing a word for it here would put copy in the DS that the
   * spec's copy table does not hold.
   */
  to?: ReactNode
  /** Hover explanation — which channel noun this maps into ("eBay specific"). */
  title?: string
  className?: string
}

/**
 * VP.5 — `MappingChip`: one shared axis and the channel option it lands in, in the Variants page's
 * mapping band.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §4.1, canvas artboard 2:
 *
 *     Colore → Colore      Taglia → Size
 *
 * Deliberately a `<span>`, not a button. §4.1 gives the band exactly one control — `Edit mapping`,
 * which opens the dock where the mapping is changed — so a clickable chip would be a second way to
 * reach a surface the band already reaches (layout doc D9, the reason the per-channel Variants nav
 * item does not exist either). It is also why the census gate does not have to know about it: a
 * static span is not a control on a tier.
 *
 * The weights carry the meaning and are not decoration: the FROM side is 500 at `--nds-text-2`
 * because the operator already knows the shared axis, the TO side is 600 at full strength because
 * that is the fact the band exists to state. 28px, so it stands level with `Edit mapping` beside
 * it.
 */
export function MappingChip({ from, to, title, className }: MappingChipProps) {
  return (
    <span className={['nds-mapchip', className].filter(Boolean).join(' ')} title={title}>
      <span className="nds-mapchip-from">{from}</span>
      <ArrowRight size={12} className="nds-mapchip-arrow" aria-hidden="true" />
      <span className="nds-mapchip-to">{to ?? '—'}</span>
    </span>
  )
}
