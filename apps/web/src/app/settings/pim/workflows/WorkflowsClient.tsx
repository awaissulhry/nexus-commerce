'use client'

/**
 * W3.5 — Workflow admin list page.
 *
 * List view + create + delete. Per-workflow stage editor lives in
 * W3.6 (/settings/pim/workflows/:id).
 *
 * Create flow: modal with workflow code + label + description + the
 * initial stage list. validateWorkflow runs server-side on submit
 * (W3.3); errors surface in the modal. Stage minimums: at least one
 * isInitial. We pre-populate a sensible 4-stage default
 * (draft / in_review / approved / published) so the operator can
 * tweak rather than start blank, which is the most common pattern.
 *
 * Delete flow: useConfirm with cascade preview ("3 families will
 * lose their workflowId, N products will fall off the workflow").
 * P2003 from a stage with live transitions surfaces as a 409.
 */

import { useCallback, useState } from 'react'
import {
  AlertCircle,
  GitBranch,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

export interface WorkflowRow {
  id: string
  code: string
  label: string
  description: string | null
  createdAt: string
  updatedAt: string
  _count?: { stages: number; families: number }
}

interface Props {
  initial: WorkflowRow[]
  initialError: string | null
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const DEFAULT_STAGES = [
  { code: 'draft', label: 'Draft', isInitial: true, isTerminal: false, isPublishable: false, slaHours: null },
  { code: 'in_review', label: 'In review', isInitial: false, isTerminal: false, isPublishable: false, slaHours: 24 },
  { code: 'approved', label: 'Approved', isInitial: false, isTerminal: false, isPublishable: true, slaHours: 12 },
  { code: 'published', label: 'Published', isInitial: false, isTerminal: true, isPublishable: true, slaHours: null },
]

export default function WorkflowsClient({ initial, initialError }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const confirm = useConfirm()
  const { toast } = useToast()
  const { t } = useTranslations()

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/workflows`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { workflows?: WorkflowRow[] }
      setWorkflows(data.workflows ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  const onDelete = useCallback(
    async (w: WorkflowRow) => {
      const familyCount = w._count?.families ?? 0
      const stageCount = w._count?.stages ?? 0
      const ok = await confirm({
        title: `Delete workflow "${w.label}"?`,
        description: [
          familyCount > 0
            ? `${familyCount} famil${familyCount === 1 ? 'y' : 'ies'} reference this workflow and will detach (workflowId → null).`
            : null,
          `${stageCount} stage${stageCount === 1 ? '' : 's'} cascade-deleted.`,
          'WorkflowTransition history is preserved for products that have already moved off this workflow.',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      setBusy(w.id)
      try {
        const res = await fetch(`${getBackendUrl()}/api/workflows/${w.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(t('pim.toasts.deleted.workflow', { label: w.label }))
        refresh()
      } catch (e: any) {
        toast.error(t('pim.toasts.failed.delete', { msg: e?.message ?? String(e) }))
      } finally {
        setBusy(null)
      }
    },
    [confirm, refresh, toast],
  )

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {t(
            workflows.length === 1
              ? 'pim.workflows.count.one'
              : 'pim.workflows.count.other',
            { count: workflows.length },
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setCreating(true)}
        >
          {t('pim.workflows.new')}
        </Button>
      </div>

      {workflows.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-12 text-center">
          <GitBranch className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <div className="text-md text-slate-700 dark:text-slate-300">
            {t('pim.workflows.empty.title')}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            {t('pim.workflows.empty.body')}
          </div>
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.workflows.col.code')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.workflows.col.label')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.workflows.col.stages')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.workflows.col.families')}</th>
                <th className="px-3 py-2 w-8" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr
                  key={w.id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                >
                  <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                    {/* W5.45 — was Link to /settings/pim/workflows/[id]
                        which doesn't exist. Per-workflow editor lives
                        inline on this page; the row label can stay
                        non-clickable until a dedicated [id] route lands. */}
                    <span className="inline-flex items-center gap-1">
                      {w.code}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
                    {w.label}
                    {w.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-md">
                        {w.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {w._count?.stages ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {w._count?.families ?? 0}
                  </td>
                  <td className="px-1 py-2">
                    <IconButton
                      aria-label={`Delete workflow ${w.label}`}
                      size="sm"
                      tone="danger"
                      disabled={busy === w.id}
                      onClick={() => onDelete(w)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateWorkflowModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function CreateWorkflowModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [stages, setStages] = useState(DEFAULT_STAGES)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()
  const { t } = useTranslations()

  const codeValid = !code || CODE_PATTERN.test(code)
  const initialCount = stages.filter((s) => s.isInitial).length
  const terminalCount = stages.filter((s) => s.isTerminal).length
  const stagesValid =
    stages.length > 0 &&
    initialCount === 1 &&
    terminalCount <= 1 &&
    stages.every((s) => CODE_PATTERN.test(s.code) && s.label.trim().length > 0)
  const canSubmit =
    CODE_PATTERN.test(code) && label.trim().length > 0 && stagesValid

  const updateStage = (i: number, patch: Partial<(typeof stages)[number]>) => {
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  const addStage = () => {
    setStages((prev) => [
      ...prev,
      { code: '', label: '', isInitial: false, isTerminal: false, isPublishable: false, slaHours: null },
    ])
  }
  const removeStage = (i: number) => {
    setStages((prev) => prev.filter((_, idx) => idx !== i))
  }

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          label: label.trim(),
          description: description.trim() || null,
          stages: stages.map((s, i) => ({ ...s, sortOrder: i })),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const detail = Array.isArray(body.details)
          ? ` — ${body.details.join('; ')}`
          : ''
        throw new Error((body.error ?? `HTTP ${res.status}`) + detail)
      }
      toast.success(t('pim.toasts.created.workflow', { label }))
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="2xl"
      title="New workflow"
      description="Define the content-quality pipeline. Default is a sensible 4-stage Draft → Review → Approved → Published; tweak rather than starting blank."
    >
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Code <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
              placeholder="standard_pim"
              autoFocus
              className={`w-full h-9 px-2 text-base font-mono border rounded ${codeValid ? 'border-slate-200 dark:border-slate-800' : 'border-rose-300 dark:border-rose-700'} dark:bg-slate-900 dark:text-slate-100`}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Label <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Standard PIM"
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
              Stages <span className="text-rose-500">*</span>{' '}
              <span className="text-xs text-slate-400 dark:text-slate-500 normal-case font-normal tracking-normal">
                ({initialCount} initial · {terminalCount} terminal)
              </span>
            </label>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              onClick={addStage}
            >
              Add stage
            </Button>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">Code</th>
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">Label</th>
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">SLA (h)</th>
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">Initial</th>
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">Terminal</th>
                  <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-300 text-xs">Publish</th>
                  <th className="px-1 w-6" />
                </tr>
              </thead>
              <tbody>
                {stages.map((s, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={s.code}
                        onChange={(e) =>
                          updateStage(i, { code: e.target.value.toLowerCase() })
                        }
                        className="w-full h-7 px-1.5 text-sm font-mono border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={s.label}
                        onChange={(e) => updateStage(i, { label: e.target.value })}
                        className="w-full h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={0}
                        value={s.slaHours ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          updateStage(i, { slaHours: v === '' ? null : Number(v) })
                        }}
                        placeholder="—"
                        className="w-16 h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={s.isInitial}
                        onChange={(e) =>
                          // Setting isInitial=true clears it on every other stage
                          // so the workflow stays valid (exactly one isInitial).
                          setStages((prev) =>
                            prev.map((ps, idx) => ({
                              ...ps,
                              isInitial: idx === i ? e.target.checked : false,
                            })),
                          )
                        }
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={s.isTerminal}
                        onChange={(e) => updateStage(i, { isTerminal: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={s.isPublishable}
                        onChange={(e) => updateStage(i, { isPublishable: e.target.checked })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <IconButton
                        aria-label={`Remove stage ${s.code || i}`}
                        size="sm"
                        tone="danger"
                        onClick={() => removeStage(i)}
                        disabled={stages.length <= 1}
                      >
                        <X className="w-3 h-3" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Exactly one stage must be marked Initial. At most one Terminal.
            Publish is a UI hint — the workflow does NOT mutate Product.status;
            you flip status to ACTIVE manually after the operator confirms.
          </p>
        </div>

        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!canSubmit}
          loading={submitting}
        >
          Create workflow
        </Button>
      </ModalFooter>
    </Modal>
  )
}
