import type { ReactNode } from 'react'

/** Ad program (Sponsored Products/Display/Brands) + targeting (Auto/Manual). */
export type AdProgram = 'sp' | 'sd' | 'sb' | 'auto' | 'manual'

export interface BadgeProps {
  program: AdProgram
  className?: string
  children: ReactNode
}

export function Badge({ program, className, children }: BadgeProps) {
  return <span className={`h10-ds-badge ${program}${className ? ` ${className}` : ''}`}>{children}</span>
}
