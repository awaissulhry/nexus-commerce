'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { COUNTRY_NAMES } from '@/lib/country-names'

export interface MarketplaceContext {
  channel: 'AMAZON' | 'EBAY'
  marketplace: string
}

export interface MarketplaceOption {
  channel: 'AMAZON' | 'EBAY'
  code: string
  name: string
  currency: string
  language: string
}

interface Props {
  value: MarketplaceContext | null
  onChange: (ctx: MarketplaceContext | null) => void
  options: MarketplaceOption[]
  /** Highlight to draw attention when channel fields are visible
   *  but no context is set yet. */
  pulse?: boolean
}

export default function MarketplaceSelector({
  value,
  onChange,
  options,
  pulse,
}: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) {
        return
      }
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Group by channel for the dropdown
  const byChannel = new Map<string, MarketplaceOption[]>()
  for (const o of options) {
    let arr = byChannel.get(o.channel)
    if (!arr) {
      arr = []
      byChannel.set(o.channel, arr)
    }
    arr.push(o)
  }

  const selectedLabel = value
    ? `${value.channel === 'AMAZON' ? 'Amazon' : 'eBay'} ${value.marketplace}`
    : 'No marketplace'
  const selectedSub = value
    ? COUNTRY_NAMES[value.marketplace] ?? value.marketplace
    : 'Pick to edit channel fields'

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-2 h-7 px-2.5 text-[12px] border rounded-md transition-colors',
          value
            ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100'
            : pulse
            ? 'border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-200 ring-offset-1 animate-pulse-slow'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Globe className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="font-mono">{selectedLabel}</span>
        <ChevronDown className="w-3 h-3 text-slate-500" />
      </button>

      {!value && pulse && (
        <span className="ml-2 text-[11px] text-amber-700">
          Pick a marketplace
        </span>
      )}

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-1 w-72 max-h-[400px] bg-white border border-slate-200 rounded-lg shadow-lg z-30 flex flex-col"
          role="listbox"
        >
          <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              Edit context
            </span>
            <span className="text-[11px] text-slate-500">
              {selectedSub}
            </span>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left',
                value === null
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50'
              )}
            >
              <X className="w-3 h-3" />
              <span>None (master data only)</span>
            </button>
            {Array.from(byChannel.entries()).map(([channel, opts]) => (
              <div key={channel}>
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {channel === 'AMAZON' ? 'Amazon' : 'eBay'}
                </div>
                {opts.map((o) => {
                  const active =
                    value?.channel === o.channel && value?.marketplace === o.code
                  return (
                    <button
                      key={`${o.channel}_${o.code}`}
                      type="button"
                      onClick={() => {
                        onChange({ channel: o.channel, marketplace: o.code })
                        setOpen(false)
                      }}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left',
                        active
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded border',
                            active
                              ? 'bg-white border-blue-200 text-blue-700'
                              : 'bg-slate-100 border-slate-200 text-slate-600'
                          )}
                        >
                          {o.code}
                        </span>
                        <span className="text-[12px] truncate">{o.name}</span>
                      </span>
                      <span className="text-[10px] text-slate-400 flex-shrink-0">
                        {o.currency}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface BannerProps {
  visible: boolean
  pendingChannelChanges: number
}

export function MarketplaceContextBanner({
  visible,
  pendingChannelChanges,
}: BannerProps) {
  if (!visible) return null
  return (
    <div className="flex-shrink-0 mb-3 flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-800">
      <Globe className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
      <span>
        <strong>Select a marketplace</strong> to edit Amazon/eBay channel
        fields. {pendingChannelChanges > 0 && (
          <>
            You have <strong className="tabular-nums">{pendingChannelChanges}</strong> pending
            channel change{pendingChannelChanges === 1 ? '' : 's'} that can't be
            saved without a context.
          </>
        )}
      </span>
    </div>
  )
}
