import type { ReactNode } from 'react'
import type { Tone } from './tone'

/**
 * Tag — the neutral / semantic metadata chip the console was missing.
 * Pill encodes entity *status* (Active/Paused/Archived/Error); Badge encodes the
 * ad *program* (SP/SD/SB/Auto/Manual). Tag is for everything else you label inline:
 * marketplace, entity type, a rule trigger, a proposed-action sentiment, a filter chip.
 * Requires `styles/primitives.css`.
 */

/** @deprecated use 'success' */
export type LegacyTagTone = 'positive'
export type TagTone = Tone | LegacyTagTone   // 'positive' retained for the untouchable flat-file consumer

export interface TagProps {
  tone?: TagTone
  className?: string
  /** The full text on hover — pass it with `truncate`, so a clipped chip still says everything. */
  title?: string
  /**
   * One line, never wider than its container: a long name ends in an ellipsis instead of running past the card's
   * edge (the chip's `white-space: nowrap` let it overflow). Pair it with `title`.
   */
  truncate?: boolean
  children: ReactNode
}

export function Tag({ tone = 'neutral', className, title, truncate, children }: TagProps) {
  const t = tone === 'positive' ? 'success' : tone   // normalize legacy
  return <span className={`nds-tag ${t}${truncate ? ' is-truncated' : ''}${className ? ` ${className}` : ''}`} title={title}>{children}</span>
}
