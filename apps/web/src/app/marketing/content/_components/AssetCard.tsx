'use client'

// MC.1.2 — single asset tile for the grid view. Aspect-locked square
// so the grid stays clean for mixed portrait/landscape sources.
// Click + double-click hooks reserved for MC.1.5 (open detail
// drawer); for now they're inert but accessible.

import Image from 'next/image'
import { Film, Box, FileText, ImageOff, Link2 } from 'lucide-react'
import { formatBytes } from '../_lib/format'
import { splitForHighlight } from '../_lib/highlight'
import type { LibraryItem } from '../_lib/types'

interface Props {
  item: LibraryItem
  onSelect?: (item: LibraryItem) => void
  selected?: boolean
  highlight?: string
}

function HighlightedText({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>
  const seg = splitForHighlight(text, query)
  if (!seg) return <>{text}</>
  return (
    <>
      {seg.before}
      <mark className="rounded-sm bg-amber-200 px-0.5 py-0 text-slate-900 dark:bg-amber-500/40 dark:text-amber-100">
        {seg.match}
      </mark>
      {seg.after}
    </>
  )
}

function TypeIcon({ type }: { type: string }) {
  if (type === 'video')
    return <Film className="w-4 h-4" aria-hidden="true" />
  if (type === 'document')
    return <FileText className="w-4 h-4" aria-hidden="true" />
  if (type === 'model3d')
    return <Box className="w-4 h-4" aria-hidden="true" />
  return null
}

export default function AssetCard({ item, onSelect, selected, highlight }: Props) {
  const isImage = item.type === 'image'
  return (
    <button
      type="button"
      onClick={() => onSelect?.(item)}
      aria-pressed={selected ?? false}
      className={`group relative flex flex-col overflow-hidden rounded-md border text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-500/30 dark:border-blue-400'
          : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'
      }`}
    >
      <div className="relative aspect-square w-full bg-slate-100 dark:bg-slate-800">
        {isImage ? (
          <Image
            src={item.url}
            alt={item.label}
            fill
            sizes="(min-width: 1024px) 16vw, (min-width: 640px) 25vw, 50vw"
            className="object-cover transition-transform group-hover:scale-105"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400 dark:text-slate-500">
            <ImageOff className="w-8 h-8" aria-hidden="true" />
          </div>
        )}
        {item.type !== 'image' && (
          <div className="absolute right-1.5 top-1.5 rounded bg-slate-900/80 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm flex items-center gap-1">
            <TypeIcon type={item.type} />
            <span className="uppercase tracking-wide text-[10px]">
              {item.type}
            </span>
          </div>
        )}
        {item.role && (
          <div className="absolute left-1.5 top-1.5 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white backdrop-blur-sm">
            {item.role}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <p
          className="truncate text-xs font-medium text-slate-900 dark:text-slate-100"
          title={item.label}
        >
          <HighlightedText text={item.label} query={highlight} />
        </p>
        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-0.5">
            {item.usageCount > 0 ? (
              <>
                <Link2 className="w-3 h-3" aria-hidden="true" />
                {item.usageCount}
              </>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">·</span>
            )}
          </span>
          <span className="truncate">
            {item.sizeBytes ? formatBytes(item.sizeBytes) : '—'}
          </span>
        </div>
      </div>
    </button>
  )
}
