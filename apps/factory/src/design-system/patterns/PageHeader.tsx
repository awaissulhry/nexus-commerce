import type { ReactNode } from 'react'

export interface PageHeaderProps {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** right-aligned actions slot (buttons, selects, date range…) */
  actions?: ReactNode
}

/** List-page header (H10 `.h10-hdr`): eyebrow + title + subtitle, actions right. */
export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="h10-ds-pagehdr">
      <div>
        {eyebrow != null && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle != null && <div className="sub">{subtitle}</div>}
      </div>
      {actions != null && <div className="h10-ds-pagehdr-actions">{actions}</div>}
    </div>
  )
}
