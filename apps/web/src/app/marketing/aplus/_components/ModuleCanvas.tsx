'use client'

// MC.8.3 — module canvas (center).
//
// Vertically-stacked list of placed modules in document order.
// HTML5 drag-and-drop reorder (same pattern as ProductImage W8.1
// reorder — no extra deps). Each row carries:
//   - tier icon + module label
//   - validation badge (issue count when payload is incomplete)
//   - delete button
//   - inline preview rendered by ModuleRender
//
// Selection state lives in the parent; clicking a row selects it
// for editing in the right-pane ModuleEditor.

import { useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import {
  Trash2,
  AlertTriangle,
  GripVertical,
  Sparkles,
  BadgeCheck,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import ModuleRender from './ModuleRender'
import { getModuleSpec } from '../_lib/modules'
import type { AplusModuleRow } from '../_lib/types'

interface Props {
  modules: AplusModuleRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (next: AplusModuleRow[]) => void
  validationByModule: Map<string, string[]>
}

export default function ModuleCanvas({
  modules,
  selectedId,
  onSelect,
  onDelete,
  onReorder,
  validationByModule,
}: Props) {
  const { t } = useTranslations()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Track latest reorder state in a ref so onDrop can read the
  // freshest sequence even if React hasn't re-rendered yet.
  const latestRef = useRef(modules)
  latestRef.current = modules

  const onDragStart = (e: ReactDragEvent<HTMLElement>, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  const onDragOver = (e: ReactDragEvent<HTMLElement>, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverId !== id) setDragOverId(id)
  }

  const onDrop = (e: ReactDragEvent<HTMLElement>, targetId: string) => {
    e.preventDefault()
    const sourceId = dragId ?? e.dataTransfer.getData('text/plain')
    setDragId(null)
    setDragOverId(null)
    if (!sourceId || sourceId === targetId) return
    const current = [...latestRef.current]
    const sourceIdx = current.findIndex((m) => m.id === sourceId)
    const targetIdx = current.findIndex((m) => m.id === targetId)
    if (sourceIdx < 0 || targetIdx < 0) return
    const [moved] = current.splice(sourceIdx, 1)
    if (moved) current.splice(targetIdx, 0, moved)
    onReorder(current)
  }

  if (modules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
        <Sparkles className="w-8 h-8 text-slate-400" />
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('aplus.builder.canvasEmpty')}
        </p>
        <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
          {t('aplus.builder.canvasEmptyHint')}
        </p>
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      role="region"
      aria-label={t('aplus.builder.canvasLabel')}
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('aplus.builder.canvasTitle')}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('aplus.builder.canvasCount', {
            n: modules.length.toString(),
          })}
        </p>
      </header>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {modules.map((module, index) => {
          const spec = getModuleSpec(module.type)
          const isSelected = selectedId === module.id
          const issues = validationByModule.get(module.id) ?? []
          const isDragOver = dragOverId === module.id && dragId !== module.id
          return (
            <li
              key={module.id}
              draggable
              onDragStart={(e) => onDragStart(e, module.id)}
              onDragEnd={() => {
                setDragId(null)
                setDragOverId(null)
              }}
              onDragOver={(e) => onDragOver(e, module.id)}
              onDrop={(e) => onDrop(e, module.id)}
              className={`relative px-3 py-2.5 transition-colors ${
                isSelected
                  ? 'bg-blue-50 dark:bg-blue-950/40'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
              } ${
                isDragOver
                  ? 'ring-2 ring-blue-500 ring-inset'
                  : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="flex flex-col items-center pt-1 text-slate-400">
                  <GripVertical className="w-4 h-4 cursor-grab" />
                  <span className="text-[10px] font-mono">{index + 1}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(module.id)}
                  className="flex-1 min-w-0 text-left"
                  aria-pressed={isSelected}
                >
                  <p className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {spec?.tier === 'premium' ? (
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <BadgeCheck className="w-3.5 h-3.5 text-slate-400" />
                    )}
                    {spec?.label ?? module.type}
                    {issues.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                        <AlertTriangle className="w-3 h-3" />
                        {issues.length}
                      </span>
                    )}
                  </p>
                  <div className="mt-1.5">
                    {spec ? (
                      <ModuleRender spec={spec} payload={module.payload} />
                    ) : (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {t('aplus.builder.unknownType', {
                          type: module.type,
                        })}
                      </p>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(module.id)
                  }}
                  aria-label={t('aplus.builder.deleteModule')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800 dark:hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
