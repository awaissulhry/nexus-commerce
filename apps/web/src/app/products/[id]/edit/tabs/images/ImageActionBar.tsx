'use client'

// Bottom action bar for the images workspace.
// Save / Discard for staged listing-image changes. Publishing lives on
// each channel panel (AmazonPublishBar, EbayPanel, ShopifyPanel) — the
// bar is only visible when there are pending changes to commit.

import { Loader2, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface Props {
  dirtyCount: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}

export default function ImageActionBar({ dirtyCount, saving, onSave, onDiscard }: Props) {
  if (dirtyCount === 0) return null

  return (
    <div className="mt-4 flex items-center gap-2 py-3 px-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving}
        className="gap-1.5"
      >
        {saving
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Save className="w-3.5 h-3.5" />}
        Save ({dirtyCount} change{dirtyCount === 1 ? '' : 's'})
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
    </div>
  )
}
