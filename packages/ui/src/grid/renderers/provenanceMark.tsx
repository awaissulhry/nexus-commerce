'use client'

/**
 * GDS / PES.2 — the provenance MARK: the glyph a cell wears when its value did not simply come
 * from that row. The verdict itself is `provenance.ts` beside this file (pure, tested); this is
 * only how it is drawn.
 */
// apps/web and apps/factory both resolve lucide-react **0.469.0**, hoisted at the repo root (neither app has its own
// copy in `node_modules`; checked 2026-10-04). An older note here said apps/web resolved 0.263.1 — no longer true.
// Check `node_modules/lucide-react/package.json` before reaching for an icon added after 0.469.
import { memo } from 'react'
import { AlertCircle, Clock, History, CornerDownRight, Layers, Link2, Pencil, Share2, Sigma, SparkleIcon, Sparkles, Store } from 'lucide-react'

import { provenanceLabel, provenanceTooltip, type CellProvenance } from './provenance'
import { WarnGlyph } from './cells'

/* The words live in `provenance.ts` (`provenanceLabel`, pure and typed per member); the glyph and the class live here. */
const MARKS = {
  outdated: { Icon: History, cls: 'nds-cell-prov-outdated' },
  inherited: { Icon: Link2, cls: 'nds-cell-prov-inherited' },
  // A DIFFERENT glyph, not a differently-coloured one: the two states reset to different places,
  // and colour alone is not identity (ruling #16, reference_tag_identity_is_glyph_not_colour).
  inheritedOverride: { Icon: CornerDownRight, cls: 'nds-cell-prov-inherited nds-cell-prov-via' },
  pinned: { Icon: Pencil, cls: 'nds-cell-prov-pinned' },
  // §9.6. Σ for "computed by a rule", and a DIFFERENT glyph for the shared-scope case rather than a
  // tint of the same one — the two differ in what happens when you edit, which is exactly the test
  // ruling #16 set for minting a member at all.
  mapped: { Icon: Sigma, cls: 'nds-cell-prov-mapped' },
  mappedShared: { Icon: Share2, cls: 'nds-cell-prov-mapped nds-cell-prov-mapped-shared' },
  ai: { Icon: Sparkles, cls: 'nds-cell-prov-ai' },
  aiStale: { Icon: SparkleIcon, cls: 'nds-cell-prov-ai nds-cell-prov-ai-stale' },
  /*
   * 2026-10-04 (channel cell marks) — channel-sheet members; see `packages/shared/cell-provenance.ts`.
   * `pending` is the CLOCK because the sheet already says "waits for Publish" with a clock — the Status and Action
   * pills (`SellingStatusCell`, `PublishActionCell`) and `SourceIndicator kind="pending"`: one fact, one glyph.
   * Rendered at 11px in both themes (1x and 2x) beside `outdated`'s History: History keeps its counter-clockwise arrow
   * notch at the top-left and Clock is a closed ring, so the two stay apart; the browser check confirms it by eye.
   */
  pending: { Icon: Clock, cls: 'nds-cell-prov-pending' },
  attention: { Icon: AlertCircle, cls: 'nds-cell-prov-attention' },
  listingValue: { Icon: Store, cls: 'nds-cell-prov-listing' },
  listingLevel: { Icon: Layers, cls: 'nds-cell-prov-listing-level' },
} as const

export interface ProvenanceMarkProps {
  provenance: CellProvenance
  /**
   * A host's own sentence, used instead of the member's — for a host whose fact is not a sheet cell's (the Matrix's
   * "Follows the pool", the Variants tab's server-stated theme source). Absent on the product sheet: there the mark
   * reads `provenanceTooltip(provenance, from)`.
   */
  tooltip?: string
  /**
   * The ONE meaning on every scope: the layer or source the value follows, came from, or no longer follows — "GALE-JACKET"
   * (the parent), "the Shared product", "the Primary listing", "the Italian text", "a linked field". Never the row's own
   * SKU. For `refused`, `pending` and `attention` it is the server's sentence, shown verbatim.
   */
  from?: string | null
}

/**
 * The mark itself. Renders NOTHING for `own`, which is most cells — a sheet where every cell
 * carries an icon has told the operator nothing.
 *
 * Each non-own mark has an accessible name. A role and label create no tab stop; hiding
 * these marks from assistive technology would hide the value’s provenance.
 *
 * 🔴 ONE text for `title` AND `aria-label`, and it is ONE sentence (2026-10-04). The name used to be the bare word
 * ("Inherited") while the hover carried the source or the refusal reason — so a screen reader never heard where a value
 * came from or why a formula was refused. Then it was "label — from", which read two ways: on the Shared scope the word
 * after the dash named what the value follows ("Inherited — GALE-JACKET"), on a channel scope where the pin lives
 * ("Pinned — Primary"). Now every member reads its `provenanceTooltip(provenance, from)` sentence — the words the
 * Shared scope's hover already used — so the mark, its hover and its spoken name say the same thing on every scope;
 * the bare label only when that sentence is empty. A refusal keeps the server's reason verbatim as its whole text
 * (`provenanceTooltip('refused', reason)` returns it; `scripts/check-editor-open.mjs` holds the title to the exact reason).
 */
/**
 * 🔴 `formula` is a CHARACTER, not a lucide icon, and that is measured rather than stylistic.
 *
 * `/design/formula-lab` drew it and recorded why: every other member of this vocabulary is an
 * UNBOXED glyph (Σ mapped, ✎ pinned, 🔗 inherited, ✦ ai), and lucide has only a BOXED function icon
 * (`FunctionSquare` / `SquareFunction`, still the only one in 0.469), which at 11px reads as a checkbox before it
 * reads as a function. The `ƒ` is both the closer match to D16.2's spec and the closer match to its siblings.
 *
 * It carries no colour of its own: `.nds-cell-prov-formula` in `grid.css` reads DS.2's
 * `--nds-prov-formula-fg`, measured in both themes. Only the typography is local, because italic and
 * weight are what make a `ƒ` read as a function rather than an `f`.
 */
export const ProvenanceMark = memo(function ProvenanceMark({ provenance, from, tooltip }: ProvenanceMarkProps) {
  if (provenance === 'own') return null
  const text = tooltip ?? (provenanceTooltip(provenance, from) || provenanceLabel(provenance))
  /**
   * #780 — a refused formula wears a WARNING in place of the ƒ, never beside it.
   *
   * Beside it would say "calculated, and also refused", which is the same false claim in two marks.
   * The warning triangle at 11px is the one shape an operator reads without a legend. Drawn as the outline `WarnGlyph`
   * (2026-10-08), not the text `⚠`, which a phone may draw as a colour emoji.
   */
  if (provenance === 'refused') {
    // The server's reason and nothing else (#780) — no label prefix, here or in the accessible name.
    return (
      <span className="nds-cell-prov nds-cell-prov-refused" role="img" aria-label={text} title={text}>
        <WarnGlyph />
      </span>
    )
  }
  if (provenance === 'formula') {
    return (
      <span className="nds-cell-prov nds-cell-prov-formula nds-formula-glyph" role="img" aria-label={text} title={text}>
        ƒ
      </span>
    )
  }
  const { Icon, cls } = MARKS[provenance]
  return (
    <span className={`nds-cell-prov ${cls}`} role="img" aria-label={text} title={text}>
      <Icon size={11} strokeWidth={2.25} aria-hidden />
    </span>
  )
})
