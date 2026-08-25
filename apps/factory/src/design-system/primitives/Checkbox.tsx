import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode
}

/** Native checkbox tinted with the H10 accent (`accent-color`), 15px, with label. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, disabled, className, ...rest },
  ref,
) {
  const cls = ['nds-check', disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <input ref={ref} type="checkbox" disabled={disabled} {...rest} />
      {label != null && <span>{label}</span>}
    </label>
  )
})
