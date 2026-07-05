import type { InputHTMLAttributes, ReactNode } from 'react'

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode
}

/** Native radio tinted with the H10 accent. Pair via a shared `name`. */
export function Radio({ label, disabled, className, ...rest }: RadioProps) {
  const cls = ['h10-ds-radio', disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <input type="radio" disabled={disabled} {...rest} />
      {label != null && <span>{label}</span>}
    </label>
  )
}
