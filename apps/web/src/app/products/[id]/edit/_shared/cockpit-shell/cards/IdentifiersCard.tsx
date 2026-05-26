'use client'

// UC.2.3 — Shared Identifiers card.
//
// Channel-agnostic, fully prop-driven: the channel passes localised
// labels and the resolved identifier values, so this card holds no
// Amazon/eBay logic. Amazon adopts it in UC.3 (replacing its current
// placeholder); eBay can adopt it in UC.4. Optional rows simply omit
// when their value is null, so the same card serves a channel that has
// a GTIN/product-type and one that doesn't.

import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

export interface IdentifierRow {
  label: string
  value: ReactNode
  /** Mono font for codes (SKU/GTIN/ASIN). */
  mono?: boolean
  /** Show a small lock glyph — identity field pinned to master. */
  locked?: boolean
}

export interface IdentifiersCardProps {
  /** Localised card title, e.g. t('…identifiers'). */
  title: string
  rows: IdentifierRow[]
  /** data-jump-target id (health-panel jump). */
  jumpTargetId?: string
  action?: ReactNode
}

export default function IdentifiersCard({
  title,
  rows,
  jumpTargetId = 'identifiers',
  action,
}: IdentifiersCardProps) {
  return (
    <div data-jump-target={jumpTargetId} className="min-w-0 scroll-mt-32">
      <Card title={title} action={action}>
        <dl className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-sm">
              <dt className="shrink-0 text-slate-500 dark:text-slate-400">{row.label}</dt>
              <dd
                className={[
                  'min-w-0 truncate text-right text-slate-800 dark:text-slate-200',
                  row.mono ? 'font-mono text-xs' : '',
                ].join(' ')}
              >
                {row.locked && (
                  <span aria-hidden className="mr-1 text-slate-400" title="Locked to master">
                    🔒
                  </span>
                )}
                {row.value ?? <span className="text-slate-400">—</span>}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}
