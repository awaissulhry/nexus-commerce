import type { HTMLAttributes, ReactNode } from 'react'
import type { Tone } from './tone'

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  /** Active→success · Paused→warning · Archived→neutral · Error→danger */
  tone: Tone
  children: ReactNode
}

/** Status pill — matches the H10 `.h10-pill`. */
export function Pill({ tone, className, children, ...rest }: PillProps) {
  return (
    <span className={`nds-pill ${tone}${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </span>
  )
}
