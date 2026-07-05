import type { ReactNode } from 'react'
import type { Tone } from './tone'

export interface PillProps {
  /** Active→success · Paused→warning · Archived→neutral · Error→danger */
  tone: Tone
  className?: string
  children: ReactNode
}

/** Status pill — matches the H10 `.h10-pill`. */
export function Pill({ tone, className, children }: PillProps) {
  return <span className={`h10-ds-pill ${tone}${className ? ` ${className}` : ''}`}>{children}</span>
}
