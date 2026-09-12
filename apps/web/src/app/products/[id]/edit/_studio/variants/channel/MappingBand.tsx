'use client'

/**
 * VP.4 — §4.1, the mapping band. 40px, the same class of band as the scope bar (§2).
 *
 *   MAPPING · Colore → Colore · Taglia → Taglia · [2 of 5 specifics] │ One listing · 19 of 20
 *   variants included · 20 of 250 allowed                              … right: [Edit mapping]
 *
 * Nothing here is a second implementation of the scope bar: the eyebrow reuses
 * `.nds-scopebar-label` (the DS pattern's own class, the same 12px/700/0.06em uppercase
 * `--nds-text-2`) and the height is `--nds-toolbar-h`, so a band that drifts drifts for every bar
 * at once rather than only for this page.
 *
 * 🔴 Every number in the sentence is the CHANNEL'S, from the wire (§4.5: "VP.2 exposes `limits` and
 * `targetOptions` per coordinate; the UI never hardcodes a number"). eBay's 5 and 250 appear nowhere
 * in this file. And a limit may be **null** — VP.2's contract §1, "no limit we can source" — so the
 * clause that names it is DROPPED rather than filled with a number nothing stands behind. On Amazon,
 * where there is no sourced variant cap, this band reads `One listing · 19 of 20 variants included`
 * and stops.
 */
import { memo } from 'react'

import { Button, Divider, MappingChip, Tag } from '@/design-system/primitives'

import { mappedCount, mappingSentence } from './copy'
import type { ProjectionPage } from './types'

export interface MappingBandProps {
  page: ProjectionPage
  onEditMapping(): void
  /** The dock is open — the trigger says so rather than opening a panel that is already there. */
  editing: boolean
}

export const MappingBand = memo(function MappingBand({ page, onEditMapping, editing }: MappingBandProps) {
  const { vocabulary, limits, mapping, split, children, coordinate } = page
  const channelLabel = coordinate.channelLabel ?? coordinate.channel
  const mapped = mapping.filter(m => m.target !== null)
  const included = children.filter(c => c.included).length
  const sentence = mappingSentence(split.listings.length, included, children.length, limits.variants)

  return (
    /* `nds-pageband` is the SHARED name for §2's new band — the family band and this one are the
       same class of band, and VP.5's layout gate measures that selector. `nds-vp-band` stays as
       this lane's own styling hook so a rename on either side cannot silently unstyle the other. */
    <div className="nds-pageband nds-vp-band" data-vp-band="mapping">
      <span className="nds-scopebar-label">MAPPING</span>
      <div className="nds-vp-band-chips">
        {mapping.map(m => (
          <MappingChip
            key={m.axisKey}
            from={m.axisLabel}
            to={m.target}
            title={m.target
              ? `The shared axis ${m.axisLabel} is the ${channelLabel} ${vocabulary.axisNoun} ${m.target}`
              : `${m.axisLabel} has no ${channelLabel} ${vocabulary.axisNoun} yet — open Edit mapping to choose one`}
          />
        ))}
        {/* The channel's own noun and its own limit, both from the wire; `title` carries VP.2's
            provenance for the number, so an operator can see where a limit came from. */}
        <Tag tone="neutral">
          <span title={limits.source.axes ?? undefined}>{mappedCount(mapped.length, limits.axes, vocabulary)}</span>
        </Tag>
      </div>
      <Divider orientation="vertical" className="nds-vp-band-rule" />
      <p className="nds-vp-band-sentence">
        {sentence.listings}
        {' · '}
        <b>{sentence.included.count}</b> {sentence.included.of}
        {sentence.allowed && (
          <>
            {' · '}
            <span title={limits.source.variants ?? undefined}>{sentence.allowed.count} {sentence.allowed.of}</span>
          </>
        )}
      </p>
      <div className="nds-vp-band-right">
        <Button size="sm" onClick={onEditMapping} aria-expanded={editing} aria-haspopup="dialog">Edit mapping</Button>
      </div>
    </div>
  )
})
