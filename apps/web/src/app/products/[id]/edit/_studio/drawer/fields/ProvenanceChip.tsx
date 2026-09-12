'use client'

/**
 * PES.4 — where this value came from, in one chip.
 *
 * The semantics are lifted from the two cockpits this replaces — `InheritanceLabel` /
 * `InheritanceAwareField` (PIM B.2) and `field-source/FieldSourceBadge` (EC.2) — but neither's
 * code: both are Tailwind, both invent their own colours, and between them they spell the same
 * two states five ways ("From Master", "Global", "inherited", "master", "🔗").
 *
 * A chip's identity is its GLYPH. Colour is reinforcement only: a chip that means something only
 * by its colour means nothing in a screenshot, in forced-colours mode, or to an operator who does
 * not separate blue from green. So every layer has a distinct mark AND a distinct word, and the
 * colour is the third signal rather than the first.
 */

import { InfoTip } from '@/design-system/primitives/InfoTip'
import { LAYER_HINT, LAYER_LABEL, type Layer } from '../types'
import styles from '../drawer.module.css'

/** One mark per layer, none repeated. `🔗` for inherited is the mark the layout spec names. */
const GLYPH: Record<Layer, string> = {
  master: '🔗',
  variant: '✎',
  alias: '✎',
  // The narrowest layer there is, and the one most worth telling apart at a glance: a value
  // pinned on ONE alias AND ONE variation. A second mark, not a shade of the first.
  aliasVariant: '✎✎',
  channel: '✎',
  linked: '⇄',
  default: '·',
  locale: '🌐',
  mapped: 'ƒ',
  locked: '🔒',
  unknown: '?',
}

const TONE: Record<Layer, string> = {
  master: styles.chipMaster,
  variant: styles.chipVariant,
  alias: styles.chipChannel,
  aliasVariant: styles.chipChannel,
  channel: styles.chipChannel,
  linked: styles.chipLinked,
  default: styles.chipDefault,
  locale: styles.chipLocale,
  mapped: styles.chipMapped,
  locked: styles.chipLocked,
  unknown: styles.chipUnknown,
}

export interface ProvenanceChipProps {
  layer: Layer
  /**
   * Where exactly, when the layer alone does not say it: "Amazon IT", "GALE-KAN-PRO-M", the alias
   * label. Appended to the hint, never substituted for the layer's own word — the chip's text has
   * to stay comparable between two fields.
   */
  from?: string | null
  /** The raw `source` string the server sent, shown verbatim when this build cannot map it. */
  rawSource?: string
}

export function ProvenanceChip({ layer, from, rawSource }: ProvenanceChipProps) {
  const hint =
    layer === 'unknown' && rawSource
      ? `${LAYER_HINT.unknown} Server said: “${rawSource}”.`
      : from
        ? `${LAYER_HINT[layer]} From ${from}.`
        : LAYER_HINT[layer]

  return (
    /**
     * `InfoTip`, not the DS `Tooltip`, and it is a measured choice rather than a preference.
     *
     * `Tooltip` is CSS-positioned (`position: absolute` inside its trigger). Measured 2026-09-01
     * inside PES.1's reserved dock track — which is `overflow: hidden` — a chip's bubble rendered
     * 47px PAST the track's left edge and `document.elementFromPoint` returned the header instead
     * of the bubble: painted, invisible, un-hit-testable, no error anywhere. The chips sit at the
     * left gutter of every field header, so this is the common case, not an edge one.
     *
     * `InfoTip` portals to `document.body` and is `position: fixed`, which the same measurement
     * confirms ESCAPES that track (painted at x=120 against a track starting at x=680, and the
     * hit test found it). Its own docstring says it is the only tooltip in the app that survives
     * a scrolling container — this is that case.
     */
    <InfoTip tip={hint}>
      {/* InfoTip with `children` deliberately adds neither a tab stop nor an accessible name, so
          the chip carries both — the hint has to reach a screen reader, which never sees the
          bubble. */}
      <span className={`${styles.chip} ${TONE[layer]}`} tabIndex={0} aria-label={`${LAYER_LABEL[layer]}. ${hint}`}>
        <span aria-hidden>{GLYPH[layer]}</span>
        {LAYER_LABEL[layer]}
      </span>
    </InfoTip>
  )
}
