'use client'

/**
 * VP.1 — the studio's ONE placeholder for a surface that is on the roadmap and not built yet.
 *
 * A tab that is coming renders this, never an empty box: a blank panel is indistinguishable from a page that
 * broke, and a surface that exists in the navigation has to say what it is and what it is waiting for
 * (feedback_keep_placeholder_controls, feedback_100_percent_honest_ui).
 *
 * 🔴 It states THREE things and invents none of them: what the surface is, which lane is building it, and what
 * it needs before it can render. It offers no control that does nothing — a disabled button here would be a
 * promise the frame cannot keep.
 *
 * It composes the DS `EmptyState`; there is no second implementation and no page-local empty-state styling
 * (feedback_design_system). This rebuilds the helper PES.7 removed from `StudioTabHost` when it filled the
 * last two tab slots — disclosed in docs/pes-claims.md under VP.1, not a silent addition to the frame.
 */

import type { ReactNode } from 'react'

import { EmptyState } from '@/design-system/components'

export interface StudioPlaceholderProps {
  /** The surface's own name, exactly as the navigation spells it. */
  title: string
  /** What it is, in the operator's words. One sentence. */
  children: ReactNode
  /** Who is building it and what it waits on. Omitted when there is nothing honest to say. */
  status?: ReactNode
  icon?: ReactNode
}

export function StudioPlaceholder({ title, children, status, icon }: StudioPlaceholderProps) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <EmptyState
        icon={icon}
        title={title}
        description={
          <span style={{ display: 'grid', gap: 6, maxWidth: 520 }}>
            <span>{children}</span>
            {status != null && <span className="nds-cell-muted">{status}</span>}
          </span>
        }
      />
    </div>
  )
}
