import type { ButtonHTMLAttributes } from 'react'

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  checked: boolean
  onChange?: (next: boolean) => void
}

/**
 * Switch toggle (H10 `.h10-toggle` spec: 30×17 track, 13px knob). Accessible
 * `role="switch"` button — controlled via `checked` / `onChange`.
 */
export function Toggle({ checked, onChange, className, disabled, ...rest }: ToggleProps) {
  const cls = ['h10-ds-toggle', checked ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
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
