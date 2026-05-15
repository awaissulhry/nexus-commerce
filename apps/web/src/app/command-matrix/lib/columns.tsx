'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ImageCell } from '@/components/ui/TableCell'
import { StatusDot, RolledUpStatusDot } from '../components/StatusDot'
import { rollupChannel, localeTone, type ChannelKey } from './rollup'
import type { CatalogNode } from './types'

export type { ChannelKey }

const col = createColumnHelper<CatalogNode>()

// ─── Locale % cell ────────────────────────────────────────────────────────────

function LocaleCell({
  pct,
  isVariant,
}: {
  pct: number | null
  isVariant: boolean
}) {
  if (isVariant || pct === null) {
    return <span className="text-slate-400 text-xs">—</span>
  }
  const tone = localeTone(pct)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium tabular-nums',
        tone === 'success' && 'text-green-700',
        tone === 'warning' && 'text-amber-700',
        tone === 'danger' && 'text-red-600',
      )}
    >
      {pct}%
      {pct < 100 && (
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full inline-block',
            tone === 'warning' && 'bg-amber-400',
            tone === 'danger' && 'bg-red-500',
          )}
        />
      )}
    </span>
  )
}

// ─── Column definitions ───────────────────────────────────────────────────────

export function buildColumns() {
  return [
    // ── Group 1: Masters & Variants ─────────────────────────────────
    col.group({
      id: 'tree',
      header: 'MASTERS & VARIANTS',
      columns: [
        col.display({
          id: 'expander',
          size: 36,
          enableResizing: false,
          header: () => null,
          cell: ({ row }) => {
            if (!row.getCanExpand()) return null
            return (
              <button
                onClick={row.getToggleExpandedHandler()}
                className="flex items-center justify-center w-full h-full text-slate-400 hover:text-slate-700"
                aria-label={row.getIsExpanded() ? 'Collapse' : 'Expand'}
              >
                {row.getIsExpanded() ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
            )
          },
        }),
        col.display({
          id: 'thumbnail',
          size: 40,
          enableResizing: false,
          header: () => null,
          cell: ({ row }) => (
            <div className="flex items-center justify-center">
              <ImageCell src={row.original.thumbnailUrl ?? undefined} alt={row.original.name} size="xs" />
            </div>
          ),
        }),
        col.accessor('name', {
          id: 'name',
          header: 'Name / SKU',
          size: 280,
          cell: ({ row }) => {
            const depth = row.depth
            return (
              <div
                className="flex flex-col min-w-0"
                style={{ paddingLeft: depth * 16 }}
              >
                <span className="truncate text-sm font-medium text-slate-900">
                  {row.original.isMaster
                    ? `Master: ${row.original.name}`
                    : row.original.name}
                </span>
                <span className="truncate text-xs text-slate-500 font-mono">
                  {row.original.sku}
                </span>
              </div>
            )
          },
        }),
      ],
    }),

    // ── Group 2: Locales ────────────────────────────────────────────
    col.group({
      id: 'locales',
      header: 'LOCALES',
      columns: (
        [
          { id: 'en' as const, header: '🇬🇧 EN', flag: '🇬🇧' },
          { id: 'de' as const, header: '🇩🇪 DE', flag: '🇩🇪' },
          { id: 'it' as const, header: '🇮🇹 IT', flag: '🇮🇹' },
        ] as const
      ).map(({ id, header }) =>
        col.display({
          id: `locale_${id}`,
          header,
          size: 72,
          cell: ({ row }) => (
            <div className="flex items-center justify-center">
              <LocaleCell
                pct={row.original.locales?.[id] ?? null}
                isVariant={!row.original.isMaster}
              />
            </div>
          ),
        }),
      ),
    }),

    // ── Group 3: Channels ───────────────────────────────────────────
    col.group({
      id: 'channels',
      header: 'CHANNELS',
      columns: (
        [
          { key: 'amazonDe' as const, header: 'AMZ DE' },
          { key: 'ebayUk' as const, header: 'EBAY' },
          { key: 'shopify' as const, header: 'SHOP' },
        ] as const
      ).map(({ key, header }) =>
        col.display({
          id: `channel_${key}`,
          header,
          size: 72,
          cell: ({ row }) => {
            const node = row.original
            if (node.isMaster && node.subRows && node.subRows.length > 0) {
              const rollup = rollupChannel(node, key)
              return (
                <div className="flex items-center justify-center">
                  <RolledUpStatusDot rollup={rollup} />
                </div>
              )
            }
            return (
              <div className="flex items-center justify-center">
                <StatusDot status={node.channels[key]} />
              </div>
            )
          },
        }),
      ),
    }),
  ]
}
