'use client'

// MC.8.3 — A+ Content visual builder.
//
// Three-pane layout:
//   left   ModulePalette    — 17 module types grouped by category
//   center ModuleCanvas     — drag-reorderable list of placed modules
//   right  ModuleEditor     — property panel for the selected module
//
// State pattern: builder owns the modules array and the selected id;
// child components emit intent (reorder, patch, delete, add).
// Persistence is per-action (each edit POSTs immediately) — not
// batched-save, since A+ documents are operator-edited slowly and a
// stale-then-discarded session would lose work.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  BadgeCheck,
  Loader2,
  AlertTriangle,
  Sparkles,
  CheckSquare,
  Send,
  History,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import ModulePalette from './ModulePalette'
import ModuleCanvas from './ModuleCanvas'
import ModuleEditor from './ModuleEditor'
import LocalizationsPanel from './LocalizationsPanel'
import TemplatePicker from './TemplatePicker'
import BrandKitReferencePanel from '@/components/brand-kit/BrandKitReferencePanel'
import ValidationResultModal, {
  type ValidationResult,
} from './ValidationResultModal'
import VersionHistoryModal from './VersionHistoryModal'
import {
  getModuleSpec,
  validateModulePayload,
  type ModuleSpec,
} from '../_lib/modules'
import type {
  AplusDetail,
  AplusModuleRow,
  AplusStatus,
} from '../_lib/types'
import { APLUS_STATUSES } from '../_lib/types'

interface Props {
  initial: AplusDetail
  apiBase: string
}

export default function AplusBuilderClient({ initial, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [modules, setModules] = useState<AplusModuleRow[]>(initial.modules)
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.modules[0]?.id ?? null,
  )
  const [status, setStatus] = useState<AplusStatus>(initial.status)
  const [busy, setBusy] = useState<null | 'add' | 'reorder' | 'status' | 'validate' | 'submit'>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [scheduleInput, setScheduleInput] = useState('')
  const [scheduleSaving, setScheduleSaving] = useState(false)

  // MC.8.10 — schedule helpers. The header surfaces a datetime
  // input so the operator can pick a future time; submitting fires
  // the PATCH /schedule endpoint.
  const saveSchedule = async (raw: string) => {
    setScheduleSaving(true)
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}/schedule`,
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
          ? t('aplus.schedule.set', {
              when: new Date(raw).toLocaleString(),
            })
          : t('aplus.schedule.cleared'),
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('aplus.schedule.error'),
      )
    } finally {
      setScheduleSaving(false)
    }
  }

  const submit = async () => {
    if (
      !window.confirm(
        t('aplus.submit.confirm', {
          marketplace: initial.marketplace,
        }),
      )
    )
      return
    setBusy('submit')
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}/submit`,
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
          t('aplus.submit.success', {
            mode: data.mode,
            id: data.amazonDocumentId ?? '—',
          }),
        )
        router.refresh()
      } else if (data.validation && !data.validation.ok) {
        // Surface validation issues via the existing modal so the
        // operator sees exactly what to fix.
        setValidationResult(data.validation)
        setValidationOpen(true)
        toast.error(
          t('aplus.submit.validationFailed', {
            n: data.validation.blocking.length.toString(),
          }),
        )
      } else {
        toast.error(
          data.error ?? t('aplus.submit.error'),
        )
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('aplus.submit.error'),
      )
    } finally {
      setBusy(null)
    }
  }

  const runValidation = async () => {
    setBusy('validate')
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}/validate`,
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
          : t('aplus.validate.runError'),
      )
    } finally {
      setBusy(null)
    }
  }

  // Re-sync if the operator navigates away + back; Next caches the
  // initial result but the builder's internal state should reset
  // to the freshest server response, not stale React state.
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
      const spec = getModuleSpec(m.type)
      if (!spec) {
        map.set(m.id, ['Unknown module type'])
        continue
      }
      map.set(m.id, validateModulePayload(spec, m.payload))
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

  const addModule = useCallback(
    async (spec: ModuleSpec) => {
      setBusy('add')
      try {
        const res = await fetch(
          `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}/modules`,
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
        const data = (await res.json()) as { module: AplusModuleRow }
        setModules((prev) => [...prev, data.module])
        setSelectedId(data.module.id)
        toast.success(t('aplus.builder.moduleAdded', { label: spec.label }))
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('aplus.builder.addError'),
        )
      } finally {
        setBusy(null)
      }
    },
    [apiBase, initial.id, t, toast],
  )

  const updateModulePayload = useCallback(
    async (moduleId: string, payload: Record<string, unknown>) => {
      // Optimistic — the property panel needs instant feedback so the
      // operator types without round-trip lag. Persist in the
      // background; rollback on failure.
      const previous = modules.find((m) => m.id === moduleId)
      setModules((prev) =>
        prev.map((m) => (m.id === moduleId ? { ...m, payload } : m)),
      )
      try {
        const res = await fetch(
          `${apiBase}/api/aplus-modules/${encodeURIComponent(moduleId)}`,
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
            : t('aplus.builder.saveError'),
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
          `${apiBase}/api/aplus-modules/${encodeURIComponent(moduleId)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(`Delete failed (${res.status})`)
        toast.success(t('aplus.builder.moduleDeleted'))
      } catch (err) {
        setModules(previous)
        if (previousSelected === moduleId) setSelectedId(previousSelected)
        toast.error(
          err instanceof Error
            ? err.message
            : t('aplus.builder.deleteError'),
        )
      }
    },
    [apiBase, modules, selectedId, t, toast],
  )

  const reorderModules = useCallback(
    async (nextOrder: AplusModuleRow[]) => {
      const previous = modules
      setBusy('reorder')
      // Optimistic position update.
      setModules(
        nextOrder.map((m, idx) => ({ ...m, position: idx })),
      )
      try {
        const res = await fetch(
          `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}/modules/reorder`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              order: nextOrder.map((m, idx) => ({
                id: m.id,
                position: idx,
              })),
            }),
          },
        )
        if (!res.ok) throw new Error(`Reorder failed (${res.status})`)
      } catch (err) {
        setModules(previous)
        toast.error(
          err instanceof Error
            ? err.message
            : t('aplus.builder.reorderError'),
        )
      } finally {
        setBusy(null)
      }
    },
    [apiBase, initial.id, modules, t, toast],
  )

  const updateStatus = useCallback(
    async (next: AplusStatus) => {
      setBusy('status')
      try {
        const res = await fetch(
          `${apiBase}/api/aplus-content/${encodeURIComponent(initial.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: next }),
          },
        )
        if (!res.ok) throw new Error(`Status update failed (${res.status})`)
        setStatus(next)
        router.refresh()
        toast.success(t('aplus.builder.statusChanged', { status: next }))
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('aplus.builder.statusError'),
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
            href="/marketing/aplus"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('aplus.builder.backToList')}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <BadgeCheck className="w-5 h-5 text-blue-500" />
            <span className="truncate">{initial.name}</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {initial.marketplace} · {initial.locale}
            {initial.brand ? ` · ${initial.brand}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {totalIssues > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('aplus.builder.issuesCount', {
                n: totalIssues.toString(),
              })}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setTemplatesOpen(true)}
            disabled={busy !== null}
          >
            <Sparkles className="w-4 h-4 mr-1" />
            {t('aplus.builder.applyTemplate')}
          </Button>
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
            {t('aplus.builder.validate')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setHistoryOpen(true)}
            disabled={busy !== null}
          >
            <History className="w-4 h-4 mr-1" />
            {t('aplus.builder.history')}
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
            {t('aplus.builder.submit')}
          </Button>
          <select
            value={status}
            onChange={(e) => void updateStatus(e.target.value as AplusStatus)}
            disabled={busy !== null}
            aria-label={t('aplus.builder.statusLabel')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          >
            {APLUS_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {busy && (
            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          )}
        </div>
      </div>

      <LocalizationsPanel document={initial} apiBase={apiBase} />

      <BrandKitReferencePanel brand={initial.brand} apiBase={apiBase} />

      {/* MC.8.10 — schedule strip. Shows the current scheduledFor
          (if any) + datetime input to set/clear. The cron picker
          (MC.8.10-followup once a job runner is wired) walks
          (status='APPROVED', scheduledFor < now) and submits. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {t('aplus.schedule.label')}
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
            t('aplus.schedule.set_cta')
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
          {t('aplus.schedule.clear')}
        </Button>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {initial.publishedAt
            ? t('aplus.schedule.publishedAt', {
                when: new Date(initial.publishedAt).toLocaleString(),
              })
            : initial.submittedAt
              ? t('aplus.schedule.submittedAt', {
                  when: new Date(initial.submittedAt).toLocaleString(),
                })
              : t('aplus.schedule.notSubmitted')}
        </span>
      </div>

      {/* Three-pane layout. Below lg the panes stack; the canvas stays
          dominant by being the middle column on desktop and the
          first stacked block on mobile. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        <ModulePalette onAdd={addModule} disabled={busy === 'add'} />
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

      <TemplatePicker
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        contentId={initial.id}
        apiBase={apiBase}
        hasExistingModules={modules.length > 0}
        onApplied={() => {
          // Refresh from server so the canvas sees the new modules.
          // Avoids re-implementing the merge logic client-side.
          router.refresh()
        }}
      />

      <ValidationResultModal
        open={validationOpen}
        onClose={() => setValidationOpen(false)}
        result={validationResult}
      />

      <VersionHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        contentId={initial.id}
        apiBase={apiBase}
        onRestored={() => router.refresh()}
      />
    </div>
  )
}
