import type { SelectHTMLAttributes, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children?: ReactNode
}

/**
 * Styled native `<select>` with the H10 custom chevron (`.h10-fsel` spec). For
 * searchable / multi / portal dropdowns see the Phase 4 components.
 */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <span className="h10-ds-select">
      <select className={className} {...rest}>
        {children}
      </select>
      <ChevronDown size={15} className="chev" aria-hidden />
    </span>
  )
}
