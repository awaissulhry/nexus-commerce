'use client'

/**
 * E3 — Recommendations inbox. The AI + 5-engine impact-ranked feed (bid optimizer, harvest,
 * pacing, share-of-voice, retail-readiness), distinct from Suggestions (which is the propose-only
 * queue for *your* Manual rules). Ports the legacy /marketing/advertising/recommendations logic
 * into the new cockpit and reskins it to the design system (light H10, image-free).
 *
 * Safety: there is no client dry-run — the apply endpoint hardcodes dryRun:false and the REAL
 * guard is the server-side 4-check write-gate (sandbox-default). So every apply is gated behind a
 * mode-aware confirm (Sandbox = simulated · Live = writes to Amazon), surfacing the account mode
 * from /summary. Per-action confirmation is the FBA-flip safety; the gate is the enforcement.
 *
 * Reads: GET /advertising/recommendations · /recommendations/brief · /alerts · /summary.
 * Writes: POST /advertising/recommendations/apply  { kind, payload }  (gated).
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, AlertTriangle, Check, X, ArrowUpRight, ChevronRight } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import { Modal } from '@/design-system/components/Modal'
import { Drawer } from '@/design-system/components/Drawer'
import { Tabs } from '@/design-system/components/Tabs'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { eur, eur2, pct, intl, roas as roasFmt } from '../_canvas/format'
import type { RecMetrics } from '@/app/_shared/ads-ui'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './recommendations.css'

type RecCategory = 'bid' | 'negative' | 'graduate' | 'budget' | 'sov' | 'retail'
type RecSeverity = 'high' | 'medium' | 'low'
interface Recommendation {
  id: string; category: RecCategory; severity: RecSeverity; title: string; detail: string
  estImpactCents: number; apply: { kind: string; payload: unknown } | null; metrics?: RecMetrics
}
interface RecResult {
  generatedAt: string; windowDays: number; counts: Record<RecCategory, number>
  potentialMonthlyImpactCents: number; recommendations: Recommendation[]
}
interface Alert { id: string; campaignId: string | null; campaignName: string; type: string; severity: string; message: string }

const CAT_LABEL: Record<RecCategory, string> = { bid: 'Bid', negative: 'Negative', graduate: 'Graduate', budget: 'Budget', sov: 'Share of voice', retail: 'Inventory' }
const CAT_DOT: Record<RecCategory, string> = { bid: '#1f6fde', negative: '#e5484d', graduate: '#067d62', budget: '#7c5cff', sov: '#0ea5e9', retail: '#d6336c' }
// Perpetua-style named strategies (left rail).
const STRATEGY: Array<{ key: RecCategory; label: string; blurb: string }> = [
  { key: 'budget', label: 'Budget Optimization', blurb: 'Raise out-of-budget winners, trim losers' },
  { key: 'bid', label: 'Bid Optimization', blurb: 'Move bids toward your target ACoS' },
  { key: 'negative', label: 'Negative Harvesting', blurb: 'Cut wasteful search terms' },
  { key: 'graduate', label: 'Keyword Graduation', blurb: 'Promote converting terms to exact' },
  { key: 'retail', label: 'Inventory Shortage', blurb: 'Pause ads for unsellable products' },
  { key: 'sov', label: 'Share of Voice', blurb: 'Outbid & cannibalization signals' },
]
const eurc = (cents?: number) => eur((cents ?? 0) / 100)

/** Compact metric-proof row — the numbers that justify a recommendation. Renders only what exists. */
function MetricRow({ m }: { m: RecMetrics }) {
  const cells: Array<[string, string | null]> = [
    ['Impr', m.impressions == null ? null : intl(m.impressions)],
    ['Clicks', m.clicks == null ? null : intl(m.clicks)],
    ['CTR', m.ctr == null ? null : pct(m.ctr)],
    ['Spend', m.spendCents == null ? null : eurc(m.spendCents)],
    ['Sales', m.salesCents == null ? null : eurc(m.salesCents)],
    ['Orders', m.orders == null ? null : intl(m.orders)],
    ['ACoS', m.acos == null ? null : pct(m.acos)],
    ['ROAS', m.roas == null ? null : roasFmt(m.roas)],
    ['CVR', m.cvr == null ? null : pct(m.cvr)],
  ]
  const shown = cells.filter(([, v]) => v != null)
  if (!shown.length) return null
  return (
    <div className="rec-metrics">
      {shown.map(([k, v]) => <span className="rec-metric" key={k}>{k} <b>{v}</b></span>)}
    </div>
  )
}

type Confirm = { kind: 'one'; rec: Recommendation } | { kind: 'all'; recs: Recommendation[] } | null

function RecommendationsInner() {
  const [data, setData] = useState<RecResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [brief, setBrief] = useState<{ tldr: string; modelUsed: string } | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [mode, setMode] = useState<string>('sandbox')
  const [cat, setCat] = useState<RecCategory | 'all'>('all')
  const [view, setView] = useState<'pending' | 'applied'>('pending')
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [detail, setDetail] = useState<Recommendation | null>(null)
  const { toast } = useToast()

  // Applied recs persist across reloads (rec ids are deterministic).
  useEffect(() => { try { const s = localStorage.getItem('ax.recs.applied'); if (s) setApplied(new Set(JSON.parse(s))) } catch { /* ignore */ } }, [])
  const persistApplied = (next: Set<string>) => { try { localStorage.setItem('ax.recs.applied', JSON.stringify([...next])) } catch { /* ignore */ } }

  const load = useCallback(() => {
    const base = getBackendUrl()
    setLoading(true)
    fetch(`${base}/api/advertising/recommendations`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
    setBrief(null)
    fetch(`${base}/api/advertising/recommendations/brief`, { cache: 'no-store' }).then((x) => x.json()).then(setBrief).catch(() => {})
    fetch(`${base}/api/advertising/alerts`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setAlerts(Array.isArray(r?.alerts) ? r.alerts : [])).catch(() => {})
    fetch(`${base}/api/advertising/summary`, { cache: 'no-store' }).then((x) => x.json()).then((s) => setMode(s?.mode ?? 'sandbox')).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  // Apply — POST { kind, payload }. The server-side write-gate decides simulate-vs-live.
  const apply = useCallback(async (r: Recommendation): Promise<boolean> => {
    if (!r.apply) return false
    setBusy(r.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/recommendations/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.apply),
      }).then((x) => x.json())
      if (res?.error) return false
      setApplied((s) => { const n = new Set(s).add(r.id); persistApplied(n); return n })
      return true
    } catch { return false } finally { setBusy(null) }
  }, [])

  const confirmApply = async () => {
    if (!confirm) return
    if (confirm.kind === 'one') {
      const ok = await apply(confirm.rec)
      toast(ok ? (mode === 'sandbox' ? 'Applied — simulated in sandbox' : 'Apply submitted — gated writes reach Amazon only where enabled') : 'Apply failed', ok ? 'success' : 'danger')
    } else {
      let ok = 0; let fail = 0
      for (const r of confirm.recs) { if (await apply(r)) ok++; else fail++ } // sequential — clean audit ordering
      toast(`${ok} applied${fail ? ` · ${fail} failed` : ''}${mode === 'sandbox' ? ' (simulated)' : ' (gated — live where enabled)'}`, fail ? 'danger' : 'success')
    }
    setConfirm(null)
  }

  const dismiss = (r: Recommendation) => {
    setDismissed((s) => new Set(s).add(r.id))
    setDetail(null)
    toast(<>Dismissed · <button type="button" className="rec-undo" onClick={() => setDismissed((s) => { const n = new Set(s); n.delete(r.id); return n })}>Undo</button></>, 'info')
  }

  const recs = (data?.recommendations ?? [])
    .filter((r) => !dismissed.has(r.id))
    .filter((r) => (view === 'applied' ? applied.has(r.id) : !applied.has(r.id)))
    .filter((r) => (cat === 'all' ? true : r.category === cat))
  const appliedCount = (data?.recommendations ?? []).filter((r) => applied.has(r.id)).length
  const pendingCount = (data?.recommendations.length ?? 0) - appliedCount
  const highPending = (data?.recommendations ?? []).filter((r) => r.severity === 'high' && r.apply && !applied.has(r.id) && !dismissed.has(r.id))

  return (
    <div className="rec">
      <AdsPageHeader
        title="Recommendations"
        subtitle="AI + rules ranked by € impact — bid moves, wasted-spend negatives, terms to promote, budget shifts. Account-wide across all markets."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showDateRange={false}
        showDataSync={false}
      />

      {mode === 'sandbox' ? (
        <div className="rec-banner">Sandbox mode — applies are simulated; nothing is sent to Amazon until live mode is enabled.</div>
      ) : (
        <div className="rec-banner rec-banner--live">Live mode is on — applies route through the per-connection &amp; per-campaign write-gate. Anything not explicitly enabled stays simulated.</div>
      )}

      {/* Alerts strip (AX2.12) */}
      {alerts.length > 0 && (
        <div className="rec-alerts">
          <div className="rec-alerts-h"><AlertTriangle size={13} /> {alerts.length} active alert{alerts.length > 1 ? 's' : ''}</div>
          {alerts.slice(0, 6).map((a) => (
            a.campaignId ? (
              <Link className="rec-alert" key={a.id} href={`/marketing/ads/campaigns/${a.campaignId}`}>
                <span className={`rec-sev rec-sev--${a.severity === 'high' ? 'high' : 'medium'}`} />
                <span className="rec-alert-name lnk">{a.campaignName}</span>
                <span className="rec-alert-msg">{a.message}</span>
              </Link>
            ) : (
              <div className="rec-alert" key={a.id}>
                <span className={`rec-sev rec-sev--${a.severity === 'high' ? 'high' : 'medium'}`} />
                <span className="rec-alert-name">{a.campaignName}</span>
                <span className="rec-alert-msg">{a.message}</span>
              </div>
            )
          ))}
          {alerts.length > 6 && <div className="rec-alerts-more">+{alerts.length - 6} more</div>}
        </div>
      )}

      {/* AI action brief */}
      <div className="rec-brief">
        <div className="rec-brief-h"><Sparkles size={12} /> AI action brief{brief?.modelUsed === 'rules-only' ? <span className="muted">· rules summary (set ANTHROPIC_API_KEY for AI)</span> : null}</div>
        <div className="rec-brief-t">{brief ? brief.tldr : 'Generating…'}</div>
      </div>

      {/* Summary tiles */}
      {data && (
        <div className="rec-tiles">
          <div className="rec-tile"><div className="rec-tile-k">Potential impact</div><div className="rec-tile-v ok">{eurc(data.potentialMonthlyImpactCents)}<small> /mo</small></div></div>
          <div className="rec-tile"><div className="rec-tile-k">Total actions</div><div className="rec-tile-v">{intl(data.recommendations.length)}</div></div>
          {highPending.length > 0 && (
            <Button className="rec-applyall" variant="primary" size="sm" onClick={() => setConfirm({ kind: 'all', recs: highPending })}>
              Apply all high-priority ({highPending.length})
            </Button>
          )}
        </div>
      )}

      {/* Pending / Applied */}
      <Tabs
        tabs={[{ id: 'pending', label: `Pending (${pendingCount})` }, { id: 'applied', label: `Applied (${appliedCount})` }]}
        active={view}
        onChange={(id) => setView(id as 'pending' | 'applied')}
      />

      {/* Strategy rail + card deck */}
      <div className="rec-layout">
        <aside className="rec-rail">
          <div className="rec-rail-h">Strategies</div>
          <button type="button" className={`rec-strat${cat === 'all' ? ' on' : ''}`} onClick={() => setCat('all')}>
            <div className="rec-strat-top">
              <span className="rec-strat-label"><span>All recommendations</span></span>
              <span className="rec-strat-count">{data?.recommendations.length ?? 0}</span>
            </div>
          </button>
          {STRATEGY.map((s) => {
            const n = data?.counts?.[s.key] ?? 0
            return (
              <button type="button" key={s.key} className={`rec-strat${cat === s.key ? ' on' : ''}`} disabled={n === 0} onClick={() => setCat(s.key)}>
                <div className="rec-strat-top">
                  <span className="rec-strat-label"><span className="rec-dot" style={{ background: CAT_DOT[s.key] }} /><span>{s.label}</span></span>
                  <span className={`rec-strat-count${n ? '' : ' zero'}`}>{n}</span>
                </div>
                <div className="rec-strat-blurb">{s.blurb}</div>
              </button>
            )
          })}
        </aside>

        <div className="rec-deck">
          {recs.length === 0 && (
            <div className="rec-empty">{loading ? 'Loading…' : view === 'applied' ? 'Nothing applied yet — apply a recommendation and it moves here.' : 'Nothing to act on here — pick another strategy, or your account is well-tuned.'}</div>
          )}
          {recs.map((r) => {
            const done = applied.has(r.id)
            const actionable = !!r.apply
            return (
              <div key={r.id} className={`rec-card${done ? ' done' : ''}${actionable ? ' click' : ''}`} onClick={actionable ? () => setDetail(r) : undefined}>
                <span className="rec-card-dot" style={{ background: CAT_DOT[r.category] }} />
                <div className="rec-card-main">
                  <div className="rec-card-top">
                    <span className={`rec-sevchip rec-sevchip--${r.severity}`}>{r.severity}</span>
                    <span className="rec-cat">{CAT_LABEL[r.category]}</span>
                    <span className="rec-title">{r.title}</span>
                  </div>
                  <div className="rec-detail">{r.detail}</div>
                  {r.metrics && <MetricRow m={r.metrics} />}
                </div>
                {r.category !== 'sov' && r.estImpactCents > 0 && <span className="rec-impact">{eurc(r.estImpactCents)}</span>}
                <div className="rec-acts" onClick={(e) => e.stopPropagation()}>
                  {actionable ? (
                    done ? (
                      <span className="rec-applied"><Check size={14} /> Applied</span>
                    ) : (
                      <>
                        <button type="button" className="rec-iconbtn apply" disabled={busy === r.id} title="Apply" onClick={() => setConfirm({ kind: 'one', rec: r })}>{busy === r.id ? '…' : <Check size={14} />}</button>
                        <button type="button" className="rec-iconbtn" title="Dismiss" onClick={() => dismiss(r)}><X size={14} /></button>
                      </>
                    )
                  ) : (
                    <>
                      <span className="rec-review"><ArrowUpRight size={12} /> Review</span>
                      <button type="button" className="rec-iconbtn" title="Dismiss" onClick={() => dismiss(r)}><X size={14} /></button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Per-action confirm — shows the diff + live account mode (the gate is server-side) */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'all' ? 'Apply all high-priority' : 'Apply recommendation'}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" className={mode === 'sandbox' ? undefined : 'rec-btn-live'} size="sm" disabled={!!busy} onClick={confirmApply}>
              {mode === 'sandbox' ? 'Apply in sandbox' : 'Apply'}
            </Button>
          </>
        }
      >
        {confirm?.kind === 'one' && (
          <div className="rec-confirm-rec">
            <div className="rec-confirm-title">{confirm.rec.title}</div>
            <div className="rec-confirm-detail">{confirm.rec.detail}</div>
          </div>
        )}
        {confirm?.kind === 'all' && (
          <ul className="rec-confirm-list">
            {confirm.recs.map((r) => (
              <li className="rec-confirm-li" key={r.id}>
                <span className="rec-card-dot" style={{ background: CAT_DOT[r.category], marginTop: 0 }} />
                <b>{r.title}</b>
                <span className="rec-impact">{r.estImpactCents > 0 ? eurc(r.estImpactCents) : ''}</span>
              </li>
            ))}
          </ul>
        )}
        <div className={`rec-mode rec-mode--${mode === 'sandbox' ? 'sandbox' : 'live'}`}>
          {mode === 'sandbox'
            ? <><b>Sandbox.</b> This is simulated — nothing is sent to Amazon.</>
            : <><AlertTriangle size={14} /> <span><b>Live mode.</b> This routes through the write-gate — it reaches Amazon only for connections &amp; campaigns you&rsquo;ve enabled, and stays simulated otherwise.</span></>}
        </div>
      </Modal>

      {/* Detail drawer — provenance + full metric proof (read-only; apply from the card) */}
      {detail && (
        <Drawer
          open
          onClose={() => setDetail(null)}
          title={<span className="rec-dh"><Tag tone="neutral">{CAT_LABEL[detail.category]}</Tag> {detail.title}</span>}
          footer={
            <div className="rec-dfoot">
              <span className="grow" />
              <Button variant="secondary" size="sm" onClick={() => dismiss(detail)}><X size={14} /> Dismiss</Button>
              {detail.apply && !applied.has(detail.id) && (
                <Button variant="primary" size="sm" onClick={() => { setConfirm({ kind: 'one', rec: detail }); setDetail(null) }}><Check size={14} /> Apply</Button>
              )}
              {applied.has(detail.id) && <span className="rec-applied"><Check size={14} /> Applied</span>}
            </div>
          }
        >
          <div className="rec-flow">
            <div className="rec-fnode"><span className="ey">Signal</span><span className="ti">{CAT_LABEL[detail.category]} · {detail.severity} severity</span></div>
            <span className="rec-fconn" />
            <div className="rec-fnode"><span className="ey">Engine</span><span className="ti">{STRATEGY.find((s) => s.key === detail.category)?.label ?? CAT_LABEL[detail.category]}</span><span className="sub">{STRATEGY.find((s) => s.key === detail.category)?.blurb}</span></div>
            <span className="rec-fconn" />
            <div className="rec-fnode"><span className="ey">Proposed action</span><span className="ti">{detail.title}</span><span className="sub">{detail.detail}</span></div>
            {detail.category !== 'sov' && detail.estImpactCents > 0 && (
              <>
                <span className="rec-fconn" />
                <div className="rec-fnode"><span className="ey">Estimated impact</span><span className="ti">{eur2(detail.estImpactCents / 100)} <ChevronRight size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> potential / month</span></div>
              </>
            )}
          </div>
          {detail.metrics && (
            <div className="rec-dmetrics">
              <div className="rec-dmetrics-h">Supporting metrics</div>
              <div className="rec-dgrid">
                {([
                  ['Impressions', detail.metrics.impressions == null ? null : intl(detail.metrics.impressions)],
                  ['Clicks', detail.metrics.clicks == null ? null : intl(detail.metrics.clicks)],
                  ['CTR', detail.metrics.ctr == null ? null : pct(detail.metrics.ctr)],
                  ['Spend', detail.metrics.spendCents == null ? null : eurc(detail.metrics.spendCents)],
                  ['Sales', detail.metrics.salesCents == null ? null : eurc(detail.metrics.salesCents)],
                  ['Orders', detail.metrics.orders == null ? null : intl(detail.metrics.orders)],
                  ['ACoS', detail.metrics.acos == null ? null : pct(detail.metrics.acos)],
                  ['ROAS', detail.metrics.roas == null ? null : roasFmt(detail.metrics.roas)],
                  ['CVR', detail.metrics.cvr == null ? null : pct(detail.metrics.cvr)],
                ] as Array<[string, string | null]>).filter(([, v]) => v != null).map(([k, v]) => (
                  <div className="rec-dcell" key={k}><div className="rec-dcell-k">{k}</div><div className="rec-dcell-v">{v}</div></div>
                ))}
              </div>
            </div>
          )}
        </Drawer>
      )}
    </div>
  )
}

/** Ads routes are standalone (AppShell) and sit outside the root ToastProvider — provide one here. */
export function RecommendationsClient() {
  return (
    <ToastProvider>
      <RecommendationsInner />
    </ToastProvider>
  )
}
