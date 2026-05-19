'use client'

/**
 * Phase A — Probe runner UI.
 *
 * Picks a profile, fires the probe suite, renders results as a
 * collapsible per-probe table. Color-codes pass/fail so the operator
 * can see at a glance which endpoint family is accessible.
 */

import { useState } from 'react'
import {
  Play, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader2,
  AlertTriangle, Copy, Check,
} from 'lucide-react'
import { marketplaceCode, marketplaceCountryName } from '@/lib/marketplace-code'

interface ProfileRow {
  profileId: string
  marketplace: string
  region: string
  accountLabel: string | null
  mode: string
  isActive: boolean
}

interface ProbeResult {
  id: string
  description: string
  method: string
  path: string
  status: number
  ok: boolean
  durationMs: number
  responseSnippet: string
  responseHeaders: Record<string, string>
  requestHeaders: Record<string, string>
}

interface ProbeReport {
  profileId: string
  marketplace: string | null
  region: string
  baseUrl: string
  generatedAt: string
  token: { acquired: boolean; status: number; snippet: string }
  results: ProbeResult[]
  summary: { total: number; passed: number; failed: number; passedIds: string[]; failedIds: string[] }
}

// ── Per-probe row ────────────────────────────────────────────────────────────

function ProbeRow({ probe }: { probe: ProbeResult }) {
  const [open, setOpen] = useState(false)
  const statusColor =
    probe.ok ? 'text-emerald-600 dark:text-emerald-400' :
    probe.status === 403 ? 'text-red-600 dark:text-red-400' :
    probe.status >= 500 ? 'text-purple-600 dark:text-purple-400' :
    'text-amber-600 dark:text-amber-400'

  return (
    <>
      <tr
        className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-3 py-2 w-6">
          {open
            ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-slate-500">{probe.id}</td>
        <td className="px-3 py-2 text-xs text-slate-700 dark:text-slate-300">{probe.description}</td>
        <td className="px-3 py-2 text-xs">
          <span className="font-mono text-slate-400">{probe.method}</span>{' '}
          <span className="font-mono text-slate-600 dark:text-slate-400">{probe.path}</span>
        </td>
        <td className={`px-3 py-2 text-xs font-bold tabular-nums ${statusColor}`}>
          {probe.ok
            ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> {probe.status}</span>
            : <span className="inline-flex items-center gap-1"><XCircle className="h-3 w-3" /> {probe.status || 'ERR'}</span>}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-slate-400">{probe.durationMs}ms</td>
      </tr>
      {open && (
        <tr className="bg-slate-50/80 dark:bg-slate-800/20">
          <td colSpan={6} className="px-6 py-3 border-b border-slate-100 dark:border-slate-800">
            <div className="space-y-2 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Request Headers</div>
                <pre className="bg-slate-100 dark:bg-slate-900 rounded p-2 font-mono text-[11px] overflow-x-auto text-slate-600 dark:text-slate-300 max-h-32">
                  {Object.entries(probe.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')}
                </pre>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Response Headers (key only)</div>
                <pre className="bg-slate-100 dark:bg-slate-900 rounded p-2 font-mono text-[11px] overflow-x-auto text-slate-600 dark:text-slate-300 max-h-32">
                  {Object.entries(probe.responseHeaders)
                    .filter(([k]) => k.toLowerCase().startsWith('x-amzn') || k.toLowerCase() === 'content-type' || k.toLowerCase() === 'location')
                    .map(([k, v]) => `${k}: ${v}`).join('\n') || '(none of interest)'}
                </pre>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Response Body (first 400 chars)</div>
                <pre className="bg-slate-100 dark:bg-slate-900 rounded p-2 font-mono text-[11px] overflow-x-auto text-slate-600 dark:text-slate-300 max-h-48 whitespace-pre-wrap break-all">
                  {probe.responseSnippet || '(empty)'}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Verdict panel — interprets the result ────────────────────────────────────

function Verdict({ report }: { report: ProbeReport }) {
  const byId = new Map(report.results.map((r) => [r.id, r]))
  const ok = (id: string) => byId.get(id)?.ok === true

  const v3SpWorks = ok('sp_v3_list') || ok('sp_v3_list_minimal')
  const v4SbWorks = ok('sb_v4_list')
  const exportsSpWorks = ok('exports_v1_campaigns_sp')
  const exportsSbWorks = ok('exports_v1_campaigns_sb')
  const exportsSdWorks = ok('exports_v1_campaigns_sd')
  const profilesOk     = ok('profiles_v2')
  const sdLegacyOk     = ok('sd_v2_get')

  let verdict: { label: string; tone: 'good' | 'mixed' | 'bad'; lines: string[] }

  if (!profilesOk) {
    verdict = {
      label: 'TOKEN PROBLEM',
      tone: 'bad',
      lines: [
        '/v2/profiles failed — the LWA token itself is not accepted.',
        'Check client_id / refresh_token / scope before anything else.',
      ],
    }
  } else if (exportsSpWorks && exportsSbWorks && exportsSdWorks) {
    verdict = {
      label: 'EXPORTS V1 WORKS — proceed with Phase C path',
      tone: 'good',
      lines: [
        'Exports API v1 accepts the current token for SP, SB, and SD.',
        'Recommended: skip Phase B (v3 direct), go straight to Phase C (Exports v1 infrastructure).',
        'This bypasses the SP/SB JWT issue entirely via the bulk async path.',
      ],
    }
  } else if (v3SpWorks && v4SbWorks) {
    verdict = {
      label: 'V3 DIRECT WORKS — Phase B is sufficient',
      tone: 'good',
      lines: [
        'SP v3 POST /list and SB v4 POST /list both return 200.',
        'Recommended: proceed with Phase B (v3 direct API migration). Phase C still valuable but no longer urgent.',
      ],
    }
  } else if (v3SpWorks || exportsSpWorks) {
    verdict = {
      label: 'PARTIAL — at least one path is open for SP',
      tone: 'mixed',
      lines: [
        v3SpWorks ? '✓ SP v3 POST /list works' : '✗ SP v3 POST /list still fails',
        exportsSpWorks ? '✓ Exports v1 (SP) works' : '✗ Exports v1 (SP) fails',
        v4SbWorks ? '✓ SB v4 list works' : '✗ SB v4 list still fails',
        exportsSbWorks ? '✓ Exports v1 (SB) works' : '✗ Exports v1 (SB) fails',
        'Pick the path with the most green and proceed.',
      ],
    }
  } else if (sdLegacyOk) {
    verdict = {
      label: 'ONLY SD LEGACY WORKS — Amazon support still required',
      tone: 'bad',
      lines: [
        '/sd/* works (current baseline) but every SP/SB variant returns ' +
        'a non-200 status.',
        'Neither v3 direct nor Exports v1 accept this token for SP/SB.',
        'This profile may need the support ticket resolved before any migration unblocks it.',
        'Check the per-probe response snippets for hints about scope/format.',
      ],
    }
  } else {
    verdict = {
      label: 'ALL FAIL — auth fundamentals broken',
      tone: 'bad',
      lines: [
        'Even the working baseline (/sd/campaigns) is returning non-200.',
        'Likely cause: token regression or account suspension. Re-issue refresh token.',
      ],
    }
  }

  const tone =
    verdict.tone === 'good' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' :
    verdict.tone === 'mixed' ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300' :
    'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'

  return (
    <div className={`rounded-lg border ${tone} p-3 mb-3`}>
      <div className="flex items-start gap-2">
        {verdict.tone === 'good'
          ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          : <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />}
        <div>
          <p className="text-sm font-bold">{verdict.label}</p>
          <ul className="text-xs mt-1 space-y-0.5 list-disc list-inside">
            {verdict.lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      </div>
    </div>
  )
}

// ── Main client ──────────────────────────────────────────────────────────────

export function ProbeRunnerClient({
  profiles,
  backendUrl,
}: {
  profiles: ProfileRow[]
  backendUrl: string
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.profileId ?? '')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ProbeReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function runProbes() {
    if (!selectedProfileId) return
    setRunning(true)
    setError(null)
    setReport(null)
    try {
      const res = await fetch(`${backendUrl}/api/advertising/debug/probe-endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: selectedProfileId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setReport(data as ProbeReport)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  async function copyJson() {
    if (!report) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  if (profiles.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-700 dark:text-amber-300">
        No Amazon Ads connections with credentials found. Add one at{' '}
        <a href="/settings/advertising" className="underline hover:text-amber-900 dark:hover:text-amber-200">
          /settings/advertising
        </a>{' '}
        first.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Picker + run button */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Profile to probe
            </label>
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              disabled={running}
              className="w-full text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
            >
              {profiles.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {marketplaceCode(p.marketplace)} ({marketplaceCountryName(p.marketplace)}) · {p.accountLabel ?? p.profileId} · {p.region} · {p.mode}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={runProbes}
            disabled={running || !selectedProfileId}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing… (~10s)</>
              : <><Play className="h-3.5 w-3.5" /> Run Probe Suite</>}
          </button>
          {report && (
            <button
              onClick={copyJson}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
              title="Copy full JSON report"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          )}
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1.5">
            {error}
          </p>
        )}
      </div>

      {/* Report */}
      {report && (
        <>
          {/* Header bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 px-1">
            <span>Profile: <code className="font-mono">{report.profileId}</code></span>
            <span>Marketplace: <code className="font-mono" title={marketplaceCountryName(report.marketplace)}>{marketplaceCode(report.marketplace)}</code></span>
            <span>Region: <code className="font-mono">{report.region}</code></span>
            <span>Base: <code className="font-mono">{report.baseUrl}</code></span>
            <span>Token: {report.token.acquired
              ? <span className="text-emerald-600 dark:text-emerald-400">acquired</span>
              : <span className="text-red-600 dark:text-red-400">FAILED ({report.token.status})</span>}
            </span>
          </div>

          {!report.token.acquired ? (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
              <strong>Token acquisition failed.</strong> Can't run probes.
              <pre className="mt-2 text-xs font-mono bg-red-100 dark:bg-red-900/40 rounded p-2 overflow-x-auto">
                {report.token.snippet}
              </pre>
            </div>
          ) : (
            <>
              <Verdict report={report} />

              <div className="flex items-center gap-3 px-1 text-xs text-slate-500 dark:text-slate-400">
                <span><strong className="text-slate-700 dark:text-slate-300">{report.summary.total}</strong> probes</span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  <strong>{report.summary.passed}</strong> passed
                </span>
                <span className="text-red-600 dark:text-red-400">
                  <strong>{report.summary.failed}</strong> failed
                </span>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                      <th className="w-6 px-3 py-2" />
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">ID</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Description</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Endpoint</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Status</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.results.map((r) => <ProbeRow key={r.id} probe={r} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
