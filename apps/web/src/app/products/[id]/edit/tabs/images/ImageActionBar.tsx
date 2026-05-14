'use client'

// IM.3 — Bottom action bar for the images workspace.
// Save/Discard apply to pending listing-image changes only.
// Publish buttons are stubs — wired in IM.9.

import { Loader2, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { ChannelTab } from './types'

interface Props {
  activeChannel: ChannelTab
  dirtyCount: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}

export default function ImageActionBar({ activeChannel, dirtyCount, saving, onSave, onDiscard }: Props) {
  if (dirtyCount === 0 && activeChannel === 'master') return null

  return (
    <div className="mt-4 flex items-center justify-between gap-4 py-3 px-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      <div className="flex items-center gap-2">
        {dirtyCount > 0 ? (
          <>
            <Button
              size="sm"
              onClick={onSave}
              disabled={saving || dirtyCount === 0}
              className="gap-1.5"
            >
              {saving
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Save className="w-3.5 h-3.5" />}
              Save {dirtyCount > 0 && `(${dirtyCount} change${dirtyCount === 1 ? '' : 's'})`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDiscard}
              disabled={saving}
              className="gap-1 text-slate-500"
            >
              <X className="w-3.5 h-3.5" /> Discard
            </Button>
          </>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500 italic">
            No pending changes
          </span>
        )}
      </div>

      {/* Publish button — active on channel tabs, stub until IM.9 */}
      {activeChannel !== 'master' && (
        <Button
          size="sm"
          variant="ghost"
          disabled
          title="Publish integration coming in a later phase"
          className="gap-1.5 text-slate-500 border border-slate-200 dark:border-slate-700"
        >
          Publish {activeChannel === 'amazon' ? 'Amazon' : activeChannel === 'ebay' ? 'eBay' : 'Shopify'}
        </Button>
      )}
    </div>
  )
}
