'use client'

/**
 * P.1i — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep.
 *
 * Saved-view dropdown: list views, apply, save current, delete,
 * set-default, open per-view alert config.
 *
 * P.3 — each row carries an alert summary badge. Bell tone is purple
 * by default and amber when an alert fired in the last 24h, so the
 * operator's eye lands on the views that need triage.
 */

import { useEffect, useRef, useState } from 'react'
import { Bell, Bookmark, BookmarkPlus, ChevronDown, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useConfirm } from '@/components/ui/ConfirmProvider'

export type SavedView = {
  id: string
  name: string
  filters: any
  isDefault: boolean
  surface: string
  alertSummary?: {
    active: number
    total: number
    firedRecently: number
  }
}

interface SavedViewsButtonProps {
  open: boolean
  setOpen: (v: boolean) => void
  views: SavedView[]
  onApply: (view: SavedView) => void
  onSaveCurrent: (name: string, isDefault: boolean) => Promise<boolean> | boolean
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onAlerts?: (view: SavedView) => void
}

export function SavedViewsButton({
  open,
  setOpen,
  views,
  onApply,
  onSaveCurrent,
  onDelete,
  onSetDefault,
  onAlerts,
}: SavedViewsButtonProps) {
  const askConfirm = useConfirm()
  const [saveMode, setSaveMode] = useState(false)
  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [setOpen])

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        onClick={() => setOpen(!open)}
        icon={<Bookmark size={12} />}
      >
        Views <ChevronDown size={12} />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-2">
          {!saveMode ? (
            <>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">
                Saved views
              </div>
              {views.length === 0 ? (
                <div className="px-2 py-3 text-base text-slate-400 text-center">
                  No saved views yet
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {views.map((v: SavedView) => {
                    const alertCount = v.alertSummary?.total ?? 0
                    const firedRecently = (v.alertSummary?.firedRecently ?? 0) > 0
                    const bellColor = firedRecently
                      ? 'text-amber-600 hover:text-amber-700'
                      : alertCount > 0
                        ? 'text-purple-600 hover:text-purple-700'
                        : 'text-slate-400 hover:text-purple-600'
                    return (
                      <li
                        key={v.id}
                        className="flex items-center justify-between gap-1 px-2 py-1.5 hover:bg-slate-50 rounded"
                      >
                        <button
                          onClick={() => onApply(v)}
                          className="flex-1 min-w-0 text-left text-base text-slate-900 inline-flex items-center gap-1.5"
                        >
                          {v.isDefault && (
                            <Star size={10} className="text-amber-500 fill-amber-500" />
                          )}
                          <span className="truncate">{v.name}</span>
                        </button>
                        <button
                          onClick={() => onAlerts?.(v)}
                          title={
                            alertCount === 0
                              ? 'Add alerts'
                              : firedRecently
                                ? `${alertCount} alert${alertCount === 1 ? '' : 's'} — fired in last 24h`
                                : `${alertCount} alert${alertCount === 1 ? '' : 's'} attached`
                          }
                          className={`min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:h-6 sm:px-1 inline-flex items-center justify-center gap-0.5 ${bellColor}`}
                        >
                          <Bell size={12} />
                          {alertCount > 0 && (
                            <span className="text-xs font-semibold tabular-nums">
                              {alertCount}
                            </span>
                          )}
                        </button>
                        <IconButton
                          onClick={() => onSetDefault(v.id)}
                          title="Set as default"
                          aria-label={`Set "${v.name}" as default view`}
                          size="sm"
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-slate-400 hover:text-amber-500"
                        >
                          <Star size={12} />
                        </IconButton>
                        <IconButton
                          onClick={async () => {
                            if (
                              await askConfirm({
                                title: `Delete view "${v.name}"?`,
                                description: 'This view + its alerts will be removed permanently.',
                                confirmLabel: 'Delete',
                                tone: 'danger',
                              })
                            ) {
                              onDelete(v.id)
                            }
                          }}
                          title="Delete"
                          aria-label={`Delete saved view "${v.name}"`}
                          size="sm"
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-slate-400 hover:text-rose-600"
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      </li>
                    )
                  })}
                </ul>
              )}
              <Button
                onClick={() => setSaveMode(true)}
                className="w-full mt-1 bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                icon={<BookmarkPlus size={12} />}
              >
                Save current view
              </Button>
            </>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1">
                Save current view
              </div>
              <input
                autoFocus
                type="text"
                placeholder="View name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-8 px-2 text-md border border-slate-200 rounded"
              />
              <label className="flex items-center gap-2 px-2 text-base text-slate-700">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
                Use as default on page load
              </label>
              <div className="flex items-center gap-2">
                <Button
                  onClick={async () => {
                    if (!name.trim()) return
                    const ok = await onSaveCurrent(name.trim(), isDefault)
                    if (ok) {
                      setSaveMode(false)
                      setName('')
                      setIsDefault(false)
                      setOpen(false)
                    }
                  }}
                  className="flex-1 bg-slate-900 text-white border-slate-900 hover:bg-slate-800"
                >
                  Save
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSaveMode(false)
                    setName('')
                  }}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
