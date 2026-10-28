import type { ReactNode } from 'react'

export interface KbdProps {
  className?: string
  children: ReactNode
}

/** Keyboard key chip (e.g. ⌘, K). */
export function Kbd({ className, children }: KbdProps) {
  return <kbd className={`nds-kbd${className ? ` ${className}` : ''}`}>{children}</kbd>
}
