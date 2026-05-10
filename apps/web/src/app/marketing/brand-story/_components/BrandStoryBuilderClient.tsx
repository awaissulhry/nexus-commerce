'use client'

// MC.9.2 — Brand Story builder.
//
// Parallel to AplusBuilderClient but tighter: 4 module specs (vs
// A+'s 17), no ASIN attachment picker, single-file build. The
// payload editor is reused from the same FieldKind set so the
// operator's mental model carries between the two surfaces.

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  AlertTriangle,
  GripVertical,
  Trash2,
  Plus,
  Image as ImageIcon,
  Quote,
  Layers,
  Camera,
  CheckSquare,
  Send,
  History,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  BRAND_STORY_MODULE_SPECS,
  getBrandStoryModuleSpec,
  validateBrandStoryModulePayload,
  type BrandStoryModuleSpec,
  type FieldSpec,
} from '../_lib/modules'
import {
  BRAND_STORY_STATUSES,
  type BrandStoryDetail,
  type BrandStoryModuleRow,
  type BrandStoryStatus,
} from '../_lib/types'
import BrandStoryLocalizationsPanel from './BrandStoryLocalizationsPanel'
import BrandStoryVersionHistoryModal from './BrandStoryVersionHistoryModal'
import BrandKitReferencePanel from '@/components/brand-kit/BrandKitReferencePanel'
import ValidationResultModal, {
  type ValidationResult,
} from '../../aplus/_components/ValidationResultModal'

interface Props {
  initial: BrandStoryDetail
  apiBase: string
}

export default function BrandStoryBuilderClient({ initial, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [modules, setModules] = useState<BrandStoryModuleRow[]>(initial.modules)
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.modules[0]?.id ?? null,
  )
  const [status, setStatus] = useState<BrandStoryStatus>(initial.status)
  const [busy, setBusy] = useState<null | 'add' | 'reorder' | 'status' | 'validate' | 'submit'>(null)
  const [validationOpen, setValidationOpen] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [scheduleInput, setScheduleInput] = useState('')
  const [scheduleSaving, setScheduleSaving] = useState(false)

  const runValidation = async () => {
    setBusy('validate')
    try {
      const res = await fetch(
        `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}/validate`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`Validation failed (${res.status})`)
      const data = (await res.json()) as { result: ValidationResult }
      setValidationResult(data.result)
      setValidationOpen(true)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('brandStory.validate.runError'),
      )
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    if (
      !window.confirm(
        t('brandStory.submit.confirm', {
          marketplace: initial.marketplace,
        }),
      )
    )
      return
    setBusy('submit')
    try {
      const res = await fetch(
        `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}/submit`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`Submit failed (${res.status})`)
      const data = (await res.json()) as {
        ok: boolean
        mode: 'sandbox' | 'live'
        amazonDocumentId: string | null
        validation: ValidationResult
        error: string | null
      }
      if (data.ok) {
        toast.success(
          t('brandStory.submit.success', {
            mode: data.mode,
            id: data.amazonDocumentId ?? '—',
          }),
        )
        router.refresh()
      } else if (data.validation && !data.validation.ok) {
        setValidationResult(data.validation)
        setValidationOpen(true)
        toast.error(
          t('brandStory.submit.validationFailed', {
            n: data.validation.blocking.length.toString(),
          }),
        )
      } else {
        toast.error(data.error ?? t('brandStory.submit.error'))
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('brandStory.submit.error'),
      )
    } finally {
      setBusy(null)
    }
  }

  const saveSchedule = async (raw: string) => {
    setScheduleSaving(true)
    try {
      const res = await fetch(
        `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}/schedule`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scheduledFor: raw ? new Date(raw).toISOString() : null,
          }),
        },
      )
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? `Schedule failed (${res.status})`)
      }
      router.refresh()
      toast.success(
        raw
          ? t('brandStory.schedule.set', {
              when: new Date(raw).toLocaleString(),
            })
          : t('brandStory.schedule.cleared'),
      )
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('brandStory.schedule.error'),
      )
    } finally {
      setScheduleSaving(false)
    }
  }

  useEffect(() => {
    setModules(initial.modules)
    setStatus(initial.status)
  }, [initial.id, initial.modules, initial.status])

  const selected = useMemo(
    () => modules.find((m) => m.id === selectedId) ?? null,
    [modules, selectedId],
  )

  const validationByModule = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of modules) {
      const spec = getBrandStoryModuleSpec(m.type)
      if (!spec) {
        map.set(m.id, ['Unknown module type'])
        continue
      }
      map.set(m.id, validateBrandStoryModulePayload(spec, m.payload))
    }
    return map
  }, [modules])

  const totalIssues = useMemo(
    () =>
      [...validationByModule.values()].reduce(
        (sum, issues) => sum + issues.length,
        0,
      ),
    [validationByModule],
  )

  // Brand Story has a tight 4-module set. Operator typically uses
  // each at most once; the palette dims modules already on the
  // canvas to discourage duplicates (Amazon allows them but it
  // looks odd). Doesn't block — just a hint.
  const usedTypes = useMemo(
    () => new Set(modules.map((m) => m.type)),
    [modules],
  )

  const addModule = useCallback(
    async (spec: BrandStoryModuleSpec) => {
      setBusy('add')
      try {
        const res = await fetch(
          `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}/modules`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: spec.id, payload: {} }),
          },
        )
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(errBody.error ?? `Add failed (${res.status})`)
        }
        const data = (await res.json()) as { module: BrandStoryModuleRow }
        setModules((prev) => [...prev, data.module])
        setSelectedId(data.module.id)
        toast.success(t('brandStory.builder.moduleAdded', { label: spec.label }))
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t('brandStory.builder.addError'),
        )
      } finally {
        setBusy(null)
      }
    },
    [apiBase, initial.id, t, toast],
  )

  const updateModulePayload = useCallback(
    async (moduleId: string, payload: Record<string, unknown>) => {
      const previous = modules.find((m) => m.id === moduleId)
      setModules((prev) =>
        prev.map((m) => (m.id === moduleId ? { ...m, payload } : m)),
      )
      try {
        const res = await fetch(
          `${apiBase}/api/brand-story-modules/${encodeURIComponent(moduleId)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ payload }),
          },
        )
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(errBody.error ?? `Save failed (${res.status})`)
        }
      } catch (err) {
        if (previous) {
          setModules((prev) =>
            prev.map((m) => (m.id === moduleId ? previous : m)),
          )
        }
        toast.error(
          err instanceof Error
            ? err.message
            : t('brandStory.builder.saveError'),
        )
      }
    },
    [apiBase, modules, t, toast],
  )

  const deleteModule = useCallback(
    async (moduleId: string) => {
      const previous = modules
      const previousSelected = selectedId
      setModules((prev) => {
        const filtered = prev.filter((m) => m.id !== moduleId)
        return filtered.map((m, idx) => ({ ...m, position: idx }))
      })
      if (selectedId === moduleId) setSelectedId(null)
      try {
        const res = await fetch(
          `${apiBase}/api/brand-story-modules/${encodeURIComponent(moduleId)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(`Delete failed (${res.status})`)
        toast.success(t('brandStory.builder.moduleDeleted'))
      } catch (err) {
        setModules(previous)
        if (previousSelected === moduleId) setSelectedId(previousSelected)
        toast.error(
          err instanceof Error
            ? err.message
            : t('brandStory.builder.deleteError'),
        )
      }
    },
    [apiBase, modules, selectedId, t, toast],
  )

  const reorderModules = useCallback(
    async (nextOrder: BrandStoryModuleRow[]) => {
      const previous = modules
      setBusy('reorder')
      setModules(nextOrder.map((m, idx) => ({ ...m, position: idx })))
      try {
        const res = await fetch(
          `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}/modules/reorder`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              order: nextOrder.map((m, idx) => ({ id: m.id, position: idx })),
            }),
          },
        )
        if (!res.ok) throw new Error(`Reorder failed (${res.status})`)
      } catch (err) {
        setModules(previous)
        toast.error(
          err instanceof Error
            ? err.message
            : t('brandStory.builder.reorderError'),
        )
      } finally {
        setBusy(null)
      }
    },
    [apiBase, initial.id, modules, t, toast],
  )

  const updateStatus = useCallback(
    async (next: BrandStoryStatus) => {
      setBusy('status')
      try {
        const res = await fetch(
          `${apiBase}/api/brand-stories/${encodeURIComponent(initial.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: next }),
          },
        )
        if (!res.ok) throw new Error(`Status update failed (${res.status})`)
        setStatus(next)
        router.refresh()
        toast.success(
          t('brandStory.builder.statusChanged', { status: next }),
        )
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('brandStory.builder.statusError'),
        )
      } finally {
        setBusy(null)
      }
    },
    [apiBase, initial.id, router, t, toast],
  )

  return (
    <div className="space-y-3">
      {/* Header strip */}
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Link
            href="/marketing/brand-story"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('brandStory.builder.backToList')}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <BookOpen className="w-5 h-5 text-blue-500" />
            <span className="truncate">{initial.name}</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {initial.brand} · {initial.marketplace} · {initial.locale}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {totalIssues > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('brandStory.builder.issuesCount', {
                n: totalIssues.toString(),
              })}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={runValidation}
            disabled={busy !== null}
          >
            {busy === 'validate' ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <CheckSquare className="w-4 h-4 mr-1" />
            )}
            {t('brandStory.builder.validate')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setHistoryOpen(true)}
            disabled={busy !== null}
          >
            <History className="w-4 h-4 mr-1" />
            {t('brandStory.builder.history')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={busy !== null || modules.length === 0}
          >
            {busy === 'submit' ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-1" />
            )}
            {t('brandStory.builder.submit')}
          </Button>
          <select
            value={status}
            onChange={(e) => void updateStatus(e.target.value as BrandStoryStatus)}
            disabled={busy !== null}
            aria-label={t('brandStory.builder.statusLabel')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          >
            {BRAND_STORY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
        </div>
      </div>

      <BrandStoryLocalizationsPanel document={initial} apiBase={apiBase} />

      <BrandKitReferencePanel brand={initial.brand} apiBase={apiBase} />

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {t('brandStory.schedule.label')}
        </span>
        <input
          type="datetime-local"
          value={scheduleInput}
          onChange={(e) => setScheduleInput(e.target.value)}
          disabled={scheduleSaving}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void saveSchedule(scheduleInput)}
          disabled={scheduleSaving || !scheduleInput}
        >
          {scheduleSaving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            t('brandStory.schedule.set_cta')
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setScheduleInput('')
            void saveSchedule('')
          }}
          disabled={scheduleSaving}
        >
          {t('brandStory.schedule.clear')}
        </Button>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {initial.publishedAt
            ? t('brandStory.schedule.publishedAt', {
                when: new Date(initial.publishedAt).toLocaleString(),
              })
            : initial.submittedAt
              ? t('brandStory.schedule.submittedAt', {
                  when: new Date(initial.submittedAt).toLocaleString(),
                })
              : t('brandStory.schedule.notSubmitted')}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
        <ModulePalette
          onAdd={addModule}
          disabled={busy === 'add'}
          usedTypes={usedTypes}
        />
        <ModuleCanvas
          modules={modules}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDelete={deleteModule}
          onReorder={reorderModules}
          validationByModule={validationByModule}
        />
        <ModuleEditor
          module={selected}
          onChange={updateModulePayload}
          validationByModule={validationByModule}
        />
      </div>

      <ValidationResultModal
        open={validationOpen}
        onClose={() => setValidationOpen(false)}
        result={validationResult}
      />

      <BrandStoryVersionHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        storyId={initial.id}
        apiBase={apiBase}
        onRestored={() => router.refresh()}
      />
    </div>
  )
}

// ── ModulePalette ────────────────────────────────────────────

function ModulePalette({
  onAdd,
  disabled,
  usedTypes,
}: {
  onAdd: (spec: BrandStoryModuleSpec) => void
  disabled?: boolean
  usedTypes: Set<string>
}) {
  const { t } = useTranslations()
  return (
    <aside className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('brandStory.builder.paletteTitle')}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('brandStory.builder.paletteHint')}
        </p>
      </header>
      <ul className="p-1.5">
        {BRAND_STORY_MODULE_SPECS.map((spec) => {
          const used = usedTypes.has(spec.id)
          return (
            <li key={spec.id}>
              <button
                type="button"
                onClick={() => onAdd(spec)}
                disabled={disabled}
                className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950/40 ${
                  used ? 'opacity-70' : ''
                }`}
              >
                <Layers className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
                <div className="flex-1 min-w-0">
                  <p className="flex items-center gap-1 text-sm font-medium text-slate-900 dark:text-slate-100">
                    <span className="truncate">{spec.label}</span>
                    {used && (
                      <span className="rounded bg-slate-100 px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        {t('brandStory.builder.alreadyUsed')}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {spec.description}
                  </p>
                </div>
                <Plus className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 opacity-0 group-hover:opacity-100" />
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// ── ModuleCanvas ─────────────────────────────────────────────

function ModuleCanvas({
  modules,
  selectedId,
  onSelect,
  onDelete,
  onReorder,
  validationByModule,
}: {
  modules: BrandStoryModuleRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (next: BrandStoryModuleRow[]) => void
  validationByModule: Map<string, string[]>
}) {
  const { t } = useTranslations()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const onDragStart = (e: DragEvent<HTMLElement>, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  const onDragOver = (e: DragEvent<HTMLElement>, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverId !== id) setDragOverId(id)
  }

  const onDrop = (e: DragEvent<HTMLElement>, targetId: string) => {
    e.preventDefault()
    const sourceId = dragId ?? e.dataTransfer.getData('text/plain')
    setDragId(null)
    setDragOverId(null)
    if (!sourceId || sourceId === targetId) return
    const next = [...modules]
    const sourceIdx = next.findIndex((m) => m.id === sourceId)
    const targetIdx = next.findIndex((m) => m.id === targetId)
    if (sourceIdx < 0 || targetIdx < 0) return
    const [moved] = next.splice(sourceIdx, 1)
    if (moved) next.splice(targetIdx, 0, moved)
    onReorder(next)
  }

  if (modules.length === 0)
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
        <BookOpen className="w-8 h-8 text-slate-400" />
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('brandStory.builder.canvasEmpty')}
        </p>
        <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
          {t('brandStory.builder.canvasEmptyHint')}
        </p>
      </div>
    )

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('brandStory.builder.canvasTitle')}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('brandStory.builder.canvasCount', {
            n: modules.length.toString(),
          })}
        </p>
      </header>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {modules.map((module, index) => {
          const spec = getBrandStoryModuleSpec(module.type)
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
                isDragOver ? 'ring-2 ring-blue-500 ring-inset' : ''
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
                >
                  <p className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
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
                        {t('brandStory.builder.unknownType', {
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
                  aria-label={t('brandStory.builder.deleteModule')}
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

// ── ModuleRender ─────────────────────────────────────────────

function ModuleRender({
  spec,
  payload,
}: {
  spec: BrandStoryModuleSpec
  payload: Record<string, unknown>
}) {
  switch (spec.id) {
    case 'brand_header':
      return <BrandHeaderRender payload={payload} />
    case 'featured_asins':
      return <FeaturedAsinsRender payload={payload} />
    case 'story_focus':
      return <StoryFocusRender payload={payload} />
    case 'image_carousel':
      return <ImageCarouselRender payload={payload} />
    default:
      return (
        <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
          {spec.description}
        </div>
      )
  }
}

function BrandHeaderRender({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const url = resolveAssetUrl(payload.logoAssetId)
  const headline = (payload.headline as string) || ''
  const description = (payload.description as string) || ''
  return (
    <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
        {url ? (
          <Image src={url} alt={headline || 'Logo'} fill sizes="64px" className="object-contain" unoptimized />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        {headline ? (
          <p className="text-base font-bold text-slate-900 dark:text-slate-100">
            {headline}
          </p>
        ) : (
          <p className="text-xs italic text-slate-400">
            {t('brandStory.preview.headlineHint')}
          </p>
        )}
        {description ? (
          <p className="mt-0.5 line-clamp-3 text-xs text-slate-600 dark:text-slate-400">
            {description}
          </p>
        ) : (
          <p className="mt-0.5 text-xs italic text-slate-400">
            {t('brandStory.preview.descriptionHint')}
          </p>
        )}
      </div>
    </div>
  )
}

function FeaturedAsinsRender({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const asins: string[] = Array.isArray(payload.asins)
    ? (payload.asins as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : []
  const description = (payload.description as string) || ''
  if (asins.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-400 dark:border-slate-700 dark:bg-slate-800/50">
        {t('brandStory.preview.featuredHint')}
      </p>
    )
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      {description && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {description}
        </p>
      )}
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${Math.min(asins.length, 4)}, minmax(0, 1fr))` }}
      >
        {asins.slice(0, 4).map((asin, idx) => (
          <div
            key={idx}
            className="flex aspect-square items-center justify-center rounded bg-slate-100 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            {asin}
          </div>
        ))}
      </div>
    </div>
  )
}

function StoryFocusRender({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const url = resolveAssetUrl(payload.imageAssetId)
  const headline = (payload.headline as string) || ''
  const body = (payload.body as string) || ''
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="relative aspect-square overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
        {url ? (
          <Image src={url} alt={headline || 'Story'} fill sizes="140px" className="object-cover" unoptimized />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Quote className="w-3.5 h-3.5 text-blue-500" />
          {headline || (
            <span className="italic text-slate-400">
              {t('brandStory.preview.headlineHint')}
            </span>
          )}
        </p>
        {body ? (
          <p className="line-clamp-4 text-xs text-slate-600 dark:text-slate-400">
            {body}
          </p>
        ) : (
          <p className="text-xs italic text-slate-400">
            {t('brandStory.preview.bodyHint')}
          </p>
        )}
      </div>
    </div>
  )
}

function ImageCarouselRender({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  interface ImageItem {
    assetId?: string
    url?: string
    alt?: string
  }
  const images: ImageItem[] = Array.isArray(payload.images)
    ? (payload.images as ImageItem[])
    : []
  if (images.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-400 dark:border-slate-700 dark:bg-slate-800/50">
        {t('brandStory.preview.carouselHint')}
      </p>
    )
  return (
    <div className="flex gap-1.5 overflow-x-auto rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      {images.slice(0, 4).map((item, idx) => {
        const url = resolveAssetUrl(item.assetId) ?? item.url ?? null
        return (
          <div
            key={idx}
            className="relative aspect-square w-24 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800"
          >
            {url ? (
              <Image
                src={url}
                alt={item.alt ?? `Slide ${idx + 1}`}
                fill
                sizes="96px"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-slate-400">
                <Camera className="w-5 h-5" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ModuleEditor ─────────────────────────────────────────────

function ModuleEditor({
  module,
  onChange,
  validationByModule,
}: {
  module: BrandStoryModuleRow | null
  onChange: (
    moduleId: string,
    payload: Record<string, unknown>,
  ) => void
  validationByModule: Map<string, string[]>
}) {
  const { t } = useTranslations()

  if (!module) {
    return (
      <aside className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {t('brandStory.builder.editorEmpty')}
      </aside>
    )
  }

  const spec = getBrandStoryModuleSpec(module.type)
  const issues = validationByModule.get(module.id) ?? []

  const setValue = (key: string, value: unknown) => {
    onChange(module.id, { ...module.payload, [key]: value })
  }

  return (
    <aside className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {spec?.label ?? module.type}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {spec?.description ??
            t('brandStory.builder.unknownType', { type: module.type })}
        </p>
      </header>

      {issues.length > 0 && (
        <ul className="border-b border-slate-200 bg-amber-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-amber-950/30">
          {issues.map((issue, idx) => (
            <li
              key={idx}
              className="flex items-start gap-1 text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {spec ? (
          spec.fields.map((field) => (
            <FieldEditor
              key={field.key}
              field={field}
              value={module.payload[field.key]}
              onChange={(v) => setValue(field.key, v)}
            />
          ))
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('brandStory.builder.specMissing')}
          </p>
        )}
      </div>
    </aside>
  )
}

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: FieldSpec
  value: unknown
  onChange: (next: unknown) => void
}) {
  const { t } = useTranslations()
  const id = `bs-field-${field.key}`

  const Label = () => (
    <label
      htmlFor={id}
      className="flex items-baseline justify-between text-xs font-medium text-slate-700 dark:text-slate-300"
    >
      <span>
        {field.label}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {field.max && typeof value === 'string' && (
        <span className="text-[10px] text-slate-400">
          {value.length}/{field.max}
        </span>
      )}
      {field.max && Array.isArray(value) && (
        <span className="text-[10px] text-slate-400">
          {value.length}/{field.max}
        </span>
      )}
    </label>
  )

  if (field.kind === 'text') {
    return (
      <div className="space-y-1">
        <Label />
        <input
          id={id}
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.max}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {field.hint && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    )
  }
  if (field.kind === 'textarea') {
    return (
      <div className="space-y-1">
        <Label />
        <textarea
          id={id}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.max}
          rows={4}
          className="w-full resize-y rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {field.hint && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    )
  }
  if (field.kind === 'asset_id') {
    return (
      <div className="space-y-1">
        <Label />
        <input
          id={id}
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('brandStory.builder.assetIdPlaceholder')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {field.hint ?? t('brandStory.builder.assetIdHint')}
        </p>
      </div>
    )
  }
  if (field.kind === 'list_text') {
    const list = Array.isArray(value) ? (value as string[]) : []
    return (
      <div className="space-y-1">
        <Label />
        <ul className="space-y-1">
          {list.map((item, idx) => (
            <li key={idx} className="flex items-center gap-1">
              <input
                type="text"
                value={item}
                onChange={(e) => {
                  const copy = [...list]
                  copy[idx] = e.target.value
                  onChange(copy)
                }}
                className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => {
                  const copy = [...list]
                  copy.splice(idx, 1)
                  onChange(copy)
                }}
                className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onChange([...list, ''])}
          disabled={!!field.max && list.length >= field.max}
          className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('brandStory.builder.listAdd')}
        </button>
      </div>
    )
  }
  if (field.kind === 'list_image') {
    interface ImageItem {
      assetId?: string
      url?: string
      headline?: string
      body?: string
      alt?: string
    }
    const list = Array.isArray(value) ? (value as ImageItem[]) : []
    return (
      <div className="space-y-1">
        <Label />
        <ul className="space-y-2">
          {list.map((item, idx) => (
            <li
              key={idx}
              className="space-y-1 rounded-md border border-slate-200 p-2 dark:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-slate-500">
                  #{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const copy = [...list]
                    copy.splice(idx, 1)
                    onChange(copy)
                  }}
                  className="rounded p-0.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <input
                type="text"
                value={item.assetId ?? ''}
                onChange={(e) => {
                  const copy = [...list]
                  copy[idx] = { ...(copy[idx] ?? {}), assetId: e.target.value }
                  onChange(copy)
                }}
                placeholder={t('brandStory.builder.assetIdPlaceholder')}
                className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="text"
                value={item.alt ?? ''}
                onChange={(e) => {
                  const copy = [...list]
                  copy[idx] = { ...(copy[idx] ?? {}), alt: e.target.value }
                  onChange(copy)
                }}
                placeholder={t('brandStory.builder.altPlaceholder')}
                className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onChange([...list, {}])}
          disabled={!!field.max && list.length >= field.max}
          className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('brandStory.builder.listAddImage')}
        </button>
      </div>
    )
  }
  return null
}

// ── helpers ──────────────────────────────────────────────────

function resolveAssetUrl(maybeId: unknown): string | null {
  if (typeof maybeId !== 'string' || !maybeId.trim()) return null
  if (maybeId.startsWith('http://') || maybeId.startsWith('https://'))
    return maybeId
  return null
}
