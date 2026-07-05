import type { ReactNode } from 'react'

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** optional CTA (e.g. a Button) */
  action?: ReactNode
  className?: string
}

/** No-data state — centred icon + title + description + optional CTA. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={`h10-ds-empty${className ? ` ${className}` : ''}`}>
      {icon != null && <div className="ico">{icon}</div>}
      <div className="t">{title}</div>
      {description != null && <div className="d">{description}</div>}
      {action != null && <div className="act">{action}</div>}
    </div>
  )
}
