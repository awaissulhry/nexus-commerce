/**
 * P1 — PageHeader primitive.
 *
 * The consistent top-of-page strip: title + optional description +
 * right-aligned actions, on the design tokens. Pages hand-roll this
 * dozens of different ways today; this standardises the spacing,
 * type scale (comfortable), and the divider underneath.
 *
 * Usage:
 *   <PageHeader
 *     title="Products"
 *     description="265 SKUs across Amazon, eBay and Shopify."
 *     actions={<Button variant="primary">Add product</Button>}
 *   />
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned action cluster (buttons, toggles). */
  actions?: ReactNode
  /** Optional breadcrumb / eyebrow rendered above the title. */
  breadcrumb?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, breadcrumb, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-default pb-4 mb-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-tertiary">{breadcrumb}</div>}
        <h1 className="text-2xl font-heading text-primary truncate">{title}</h1>
        {description && <p className="mt-1 text-body text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
