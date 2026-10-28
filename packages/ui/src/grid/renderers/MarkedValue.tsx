'use client'

/**
 * The ONE cell layout that wears a provenance mark — the Shared scope and every channel scope of the product sheet
 * draw it (2026-10-04, channel cell marks). Before, the Shared sheet's `withMark` and the channel sheet's
 * `CascadeCell` were two hand-written copies with different marks, positions and spacing.
 *
 *   mark (nothing for `own`) · value text (the ellipsizing box) · trail (chevron, pinned right) · after (save marks)
 *
 * 🔴 `trail` and `after` are SIBLINGS of the text, never inside it: `.nds-cell-value-text` truncates, and an icon
 * placed in there becomes inline content of the truncating block and falls to a second line (#707).
 */
import { memo, type ReactNode } from 'react'

import { ProvenanceMark } from './provenanceMark'
import type { CellProvenance } from './provenance'

export interface MarkedValueProps {
  provenance: CellProvenance
  /** A host's own sentence for the mark, instead of the member's (`ProvenanceMark`'s `tooltip`). */
  tooltip?: string
  /**
   * What the value follows, came from or no longer follows — "GALE-JACKET", "the Shared product", "the Primary listing";
   * the server's sentence for refused / pending / attention. The mark reads `provenanceTooltip(provenance, from)`.
   */
  from?: string | null
  /** The value as drawn (text, empty, required, shape, long text). */
  children: ReactNode
  /** Chrome on the value's line, pinned right — the select chevron. */
  trail?: ReactNode
  /** After the trail: the cell's action button, its save reason and save mark. */
  after?: ReactNode
}

export const MarkedValue = memo(function MarkedValue({ provenance, tooltip, from, children, trail, after }: MarkedValueProps) {
  return (
    <span className="nds-cell-value">
      <ProvenanceMark provenance={provenance} tooltip={tooltip} from={from} />
      <span className="nds-cell-value-text">{children}</span>
      {trail}
      {after}
    </span>
  )
})
