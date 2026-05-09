'use client'

/**
 * W3.8 — bulk move-workflow-stage modal.
 *
 * Operator selects N products → BulkActionBar's "Move stage" button
 * → this modal. Pick a target stage from the dropdown (grouped by
 * workflow) + optional comment, submit. Hits
 * POST /api/products/bulk-move-workflow-stage which calls
 * workflowService.moveStage per product (sequential — each move
 * gets its own transition row + audit), one $transaction per
 * product.
 *
 * Cross-workflow products in the selection are surfaced as
 * per-product errors in the response (workflowService rejects
 * cross-workflow moves with a 409). The modal shows a "N changed,
 * M skipped, K failed" toast post-submit so the operator can decide
 * to detach + retry if needed.
 *
 * Lazy-loaded via next/dynamic from BulkActionBar.
 */

import { useEffect, useState } from 'react'
import { GitBranch, Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface StageOption {
  id: string
  code: string
  label: string
  workflowId: string
  workflowLabel: string
  isPublishable: boolean
  isTerminal: boolean
}

interface Props {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}

export default function MoveWorkflowStageModal({
  productIds,
  onClose,
  onComplete,
}: Props) {
  const [stages, setStages] = useState<StageOption[] | null>(null)
  const [target, setTarget] = useState<string>('')
  const [comment, setComment] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/workflows`, { cache: 'no-store' })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then(async (data) => {
        // Need full stages for each workflow — second fetch per
        // workflow is fine at the typical 1-3 workflows count.
        const flat: StageOption[] = []
        for (const w of data.workflows ?? []) {
          const detail = await fetch(
            `${getBackendUrl()}/api/workflows/${w.id}`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : null))
          if (!detail?.workflow) continue
          for (const s of detail.workflow.stages ?? []) {
            flat.push({
              id: s.id,
              code: s.code,
              label: s.label,
              workflowId: w.id,
              workflowLabel: w.label,
              isPublishable: !!s.isPublishable,
              isTerminal: !!s.isTerminal,
            })
          }
        }
        if (!cancelled) {
          setStages(flat)
          if (flat[0]) setTarget(flat[0].id)
        }
      })
      .catch((e) => !cancelled && setErr(e?.message ?? String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-move-workflow-stage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds,
            toStageId: target,
            comment: comment.trim() || null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const r = (await res.json()) as {
        changed: number
        noOp: number
        errors: number
      }
      const stageLabel =
        stages?.find((s) => s.id === target)?.label ?? 'stage'
      if (r.errors > 0) {
        toast.error(
          `${r.changed} moved · ${r.noOp} already there · ${r.errors} failed (cross-workflow products skipped). Detach + retry to move them.`,
        )
      } else {
        toast.success(
          `Moved ${r.changed} product${r.changed === 1 ? '' : 's'} to ${stageLabel}` +
            (r.noOp > 0 ? ` (${r.noOp} were already there)` : ''),
        )
      }
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds, source: 'bulk-move-workflow-stage' },
      })
      onComplete()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Group stages by workflow for an organised dropdown.
  const stagesByWorkflow = (stages ?? []).reduce<
    Record<string, StageOption[]>
  >((acc, s) => {
    if (!acc[s.workflowId]) acc[s.workflowId] = []
    acc[s.workflowId].push(s)
    return acc
  }, {})

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title={
        <span className="inline-flex items-center gap-1.5">
          <GitBranch size={14} /> Move {productIds.length} product
          {productIds.length === 1 ? '' : 's'} to stage
        </span>
      }
      description="Cross-workflow moves are rejected per-product — products on a different workflow than the target stage are skipped. The response surfaces partial-success counts so you can detach + retry."
    >
      <div className="p-5 space-y-4">
        {stages === null ? (
          <div className="inline-flex items-center gap-2 text-base text-slate-500 dark:text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading stages…
          </div>
        ) : stages.length === 0 ? (
          <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 rounded-md px-3 py-2 text-base text-amber-800 dark:text-amber-300">
            No workflows exist yet. Create one under{' '}
            <a
              href="/settings/pim/workflows"
              className="underline font-medium"
            >
              Settings → PIM → Workflows
            </a>{' '}
            first.
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
                Target stage
              </label>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                autoFocus
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
              >
                {Object.entries(stagesByWorkflow).map(([wfId, wfStages]) => (
                  <optgroup key={wfId} label={wfStages[0]?.workflowLabel ?? wfId}>
                    {wfStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                        {s.isTerminal ? ' (terminal)' : ''}
                        {s.isPublishable ? ' · publishable' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
                Comment (optional)
              </label>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Reason / note for the audit log"
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </>
        )}
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300">
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
          icon={<Send className="w-3 h-3" />}
          onClick={submit}
          disabled={submitting || !target || !stages || stages.length === 0}
          loading={submitting}
        >
          Move
        </Button>
      </ModalFooter>
    </Modal>
  )
}
