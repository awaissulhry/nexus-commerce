import type { DetailsHTMLAttributes, ReactNode } from 'react'
import type { Tone } from '../primitives/tone'
import { ChevronRight } from 'lucide-react'

export interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
  /** Visible toggle label. Keep interactive controls in the body, outside the summary. */
  tone?: Tone
  summary: ReactNode
  children: ReactNode
}

/** Collapsible supporting content. Native details supplies keyboard and expanded-state semantics. */
export function Disclosure({ summary, children, tone, className, ...rest }: DisclosureProps) {
  return (
    <details className={['nds-disclosure', tone, className].filter(Boolean).join(' ')} {...rest}>
      <summary className="nds-disclosure-summary">
        <ChevronRight size={14} className="nds-disclosure-chevron" aria-hidden />
        <span>{summary}</span>
      </summary>
      <div className="nds-disclosure-body">{children}</div>
    </details>
  )
}
