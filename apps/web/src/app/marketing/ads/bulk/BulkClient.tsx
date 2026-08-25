'use client'

/**
 * AX-IE.8 — Bulk operations.
 *
 * The surface the whole AX-IE series was building toward: download current state,
 * edit it in Excel or Numbers, upload it back, SEE WHAT IT WOULD DO, apply, and
 * undo the whole thing if it was wrong.
 *
 * The import tab is deliberately a linear staircase — Upload, Review, Apply,
 * Done — because the one thing that must not happen is somebody applying a file
 * they have not looked at. The Apply button does not exist until a preview has
 * been computed, and the server refuses an apply that arrives without the token
 * that preview issued.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Download, Upload, History as HistoryIcon, FileSpreadsheet,
  CheckCircle2, Undo2, RefreshCw, ArrowRight, FileWarning,
} from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Select } from '@/design-system/primitives/Select'
import { Banner } from '@/design-system/components/Banner'
import { Tabs } from '@/design-system/components/Tabs'
import { FileDropzone } from '@/design-system/components/FileDropzone'
import { ProgressBar } from '@/design-system/components/ProgressBar'
import { EmptyState } from '@/design-system/components/EmptyState'
import { DataGrid } from '@/design-system/components/DataGrid'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { ExportScopeModal } from './ExportScopeModal'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './bulk.css'

// ── types mirrored from the API ───────────────────────────────────────
interface Counts {
  total: number; create: number; update: number; archive: number
  unchanged: number; conflict: number; unresolved: number; unsupported: number; errorRows: number
}
interface BlastRadius {
  dailyBudget: { currentEur: number; nextEur: number; deltaEur: number; deltaPct: number | null; campaigns: number }
  archives: number; pauses: number; enables: number
  bidChanges: number; largeBidChanges: number; bidDeltaEur: number
  byEntity: Record<string, number>
}
interface DiffRow {
  rowIndex: number; entity: string; operation: string; label: string
  status: string; diffs: Array<{ field: string; current: string; next: string }>; note?: string
}
interface Preview {
  planToken: string; counts: Counts; blastRadius: BlastRadius
  warnings: string[]; conflicts: DiffRow[]; rows: DiffRow[]
}
interface JobRow {
  id: string; filename: string | null; status: string
  totalRows: number; successRows: number; failedRows: number; skippedRows: number
  errorSummary: string | null; createdAt: string; completedAt: string | null
  planSummary?: { counts?: Counts; warnings?: string[] } | null
}

type Stage = 'idle' | 'uploading' | 'validating' | 'reviewing' | 'applying' | 'done'

const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`
const eur = (n: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(n)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'ok', FAILED_PARTIAL: 'warn', FAILED: 'bad',
  ROLLED_BACK: 'muted', PENDING_PREVIEW: 'info', PROCESSING: 'info',
}

function BulkInner() {
  const { toast } = useToast()
  const params = useSearchParams()
  const [tab, setTab] = useState('import')

  // ── export ──
  // "Download everything" is the one-click path and takes the default window;
  // anyone who cares about the window is in the scope modal, which owns its own.
  const perfDays = '30'
  const [downloading, setDownloading] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)

  // ── import ──
  const [stage, setStage] = useState<Stage>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [applyLive, setApplyLive] = useState(false)
  const [conflictMode, setConflictMode] = useState<'skip' | 'mine'>('skip')
  const [applyResult, setApplyResult] = useState<{ applied: number; skipped: number; failed: number } | null>(null)
  const [busy, setBusy] = useState(false)

  // ── history ──
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [loadingJobs, setLoadingJobs] = useState(false)

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true)
    try {
      const r = await fetch(api('/bulk/imports?limit=25'), { cache: 'no-store' }).then((x) => x.json())
      setJobs(r.items ?? [])
    } catch { /* keep last good */ } finally { setLoadingJobs(false) }
  }, [])

  useEffect(() => { void loadJobs() }, [loadJobs])

  // ?job=<id> reopens a previous import. Makes every History row linkable and
  // shareable — "look at what this upload was going to do" is a thing people ask
  // each other, and it should be a URL rather than a description.
  useEffect(() => {
    const id = params.get('job')
    if (!id || jobId === id) return
    setJobId(id); setTab('import')
    void runPreview(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const downloadExport = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(api(`/bulk/export?days=${perfDays}`), { cache: 'no-store' })
      if (!res.ok) { toast(`Export failed — HTTP ${res.status}`, 'danger'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'nexus-bulksheet.xlsx'
      a.click()
      URL.revokeObjectURL(url)
      toast(`Bulksheet downloaded — ${res.headers.get('X-Nexus-Export-Rows') ?? '?'} rows · ${res.headers.get('X-Nexus-Export-Campaigns') ?? '?'} campaigns`, 'success')
    } catch (e) {
      toast(`Export failed — ${(e as Error).message}`, 'danger')
    } finally { setDownloading(false) }
  }, [perfDays, toast])

  /** Upload, then poll the job until it stops PROCESSING. */
  const onFiles = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setStage('uploading'); setFileName(file.name)
    setPreview(null); setApplyResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(api('/bulk/upload'), { method: 'POST', body: fd })
      const body = await res.json()
      if (!res.ok && res.status !== 202) {
        setStage('idle')
        toast(`File refused — ${body.message ?? body.error ?? `HTTP ${res.status}`}`, 'danger')
        return
      }
      setJobId(body.importJobId)
      setStage('validating')

      // The upload returns 202 immediately; validation continues behind it.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const j = await fetch(api(`/bulk/import/${body.importJobId}?limit=1`), { cache: 'no-store' }).then((x) => x.json())
        if (j.job?.status && j.job.status !== 'PROCESSING') {
          if (j.job.status === 'FAILED' && !j.job.totalRows) {
            setStage('idle')
            toast(`File rejected — ${j.job.errorSummary ?? 'unreadable file'}`, 'danger')
            return
          }
          break
        }
      }
      // Straight into the dry run — reviewing is the point, so do not make them ask.
      await runPreview(body.importJobId)
      void loadJobs()
    } catch (e) {
      setStage('idle')
      toast(`Upload failed — ${(e as Error).message}`, 'danger')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, loadJobs])

  const runPreview = useCallback(async (id: string) => {
    setBusy(true)
    try {
      const r = await fetch(api(`/bulk/import/${id}/preview?limit=300`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const body = await r.json()
      if (!r.ok) {
        toast(`Could not build the preview — ${body.message ?? body.error}`, 'danger')
        setStage('idle'); return
      }
      setPreview(body); setStage('reviewing')
    } finally { setBusy(false) }
  }, [toast])

  const doApply = useCallback(async () => {
    if (!jobId || !preview) return
    setStage('applying'); setBusy(true)
    try {
      const r = await fetch(api(`/bulk/import/${jobId}/apply`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planToken: preview.planToken, applyImmediately: applyLive, conflicts: conflictMode }),
      })
      const body = await r.json()
      if (!r.ok) {
        setStage('reviewing')
        toast(body.error === 'plan_changed'
          ? 'The plan changed since you reviewed it — showing you the new one'
          : `Apply failed — ${body.message ?? body.error}`, 'danger')
        if (body.error === 'plan_changed') await runPreview(jobId)
        return
      }
      setApplyResult(body); setStage('done')
      toast(`${body.applied} row${body.applied === 1 ? '' : 's'} applied — ${body.skipped} skipped · ${body.failed} failed`, body.failed ? 'warning' : 'success')
      void loadJobs()
    } finally { setBusy(false) }
  }, [jobId, preview, applyLive, conflictMode, toast, runPreview, loadJobs])

  const doRollback = useCallback(async (id: string) => {
    setBusy(true)
    try {
      const r = await fetch(api(`/bulk/import/${id}/rollback`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'operator rollback from bulk page' }),
      })
      const body = await r.json()
      // Phase 2 — an expired undo window is a fact, not a silent zero. This
      // previously reported "0 changes reverted" for a change set that was
      // simply too old, which reads identically to "there was nothing to undo".
      if (body.expired) {
        toast(body.reason ?? `Past the ${body.windowHours ?? 24}-hour undo window.`, 'warning')
      } else {
        toast(`${body.reversed} change${body.reversed === 1 ? '' : 's'} reverted — ${body.skipped} skipped · ${body.failed} failed`, body.failed ? 'warning' : 'success')
      }
      void loadJobs()
    } finally { setBusy(false) }
  }, [toast, loadJobs])

  const downloadAnnotated = useCallback(async (id: string, name?: string | null) => {
    const res = await fetch(api(`/bulk/import/${id}/annotated`), { cache: 'no-store' })
    if (!res.ok) { toast('Could not build the reviewed file', 'danger'); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name ?? 'bulksheet').replace(/\.xlsx$/i, '')}-reviewed.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }, [toast])

  const reset = () => { setStage('idle'); setJobId(null); setPreview(null); setApplyResult(null); setFileName('') }

  const b = preview?.blastRadius
  const c = preview?.counts
  const willChange = c ? c.create + c.update + c.archive : 0

  return (
    <>
      <AdsPageHeader
        title="Bulk operations"
        subtitle="Download your ad state, edit it in Excel or Numbers, and upload it back. Nothing is applied until you have seen exactly what it would do."
        markets={[]} market="all" onMarketChange={() => {}}
        showDataSync={false} showDateRange={false}
      />

      <div className="bulk-wrap">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { id: 'import', label: <span className="bulk-tab"><Upload size={14} />Import</span> },
            { id: 'export', label: <span className="bulk-tab"><Download size={14} />Export</span> },
            { id: 'history', label: <span className="bulk-tab"><HistoryIcon size={14} />History</span> },
          ]}
        />

        {/* ── EXPORT ─────────────────────────────────────────────── */}
        {tab === 'export' && (
          <div className="bulk-panel">
            <div className="bulk-card">
              <h3 className="bulk-card-h"><FileSpreadsheet size={16} />Download current state</h3>
              <p className="bulk-card-p">
                An Amazon-format bulksheet of every campaign, ad group, product ad, keyword, target
                and placement modifier. Column-for-column identical to Amazon&rsquo;s own Sponsored
                Products layout, so it opens in Excel and Numbers with no surprises.
              </p>
              <div className="bulk-row">
                <Button variant="primary" onClick={() => setScopeOpen(true)}>
                  <Download size={14} />Choose what to export
                </Button>
                <Button variant="secondary" onClick={() => void downloadExport()} disabled={downloading}>
                  {downloading ? 'Preparing…' : 'Download everything'}
                </Button>
                <span className="bulk-hint">
                  Scope it by portfolio, product, state or row type — and see the row count before
                  you download.
                </span>
              </div>
              <Banner tone="info" className="bulk-banner">
                Metrics are populated for campaigns and product ads. Keyword and ad-group rows are
                left <strong>blank rather than zero</strong> — we do not collect performance at those
                grains yet, and a zero would claim &ldquo;no impressions&rdquo; when the truth is
                &ldquo;never measured&rdquo;. Sponsored Brands and Sponsored Display are not in the
                file yet.
              </Banner>
            </div>
          </div>
        )}

        {/* ── IMPORT ─────────────────────────────────────────────── */}
        {tab === 'import' && (
          <div className="bulk-panel">
            <ol className="bulk-steps">
              {(['Upload', 'Review', 'Apply', 'Done'] as const).map((s, i) => {
                const idx = stage === 'idle' || stage === 'uploading' || stage === 'validating' ? 0
                  : stage === 'reviewing' ? 1 : stage === 'applying' ? 2 : 3
                return <li key={s} className={`bulk-step ${i === idx ? 'is-active' : i < idx ? 'is-done' : ''}`}><span>{i + 1}</span>{s}</li>
              })}
            </ol>

            {(stage === 'idle') && (
              <div className="bulk-card">
                <h3 className="bulk-card-h"><Upload size={16} />Upload an edited bulksheet</h3>
                <FileDropzone
                  onFiles={(f) => void onFiles(f)}
                  accept=".xlsx"
                  maxBytes={50 * 1024 * 1024}
                  hint="An .xlsx bulksheet, up to 50 MB. Leave Operation blank on any row you do not want to change."
                />
                <div className="bulk-row bulk-row--between">
                  <span className="bulk-hint">Do not have one yet?</span>
                  <Button variant="secondary" onClick={() => void downloadExport()} disabled={downloading}>
                    <Download size={14} />Download current data
                  </Button>
                </div>
              </div>
            )}

            {(stage === 'uploading' || stage === 'validating') && (
              <div className="bulk-card">
                <h3 className="bulk-card-h"><RefreshCw size={16} className="bulk-spin" />
                  {stage === 'uploading' ? 'Uploading' : 'Checking every row'}
                </h3>
                <p className="bulk-card-p">{fileName}</p>
                <ProgressBar indeterminate />
                <p className="bulk-hint">Nothing is written while this runs.</p>
              </div>
            )}

            {stage === 'reviewing' && preview && c && b && (
              <>
                {preview.warnings.length > 0 && (
                  <Banner tone={b.archives > 0 || c.conflict > 0 ? 'warning' : 'info'} title="Before you apply this">
                    <ul className="bulk-warnlist">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </Banner>
                )}

                <div className="bulk-metrics">
                  <div className="bulk-metric"><span className="bulk-metric-v">{willChange}</span><span className="bulk-metric-l">will change</span></div>
                  <div className="bulk-metric"><span className="bulk-metric-v">{c.update}</span><span className="bulk-metric-l">updates</span></div>
                  <div className={`bulk-metric ${c.archive ? 'is-danger' : ''}`}><span className="bulk-metric-v">{c.archive}</span><span className="bulk-metric-l">archives</span></div>
                  <div className={`bulk-metric ${c.conflict ? 'is-warn' : ''}`}><span className="bulk-metric-v">{c.conflict}</span><span className="bulk-metric-l">conflicts</span></div>
                  <div className={`bulk-metric ${c.errorRows ? 'is-danger' : ''}`}><span className="bulk-metric-v">{c.errorRows}</span><span className="bulk-metric-l">bad rows</span></div>
                  <div className="bulk-metric"><span className="bulk-metric-v">{c.unchanged}</span><span className="bulk-metric-l">unchanged</span></div>
                </div>

                {b.dailyBudget.deltaEur !== 0 && (
                  <div className="bulk-budget">
                    <span className="bulk-budget-l">Total daily budget</span>
                    <span className="bulk-budget-v">{eur(b.dailyBudget.currentEur)}</span>
                    <ArrowRight size={15} className="bulk-budget-arrow" />
                    <span className={`bulk-budget-v ${b.dailyBudget.deltaEur > 0 ? 'is-up' : 'is-down'}`}>{eur(b.dailyBudget.nextEur)}</span>
                    <span className={`bulk-budget-d ${b.dailyBudget.deltaEur > 0 ? 'is-up' : 'is-down'}`}>
                      {b.dailyBudget.deltaEur > 0 ? '+' : ''}{eur(b.dailyBudget.deltaEur)}
                      {b.dailyBudget.deltaPct != null && ` (${b.dailyBudget.deltaPct > 0 ? '+' : ''}${b.dailyBudget.deltaPct}%)`}
                    </span>
                    <span className="bulk-budget-n">across {b.dailyBudget.campaigns} campaign{b.dailyBudget.campaigns === 1 ? '' : 's'}</span>
                  </div>
                )}

                <div className="bulk-card">
                  <h3 className="bulk-card-h">What will change</h3>
                  <DataGrid<DiffRow>
                    className="bulk-table"
                    size="sm"
                    rows={preview.rows.slice(0, 200)}
                    rowKey={(r) => String(r.rowIndex)}
                    rowClassName={(r) => (r.status === 'CONFLICT' ? 'is-conflict' : r.status === 'ARCHIVE' ? 'is-archive' : undefined)}
                    columns={[
                      { key: 'row', label: 'Row', align: 'right', sortable: true, sortValue: (r) => r.rowIndex, render: (r) => <span className="bulk-num">{r.rowIndex}</span> },
                      { key: 'entity', label: 'Entity', sortable: true, sortValue: (r) => r.entity, render: (r) => r.entity },
                      { key: 'name', label: 'Name', sortable: true, sortValue: (r) => r.label, render: (r) => <span className="bulk-name" title={r.label}>{r.label}</span> },
                      {
                        key: 'change', label: 'Change',
                        render: (r) => (
                          <>
                            {r.diffs.length === 0 ? <span className="bulk-hint">—</span> : r.diffs.map((d) => (
                              <span key={d.field} className="bulk-diff">
                                <span className="bulk-diff-f">{d.field}</span>
                                <span className="bulk-diff-o">{d.current || '∅'}</span>
                                <ArrowRight size={11} />
                                <span className="bulk-diff-n">{d.next || '∅'}</span>
                              </span>
                            ))}
                            {r.note && <div className="bulk-note">{r.note}</div>}
                          </>
                        ),
                      },
                      { key: 'status', label: 'Status', sortable: true, sortValue: (r) => r.status, render: (r) => <span className={`bulk-pill is-${r.status.toLowerCase()}`}>{r.status.toLowerCase()}</span> },
                    ]}
                  />
                  {preview.rows.length > 200 && <p className="bulk-hint">Showing the first 200 of {preview.rows.length}.</p>}
                </div>

                <div className="bulk-actions">
                  <div className="bulk-actions-opts">
                    {c.conflict > 0 && (
                      <label className="bulk-opt">
                        <span>Rows changed on Amazon</span>
                        <Select value={conflictMode} onChange={(e) => setConflictMode(e.target.value as 'skip' | 'mine')} className="bulk-select">
                          <option value="skip">Skip them (safe)</option>
                          <option value="mine">Overwrite with my values</option>
                        </Select>
                      </label>
                    )}
                    <Checkbox
                      className="bulk-opt--check"
                      checked={applyLive}
                      onChange={(e) => setApplyLive(e.target.checked)}
                      label={<>Push to Amazon now <em>— otherwise changes queue behind the write gate</em></>}
                    />
                  </div>
                  <div className="bulk-actions-btns">
                    <Button variant="secondary" onClick={reset} disabled={busy}>Cancel</Button>
                    <Button
                      variant={b.archives > 0 || applyLive ? 'danger' : 'primary'}
                      onClick={() => void doApply()}
                      disabled={busy || willChange === 0}
                    >
                      {willChange === 0 ? 'Nothing to apply' : `Apply ${willChange} change${willChange === 1 ? '' : 's'}`}
                    </Button>
                  </div>
                </div>
              </>
            )}

            {stage === 'applying' && (
              <div className="bulk-card">
                <h3 className="bulk-card-h"><RefreshCw size={16} className="bulk-spin" />Applying</h3>
                <ProgressBar indeterminate />
              </div>
            )}

            {stage === 'done' && applyResult && jobId && (
              <div className="bulk-card">
                <h3 className="bulk-card-h">
                  {applyResult.failed ? <FileWarning size={16} /> : <CheckCircle2 size={16} className="bulk-ok" />}
                  {applyResult.applied} applied · {applyResult.skipped} skipped · {applyResult.failed} failed
                </h3>
                <p className="bulk-card-p">
                  {applyLive
                    ? 'Changes were pushed to Amazon.'
                    : 'Changes are queued behind the write gate. They reach Amazon when the gate allows it.'}
                </p>
                <div className="bulk-row">
                  <Button variant="secondary" onClick={() => void downloadAnnotated(jobId, fileName)}>
                    <Download size={14} />Download reviewed file
                  </Button>
                  <Button variant="danger" onClick={() => void doRollback(jobId)} disabled={busy}>
                    <Undo2 size={14} />Undo this import
                  </Button>
                  <Button variant="secondary" onClick={reset}>Import another file</Button>
                </div>
                <p className="bulk-hint">
                  The reviewed file marks every failed cell and refreshes what already succeeded, so
                  you can fix it and upload the same file again — only the failures will re-run.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY ────────────────────────────────────────────── */}
        {tab === 'history' && (
          <div className="bulk-panel">
            <div className="bulk-card">
              <div className="bulk-row bulk-row--between">
                <h3 className="bulk-card-h"><HistoryIcon size={16} />Recent imports</h3>
                <Button variant="secondary" onClick={() => void loadJobs()} disabled={loadingJobs}>
                  <RefreshCw size={14} className={loadingJobs ? 'bulk-spin' : ''} />Refresh
                </Button>
              </div>
              {jobs.length === 0 ? (
                <EmptyState icon={<FileSpreadsheet size={22} />} title="No imports yet" description="Uploaded bulksheets show up here with what they changed and a button to undo them." />
              ) : (
                <DataGrid<JobRow>
                  className="bulk-table"
                  size="sm"
                  rows={jobs}
                  rowKey={(j) => j.id}
                  columns={[
                    { key: 'file', label: 'File', sortable: true, sortValue: (j) => j.filename ?? '', render: (j) => <span className="bulk-name" title={j.filename ?? ''}>{j.filename ?? '—'}</span> },
                    { key: 'when', label: 'When', sortable: true, sortValue: (j) => j.createdAt, render: (j) => <span className="bulk-when">{when(j.createdAt)}</span> },
                    { key: 'rows', label: 'Rows', align: 'right', sortable: true, sortValue: (j) => j.totalRows, render: (j) => <span className="bulk-num">{j.totalRows}</span> },
                    { key: 'applied', label: 'Applied', align: 'right', sortable: true, sortValue: (j) => j.successRows, render: (j) => <span className="bulk-num">{j.successRows}</span> },
                    { key: 'failed', label: 'Failed', align: 'right', sortable: true, sortValue: (j) => j.failedRows, render: (j) => <span className={`bulk-num ${j.failedRows ? 'is-danger' : ''}`}>{j.failedRows}</span> },
                    { key: 'status', label: 'Status', sortable: true, sortValue: (j) => j.status, render: (j) => <span className={`bulk-pill is-${STATUS_TONE[j.status] ?? 'info'}`}>{j.status.toLowerCase().replace(/_/g, ' ')}</span> },
                    {
                      key: 'acts', label: '',
                      render: (j) => (
                        <span className="bulk-rowacts">
                          <Button variant="secondary" size="sm" onClick={() => { setJobId(j.id); setTab('import'); void runPreview(j.id) }}>Review</Button>
                          <Button variant="secondary" size="sm" onClick={() => void downloadAnnotated(j.id, j.filename)}>Reviewed file</Button>
                          {j.successRows > 0 && j.status !== 'ROLLED_BACK' && (
                            <Button variant="secondary" size="sm" onClick={() => void doRollback(j.id)} disabled={busy}>
                              <Undo2 size={13} />Undo
                            </Button>
                          )}
                        </span>
                      ),
                    },
                  ]}
                />
              )}
              <Banner tone="neutral" className="bulk-banner">
                Undo restores the values an import changed, and only within 24 hours of it running.
                Archiving cannot be undone — Amazon has no unarchive.
              </Banner>
            </div>
          </div>
        )}
      </div>

      <ExportScopeModal
        open={scopeOpen}
        onClose={() => setScopeOpen(false)}
        api={api}
        onDownloaded={({ rows, campaigns, filename }) =>
          toast(`${rows.toLocaleString()} rows across ${campaigns} campaign${campaigns === 1 ? '' : 's'} → ${filename}`, 'success')}
        onError={(m) => toast(m, 'danger')}
      />
    </>
  )
}

export function BulkClient() {
  // Ads routes do not get a ToastProvider from the app shell.
  return <ToastProvider><BulkInner /></ToastProvider>
}
