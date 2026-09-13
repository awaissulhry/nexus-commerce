'use client'

/**
 * GDS / PES.2 — the provenance MARK: the glyph a cell wears when its value did not simply come
 * from that row. The verdict itself is `provenance.ts` beside this file (pure, tested); this is
 * only how it is drawn.
 */
// ⚠ apps/web resolves lucide-react **0.263.1** (`apps/web/node_modules`), NOT the 0.469.0 hoisted
// at the repo root. Icons added to lucide after 0.263 (`Waypoints`, `Route`, …) typecheck against
// the root copy and fail here. Check `apps/web/node_modules/lucide-react` before reaching for one.
import { memo } from 'react'
import { History, CornerDownRight, Link2, Pencil, Share2, Sigma, SparkleIcon, Sparkles } from 'lucide-react'

import type { CellProvenance } from './provenance'

const MARKS = {
  outdated: { Icon: History, label: 'Out of date', cls: 'nds-cell-prov-outdated' },
  inherited: { Icon: Link2, label: 'Inherited', cls: 'nds-cell-prov-inherited' },
  // A DIFFERENT glyph, not a differently-coloured one: the two states reset to different places,
  // and colour alone is not identity (ruling #16, reference_tag_identity_is_glyph_not_colour).
  inheritedOverride: { Icon: CornerDownRight, label: 'Inherited via an override', cls: 'nds-cell-prov-inherited nds-cell-prov-via' },
  pinned: { Icon: Pencil, label: 'Pinned', cls: 'nds-cell-prov-pinned' },
  // §9.6. Σ for "computed by a rule", and a DIFFERENT glyph for the shared-scope case rather than a
  // tint of the same one — the two differ in what happens when you edit, which is exactly the test
  // ruling #16 set for minting a member at all.
  mapped: { Icon: Sigma, label: 'Derived by a mapping rule', cls: 'nds-cell-prov-mapped' },
  mappedShared: { Icon: Share2, label: 'Derived per product — shared by every alias', cls: 'nds-cell-prov-mapped nds-cell-prov-mapped-shared' },
  ai: { Icon: Sparkles, label: 'AI-drafted', cls: 'nds-cell-prov-ai' },
  aiStale: { Icon: SparkleIcon, label: 'AI-drafted · out of date', cls: 'nds-cell-prov-ai nds-cell-prov-ai-stale' },
} as const

export interface ProvenanceMarkProps {
  provenance: CellProvenance
  /** The canonical describeCellSource sentence, including the addressed tier when available. */
  tooltip?: string
  /** Names the layer the value came from — "GALE-JACKET", "Amazon · IT", "master". */
  from?: string | null
}

/**
 * The mark itself. Renders NOTHING for `own`, which is most cells — a sheet where every cell
 * carries an icon has told the operator nothing.
 *
 * Each non-own mark has an accessible name. A role and label create no tab stop; hiding
 * these marks from assistive technology would hide the value’s provenance.
 */
/**
 * 🔴 `formula` is a CHARACTER, not a lucide icon, and that is measured rather than stylistic.
 *
 * `/design/formula-lab` drew it and recorded why: every other member of this vocabulary is an
 * UNBOXED glyph (Σ mapped, ✎ pinned, 🔗 inherited, ✦ ai), and lucide 0.263.1 — the version
 * `apps/web` actually resolves, not the 0.469 hoisted at the root — has only `FunctionSquare`, which
 * at 11px reads as a checkbox before it reads as a function. The `ƒ` is both the closer match to
 * D16.2's spec and the closer match to its siblings.
 *
 * It carries no colour of its own: `.nds-cell-prov-formula` in `grid.css` reads DS.2's
 * `--nds-prov-formula-fg`, measured in both themes. Only the typography is local, because italic and
 * weight are what make a `ƒ` read as a function rather than an `f`.
 */
export const ProvenanceMark = memo(function ProvenanceMark({ provenance, from, tooltip }: ProvenanceMarkProps) {
  if (provenance === 'own') return null
  /**
   * #780 — a refused formula wears a WARNING in place of the ƒ, never beside it.
   *
   * Beside it would say "calculated, and also refused", which is the same false claim in two marks.
   * `⚠` for the same reason `ƒ` is a character: every member of this vocabulary is an unboxed glyph,
   * and the warning triangle at 11px is the one shape an operator reads without a legend.
   */
  if (provenance === 'refused') {
    const label = 'The formula produced no value'
    return (
      <span
        className="nds-cell-prov nds-cell-prov-refused"
        role="img"
        aria-label={label}
        title={tooltip ?? from ?? label}
      >
        ⚠
      </span>
    )
  }
  if (provenance === 'formula') {
    const label = 'Calculated by a formula'
    return (
      <span
        className="nds-cell-prov nds-cell-prov-formula nds-formula-glyph"
        role="img"
        aria-label={label}
        title={tooltip ?? (from ? `${label} — ${from}` : label)}
      >
        ƒ
      </span>
    )
  }
  const { Icon, label, cls } = MARKS[provenance]
  return (
    <span className={`nds-cell-prov ${cls}`} role="img" aria-label={label} title={tooltip ?? (from ? `${label} — ${from}` : label)}>
      <Icon size={11} strokeWidth={2.25} aria-hidden />
    </span>
  )
})
