import type { InputHTMLAttributes, ReactNode } from 'react'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  /** leading glyph (e.g. a search icon) inside the field */
  leadingIcon?: ReactNode
  /** shaded prefix adornment (e.g. `€`) */
  prefix?: ReactNode
  /** shaded suffix adornment (e.g. `%`) */
  suffix?: ReactNode
  /** class for the bordered field wrapper (the input itself takes `className`) */
  fieldClassName?: string
}

/**
 * Text field. Matches the H10 `.h10-am-search` / money-input (`.mmin`) specs:
 * a bordered wrapper that owns hover/focus, with optional leading icon and
 * shaded €/% unit adornments. Requires `styles/primitives.css`.
 */
export function Input({ leadingIcon, prefix, suffix, fieldClassName, disabled, ...rest }: InputProps) {
  const cls = ['h10-ds-field', disabled ? 'disabled' : '', fieldClassName ?? ''].filter(Boolean).join(' ')
  return (
    <span className={cls}>
      {prefix != null && <span className="ad pre">{prefix}</span>}
      {leadingIcon != null && <span className="lead">{leadingIcon}</span>}
      <input disabled={disabled} {...rest} />
      {suffix != null && <span className="ad suf">{suffix}</span>}
    </span>
  )
}
