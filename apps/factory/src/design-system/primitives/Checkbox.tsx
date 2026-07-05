import type { InputHTMLAttributes, ReactNode } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode
}

/** Native checkbox tinted with the H10 accent (`accent-color`), 15px, with label. */
export function Checkbox({ label, disabled, className, ...rest }: CheckboxProps) {
  const cls = ['h10-ds-check', disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <input type="checkbox" disabled={disabled} {...rest} />
      {label != null && <span>{label}</span>}
    </label>
  )
}
