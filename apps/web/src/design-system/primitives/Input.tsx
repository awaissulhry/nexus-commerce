import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import type { Size } from './size'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
  /** leading glyph (e.g. a search icon) inside the field */
  leadingIcon?: ReactNode
  /** shaded prefix adornment (e.g. `€`) */
  prefix?: ReactNode
  /** shaded suffix adornment (e.g. `%`) */
  suffix?: ReactNode
  /** class for the bordered field wrapper (the input itself takes `className`) */
  fieldClassName?: string
  /**
   * `xs` is the dense grid-cell tier. Shadows the native numeric `size` attribute, which is
   * omitted above — it sets a character-count width nobody wants on a styled field.
   */
  size?: Extract<Size, 'xs' | 'sm' | 'md'>
}

/**
 * Text field. Matches the H10 `.h10-am-search` / money-input (`.mmin`) specs:
 * a bordered wrapper that owns hover/focus, with optional leading icon and
 * shaded €/% unit adornments. Requires `styles/primitives.css`.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingIcon, prefix, suffix, fieldClassName, size = 'md', disabled, ...rest },
  ref,
) {
  const cls = ['nds-field', size === 'md' ? '' : size, disabled ? 'disabled' : '', fieldClassName ?? ''].filter(Boolean).join(' ')
  return (
    <span className={cls}>
      {prefix != null && <span className="ad pre">{prefix}</span>}
      {leadingIcon != null && <span className="lead">{leadingIcon}</span>}
      <input ref={ref} disabled={disabled} {...rest} />
      {suffix != null && <span className="ad suf">{suffix}</span>}
    </span>
  )
})
