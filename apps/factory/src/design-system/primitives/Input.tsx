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
  /**
   * Where `prefix`/`suffix` sit relative to the field's border.
   *
   * `inside` (default) is the shaded adornment: `[€|12.50]`, one bordered box, the unit on a
   * sunken ground. `outside` puts the mark beside the box as plain text: `€ [12.50]`.
   *
   * Not two anatomies for one component — the border stays on the field either way. What moves
   * is the MARK. `outside` exists because a dense grid cell cannot spare the width a shaded
   * adornment costs, and because the state tints (`on`, `edited`) belong on the box around the
   * input, not on a box that also contains a currency symbol. 26 rules in this console put the
   * border on the input for exactly that reason.
   */
  affix?: 'inside' | 'outside'
}

/**
 * Text field. Matches the H10 `.h10-am-search` / money-input (`.mmin`) specs:
 * a bordered wrapper that owns hover/focus, with optional leading icon and
 * €/% unit marks — shaded inside the border by default, or plain beside it
 * with `affix="outside"`. Requires `styles/primitives.css`.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingIcon, prefix, suffix, fieldClassName, size = 'md', affix = 'inside', disabled, ...rest },
  ref,
) {
  const cls = ['nds-field', size === 'md' ? '' : size, disabled ? 'disabled' : '', fieldClassName ?? ''].filter(Boolean).join(' ')
  const field = (
    <span className={cls}>
      {affix === 'inside' && prefix != null && <span className="ad pre">{prefix}</span>}
      {leadingIcon != null && <span className="lead">{leadingIcon}</span>}
      <input ref={ref} disabled={disabled} {...rest} />
      {affix === 'inside' && suffix != null && <span className="ad suf">{suffix}</span>}
    </span>
  )
  if (affix === 'inside' || (prefix == null && suffix == null)) return field
  // The border stays on `field`; only the MARK moves outside it.
  return (
    <span className={['nds-field-row', disabled ? 'disabled' : ''].filter(Boolean).join(' ')}>
      {prefix != null && <span className="af pre">{prefix}</span>}
      {field}
      {suffix != null && <span className="af suf">{suffix}</span>}
    </span>
  )
})
