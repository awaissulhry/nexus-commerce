import type { ReactNode } from 'react'

export interface HoverCardProps {
  /** rich content shown on hover/focus */
  card: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Rich hover panel (H10 HoverCard): a light surface card above the trigger,
 * shown on hover or keyboard focus. For a plain text hint use Tooltip.
 */
export function HoverCard({ card, children, className }: HoverCardProps) {
  return (
    <span className={`h10-ds-hovercard${className ? ` ${className}` : ''}`} tabIndex={0}>
      {children}
      <span className="hc" role="tooltip">
        {card}
      </span>
    </span>
  )
}
