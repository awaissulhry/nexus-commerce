'use client'

/**
 * Phase 5d — Report job pipeline client component.
 *
 * Provides manual trigger panel (Create Cycle / Poll / Ingest) and
 * expandable job rows to inspect configuration JSON + error messages.
 * Polling status refresh happens via router.refresh() after each action.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  RefreshCw, PlayCircle, Search, BarChart3, ChevronDown, ChevronRight,
  AlertCircle, CheckCircle2, Clock, Loader2, XCircle,
} from 'lucide-react'

export interface ReportJobRow {
  id: string
  profileId: string
  adProduct: string
  reportTypeId: string
  externalReportId: string
  status: string
  startDate: string
  endDate: string
  location: string | null
  fileSize: number | null
  rowsIngested: number
  errorMessage: string | null
  attempts: number
  lastPolledAt: string | null
  createdAt: string
  completedAt: string | null
  configuration: unknown
}

interface TriggerState {
  running: boolean
  result: string | null
  error: string | null
}

const STATUS_CONFIG: Record<string, { label: string; color: string; Icon: React.ElementType }> = {
  PENDING:     { label: 'Pending',     color: 'text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-400',         Icon: Clock },
  IN_PROGRESS: { label: 'In Progress', color: 'text-blue-700 bg-blue-50 dark:bg-blue-900/30 dark:text-blue-300',           Icon: Loader2 },
  COMPLETED:   { label: 'Completed',   color: 'text-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300', Icon: CheckCircle2 },
  FAILED:      { label: 'Failed',      color: 'text-red-700 bg-red-50 dark:bg-red-900/30 dark:text-red-300',               Icon: AlertCircle },
  EXPIRED:     { label: 'Expired',     color: 'text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-300',        Icon: XCircle },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING
  const Icon = cfg.Icon
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${cfg.color}`}>
      <Icon className={`h-3 w-3 ${status === 'IN_PROGRESS' ? 'animate-spin' : ''}`} aria-hidden />
      {cfg.label}
    </span>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function reportTypeLabel(typeId: string): string {
  const MAP: Record<string, string> = {
    spCampaigns:    'Campaign',
    sbCampaigns:    'Campaign',
    sdCampaigns:    'Campaign',
    spSearchTerm:   'Search Term',
    sbSearchTerm:   'Search Term',
    spPlacement:    'Placement',
  }
  return MAP[typeId] ?? typeId
}

// ── Expandable job row ───────────────────────────────────────────────────────

function JobRow({ job }: { job: ReportJobRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <tr
        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-2 whitespace-nowrap">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-tertiary" />
            : <ChevronRight className="h-3.5 w-3.5 text-tertiary" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-slate-500">{job.profileId.slice(-8)}</td>
        <td className="px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300">{job.adProduct}</td>
        <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{reportTypeLabel(job.reportTypeId)}</td>
        <td className="px-3 py-2 text-xs text-slate-500">
          {formatDateShort(job.startDate)} – {formatDateShort(job.endDate)}
        </td>
        <td className="px-3 py-2"><StatusBadge status={job.status} /></td>
        <td className="px-3 py-2 text-xs tabular-nums text-slate-500 text-right">{job.attempts}</td>
        <td className="px-3 py-2 text-xs tabular-nums text-slate-700 dark:text-slate-300 text-right">
          {job.rowsIngested > 0 ? job.rowsIngested.toLocaleString() : '—'}
        </td>
        <td className="px-3 py-2 text-xs text-slate-500">{formatBytes(job.fileSize)}</td>
        <td className="px-3 py-2 text-xs text-tertiary">{formatDate(job.createdAt)}</td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/80 dark:bg-slate-800/20">
          <td colSpan={10} className="px-6 py-3 border-t border-subtle dark:border-slate-800">
            <div className="space-y-2 text-xs">
              <div className="flex gap-8 flex-wrap">
                <div>
                  <span className="text-tertiary uppercase tracking-wider text-[10px]">Job ID</span>
                  <p className="font-mono text-slate-600 dark:text-slate-300 mt-0.5">{job.id}</p>
                </div>
                <div>
                  <span className="text-tertiary uppercase tracking-wider text-[10px]">External Report ID</span>
                  <p className="font-mono text-slate-600 dark:text-slate-300 mt-0.5">{job.externalReportId || '—'}</p>
                </div>
                {job.lastPolledAt && (
                  <div>
                    <span className="text-tertiary uppercase tracking-wider text-[10px]">Last Polled</span>
                    <p className="text-slate-600 dark:text-slate-300 mt-0.5">{formatDate(job.lastPolledAt)}</p>
                  </div>
                )}
                {job.completedAt && (
                  <div>
                    <span className="text-tertiary uppercase tracking-wider text-[10px]">Completed</span>
                    <p className="text-slate-600 dark:text-slate-300 mt-0.5">{formatDate(job.completedAt)}</p>
                  </div>
                )}
              </div>
              {job.errorMessage && (
                <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-3 py-2">
                  <span className="text-red-700 dark:text-red-300 font-medium">Error: </span>
                  <span className="text-red-600 dark:text-red-400">{job.errorMessage}</span>
                </div>
              )}
              <details className="group">
                <summary className="cursor-pointer text-tertiary hover:text-slate-600 dark:hover:text-slate-300 list-none flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 group-open:rotate-90 transition-transform" />
                  Configuration JSON
                </summary>
                <pre className="mt-1 text-[11px] font-mono bg-slate-100 dark:bg-slate-900 rounded p-2 overflow-x-auto text-slate-600 dark:text-slate-300 max-h-48">
                  {JSON.stringify(job.configuration, null, 2)}
                </pre>
              </details>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Trigger panel ────────────────────────────────────────────────────────────

async function postAction(url: string, body?: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, text: data.error ?? `HTTP ${res.status}` }
    return { ok: true, text: JSON.stringify(data, null, 2) }
  } catch (e) {
    return { ok: false, text: String(e) }
  }
}

function TriggerButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  variant = 'default',
}: {
  label: string
  icon: React.ElementType
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'primary'
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        variant === 'primary'
          ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

interface TriggerPanelProps {
  backendUrl: string
}

function TriggerPanel({ backendUrl }: TriggerPanelProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [createState, setCreateState] = useState<TriggerState>({ running: false, result: null, error: null })
  const [pollState, setPollState] = useState<TriggerState>({ running: false, result: null, error: null })
  const [ingestState, setIngestState] = useState<TriggerState>({ running: false, result: null, error: null })
  const [searchTermState, setSearchTermState] = useState<TriggerState>({ running: false, result: null, error: null })
  const [placementState, setPlacementState] = useState<TriggerState>({ running: false, result: null, error: null })

  // date range defaults: yesterday
  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const yyyyMmDd = yesterday.toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(yyyyMmDd)
  const [endDate, setEndDate] = useState(yyyyMmDd)

  function refresh() {
    startTransition(() => router.refresh())
  }

  async function runCreate() {
    setCreateState({ running: true, result: null, error: null })
    const r = await postAction(`${backendUrl}/api/advertising/reports/create-cycle`, { startDate, endDate })
    setCreateState({ running: false, result: r.ok ? r.text : null, error: r.ok ? null : r.text })
    if (r.ok) refresh()
  }

  async function runPoll() {
    setPollState({ running: true, result: null, error: null })
    const r = await postAction(`${backendUrl}/api/advertising/reports/poll`)
    setPollState({ running: false, result: r.ok ? r.text : null, error: r.ok ? null : r.text })
    if (r.ok) refresh()
  }

  async function runIngest() {
    setIngestState({ running: true, result: null, error: null })
    const r = await postAction(`${backendUrl}/api/advertising/reports/ingest-completed`)
    setIngestState({ running: false, result: r.ok ? r.text : null, error: r.ok ? null : r.text })
    if (r.ok) refresh()
  }

  async function runSearchTerms() {
    setSearchTermState({ running: true, result: null, error: null })
    const r = await postAction(`${backendUrl}/api/advertising/reports/create-search-terms-cycle`, { startDate, endDate })
    setSearchTermState({ running: false, result: r.ok ? r.text : null, error: r.ok ? null : r.text })
    if (r.ok) refresh()
  }

  async function runPlacements() {
    setPlacementState({ running: true, result: null, error: null })
    const r = await postAction(`${backendUrl}/api/advertising/reports/create-placements-cycle`, { startDate, endDate })
    setPlacementState({ running: false, result: r.ok ? r.text : null, error: r.ok ? null : r.text })
    if (r.ok) refresh()
  }

  function ResultBox({ state }: { state: TriggerState }) {
    if (!state.result && !state.error) return null
    return (
      <pre className={`mt-2 text-[11px] font-mono rounded p-2 overflow-x-auto max-h-32 ${
        state.error
          ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
          : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300'
      }`}>
        {state.result ?? state.error}
      </pre>
    )
  }

  return (
    <div className="rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 p-4 mb-4">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Manual Triggers</h2>

      {/* Date range */}
      <div className="flex items-center gap-2 mb-4">
        <label className="text-xs text-slate-500 shrink-0">Date range:</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="text-xs border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
        />
        <span className="text-xs text-tertiary">to</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="text-xs border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
        />
      </div>

      {/* Action grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Campaign cycle */}
        <div className="space-y-1.5">
          <TriggerButton
            label={createState.running ? 'Creating…' : 'Create Campaign Cycle'}
            icon={createState.running ? Loader2 : PlayCircle}
            onClick={runCreate}
            disabled={createState.running}
            variant="primary"
          />
          <ResultBox state={createState} />
        </div>

        {/* Search terms cycle */}
        <div className="space-y-1.5">
          <TriggerButton
            label={searchTermState.running ? 'Creating…' : 'Create Search-Term Cycle'}
            icon={searchTermState.running ? Loader2 : Search}
            onClick={runSearchTerms}
            disabled={searchTermState.running}
          />
          <ResultBox state={searchTermState} />
        </div>

        {/* Placements cycle */}
        <div className="space-y-1.5">
          <TriggerButton
            label={placementState.running ? 'Creating…' : 'Create Placement Cycle'}
            icon={placementState.running ? Loader2 : BarChart3}
            onClick={runPlacements}
            disabled={placementState.running}
          />
          <ResultBox state={placementState} />
        </div>

        {/* Poll */}
        <div className="space-y-1.5">
          <TriggerButton
            label={pollState.running ? 'Polling…' : 'Poll Pending Jobs'}
            icon={pollState.running ? Loader2 : RefreshCw}
            onClick={runPoll}
            disabled={pollState.running}
          />
          <ResultBox state={pollState} />
        </div>

        {/* Ingest */}
        <div className="space-y-1.5">
          <TriggerButton
            label={ingestState.running ? 'Ingesting…' : 'Ingest Completed'}
            icon={ingestState.running ? Loader2 : CheckCircle2}
            onClick={runIngest}
            disabled={ingestState.running}
          />
          <ResultBox state={ingestState} />
        </div>
      </div>
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

interface ReportsPipelineClientProps {
  jobs: ReportJobRow[]
  backendUrl: string
  statusFilter: string
}

export function ReportsPipelineClient({ jobs, backendUrl, statusFilter }: ReportsPipelineClientProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [activeStatus, setActiveStatus] = useState(statusFilter)

  function applyFilter(status: string) {
    setActiveStatus(status)
    const params = new URLSearchParams(window.location.search)
    if (status) params.set('status', status)
    else params.delete('status')
    startTransition(() => router.push(`?${params.toString()}`))
  }

  const STATUS_FILTERS = ['', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED']

  return (
    <>
      <TriggerPanel backendUrl={backendUrl} />

      {/* Status filter pills */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s || 'all'}
            onClick={() => applyFilter(s)}
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
              activeStatus === s
                ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 border-slate-800 dark:border-slate-200'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {/* Job table */}
      {jobs.length === 0 ? (
        <div className="text-sm text-tertiary py-12 text-center">No report jobs found.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-default dark:border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-default dark:border-slate-700">
                <th className="w-6 px-3 py-2" />
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Profile</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Ad Product</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Report Type</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Date Range</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Status</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Tries</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Rows</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Size</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
