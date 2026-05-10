'use client'

/**
 * W2.3 — Workflow tab on /products/[id]/edit.
 *
 * Salesforce-tier stage gate: every product follows a workflow
 * (DRAFT → REVIEW → APPROVED → PUBLISHED, custom per workflow).
 * The W3 schema (ProductWorkflow + WorkflowStage + WorkflowTransition
 * + WorkflowComment) has been in place since Wave 3; the drawer
 * has a compact version of this UI but it never made it onto the
 * canonical edit page.
 *
 * Empty state (product has no workflowStageId) — picker to attach
 * a workflow from /api/workflows. Active state — current stage card
 * with SLA, move-stage form with optional comment, per-stage
 * comment thread, transition history (newest first), and a Detach
 * button gated behind useConfirm().
 *
 * All actions persist immediately, so this tab never reports dirty
 * state. discardSignal nudges a refetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  GitBranch,
  Loader2,
  Plus,
  Send,
  Unplug,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface WorkflowStageRow {
  id: string
  code: string
  label: string
  sortOrder: number
  isPublishable: boolean
  isTerminal: boolean
  isInitial: boolean
}

interface WorkflowSnapshot {
  productId: string
  sku: string
  currentStage: {
    id: string
    code: string
    label: string
    slaHours: number | null
    isPublishable: boolean
    isInitial: boolean
    isTerminal: boolean
    workflowId: string
    workflow: {
      id: string
      code: string
      label: string
      stages: WorkflowStageRow[]
    }
  } | null
  sla: {
    state: 'on_track' | 'soon' | 'overdue' | 'no_sla'
    dueAt: string | null
    hoursRemaining: number | null
  } | null
  transitions: Array<{
    id: string
    fromStage: { id: string; code: string; label: string } | null
    toStage: { id: string; code: string; label: string }
    comment: string | null
    createdAt: string
  }>
  comments: Array<{
    id: string
    body: string
    createdAt: string
    stage: { id: string; code: string; label: string }
  }>
}

interface WorkflowOption {
  id: string
  code: string
  label: string
  description: string | null
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

// ── Assignment types ────────────────────────────────────────────────────

interface UserStub {
  id: string
  displayName: string
  email: string
  avatarUrl: string
}

interface WorkflowAssignmentRow {
  id: string
  productId: string
  assigneeId: string
  assignee: UserStub
  role: string
  stageId: string | null
  stage: { id: string; label: string; code: string } | null
  dueAt: string | null
  note: string | null
  createdAt: string
}

const ROLE_COLORS: Record<string, string> = {
  OWNER: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  APPROVER: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  REVIEWER: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}

// ── Assignments card ────────────────────────────────────────────────────

function AssignmentsCard({ productId, discardSignal }: { productId: string; discardSignal: number }) {
  const { t } = useTranslations()
  const [assignments, setAssignments] = useState<WorkflowAssignmentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [userQuery, setUserQuery] = useState('')
  const [userResults, setUserResults] = useState<UserStub[]>([])
  const [selectedUser, setSelectedUser] = useState<UserStub | null>(null)
  const [role, setRole] = useState('REVIEWER')
  const [dueAt, setDueAt] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadAssignments = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/products/${productId}/workflow/assignments`)
      if (!res.ok) throw new Error()
      setAssignments(await res.json())
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { loadAssignments() }, [loadAssignments, discardSignal])

  useEffect(() => {
    if (!userQuery.trim()) { setUserResults([]); return }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(userQuery)}&limit=8`)
        if (!res.ok) return
        setUserResults(await res.json())
      } catch { /* non-fatal */ }
    }, 250)
  }, [userQuery])

  async function handleAssign() {
    if (!selectedUser) return
    setSaving(true)
    try {
      const res = await fetch(`/api/products/${productId}/workflow/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assigneeId: selectedUser.id,
          role,
          dueAt: dueAt || null,
          note: note || null,
        }),
      })
      if (!res.ok) throw new Error()
      const created: WorkflowAssignmentRow = await res.json()
      setAssignments((prev) => {
        const idx = prev.findIndex((a) => a.id === created.id)
        return idx >= 0 ? prev.map((a) => (a.id === created.id ? created : a)) : [...prev, created]
      })
      setShowForm(false)
      setSelectedUser(null)
      setUserQuery('')
      setRole('REVIEWER')
      setDueAt('')
      setNote('')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(assignmentId: string) {
    setRemovingId(assignmentId)
    try {
      await fetch(`/api/products/${productId}/workflow/assignments/${assignmentId}`, { method: 'DELETE' })
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId))
    } finally {
      setRemovingId(null)
    }
  }

  const inputCls = 'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex-1">
          {t('products.edit.workflow.assignees')}
        </h3>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" /> {t('products.edit.workflow.assign')}
        </Button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2.5 bg-slate-50 dark:bg-slate-800/40">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              {t('products.edit.workflow.assignUser')}
            </label>
            <input
              value={userQuery}
              onChange={(e) => { setUserQuery(e.target.value); setSelectedUser(null) }}
              placeholder="Search by name or email…"
              className={inputCls}
            />
            {userResults.length > 0 && !selectedUser && (
              <ul className="mt-1 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
                {userResults.map((u) => (
                  <li
                    key={u.id}
                    className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 text-sm"
                    onClick={() => { setSelectedUser(u); setUserQuery(u.displayName || u.email) }}
                  >
                    <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xs font-medium text-blue-700 dark:text-blue-300 flex-shrink-0">
                      {(u.displayName || u.email)[0]?.toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-slate-900 dark:text-slate-100">{u.displayName}</p>
                      <p className="text-xs text-slate-500">{u.email}</p>
                    </div>
                    <UserCheck className="w-3.5 h-3.5 ml-auto text-emerald-500 opacity-0" aria-hidden />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
                <option value="REVIEWER">Reviewer</option>
                <option value="APPROVER">Approver</option>
                <option value="OWNER">Owner</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Due date</label>
              <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputCls} />
            </div>
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAssign} disabled={!selectedUser || saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Assign
            </Button>
          </div>
        </div>
      )}

      {/* Current assignees */}
      {loading ? (
        <div className="flex items-center gap-1.5 text-sm text-slate-400 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : assignments.length === 0 ? (
        <p className="text-sm italic text-slate-500 dark:text-slate-400 py-1">
          {t('products.edit.workflow.noAssignees')}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {assignments.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2.5">
              <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xs font-medium text-blue-700 dark:text-blue-300 flex-shrink-0">
                {(a.assignee.displayName || a.assignee.email)[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {a.assignee.displayName || a.assignee.email}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium', ROLE_COLORS[a.role] ?? ROLE_COLORS.REVIEWER)}>
                    {a.role}
                  </span>
                  {a.dueAt && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      due {new Date(a.dueAt).toLocaleDateString('it-IT')}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRemove(a.id)}
                disabled={removingId === a.id}
                className="p-1.5 text-slate-400 hover:text-red-500 disabled:opacity-50 rounded"
                aria-label="Remove assignee"
              >
                {removingId === a.id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <UserMinus className="w-3.5 h-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const SLA_TONE: Record<string, string> = {
  on_track:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  soon: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  overdue:
    'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  no_sla:
    'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

export default function WorkflowTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()

  const [snap, setSnap] = useState<WorkflowSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([])
  const [attachPicker, setAttachPicker] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const [moveComment, setMoveComment] = useState('')
  const [moving, setMoving] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commenting, setCommenting] = useState(false)

  // Stable "tab is never dirty" signal.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    onDirtyChange(0)
  }, [onDirtyChange])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/workflow`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as WorkflowSnapshot
      setSnap(data)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [product.id])

  // Workflow options for the attach picker — lazy-loaded only when
  // the product has no current stage. Cheap GET, small payload.
  const loadWorkflowOptions = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/workflows`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const json = await res.json()
      const items = Array.isArray(json) ? json : (json?.workflows ?? [])
      setWorkflowOptions(items as WorkflowOption[])
    } catch {
      /* non-fatal — attach picker just falls back to "no workflows
       * defined" empty state. */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Load workflow options whenever the product becomes detached
  // (snap loaded with currentStage === null).
  useEffect(() => {
    if (snap && snap.currentStage === null) {
      void loadWorkflowOptions()
    }
  }, [snap, loadWorkflowOptions])

  // Discard nudge: refetch so any concurrent stage move shows up.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    void refresh()
  }, [discardSignal, refresh])

  const onAttach = async () => {
    if (!attachPicker) return
    setAttaching(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/workflow/attach`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId: attachPicker }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setAttachPicker('')
      toast.success(t('products.edit.workflow.attached'))
      await refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.workflow.attachFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setAttaching(false)
    }
  }

  const onDetach = async () => {
    const ok = await confirm({
      title: t('products.edit.workflow.detachTitle'),
      description: t('products.edit.workflow.detachBody'),
      confirmLabel: t('products.edit.workflow.detachConfirm'),
      tone: 'warning',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/workflow/detach`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.workflow.detached'))
      await refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.workflow.detachFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  const onMove = async () => {
    if (!moveTo) return
    setMoving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/workflow/move`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toStageId: moveTo,
            comment: moveComment.trim() || null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setMoveTo('')
      setMoveComment('')
      toast.success(t('products.edit.workflow.moved'))
      await refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.workflow.moveFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setMoving(false)
    }
  }

  const onAddComment = async () => {
    if (!snap?.currentStage || !commentBody.trim()) return
    setCommenting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/workflow/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stageId: snap.currentStage.id,
            body: commentBody.trim(),
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setCommentBody('')
      toast.success(t('products.edit.workflow.commentPosted'))
      await refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.workflow.commentFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setCommenting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('products.edit.workflow.loading')}
        </div>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      </Card>
    )
  }

  // ── Empty state: not attached ───────────────────────────────
  if (!snap?.currentStage) {
    return (
      <Card
        title={t('products.edit.workflow.title')}
        description={t('products.edit.workflow.description')}
      >
        <div className="border border-dashed border-slate-200 dark:border-slate-800 rounded-lg p-6 text-center space-y-4">
          <GitBranch className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600" />
          <div>
            <div className="text-md font-medium text-slate-700 dark:text-slate-300">
              {t('products.edit.workflow.emptyTitle')}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
              {t('products.edit.workflow.emptyBody')}
            </div>
          </div>
          {workflowOptions.length === 0 ? (
            <div className="text-sm italic text-slate-500 dark:text-slate-400">
              {t('products.edit.workflow.noWorkflowsDefined')}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 max-w-md mx-auto">
              <select
                value={attachPicker}
                onChange={(e) => setAttachPicker(e.target.value)}
                className="flex-1 h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3"
              >
                <option value="">
                  {t('products.edit.workflow.attachPicker')}
                </option>
                {workflowOptions.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                size="sm"
                disabled={!attachPicker}
                loading={attaching}
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => void onAttach()}
              >
                {t('products.edit.workflow.attach')}
              </Button>
            </div>
          )}
        </div>
      </Card>
    )
  }

  // ── Active state ────────────────────────────────────────────
  const stage = snap.currentStage
  const otherStages = stage.workflow.stages.filter((s) => s.id !== stage.id)
  const stageComments = snap.comments.filter((c) => c.stage.id === stage.id)

  return (
    <div className="space-y-4">
      {/* Current stage card */}
      <Card
        title={t('products.edit.workflow.currentStageTitle', {
          workflow: stage.workflow.label,
        })}
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<Unplug className="w-3.5 h-3.5" />}
            onClick={() => void onDetach()}
          >
            {t('products.edit.workflow.detach')}
          </Button>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="info">{stage.label}</Badge>
          {stage.isInitial && (
            <span className="text-xs text-slate-500 dark:text-slate-400 italic">
              {t('products.edit.workflow.tag.initial')}
            </span>
          )}
          {stage.isTerminal && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300 italic">
              {t('products.edit.workflow.tag.terminal')}
            </span>
          )}
          {stage.isPublishable && (
            <span className="text-xs text-amber-700 dark:text-amber-300 italic">
              {t('products.edit.workflow.tag.publishable')}
            </span>
          )}
          {snap.sla && (
            <span
              className={cn(
                'inline-flex items-center px-1.5 py-0.5 text-xs rounded font-medium',
                SLA_TONE[snap.sla.state],
              )}
              title={
                snap.sla.dueAt
                  ? t('products.edit.workflow.sla.due', {
                      when: new Date(snap.sla.dueAt).toLocaleString(),
                    })
                  : t('products.edit.workflow.sla.none')
              }
            >
              {snap.sla.state === 'no_sla'
                ? t('products.edit.workflow.sla.noSla')
                : snap.sla.state === 'overdue'
                  ? t('products.edit.workflow.sla.overdue', {
                      hours: Math.abs(
                        Math.round(snap.sla.hoursRemaining ?? 0),
                      ),
                    })
                  : t('products.edit.workflow.sla.left', {
                      hours: Math.round(snap.sla.hoursRemaining ?? 0),
                    })}
            </span>
          )}
        </div>
      </Card>

      {/* Move stage controls */}
      {otherStages.length > 0 && (
        <Card
          title={t('products.edit.workflow.moveTitle')}
          description={t('products.edit.workflow.moveDescription')}
        >
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
              <select
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
                className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3"
              >
                <option value="">
                  {t('products.edit.workflow.movePicker')}
                </option>
                {otherStages
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((s) => {
                    const suffix =
                      [
                        s.isTerminal
                          ? t('products.edit.workflow.moveSuffix.terminal')
                          : '',
                        s.isPublishable
                          ? t('products.edit.workflow.moveSuffix.publishable')
                          : '',
                      ]
                        .filter(Boolean)
                        .join('')
                    return (
                      <option key={s.id} value={s.id}>
                        {s.label}
                        {suffix}
                      </option>
                    )
                  })}
              </select>
              <Button
                variant="primary"
                size="sm"
                disabled={!moveTo}
                loading={moving}
                icon={<Send className="w-3.5 h-3.5" />}
                onClick={() => void onMove()}
              >
                {t('products.edit.workflow.move')}
              </Button>
            </div>
            <input
              type="text"
              value={moveComment}
              onChange={(e) => setMoveComment(e.target.value)}
              placeholder={t('products.edit.workflow.movePlaceholder')}
              className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3"
            />
          </div>
        </Card>
      )}

      {/* Comment thread */}
      <Card
        title={t('products.edit.workflow.commentsTitle', {
          stage: stage.label,
        })}
        description={t('products.edit.workflow.commentsDescription')}
      >
        <div className="space-y-2">
          {stageComments.length === 0 ? (
            <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
              {t('products.edit.workflow.commentsEmpty')}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {stageComments.slice(0, 20).map((c) => (
                <li
                  key={c.id}
                  className="border border-slate-200 dark:border-slate-800 rounded px-3 py-2 text-md text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900"
                >
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1 tabular-nums">
                    {new Date(c.createdAt).toLocaleString()}
                  </div>
                  <div className="whitespace-pre-wrap break-words">
                    {c.body}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2 pt-2">
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={2}
              placeholder={t('products.edit.workflow.commentPlaceholder')}
              className="flex-1 px-3 py-2 text-md rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!commentBody.trim()}
              loading={commenting}
              icon={<Check className="w-3.5 h-3.5" />}
              onClick={() => void onAddComment()}
            >
              {t('products.edit.workflow.post')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Transition history */}
      <Card
        title={t('products.edit.workflow.historyTitle')}
        description={t('products.edit.workflow.historyDescription')}
      >
        {snap.transitions.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
            {t('products.edit.workflow.historyEmpty')}
          </div>
        ) : (
          <ul className="space-y-1">
            {snap.transitions.map((tr) => (
              <li
                key={tr.id}
                className="flex items-start justify-between gap-3 border border-slate-200 dark:border-slate-800 rounded px-3 py-2 bg-white dark:bg-slate-900"
              >
                <div className="min-w-0 text-md">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="default">
                      {tr.fromStage?.label ??
                        t('products.edit.workflow.initialMarker')}
                    </Badge>
                    <span className="text-slate-400 dark:text-slate-600">
                      →
                    </span>
                    <Badge variant="info">{tr.toStage.label}</Badge>
                  </div>
                  {tr.comment && (
                    <div className="text-sm text-slate-600 dark:text-slate-400 mt-1 whitespace-pre-wrap break-words">
                      {tr.comment}
                    </div>
                  )}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums flex-shrink-0">
                  {new Date(tr.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* W9.x — Assignees card */}
      <AssignmentsCard productId={product.id} discardSignal={discardSignal} />
    </div>
  )
}
