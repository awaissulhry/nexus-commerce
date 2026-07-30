'use client'

/**
 * AX-VT.6 — the trust surface.
 *
 * One page answering one question: is Nexus telling me the truth about Amazon right now?
 *
 * Every number here already existed and was scattered — AdDrift rows, AD_* dead letters, unsettled
 * write intents, launch receipts, the integrity snapshot. That scattering is precisely how the
 * defect that started this series survived: 169 drift rows for biddingStrategy sat unread while
 * portfolioId was structurally undetectable, and nobody had one place that would have shown both.
 *
 * The design rule throughout: never let "we don't know" render as "it's fine". A stale reconcile is
 * its own warning state, not a green tick.
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, ShieldAlert, ShieldQuestion, Hourglass, ExternalLink } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import { Banner } from '@/design-system/components/Banner'
import type { Tone } from '@/design-system/primitives/tone'
import { getBackendUrl } from '@/lib/backend-url'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './trust.css'

type Verdict = 'TRUSTWORTHY' | 'SETTLING' | 'UNVERIFIED' | 'NEEDS_ATTENTION'

interface TrustPayload {
  verdict: Verdict
  headline: string
  drift: { open: number; needsAttention: number; selfHealing: number; byClassification: Record<string, number> }
  writes: { deadLetters: number; pending: number; stuckOverADay: number; campaignsWithFailedWrite: number }
  lastReconcile: { startedAt: string; finishedAt: string | null; status: string; summary: string | null; stale: boolean } | null
  lastLaunchVerification: { at: string; status: string; ok: boolean | null; total: number | null; verified: number | null; mismatch: number | null; missingOnAmazon: number | null; notPushed: number | null; uncovered: number | null } | null
  integrity: { severity: string; findings: Array<{ code: string; severity: string; message: string; action: string }> } | null
}

const VERDICT: Record<Verdict, { tone: Tone; label: string; Icon: typeof ShieldCheck }> = {
  TRUSTWORTHY: { tone: 'success', label: 'Trustworthy', Icon: ShieldCheck },
  SETTLING: { tone: 'info', label: 'Settling', Icon: Hourglass },
  // Amber, not green: "nothing has checked" is not good news, it is an absence of news.
  UNVERIFIED: { tone: 'warning', label: 'Unverified', Icon: ShieldQuestion },
  NEEDS_ATTENTION: { tone: 'danger', label: 'Needs attention', Icon: ShieldAlert },
}

/** WRITE_PENDING/WRITE_LAG clear themselves; the other two do not. Colour follows that, not severity. */
const CLASS_TONE: Record<string, Tone> = {
  WRITE_PENDING: 'info', WRITE_LAG: 'info',
  WRITE_FAILED: 'danger', EXTERNAL_CHANGE: 'warning',
}

const ago = (iso: string | null | undefined): string => {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: Tone; hint?: string }) {
  return (
    <div className={`h10-vt-stat${tone && value !== 0 ? ` t-${tone}` : ''}`} title={hint}>
      <span className="h10-vt-stat-v">{value}</span>
      <span className="h10-vt-stat-l">{label}</span>
    </div>
  )
}

export function TrustClient() {
  const [data, setData] = useState<TrustPayload | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/trust`, { credentials: 'include' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Could not load trust status')
      setData(j)
    } catch (e) { setErr((e as Error).message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Run the reconcile now. Read-only — repair stays with the cron so this button is always safe. */
  const reconcileNow = useCallback(async () => {
    if (reconciling) return
    setReconciling(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/structural-reconcile?repairPortfolios=0&limit=40`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      await load()
    } catch (e) { setErr((e as Error).message) }
    finally { setReconciling(false) }
  }, [reconciling, load])

  const v = data ? VERDICT[data.verdict] : null

  return (
    <>
      <AdsPageHeader
        title="Trust"
        subtitle="Does Nexus match Amazon right now — and when was that last actually checked?"
        markets={['All markets']} market="All markets" onMarketChange={() => {}}
        showLearn={false} showDataSync={false} showDateRange={false}
        actions={[]}
      />

      <div className="h10-vt-trust">
        {err && <Banner tone="danger" title="Could not load trust status">{err}</Banner>}
        {loading && <div className="h10-vt-loading">Checking…</div>}

        {data && v && (
          <>
            <div className={`h10-vt-verdict t-${v.tone}`}>
              <v.Icon size={22} />
              <div className="h10-vt-verdict-body">
                <div className="h10-vt-verdict-top">
                  <Pill tone={v.tone}>{v.label}</Pill>
                  <span className="h10-vt-verdict-when">
                    last full check {ago(data.lastReconcile?.finishedAt)}
                    {data.lastReconcile?.stale && ' — overdue'}
                  </span>
                </div>
                <p className="h10-vt-verdict-head">{data.headline}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={reconcileNow} disabled={reconciling}>
                <RefreshCw size={13} className={reconciling ? 'h10-spin' : undefined} />
                {reconciling ? 'Checking…' : 'Check now'}
              </Button>
            </div>

            <div className="h10-vt-grid">
              <section className="h10-vt-card">
                <h3>Disagreements with Amazon</h3>
                <div className="h10-vt-stats">
                  <Stat label="won't self-heal" value={data.drift.needsAttention} tone="danger"
                        hint="Someone changed it on Amazon, or one of our writes failed. Needs a human." />
                  <Stat label="settling" value={data.drift.selfHealing} tone="info"
                        hint="Our own writes still landing. Expected to clear on its own." />
                  <Stat label="open total" value={data.drift.open} />
                </div>
                {Object.keys(data.drift.byClassification).length > 0 && (
                  <div className="h10-vt-chips">
                    {Object.entries(data.drift.byClassification).map(([k, n]) => (
                      <Pill key={k} tone={CLASS_TONE[k] ?? 'neutral'}>{k.replace('_', ' ').toLowerCase()} · {n}</Pill>
                    ))}
                  </div>
                )}
                <a className="h10-vt-link" href={`${getBackendUrl()}/api/advertising/drift`} target="_blank" rel="noreferrer">
                  Full drift detail <ExternalLink size={11} />
                </a>
              </section>

              <section className="h10-vt-card">
                <h3>Writes reaching Amazon</h3>
                <div className="h10-vt-stats">
                  <Stat label="dead-lettered" value={data.writes.deadLetters} tone="danger"
                        hint="Gave up after retries. These will not be delivered without action." />
                  <Stat label="stuck &gt; 1 day" value={data.writes.stuckOverADay} tone="danger"
                        hint="An intent this old is not in flight any more." />
                  <Stat label="in flight" value={data.writes.pending} tone="info" />
                  <Stat label="campaigns w/ failed write" value={data.writes.campaignsWithFailedWrite} tone="warning" />
                </div>
              </section>

              <section className="h10-vt-card">
                <h3>Last full comparison</h3>
                {data.lastReconcile ? (
                  <>
                    <div className="h10-vt-kv"><span>ran</span><b>{ago(data.lastReconcile.finishedAt ?? data.lastReconcile.startedAt)}</b></div>
                    <div className="h10-vt-kv"><span>outcome</span><b>{data.lastReconcile.status}</b></div>
                    {data.lastReconcile.summary && <pre className="h10-vt-pre">{data.lastReconcile.summary}</pre>}
                  </>
                ) : (
                  <p className="h10-vt-empty">
                    Never run. Nothing is comparing this account against Amazon on a schedule, so
                    everything above describes only what we happen to have noticed.
                  </p>
                )}
              </section>

              <section className="h10-vt-card">
                <h3>Last launch verified</h3>
                {data.lastLaunchVerification ? (
                  <>
                    <div className="h10-vt-kv"><span>when</span><b>{ago(data.lastLaunchVerification.at)}</b></div>
                    <div className="h10-vt-stats">
                      <Stat label="verified" value={data.lastLaunchVerification.verified ?? '—'} />
                      <Stat label="differed" value={data.lastLaunchVerification.mismatch ?? '—'} tone="warning" />
                      <Stat label="not sent" value={data.lastLaunchVerification.notPushed ?? '—'} tone="danger" />
                      <Stat label="uncheckable" value={data.lastLaunchVerification.uncovered ?? '—'} tone="warning"
                            hint="No Amazon read wired up for these — reported rather than assumed fine." />
                    </div>
                  </>
                ) : <p className="h10-vt-empty">No launch has been verified yet.</p>}
              </section>
            </div>

            {data.integrity && data.integrity.findings.length > 0 && (
              <section className="h10-vt-card">
                <h3>Health findings</h3>
                <ul className="h10-vt-findings">
                  {data.integrity.findings.map((f) => (
                    <li key={f.code}>
                      <Pill tone={f.severity === 'CRITICAL' ? 'danger' : 'warning'}>{f.severity}</Pill>
                      <div>
                        <b>{f.message}</b>
                        <span>{f.action}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  )
}
