import type { ReactNode } from 'react'

export type PillStatus = 'ok' | 'warn' | 'arch' | 'err'

/** Status pill — matches the H10 `.h10-pill` (Active / Paused / Archived / Error). */
export function Pill({ status, children }: { status: PillStatus; children: ReactNode }) {
  return <span className={`h10-ds-pill ${status}`}>{children}</span>
}
