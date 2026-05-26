'use client'

// FL.3 — Per-field scope control ("the choice").
//
// Opened from a FieldSourceBadge. Lets the operator set how ONE field
// resolves on this coordinate:
//   ⬆ Follow master   — inherit the product value (auto-translate per market)
//   🔗 Linked group    — share with a chosen set of {channel × market}
//   ✏️ Independent      — pin this cell only
//
// FL.3 (this) is the UI + diff-then-apply contract; it calls onApply with
// the chosen scope + member keys. Persistence to FieldLinkGroup /
// ChannelListingOverride is wired in FL.3b once the migration is live.
// Rendered as a small centred dialog so positioning is robust.

import { useEffect, useState } from 'react'
import { X, ArrowUpFromLine, Link2, Pencil, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FieldScope = 'master' | 'linked' | 'independent'

export interface ScopeMember {
  /** Stable key "CHANNEL:MARKET", also the apply payload value. */
  key: string
  channel: string
  marketplace: string
  label: string
}

export interface FieldScopeResult {
  scope: FieldScope
  /** Selected member keys when scope === 'linked'. */
  memberKeys: string[]
  translate: boolean
}

export interface FieldScopePopoverProps {
  open: boolean
  onClose: () => void
  fieldLabel: string
  marketLabel: string
  scope: FieldScope
  /** Channels × markets available to link. */
  members?: ScopeMember[]
  /** Pre-checked member keys (the current group). */
  selectedMembers?: string[]
  /** Whether cross-language members auto-translate (text fields). */
  canTranslate?: boolean
  onApply: (result: FieldScopeResult) => void
  /** FL.4 — when set and scope is linked, shows a "Propagate to members"
   *  action that opens the diff modal. */
  onPropagate?: () => void
}

export default function FieldScopePopover({
  open,
  onClose,
  fieldLabel,
  marketLabel,
  scope,
  members = [],
  selectedMembers = [],
  canTranslate = true,
  onApply,
  onPropagate,
}: FieldScopePopoverProps) {
  const [draftScope, setDraftScope] = useState<FieldScope>(scope)
  const [checked, setChecked] = useState<Set<string>>(new Set(selectedMembers))
  const [translate, setTranslate] = useState(canTranslate)

  // Re-seed when (re)opened for a different field/coordinate.
  useEffect(() => {
    if (!open) return
    setDraftScope(scope)
    setChecked(new Set(selectedMembers))
    setTranslate(canTranslate)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const apply = () => {
    onApply({
      scope: draftScope,
      memberKeys: draftScope === 'linked' ? Array.from(checked) : [],
      translate: draftScope === 'linked' ? translate : false,
    })
    onClose()
  }

  // Plain data (not a nested component) → stable host <button> elements
  // that don't remount on every parent re-render, so the click sticks.
  const scopeOptions: Array<{
    value: FieldScope
    icon: LucideIcon
    title: string
    hint: string
  }> = [
    { value: 'master', icon: ArrowUpFromLine, title: 'Follow master', hint: 'Inherit the product value (auto-translate per market)' },
    { value: 'linked', icon: Link2, title: 'Linked group', hint: 'Share with a chosen set of channels × markets' },
    { value: 'independent', icon: Pencil, title: 'Independent', hint: 'Pin this cell only' },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${fieldLabel} · ${marketLabel} field scope`}
        className="relative w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {fieldLabel}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{marketLabel}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2">
          {scopeOptions.map(({ value, icon: Icon, title, hint }) => (
            <button
              key={value}
              type="button"
              onClick={() => setDraftScope(value)}
              aria-pressed={draftScope === value}
              className={cn(
                'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left',
                draftScope === value
                  ? 'border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              )}
            >
              <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">
                  {title}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
              </span>
            </button>
          ))}
        </div>

        {draftScope === 'linked' && (
          <div className="mt-3 rounded-md border border-slate-200 p-2 dark:border-slate-700">
            <div className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">
              Members
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {members.length === 0 && (
                <div className="text-xs text-slate-400">No other markets available to link.</div>
              )}
              {members.map((m) => (
                <label key={m.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked.has(m.key)}
                    onChange={() => toggle(m.key)}
                    className="rounded border-slate-300 dark:border-slate-600"
                  />
                  <span className="text-slate-700 dark:text-slate-300">{m.label}</span>
                </label>
              ))}
            </div>
            {canTranslate && (
              <label className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <input
                  type="checkbox"
                  checked={translate}
                  onChange={(e) => setTranslate(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-600"
                />
                🤖 Auto-translate across languages
              </label>
            )}
          </div>
        )}

        {draftScope === 'linked' && onPropagate && (
          <button
            type="button"
            onClick={onPropagate}
            className="mt-3 w-full rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
          >
            Propagate current value to members →
          </button>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
