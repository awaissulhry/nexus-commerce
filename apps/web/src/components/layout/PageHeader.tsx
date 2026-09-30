import Link from '@/lib/workspaces/Link'
import { ChevronRight } from 'lucide-react'
import './page-header.css'

interface Breadcrumb {
  label: string
  href?: string
}

interface PageHeaderProps {
  /** Page title */
  title: string
  /** Optional subtitle. Both `subtitle` and `description` accepted; `description` wins. */
  subtitle?: string
  description?: string
  /** Breadcrumb trail */
  breadcrumbs?: Breadcrumb[]
  /** Action buttons (rendered on the right) */
  actions?: React.ReactNode
}

/**
 * PageHeader — used at the top of every page.
 *
 * Phase 4 styling: 18px title, 13px description, single chrome row, kept
 * inline (no full-width background band) so pages with the layout's p-6
 * wrapper continue to render correctly without mechanical churn.
 *
 * Styled by page-header.css from DS tokens, not Tailwind colour classes: those
 * read an alias that tokens.css redefines in another form, and the title turned
 * black on the dark page (1.04:1). Same sizes and layout as before.
 */
export default function PageHeader({
  title,
  subtitle,
  description,
  breadcrumbs,
  actions,
}: PageHeaderProps) {
  const desc = description ?? subtitle

  return (
    <div className="app-pagehdr">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="app-pagehdr-crumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="app-pagehdr-crumb">
              {i > 0 && <ChevronRight aria-hidden />}
              {crumb.href ? (
                <Link href={crumb.href}>{crumb.label}</Link>
              ) : (
                <span className="app-pagehdr-crumb-current">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      {/* U.12 — mobile parity: title stacks above actions on narrow screens,
          actions wrap if a toolbar overflows; side by side from 640px. A long
          title wraps on a phone and is cut with an ellipsis on a wide screen. */}
      <div className="app-pagehdr-row">
        <div className="app-pagehdr-text">
          <h1 className="app-pagehdr-title">{title}</h1>
          {desc && <p className="app-pagehdr-desc">{desc}</p>}
        </div>
        {actions && <div className="app-pagehdr-actions">{actions}</div>}
      </div>
    </div>
  )
}
