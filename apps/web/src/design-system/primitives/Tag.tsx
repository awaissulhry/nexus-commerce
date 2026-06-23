import type { ReactNode } from 'react'

/**
 * Tag — the neutral / semantic metadata chip the console was missing.
 * Pill encodes entity *status* (Active/Paused/Archived/Error); Badge encodes the
 * ad *program* (SP/SD/SB/Auto/Manual). Tag is for everything else you label inline:
 * marketplace, entity type, a rule trigger, a proposed-action sentiment, a filter chip.
 * Requires `styles/primitives.css`.
 */
export type TagTone = 'neutral' | 'info' | 'positive' | 'warning' | 'danger'

export function Tag({ tone = 'neutral', children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`h10-ds-tag ${tone}`}>{children}</span>
}
