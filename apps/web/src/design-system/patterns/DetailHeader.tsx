'use client'

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

export interface DetailHeaderProps {
  backLabel?: ReactNode
  onBack?: () => void
  /** leading badge slot (e.g. a targeting chip) */
  badge?: ReactNode
  title: ReactNode
  actions?: ReactNode
}

/** Drill-in detail header (H10 `.h10-cd-hdr`): back link + badge + title + actions. */
export function DetailHeader({ backLabel = 'Back', onBack, badge, title, actions }: DetailHeaderProps) {
  return (
    <div className="nds-detailhdr">
      {onBack && (
        <button type="button" className="back" onClick={onBack}>
          <ChevronLeft size={14} />
          {backLabel}
        </button>
      )}
      <div className="nds-detailhdr-row">
        <div className="nds-detailhdr-title">
          {badge}
          <h1>{title}</h1>
        </div>
        {actions != null && <div className="nds-pagehdr-actions">{actions}</div>}
      </div>
    </div>
  )
}
