import type { DetailsHTMLAttributes, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
  /** Visible toggle label. Keep interactive controls in the body, outside the summary. */
  summary: ReactNode
  children: ReactNode
}

/** Collapsible supporting content. Native details supplies keyboard and expanded-state semantics. */
export function Disclosure({ summary, children, className, ...rest }: DisclosureProps) {
  return (
    <details className={['nds-disclosure', className].filter(Boolean).join(' ')} {...rest}>
      <summary className="nds-disclosure-summary">
        <ChevronRight size={14} className="nds-disclosure-chevron" aria-hidden />
        <span>{summary}</span>
      </summary>
      <div className="nds-disclosure-body">{children}</div>
    </details>
  )
}
