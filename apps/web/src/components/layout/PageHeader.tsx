import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

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
    <div className="mb-5">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1.5 mb-2 text-base text-slate-500">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300" />}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="hover:text-slate-700 transition-colors"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-slate-700 font-medium">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}

      {/* U.12 — mobile parity: title stacks above actions on narrow
          screens (flex-col), actions wrap if a toolbar overflows. The
          desktop layout (sm:flex-row sm:items-start sm:justify-between)
          is unchanged. Title swaps `truncate` for `break-words` since
          wrapping a long title beats truncating it on mobile, where
          horizontal space is precious. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 break-words sm:truncate">
            {title}
          </h1>
          {desc && <p className="text-md text-slate-500 mt-0.5">{desc}</p>}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap sm:flex-shrink-0 sm:flex-nowrap">
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
