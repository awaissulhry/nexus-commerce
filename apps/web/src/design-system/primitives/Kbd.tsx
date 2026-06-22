import type { ReactNode } from 'react'

/** Keyboard key chip (e.g. ⌘, K). Combine multiple for a shortcut. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="h10-ds-kbd">{children}</kbd>
}
