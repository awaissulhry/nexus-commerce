import type { ReactNode } from 'react'

/** Program (Sponsored Products/Display/Brands) + targeting (Auto/Manual) chips. */
export type BadgeTone = 'sp' | 'sd' | 'sb' | 'auto' | 'manual'

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`h10-ds-badge ${tone}`}>{children}</span>
}
