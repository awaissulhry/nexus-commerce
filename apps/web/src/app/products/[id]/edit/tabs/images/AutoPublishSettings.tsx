'use client'

// PB.11 — Compact auto-publish toggle popover. Mounted from a small
// gear in the ImageActionBar. Shows one row per channel; checking a
// row arms the post-save auto-publish for that channel.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Settings, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import {
  type AutoPublishChannel,
  getAutoPublishEnabled,
  setAutoPublishEnabled,
} from './autoPublishPrefs'

interface Props {
  productId: string
  /** Filter the visible channels to ones that actually have content.
   *  Operator can still re-enable later when content lands. */
  availableChannels: AutoPublishChannel[]
  /** Bumped when the operator toggles something, so parent re-reads
   *  the prefs and the action bar's "armed" badge stays current. */
  onChanged?: () => void
}

const CHANNEL_LABEL: Record<AutoPublishChannel, string> = {
  AMAZON: 'Amazon (all markets)',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

export default function AutoPublishSettings({ productId, availableChannels, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [prefs, setPrefs] = useState<Record<AutoPublishChannel, boolean>>({
    AMAZON: false,
    EBAY: false,
    SHOPIFY: false,
  })

  function refresh() {
    setPrefs({
      AMAZON: getAutoPublishEnabled(productId, 'AMAZON'),
      EBAY: getAutoPublishEnabled(productId, 'EBAY'),
      SHOPIFY: getAutoPublishEnabled(productId, 'SHOPIFY'),
    })
  }

  useEffect(() => { refresh() }, [productId])

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggle(channel: AutoPublishChannel) {
    const next = !prefs[channel]
    setAutoPublishEnabled(productId, channel, next)
    setPrefs((p) => ({ ...p, [channel]: next }))
    onChanged?.()
  }

  const armedCount = Object.values(prefs).filter(Boolean).length

  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((p) => !p)}
        className="gap-1.5 border border-slate-200 dark:border-slate-700"
        title="Auto-publish settings"
      >
        <Settings className="w-3.5 h-3.5" />
        Auto-publish
        {armedCount > 0 && (
          <span className="text-[10px] font-medium px-1.5 py-px rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 inline-flex items-center gap-0.5">
            <Zap className="w-2.5 h-2.5" />
            {armedCount}
          </span>
        )}
        <ChevronDown className="w-3 h-3" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Auto-publish settings"
          className="absolute right-0 bottom-10 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-2 min-w-[300px] text-sm"
        >
          <div className="px-3 pb-1 text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
            Auto-publish after Save
          </div>
          <div className="px-3 pb-2 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
            When ON, the channel publishes automatically right after every Save (only when that channel had pending changes).
          </div>
          {(['AMAZON', 'EBAY', 'SHOPIFY'] as AutoPublishChannel[]).map((c) => {
            const available = availableChannels.includes(c)
            return (
              <label
                key={c}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer',
                  available
                    ? 'hover:bg-slate-50 dark:hover:bg-slate-700'
                    : 'opacity-50 cursor-not-allowed',
                )}
              >
                <input
                  type="checkbox"
                  checked={prefs[c]}
                  disabled={!available}
                  onChange={() => available && toggle(c)}
                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="flex-1 text-slate-700 dark:text-slate-300">{CHANNEL_LABEL[c]}</span>
                {!available && (
                  <span className="text-[10px] text-slate-400">no content</span>
                )}
              </label>
            )
          })}
          <div className="border-t border-slate-100 dark:border-slate-700 mt-2 pt-2 px-3 text-[10px] text-slate-400 leading-snug">
            Per-browser preference. Cleared when you clear site data.
          </div>
        </div>
      )}
    </div>
  )
}
