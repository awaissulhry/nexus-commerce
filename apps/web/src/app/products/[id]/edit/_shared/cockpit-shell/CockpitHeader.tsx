'use client'

// UC.1.2 / UC.3.A — Shared cockpit header skeleton.
//
// A faithful structural extraction of the cockpit header: a sticky Card
// with an optional chip-strip row, an identity row (leading badge ·
// title · inline pills · right-aligned actions), and a subtitle line
// under the title. Everything channel-specific arrives via slots so the
// header reproduces each channel's content exactly while the frame
// (sticky offset, card chrome, spacing, flex/wrap behaviour) is shared.
//
// Channels build their own pills using the tokens in ./tokens so the
// visual language stays consistent without the primitive hard-coding a
// status vocabulary.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { COCKPIT_HEADER_STICKY } from './tokens'

export interface CockpitHeaderProps {
  /** Chip-strip row, rendered as the first child of the Card. The
   *  channel owns the row's own chrome (border/bg). Omit for none. */
  chipStrip?: ReactNode
  /** Leading element on the identity row, e.g. a market-code Badge. */
  leading?: ReactNode
  /** Primary title (marketplace name). */
  title: ReactNode
  /** Inline pills / links rendered after the title (status, fulfilment,
   *  public URL) — channel-built from tokens. */
  titlePills?: ReactNode
  /** Secondary line under the title (identifiers · currency · language). */
  subtitle?: ReactNode
  /** Right-aligned action cluster (Pull / AI / Publish / Classic …). */
  actions?: ReactNode
  /** aria-label for the region landmark. */
  ariaLabel?: string
}

export default function CockpitHeader({
  chipStrip,
  leading,
  title,
  titlePills,
  subtitle,
  actions,
  ariaLabel = 'Listing cockpit header',
}: CockpitHeaderProps) {
  return (
    <div className={COCKPIT_HEADER_STICKY} role="region" aria-label={ariaLabel}>
      <Card noPadding>
        {chipStrip}
        <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {leading}
            <div className="min-w-0">
              <div
                className={cn(
                  'text-md font-semibold text-slate-900 dark:text-slate-100 truncate',
                  'flex items-center gap-2 flex-wrap',
                )}
              >
                {title}
                {titlePills}
              </div>
              {subtitle && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                  {subtitle}
                </div>
              )}
            </div>
          </div>
          {actions && (
            <div className="flex items-center gap-2 flex-wrap">{actions}</div>
          )}
        </div>
      </Card>
    </div>
  )
}
