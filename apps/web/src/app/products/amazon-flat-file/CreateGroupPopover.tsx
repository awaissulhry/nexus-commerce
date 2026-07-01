'use client'
// Create-group popover. Holds the draft name/colour in LOCAL state so typing
// re-renders only this small component — never the 7k-line grid — keeping input
// instant. Commits once, on Create.
import { useEffect, useRef, useState } from 'react'
import { GROUP_PALETTE, type FamilyColorName } from './group-model'

const SWATCH: Record<FamilyColorName, string> = {
  blue: 'bg-blue-400', purple: 'bg-purple-400', emerald: 'bg-emerald-400',
  orange: 'bg-orange-400', teal: 'bg-teal-400', amber: 'bg-amber-400',
}

export function CreateGroupPopover({
  skuCount, defaultColor, onCreate, onCancel,
}: {
  skuCount: number
  defaultColor: FamilyColorName
  onCreate: (name: string, color: FamilyColorName) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<FamilyColorName>(defaultColor)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const create = () => onCreate(name.trim() || 'New group', color)

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/20" onClick={onCancel}>
      <div
        className="w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New group"
      >
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">New group</div>
        <div className="text-[11px] text-slate-400 mb-3">{skuCount} SKU{skuCount === 1 ? '' : 's'} selected</div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); else if (e.key === 'Escape') onCancel() }}
          placeholder="Group name (e.g. FBM items)"
          className="w-full text-sm px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 mb-3"
        />
        <div className="flex items-center gap-1.5 mb-4">
          {GROUP_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full border-2 ${SWATCH[c]} ${color === c ? 'ring-2 ring-offset-1 ring-slate-400 border-transparent' : 'border-transparent'}`}
            />
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700">Cancel</button>
          <button type="button" onClick={create} className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700">
            Create group
          </button>
        </div>
      </div>
    </div>
  )
}
