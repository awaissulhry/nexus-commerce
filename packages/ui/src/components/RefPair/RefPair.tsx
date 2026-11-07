'use client'

/**
 * RefPair — two references side by side, the partner's own first and ours second (B-W2b-155, design part RefPair):
 * "Your PO 4500-1234 · Our ref. SO-2026-0042" in a portal band, a row, a card, a thread's head.
 *
 *   <RefPair theirs={order.theirRef} theirsLabel="Il vostro ordine" ours={order.number} oursLabel="Nostro ordine"
 *            match={search} labels={ds.refPair} />
 *
 * - Their number first, always: it is the one the partner searches by. A missing one is left out (only ours is drawn).
 * - Each value can be copied (`copy`, default true): a small button named "Copy 4500-1234", a tick and a polite "Copied"
 *   after it, words when the browser refuses. The values are plain text, so they can be selected too.
 * - `match` marks where a search found the value (case and accents ignored), in both references.
 * - `layout` `inline` (one line that wraps between the two) or `stacked` (one under the other, in a card).
 */
import { Check, Copy } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { REF_PAIR_LABELS, type RefPairLabels } from './RefPairLabels'
import { refMatchParts, refPairSides } from './refPairModel'
import { useCopyText } from './useCopyText'
import './refPair.css'

export interface RefPairProps {
  /** The partner's own reference (their PO, their order). Drawn first. */
  theirs?: string | null
  /** Ours (the sales order, the PO number). Drawn second. */
  ours?: string | null
  /** What their reference is called here ("Your PO"). Default "Your ref.". */
  theirsLabel?: string
  /** What ours is called here ("Our order"). Default "Our ref.". */
  oursLabel?: string
  /** A copy button beside each value. Default true. */
  copy?: boolean
  /** `inline` (default): one line, wrapping between the two; `stacked`: one under the other. */
  layout?: 'inline' | 'stacked'
  /** `sm` for a dense row. Default `md`. */
  size?: 'md' | 'sm'
  /** The search text to mark in both values. */
  match?: string | null
  className?: string
  labels?: Partial<RefPairLabels>
}

export function RefPair({ theirs, ours, theirsLabel, oursLabel, copy = true, layout = 'inline', size = 'md', match, className, labels }: RefPairProps) {
  const lw = mergeLabels(REF_PAIR_LABELS, labels)
  const sides = refPairSides(theirs, ours, { theirs: theirsLabel ?? lw.theirs, ours: oursLabel ?? lw.ours })
  const { state, copy: copyText } = useCopyText()
  if (!sides.length) return null
  return (
    <span
      className={['nds-refpair', className].filter(Boolean).join(' ')}
      data-layout={layout}
      data-size={size}
    >
      {sides.map((side, i) => {
        const copied = state?.value === side.value && state.outcome === 'copied'
        return (
          <span key={side.side} className="nds-ref" data-side={side.side}>
            {i > 0 && layout === 'inline' ? (
              <span className="nds-ref-sep" aria-hidden>
                ·
              </span>
            ) : null}
            <span className="nds-ref-label">{side.label}</span>{' '}
            <span className="nds-ref-value">
              {refMatchParts(side.value, match).map((part, k) =>
                part.match ? (
                  <mark key={k} className="nds-ref-mark">
                    {part.text}
                  </mark>
                ) : (
                  <span key={k}>{part.text}</span>
                ),
              )}
            </span>
            {copy ? (
              <Button size="xs" variant="quiet" className="nds-ref-copy" aria-label={lw.copy(side.value)} onClick={() => void copyText(side.value)}>
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              </Button>
            ) : null}
          </span>
        )
      })}
      {copy ? (
        <span className="nds-vh" role="status">
          {state ? (state.outcome === 'copied' ? lw.copied : lw.copyFailed) : ''}
        </span>
      ) : null}
    </span>
  )
}
