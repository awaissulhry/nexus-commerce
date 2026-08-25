import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode
}

/** Native radio tinted with the H10 accent. Pair via a shared `name`. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, disabled, className, ...rest },
  ref,
) {
  const cls = ['nds-radio', disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <input ref={ref} type="radio" disabled={disabled} {...rest} />
      {label != null && <span>{label}</span>}
    </label>
  )
})
