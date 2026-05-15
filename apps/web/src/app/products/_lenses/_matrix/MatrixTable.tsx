'use client'

import { memo, useRef, useMemo, createContext, useContext } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  createColumnHelper,
  type ColumnDef,
  type ColumnPinningState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown } from 'lucide-react'
import {
  CHANNEL_GROUPS,
  CHANNEL_MARKETPLACES,
  CHANNEL_LABELS,
  type ChannelGroup,
  type ContentLocale,
  type MatrixFlatRow,
} from './types'
import { MatrixMasterCells, ContentLocaleContext } from './MatrixMasterCells'
import { MatrixChannelCell } from './MatrixChannelCell'
import { getCoverageCell } from './useMatrixCoverage'

// ── ExpandedChannelsContext ───────────────────────────────────────────
export const ExpandedChannelsContext = createContext<{
  expanded: Set<ChannelGroup>
  toggle: (ch: ChannelGroup) => void
}>({ expanded: new Set(), toggle: () => {} })

// ── Pinned master column IDs ──────────────────────────────────────────
const MASTER_COL_IDS = ['_expand', '_thumb', '_sku', '_name', '_price', '_stock', '_status'] as const
const MASTER_PIN_LEFT: ColumnPinningState = { left: [...MASTER_COL_IDS] }

const ROW_HEIGHT = 44

// ── Helpers ───────────────────────────────────────────────────────────
function buildColumnDefs(
  expandedChannelGroups: Set<ChannelGroup>,
): ColumnDef<MatrixFlatRow>[] {
  const helper = createColumnHelper<MatrixFlatRow>()

  // Frozen master columns — empty header cells; content rendered by MatrixMasterCells.
  const masterCols: ColumnDef<MatrixFlatRow>[] = MASTER_COL_IDS.map((id) =>
    helper.display({
      id,
      header: () => null,
      cell: () => null, // MatrixRow renders the full master section directly
      size:
        id === '_expand' ? 32
        : id === '_thumb' ? 40
        : id === '_sku' ? 128
        : id === '_name' ? 224
        : id === '_price' ? 96
        : id === '_stock' ? 80
        : 80, // _status
    }),
  )

  // Scrollable channel group columns.
  const channelCols: ColumnDef<MatrixFlatRow>[] = CHANNEL_GROUPS.flatMap((channel) => {
    const marketplaces = CHANNEL_MARKETPLACES[channel]
    const isExpanded = expandedChannelGroups.has(channel)

    if (!isExpanded) {
      // Collapsed: single roll-up column for the channel.
      return [
        helper.display({
          id: `ch_${channel}`,
          header: () => null, // Rendered by MatrixHeader
          cell: ({ row }) => {
            const product = row.original.product
            // Roll up: worst status across all marketplaces for this channel.
            let worstStatus: 'live' | 'override' | 'error' | 'none' = 'none'
            let totalErrors = 0
            let totalOverrides = 0
            let totalChildren = 0
            for (const mp of marketplaces) {
              const cell = getCoverageCell(product, channel, mp)
              if (cell.status === 'error') worstStatus = 'error'
              else if (cell.status === 'override' && worstStatus !== 'error') worstStatus = 'override'
              else if (cell.status === 'live' && worstStatus === 'none') worstStatus = 'live'
              totalErrors += cell.errorChildCount
              totalOverrides += cell.overrideChildCount
              totalChildren = Math.max(totalChildren, cell.totalChildren)
            }
            return (
              <MatrixChannelCell
                status={worstStatus}
                isParent={product.isParent}
                errorChildCount={totalErrors}
                overrideChildCount={totalOverrides}
                totalChildren={totalChildren}
              />
            )
          },
          size: 72,
        }),
      ]
    }

    // Expanded: one column per marketplace.
    return marketplaces.map((mp) =>
      helper.display({
        id: `ch_${channel}_${mp}`,
        header: () => null,
        cell: ({ row }) => {
          const product = row.original.product
          const cell = getCoverageCell(product, channel, mp)
          return (
            <MatrixChannelCell
              status={cell.status}
              isParent={product.isParent}
              errorChildCount={cell.errorChildCount}
              overrideChildCount={cell.overrideChildCount}
              totalChildren={cell.totalChildren}
            />
          )
        },
        size: 72,
      }),
    )
  })

  return [...masterCols, ...channelCols]
}

// ── MatrixHeader ──────────────────────────────────────────────────────
// Renders two rows: channel group headers (with expand/collapse chevrons)
// and marketplace sub-headers.
function MatrixHeader({
  masterWidth,
}: {
  masterWidth: number
}) {
  const { expanded, toggle } = useContext(ExpandedChannelsContext)

  return (
    <div
      className="flex sticky top-0 z-20 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 select-none"
      role="rowgroup"
    >
      {/* Frozen master section header */}
      <div
        className="sticky left-0 z-30 flex flex-col border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
        style={{ width: masterWidth }}
      >
        <div className="h-7 flex items-center px-3 border-b border-slate-100 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Master PIM
          </span>
        </div>
        {/* Sub-header labels */}
        <div className="h-7 flex items-center">
          <div className="w-8 shrink-0" /> {/* expand */}
          <div className="w-10 shrink-0" /> {/* thumb */}
          {[
            { label: 'SKU', w: 128 },
            { label: 'Name', w: 224 },
            { label: 'Price', w: 96 },
            { label: 'Stock', w: 80 },
            { label: 'Status', w: 80 },
          ].map(({ label, w }) => (
            <div
              key={label}
              className="shrink-0 flex items-center px-2 text-xs font-medium text-slate-500 dark:text-slate-400 border-r border-slate-100 dark:border-slate-800 last:border-r-0"
              style={{ width: w }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Channel group headers */}
      <div className="flex flex-col">
        {/* Group row */}
        <div className="h-7 flex items-center border-b border-slate-100 dark:border-slate-800">
          {CHANNEL_GROUPS.map((channel) => {
            const isExp = expanded.has(channel)
            const colCount = isExp ? CHANNEL_MARKETPLACES[channel].length : 1
            return (
              <button
                key={channel}
                onClick={() => toggle(channel)}
                className="h-full flex items-center justify-center gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300 border-r border-slate-200 dark:border-slate-700 last:border-r-0 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors px-2"
                style={{ width: colCount * 72 }}
                title={isExp ? `Collapse ${CHANNEL_LABELS[channel]}` : `Expand ${CHANNEL_LABELS[channel]}`}
              >
                {CHANNEL_LABELS[channel]}
                {isExp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
            )
          })}
        </div>

        {/* Marketplace sub-header row */}
        <div className="h-7 flex items-center">
          {CHANNEL_GROUPS.map((channel) => {
            const isExp = expanded.has(channel)
            const marketplaces = isExp ? CHANNEL_MARKETPLACES[channel] : ['—']
            return marketplaces.map((mp) => (
              <div
                key={`${channel}:${mp}`}
                className="h-full flex items-center justify-center text-[10px] font-medium text-slate-400 dark:text-slate-500 border-r border-slate-100 dark:border-slate-800 last:border-r-0"
                style={{ width: 72 }}
              >
                {mp}
              </div>
            ))
          })}
        </div>
      </div>
    </div>
  )
}

// ── MatrixTable ───────────────────────────────────────────────────────
interface MatrixTableProps {
  flatRows: MatrixFlatRow[]
  contentLocale: ContentLocale
  expandedChannelGroups: Set<ChannelGroup>
  onToggleChannelGroup: (ch: ChannelGroup) => void
  expandedParents: Set<string>
  onToggleParent: (id: string) => void
  loadingChildren: Set<string>
}

export const MatrixTable = memo(function MatrixTable({
  flatRows,
  contentLocale,
  expandedChannelGroups,
  onToggleChannelGroup,
  expandedParents,
  onToggleParent,
  loadingChildren,
}: MatrixTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const columns = useMemo(
    () => buildColumnDefs(expandedChannelGroups),
    [expandedChannelGroups],
  )

  const table = useReactTable({
    data: flatRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnPinning: MASTER_PIN_LEFT,
    },
    defaultColumn: { size: 72 },
  })

  const { rows } = table.getRowModel()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  const virtualRows = virtualizer.getVirtualItems()
  const totalHeight = virtualizer.getTotalSize()

  // Compute master section width (sum of pinned left column sizes).
  const masterWidth = useMemo(() => {
    return table.getLeftLeafColumns().reduce((sum, col) => sum + col.getSize(), 0)
  }, [table])

  const ctxValue = useMemo(
    () => ({ expanded: expandedChannelGroups, toggle: onToggleChannelGroup }),
    [expandedChannelGroups, onToggleChannelGroup],
  )

  return (
    <ExpandedChannelsContext.Provider value={ctxValue}>
      <ContentLocaleContext.Provider value={contentLocale}>
        <div
          ref={scrollRef}
          className="overflow-auto flex-1 relative"
          style={{ contain: 'strict' }}
        >
          <MatrixHeader masterWidth={masterWidth} />

          {/* Virtualizer spacer */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            {virtualRows.map((vRow) => {
              const row = rows[vRow.index]
              const flatRow = row.original
              const product = flatRow.product
              const isChild = flatRow.kind === 'child'
              const isExpanded = expandedParents.has(product.id)
              const isLoadingChildren = product.isParent && loadingChildren.has(product.id)

              return (
                <div
                  key={product.id}
                  role="row"
                  data-testid={`matrix-row-${product.id}`}
                  className={`absolute left-0 right-0 flex border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors ${
                    isChild ? 'bg-slate-50/30 dark:bg-slate-800/20' : ''
                  } ${isLoadingChildren ? 'animate-pulse' : ''}`}
                  style={{
                    top: vRow.start,
                    height: ROW_HEIGHT,
                  }}
                >
                  {/* Frozen master cells */}
                  <div
                    className="sticky left-0 z-10 flex bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700"
                    style={{ width: masterWidth }}
                  >
                    {isChild && (
                      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-200 dark:bg-blue-800" />
                    )}
                    <MatrixMasterCells
                      product={product}
                      isExpanded={isExpanded}
                      onToggleExpand={onToggleParent}
                      rowHeight={ROW_HEIGHT}
                    />
                  </div>

                  {/* Scrollable channel cells */}
                  {CHANNEL_GROUPS.flatMap((channel) => {
                    const isExp = expandedChannelGroups.has(channel)
                    const marketplaces = isExp ? CHANNEL_MARKETPLACES[channel] : ['_rolled']

                    return marketplaces.map((mp) => {
                      const cellKey = `${channel}:${mp}`
                      let cell = getCoverageCell(product, channel, mp === '_rolled' ? CHANNEL_MARKETPLACES[channel][0] : mp)

                      if (mp === '_rolled') {
                        // Rolled-up: worst status across all marketplaces.
                        let worstStatus: 'live' | 'override' | 'error' | 'none' = 'none'
                        let totalErrors = 0
                        let totalOverrides = 0
                        let maxChildren = 0
                        for (const mmp of CHANNEL_MARKETPLACES[channel]) {
                          const c = getCoverageCell(product, channel, mmp)
                          if (c.status === 'error') worstStatus = 'error'
                          else if (c.status === 'override' && worstStatus !== 'error') worstStatus = 'override'
                          else if (c.status === 'live' && worstStatus === 'none') worstStatus = 'live'
                          totalErrors += c.errorChildCount
                          totalOverrides += c.overrideChildCount
                          maxChildren = Math.max(maxChildren, c.totalChildren)
                        }
                        cell = { status: worstStatus, errorChildCount: totalErrors, overrideChildCount: totalOverrides, totalChildren: maxChildren }
                      }

                      return (
                        <div
                          key={cellKey}
                          className="shrink-0 border-r border-slate-100 dark:border-slate-800 last:border-r-0"
                          style={{ width: 72, height: ROW_HEIGHT }}
                        >
                          <MatrixChannelCell
                            status={cell.status}
                            isParent={product.isParent}
                            errorChildCount={cell.errorChildCount}
                            overrideChildCount={cell.overrideChildCount}
                            totalChildren={cell.totalChildren}
                          />
                        </div>
                      )
                    })
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </ContentLocaleContext.Provider>
    </ExpandedChannelsContext.Provider>
  )
})
