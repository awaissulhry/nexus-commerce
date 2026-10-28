import { forwardRef } from 'react'
import type { SelectHTMLAttributes, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Size } from './size'

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  children?: ReactNode
  /**
   * `xs` is the dense grid-cell tier. Shadows the native numeric `size`, which is omitted above —
   * on a `<select>` it means "show N rows at once", turning it into a list box.
   */
  size?: Extract<Size, 'xs' | 'sm' | 'md'>
}

/**
 * Styled native `<select>` with the H10 custom chevron (`.h10-fsel` spec). For
 * searchable / multi / portal dropdowns see the Phase 4 components.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, size = 'md', ...rest },
  ref,
) {
  return (
    <span className={['nds-select', size === 'md' ? '' : size].filter(Boolean).join(' ')}>
      <select ref={ref} className={className} {...rest}>
        {children}
      </select>
      <ChevronDown size={15} className="chev" aria-hidden />
    </span>
  )
})
