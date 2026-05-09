'use client'

/**
 * P.1l — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. F7 was the original feature.
 *
 * Drag-drop column picker. Native HTML5 dragstart/dragover/drop
 * (no library). Tracks the drag source key in state; on drop, it
 * splices the visible array. Only togglable columns participate —
 * locked columns (thumb/sku/name/actions) keep their positions in
 * the rendered grid via the workspace's visible useMemo.
 */

import { useEffect, useRef, useState } from 'react'
import { ALL_COLUMNS, DEFAULT_VISIBLE } from '../_columns'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ColumnPickerMenuProps {
  visible: string[]
  setVisible: (v: string[]) => void
  onClose: () => void
}

export function ColumnPickerMenu({
  visible,
  setVisible,
  onClose,
}: ColumnPickerMenuProps) {
  const { t } = useTranslations()
  const ref = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  const togglable = ALL_COLUMNS.filter((c) => !c.locked && c.label)

  // Picker shows columns in the user's current order (visible[]) for
  // togglable rows that ARE visible, then non-visible togglable rows
  // at the end. Drag-reorder only happens within visible.
  const visibleTogglable = visible
    .map((k) => togglable.find((c) => c.key === k))
    .filter((c): c is (typeof togglable)[number] => !!c)
  const hiddenTogglable = togglable.filter((c) => !visible.includes(c.key))

  const onDragStart = (key: string) => (e: React.DragEvent) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null)
      return
    }
    const next = [...visible]
    const fromIdx = next.indexOf(dragKey)
    const toIdx = next.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) {
      setDragKey(null)
      return
    }
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragKey)
    setVisible(next)
    setDragKey(null)
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-1.5 max-h-[480px] overflow-y-auto dark:bg-slate-900 dark:border-slate-800"
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1.5 flex items-center justify-between">
        <span>{t('products.colPicker.visibleHeader')}</span>
      </div>
      {visibleTogglable.map((c) => (
        <div
          key={c.key}
          draggable
          onDragStart={onDragStart(c.key)}
          onDragOver={onDragOver}
          onDrop={onDrop(c.key)}
          className={`flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-move dark:hover:bg-slate-800 ${dragKey === c.key ? 'opacity-40' : ''}`}
        >
          <span className="text-slate-300 dark:text-slate-600 font-mono select-none">⠿</span>
          <input
            type="checkbox"
            checked
            onChange={() => setVisible(visible.filter((k) => k !== c.key))}
          />
          <span className="text-slate-700 dark:text-slate-300">{c.labelKey ? t(c.labelKey) : c.label}</span>
        </div>
      ))}
      {hiddenTogglable.length > 0 && (
        <>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1.5 mt-1">
            {t('products.colPicker.hiddenHeader')}
          </div>
          {hiddenTogglable.map((c) => (
            <label
              key={c.key}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer dark:hover:bg-slate-800"
            >
              <span className="text-transparent select-none">⠿</span>
              <input
                type="checkbox"
                checked={false}
                onChange={() => setVisible([...visible, c.key])}
              />
              <span className="text-slate-700 dark:text-slate-300">{c.labelKey ? t(c.labelKey) : c.label}</span>
            </label>
          ))}
        </>
      )}
      <div className="border-t border-slate-100 dark:border-slate-800 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button
          onClick={() => setVisible(DEFAULT_VISIBLE)}
          className="text-sm text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          {t('products.colPicker.reset')}
        </button>
        <button
          onClick={onClose}
          className="text-sm text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          {t('products.colPicker.close')}
        </button>
      </div>
    </div>
  )
}
