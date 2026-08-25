'use client'

/**
 * ACR.6 (R12) — the endpoint probe console, on the page about whether things work.
 *
 * Fires the live probe suite against one connected profile and reports, endpoint by endpoint,
 * what Amazon actually accepts for that token right now. It is the only surface in the system that
 * answers "is it us or is it them" with evidence rather than inference, which is why it survives
 * the retirement of `/marketing/advertising/debug` — but it is diagnostics, not a daily view, so it
 * is a collapsed panel at the foot of Alerts & Health rather than a rail entry of its own.
 *
 * DELIBERATELY NOT PORTED: the legacy page's "Verdict" block, which read the results and advised
 * things like "EXPORTS V1 WORKS — proceed with Phase C path". That migration finished long ago;
 * the advice now points at phases that no longer exist. Carrying it over would have made a stale
 * recommendation look like a live diagnosis — the exact failure this programme keeps finding. The
 * probe rows themselves are unchanged, because those are measurements.
 *
 * Each run costs roughly a dozen real Amazon requests and writes nothing, so it is manual-trigger
 * only and says so before you press it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Stethoscope, Play, ChevronDown, ChevronRight, CheckCircle2, XCircle, Copy, Check, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/design-system/primitives'

interface ProfileRow { profileId: string; marketplace: string; region: string; accountLabel: string | null; mode: string; isActive: boolean }
interface ProbeResult {
  id: string; description: string; method: string; path: string
  status: number; ok: boolean; durationMs: number
  responseSnippet: string; responseHeaders: Record<string, string>; requestHeaders: Record<string, string>
}
interface ProbeReport {
  profileId: string; marketplace: string | null; region: string; baseUrl: string; generatedAt: string
  token: { acquired: boolean; status: number; snippet: string }
  results: ProbeResult[]
  summary: { total: number; passed: number; failed: number; passedIds: string[]; failedIds: string[] }
}

/** 403 is a permission answer, 5xx is Amazon's problem, anything else non-2xx is ours to read. */
const tone = (p: ProbeResult) => (p.ok ? 'ok' : p.status === 403 ? 'bad' : p.status >= 500 ? 'them' : 'warn')

function ProbeRow({ probe }: { probe: ProbeResult }) {
  const [open, setOpen] = useState(false)
  const interesting = Object.entries(probe.responseHeaders)
    .filter(([k]) => k.toLowerCase().startsWith('x-amzn') || k.toLowerCase() === 'content-type' || k.toLowerCase() === 'location')
  return (
    <>
      <tr className="hl-pb-r" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <td className="chev">{open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}</td>
        <td className="mono dim">{probe.id}</td>
        <td>{probe.description}</td>
        <td className="mono dim"><b>{probe.method}</b> {probe.path}</td>
        <td className={`st ${tone(probe)}`}>
          {probe.ok ? <CheckCircle2 size={12} aria-hidden /> : <XCircle size={12} aria-hidden />} {probe.status || 'ERR'}
        </td>
        <td className="r dim">{probe.durationMs}ms</td>
      </tr>
      {open && (
        <tr className="hl-pb-d">
          <td colSpan={6}>
            <div className="hl-pb-k">Request headers</div>
            <pre>{Object.entries(probe.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'}</pre>
            <div className="hl-pb-k">Response headers</div>
            <pre>{interesting.map(([k, v]) => `${k}: ${v}`).join('\n') || '(none of interest)'}</pre>
            <div className="hl-pb-k">Response body · first 400 chars</div>
            <pre className="wrap">{probe.responseSnippet || '(empty)'}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

export function ProbePanel() {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ProfileRow[] | null>(null)
  const [selected, setSelected] = useState('')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ProbeReport | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || profiles != null) return
    fetch(`${getBackendUrl()}/api/advertising/debug/probe-endpoints/profiles`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        const items: ProfileRow[] = Array.isArray(j?.items) ? j.items : []
        setProfiles(items)
        setSelected((s) => s || items[0]?.profileId || '')
      })
      .catch(() => setProfiles([]))
  }, [open, profiles])

  const run = useCallback(async () => {
    if (!selected) return
    setRunning(true); setError(''); setReport(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/debug/probe-endpoints`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: selected }),
      })
      const j = await res.json()
      if (!res.ok) { setError(j?.error ?? `HTTP ${res.status}`); return }
      setReport(j as ProbeReport)
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }, [selected])

  const copy = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard denied — the table is still readable */ }
  }

  return (
    <div className="hl-section" id="hl-probe">
      <button type="button" className="hl-sec-h hl-pb-t" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Stethoscope size={15} aria-hidden /> Endpoint probe
        <span className="hl-chip">diagnostic</span>
        <span className="grow" />
        <ChevronDown size={15} className={open ? 'open' : ''} aria-hidden />
      </button>

      {open && (
        <>
          <p className="hl-pb-lede">
            Asks Amazon directly what this connection&rsquo;s token can reach, endpoint by endpoint. The only
            way to settle &ldquo;is it us or is it them&rdquo; with evidence. Writes nothing, and costs about a
            dozen real Amazon requests per run — so it fires only when you press the button.
          </p>

          {profiles == null ? (
            <div className="hl-empty">Loading connections…</div>
          ) : profiles.length === 0 ? (
            <div className="hl-empty">No Amazon Ads connection with credentials. Add one under <a href="/settings/advertising">Settings → Advertising</a> first.</div>
          ) : (
            <>
              <div className="hl-pb-ctl">
                <span className="hl-pb-seg" role="radiogroup" aria-label="Profile to probe">
                  {profiles.map((p) => (
                    <button key={p.profileId} type="button" role="radio" aria-checked={selected === p.profileId}
                      className={selected === p.profileId ? 'on' : ''} disabled={running}
                      title={`${p.accountLabel ?? p.profileId} · ${p.region} · ${p.mode}${p.isActive ? '' : ' · inactive'}`}
                      onClick={() => setSelected(p.profileId)}>
                      {p.marketplace}
                    </button>
                  ))}
                </span>
                <Button variant="primary" size="sm" disabled={running || !selected} onClick={() => void run()}>
                  {running ? <><Loader2 size={13} className="hl-pb-spin" aria-hidden /> Probing…</> : <><Play size={13} aria-hidden /> Run probe suite</>}
                </Button>
                {report && (
                  <Button size="sm" onClick={() => void copy()} title="Copy the full JSON report">
                    {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {copied ? 'Copied' : 'Copy JSON'}
                  </Button>
                )}
              </div>

              {error && <div className="hl-pb-err">{error}</div>}

              {report && (
                <>
                  <div className="hl-pb-meta">
                    <span>Profile <b>{report.profileId}</b></span>
                    <span>Market <b>{report.marketplace ?? '—'}</b></span>
                    <span>Region <b>{report.region}</b></span>
                    <span className="mono">{report.baseUrl}</span>
                    <span>Token {report.token.acquired ? <b className="ok">acquired</b> : <b className="bad">failed ({report.token.status})</b>}</span>
                    {report.token.acquired && (
                      <span className="grow r"><b>{report.summary.passed}</b> passed · <b>{report.summary.failed}</b> failed of {report.summary.total}</span>
                    )}
                  </div>

                  {!report.token.acquired ? (
                    <div className="hl-pb-err">
                      <b>Token acquisition failed — no probe could run.</b> Every result below would be
                      meaningless, so none was attempted. Check the client id, refresh token and scope.
                      <pre>{report.token.snippet}</pre>
                    </div>
                  ) : (
                    <div className="hl-pb-scroll">
                      <table className="hl-pb">
                        <thead>
                          <tr><th /><th>ID</th><th>What it asks</th><th>Endpoint</th><th>Status</th><th className="r">Time</th></tr>
                        </thead>
                        <tbody>{report.results.map((r) => <ProbeRow key={r.id} probe={r} />)}</tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
