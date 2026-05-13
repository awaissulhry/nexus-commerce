'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CellProps } from '@/components/flat-file/FlatFileGrid.types'
import type { EbayColumn } from './ebay-columns'

// ── Market link URLs ───────────────────────────────────────────────────────

const MARKET_URLS: Record<string, string> = {
  IT: 'https://www.ebay.it/itm/',
  DE: 'https://www.ebay.de/itm/',
  FR: 'https://www.ebay.fr/itm/',
  ES: 'https://www.ebay.es/itm/',
  UK: 'https://www.ebay.co.uk/itm/',
}

function statusBadgeCls(status?: string | null) {
  switch (status?.toUpperCase()) {
    case 'ACTIVE': return 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'DRAFT':  return 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
    case 'ERROR':  return 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300'
    default:       return 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400'
  }
}

// ── Extended props for eBay-specific callbacks ─────────────────────────────

export interface EbayCellProps extends CellProps {
  onOpenDescription: () => void
  onOpenCategorySearch: () => void
}

// ── Cell component ─────────────────────────────────────────────────────────

export function EbayCell({
  col: colBase,
  value,
  isActive,
  isSelected,
  cfClass,
  rowBandClass,
  onChange,
  onActivate,
  onOpenDescription,
  onOpenCategorySearch,
}: EbayCellProps) {
  const col = colBase as EbayColumn

  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

  const displayVal = value == null || value === '' ? '' : String(value)
  const isReadOnly = col.readOnly || col.kind === 'readonly'

  const startEdit = useCallback(() => {
    if (isReadOnly) return
    if (col.kind === 'longtext') { onOpenDescription(); return }
    if (col.id === 'category_id') { onOpenCategorySearch(); return }
    setDraft(displayVal)
    setEditing(true)
  }, [isReadOnly, col.kind, col.id, displayVal, onOpenDescription, onOpenCategorySearch])

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  function commit(v: string) {
    setEditing(false)
    let coerced: unknown = v
    if (col.kind === 'number')  coerced = v === '' ? '' : Number(v)
    if (col.kind === 'boolean') coerced = v === 'true' || v === '1'
    onChange(coerced)
  }

  // tdCls: <td> without flex — applying flex directly to <td> breaks table layout.
  // No explicit text-size here — inherits text-sm from the table element.
  const tdCls = cn(
    'h-7 border-r border-b border-slate-200 dark:border-slate-700',
    'overflow-hidden cursor-pointer select-none',
    isReadOnly && 'bg-slate-50/60 dark:bg-slate-900/40 text-slate-400',
    !isReadOnly && (rowBandClass ?? ''),
    !isReadOnly && (cfClass ?? ''),
    isActive   && 'ring-2 ring-inset ring-blue-500',
    isSelected && !isActive && 'bg-blue-100/60 dark:bg-blue-900/20',
    col.id === 'sku' && 'font-mono font-medium',
  )
  const inner = 'flex items-center h-full px-1.5 gap-1 overflow-hidden'

  // ── Editing states ───────────────────────────────────────────────────

  if (editing) {
    if (col.kind === 'enum') {
      return (
        <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }}>
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="w-full h-full px-1.5 bg-white dark:bg-slate-800 border-none outline-none"
            value={draft}
            onChange={(e) => { commit(e.target.value); setEditing(false) }}
            onBlur={() => commit(draft)}
          >
            {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </td>
      )
    }
    if (col.kind === 'boolean') {
      return (
        <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }}>
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="w-full h-full px-1.5 bg-white dark:bg-slate-800 border-none outline-none"
            value={draft}
            onChange={(e) => { commit(e.target.value); setEditing(false) }}
            onBlur={() => commit(draft)}
          >
            <option value="">—</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </td>
      )
    }
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={col.kind === 'number' ? 'number' : 'text'}
          className="w-full h-full px-1.5 bg-transparent border-none outline-none"
          value={draft}
          maxLength={col.maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(draft) }
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      </td>
    )
  }

  // ── Market-specific read-only cells ──────────────────────────────────

  if (col.id.endsWith('_status') && col.readOnly) {
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <div className={inner}>
          {displayVal
            ? <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(displayVal))}>{displayVal}</span>
            : <span className="text-slate-300 text-[10px]">—</span>}
        </div>
      </td>
    )
  }

  if (col.id.endsWith('_item_id') && col.readOnly) {
    const marketCode = col.id.slice(0, 2).toUpperCase()
    const baseUrl = MARKET_URLS[marketCode] ?? ''
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <div className={inner}>
          {displayVal
            ? <a href={`${baseUrl}${displayVal}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-mono text-[10px]"
                onClick={(e) => e.stopPropagation()}>
                {displayVal}
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              </a>
            : <span className="text-slate-300 text-[10px]">—</span>}
        </div>
      </td>
    )
  }

  // ── Special column renderers ──────────────────────────────────────────

  if (col.id === 'title') {
    const len = displayVal.length
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate} onDoubleClick={startEdit}>
        <div className={inner}>
          <span className="flex-1 truncate">{displayVal}</span>
          {len > 0 && (
            <span className={cn('text-[10px] shrink-0', len > 80 ? 'text-red-500' : 'text-slate-400')}>{len}</span>
          )}
        </div>
      </td>
    )
  }

  if (col.id === 'description') {
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate} onDoubleClick={onOpenDescription}>
        <div className={inner}>
          <span className="truncate text-slate-400 italic text-[10px]">
            {displayVal ? displayVal.replace(/<[^>]+>/g, '').slice(0, 40) + '…' : 'Double-click to edit…'}
          </span>
        </div>
      </td>
    )
  }

  if (col.id === 'category_id') {
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate} onDoubleClick={onOpenCategorySearch}>
        <div className={inner}>
          {displayVal
            ? <span className="font-mono text-[10px] text-blue-700 dark:text-blue-300">{displayVal}</span>
            : <span className="text-slate-300 text-[10px]">Double-click to search…</span>}
        </div>
      </td>
    )
  }

  if (col.kind === 'boolean') {
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate} onDoubleClick={startEdit}>
        <div className={inner}>
          {value === true || value === 'true'
            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            : <span className="text-slate-300">—</span>}
        </div>
      </td>
    )
  }

  if (col.id === 'listing_status') {
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <div className={inner}>
          {displayVal && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(displayVal))}>
              {displayVal}
            </span>
          )}
        </div>
      </td>
    )
  }

  if (col.id === 'last_pushed_at') {
    const d = displayVal ? new Date(displayVal) : null
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <div className={inner}>
          <span className="truncate text-slate-400 text-[10px]">
            {d ? d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
          </span>
        </div>
      </td>
    )
  }

  // Push sync status
  if (col.id === 'sync_status') {
    const iconMap: Record<string, React.ReactNode> = {
      synced:  <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
      pending: <Loader2 className="h-3 w-3 text-amber-500 animate-spin" />,
      error:   <AlertCircle className="h-3 w-3 text-red-500" />,
    }
    return (
      <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <div className={inner}>
          {iconMap[displayVal] ?? <span className="text-slate-300 text-[10px]">—</span>}
        </div>
      </td>
    )
  }

  // ── Default cell ──────────────────────────────────────────────────────

  return (
    <td className={tdCls} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate} onDoubleClick={startEdit}>
      <div className={inner}>
        <span className="truncate">{displayVal || <span className="text-slate-300">—</span>}</span>
      </div>
    </td>
  )
}
