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
  children: ReactNode
}

export function Tag({ tone = 'neutral', className, children }: TagProps) {
  const t = tone === 'positive' ? 'success' : tone   // normalize legacy
  return <span className={`h10-ds-tag ${t}${className ? ` ${className}` : ''}`}>{children}</span>
}
