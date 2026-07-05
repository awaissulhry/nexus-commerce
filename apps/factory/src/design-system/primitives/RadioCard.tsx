import type { InputHTMLAttributes, ReactNode } from 'react'

export interface RadioCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'title'> {
  title: ReactNode
  description?: ReactNode
  /** Visual highlight (the `.on` state). Pair with the radio's checked state. */
  selected?: boolean
}

/**
 * Selectable card with a radio + title + description (H10 `.h10-radio-card`,
 * e.g. the targeting-type picker). Selected = primary border + wash.
 */
export function RadioCard({ title, description, selected, className, ...rest }: RadioCardProps) {
  const cls = ['h10-ds-radiocard', selected ? 'on' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <input type="radio" {...rest} />
      <span className="rc-body">
        <span className="rc-title">{title}</span>
        {description != null && <span className="rc-desc">{description}</span>}
      </span>
    </label>
  )
}
