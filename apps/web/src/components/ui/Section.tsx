/**
 * P1 — Section primitive.
 *
 * A labelled content group: optional heading + description + actions,
 * then children. Use to break a page into scannable blocks with
 * consistent heading weight and spacing. Set `card` to wrap the body
 * in a panel surface.
 *
 * Usage:
 *   <Section title="Pricing" description="Live across all markets" card>
 *     …
 *   </Section>
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SectionProps {
  title?: ReactNode
  description?: ReactNode
  /** Right-aligned actions in the section header. */
  actions?: ReactNode
  /** Wrap the body in a card surface (bg-card + border + padding). */
  card?: boolean
  children: ReactNode
  className?: string
  /** Extra class for the body wrapper. */
  bodyClassName?: string
}

export function Section({ title, description, actions, card, children, className, bodyClassName }: SectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      {(title || description || actions) && (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-body-lg font-heading text-primary">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-secondary">{description}</p>}
          </div>
          {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(card && 'rounded-lg border border-default bg-card p-4', bodyClassName)}>{children}</div>
    </section>
  )
}
