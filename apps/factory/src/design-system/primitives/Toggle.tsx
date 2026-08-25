import type { ButtonHTMLAttributes } from 'react'
import type { Size } from './size'

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  checked: boolean
  onChange?: (next: boolean) => void
  /** `xs` is the dense grid-cell tier: a 24x14 track with an 11px knob. */
  size?: Extract<Size, 'xs' | 'sm' | 'md'>
}

/**
 * Switch toggle (H10 `.h10-toggle` spec: 30×17 track, 13px knob). Accessible
 * `role="switch"` button — controlled via `checked` / `onChange`.
 */
export function Toggle({ checked, onChange, className, size = 'md', disabled, ...rest }: ToggleProps) {
  const cls = ['nds-toggle', size === 'md' ? '' : size, checked ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cls}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      {...rest}
    />
  )
}
