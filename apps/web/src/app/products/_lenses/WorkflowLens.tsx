'use client'

/**
 * W3.7 — Workflow lens.
 *
 * Pipeline view: per-stage column with count + sample products.
 * Visual answer to the question "where are we in the pipeline?"
 * — operator sees at a glance "47 in DRAFT, 12 IN_REVIEW, 8
 * APPROVED, 3,200 PUBLISHED" without leaving /products.
 *
 * If multiple workflows exist, a picker at the top selects which
 * one to show. Defaults to the first by alpha label.
 *
 * Each stage column shows:
 *   - Stage label + chip (initial / terminal / publishable)
 *   - SLA hours (when set)
 *   - Total count
 *   - Sample of 10 most-recently-updated products at that stage
 *   - Click a product to open its drawer at the workflow tab
 *
 * Stageless products (familyId null OR family without a workflow)
 * are NOT shown here. The Hierarchy / Coverage / Health lenses
 * surface them through other dimensions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, GitBranch } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'

interface WorkflowSummary {
  id: string
  code: string
  label: string
  _count?: { stages: number; families: number }
}

interface PipelineStage {
  id: string
  code: string
  label: string
  sortOrder: number
  slaHours: number | null
  isPublishable: boolean
  isInitial: boolean
  isTerminal: boolean
  count: number
  sampleProducts: Array<{
    id: string
    sku: string
    name: string
    brand: string | null
    status: string
  }>
}

export function WorkflowLens() {
  const { t } = useTranslations()
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [pipeline, setPipeline] = useState<{
    workflow: WorkflowSummary
    stages: PipelineStage[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load list of workflows once.
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/workflows`, { cache: 'no-store' })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        const list: WorkflowSummary[] = data.workflows ?? []
        list.sort((a, b) => a.label.localeCompare(b.label))
        setWorkflows(list)
        if (list[0] && !selectedId) setSelectedId(list[0].id)
      })
      .catch((e) => setError(e?.message ?? String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = useCallback(async () => {
    if (!selectedId) {
      setPipeline(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/workflows/${selectedId}/pipeline?sampleSize=10`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setPipeline(data)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const totalProducts = useMemo(
    () => (pipeline?.stages ?? []).reduce((acc, s) => acc + s.count, 0),
    [pipeline],
  )

  if (workflows && workflows.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title={t('products.lens.workflow.empty.title')}
        description={t('products.lens.workflow.empty.body')}
        action={{
          label: t('products.lens.workflow.empty.action'),
          href: '/settings/pim/workflows',
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Workflow picker */}
      {workflows && workflows.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
            {t('products.lens.workflow.picker.label')}
          </span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <Link
            // W5.45 — /settings/pim/workflows/[id] page doesn't exist;
            // the workflow editor lives on the list page (operator
            // clicks the row to expand inline). Rerouting prevents a
            // 404 on the "edit definition" CTA.
            href={`/settings/pim/workflows`}
            className="text-sm text-blue-700 dark:text-blue-300 hover:underline"
          >
            {t('products.lens.workflow.editDefinition')}
          </Link>
        </div>
      )}

      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !pipeline ? (
        <div className="text-base text-slate-500 dark:text-slate-400">
          {t('products.lens.workflow.loading')}
        </div>
      ) : pipeline ? (
        <>
          <div className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
            {t(
              totalProducts === 1
                ? 'products.lens.workflow.summary.one'
                : 'products.lens.workflow.summary.other',
              {
                label: pipeline.workflow.label,
                count: totalProducts.toLocaleString(),
              },
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {pipeline.stages.map((s) => (
              <StageColumn key={s.id} stage={s} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

function StageColumn({ stage }: { stage: PipelineStage }) {
  const { t } = useTranslations()
  return (
    <Card
      title={
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={cn(
                'inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded truncate',
                stage.isPublishable
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                  : stage.isTerminal
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : stage.isInitial
                      ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
              )}
            >
              {stage.label}
            </span>
            <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300 font-medium">
              {stage.count.toLocaleString()}
            </span>
          </div>
          {stage.slaHours != null && (
            <span
              className="text-xs text-slate-500 dark:text-slate-400 tabular-nums flex-shrink-0"
              title={t('products.lens.workflow.slaTooltip', { hours: stage.slaHours })}
            >
              {stage.slaHours}h
            </span>
          )}
        </div>
      }
    >
      {stage.count === 0 ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400 py-2">
          {t('products.lens.workflow.stage.empty')}
        </div>
      ) : (
        <ul className="space-y-1 -my-1">
          {stage.sampleProducts.map((p) => (
            <li key={p.id}>
              <Link
                href={`/products?drawer=${p.id}&drawerTab=workflow`}
                className="flex items-center justify-between gap-2 py-1 px-1.5 -mx-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-900 dark:text-slate-100 truncate">
                    {p.name}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                    {p.sku}
                    {p.brand && (
                      <span className="ml-1 text-slate-400 dark:text-slate-500">
                        · {p.brand}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    'text-xs px-1 py-0.5 rounded uppercase tracking-wider font-medium flex-shrink-0',
                    p.status === 'ACTIVE'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : p.status === 'DRAFT'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
                  )}
                >
                  {p.status}
                </span>
              </Link>
            </li>
          ))}
          {stage.count > stage.sampleProducts.length && (
            <li className="text-xs text-slate-500 dark:text-slate-400 italic px-1.5 pt-1">
              {t('products.lens.workflow.stage.more', {
                count: (stage.count - stage.sampleProducts.length).toLocaleString(),
              })}
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}
