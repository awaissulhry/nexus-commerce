import type { ReactNode } from 'react'

export interface RecordLayoutProps {
  /** The record's main column: what it is, its numbers, its history. */
  main: ReactNode
  /** The side panel (260–300px): status, actions, a trend. After `main` on a phone. */
  aside: ReactNode
  className?: string
  /** Names the side panel and makes it a landmark (`<aside>`, "Status and actions"). Without it, a plain block. */
  asideLabel?: string
}

/**
 * RecordLayout — a record's body in two columns (Negative Targeting redesign, 2026-10-26): a flexible main column and a
 * 260–300px side panel, `minmax(0, 1fr) minmax(260px, 300px)`, 20px apart, both aligned to the top. Below 760px (the DS
 * sheet breakpoint) one column, the side panel after the main one — the order in the markup, so a screen reader and the
 * Tab key meet them in the same order everywhere.
 */
export function RecordLayout({ main, aside, className, asideLabel }: RecordLayoutProps) {
  return (
    <div className={`nds-record-layout${className ? ` ${className}` : ''}`}>
      <div className="nds-record-layout-main">{main}</div>
      {asideLabel
        ? <aside className="nds-record-layout-aside" aria-label={asideLabel}>{aside}</aside>
        : <div className="nds-record-layout-aside">{aside}</div>}
    </div>
  )
}
