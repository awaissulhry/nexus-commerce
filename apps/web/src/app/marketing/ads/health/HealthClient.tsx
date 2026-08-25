'use client'

/**
 * E4 — Alerts & Health. One dedicated surface unifying the account's health signals that were
 * previously unsurfaced or scattered: live alerts (/alerts), retail-readiness (out-of-stock /
 * lost-Buy-Box wasted spend), automation-fleet health, and budget enforcement — plus a
 * transparent rolled-up Health Score. Read-only: every row drills through to the campaign to act.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Package, Bot, ChevronRight, ShieldCheck } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { ProbePanel } from './ProbePanel'
import { getBackendUrl } from '@/lib/backend-url'
import { FilterChip } from '@/design-system/primitives'
import { Card } from '@/design-system/components'
import { intl } from '../_canvas/format'
import './health.css'

type AlertType = 'acos_breach' | 'zero_sales' | 'spend_spike' | 'sales_drop'
interface Alert { id: string; campaignId: string | null; campaignName: string; type: AlertType; severity: 'high' | 'medium'; message: string }
interface AlertsResult { alerts: Alert[]; counts: Record<AlertType, number> }
interface RetailRow { campaignId: string; name: string; marketplace: string | null; status: string; products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; verdict: 'pause' | 'watch' | 'ok'; reason: string }
interface Retail { campaigns: RetailRow[]; summary: { pause: number; watch: number; ok: number; atRiskSpendNote?: string } }
interface Automation { rules: { total: number; live: number; dryRun: number; disabled: number }; executions30d: { total: number; failed: number; success: number; dryRun: number }; successRatePct: number; estTimeSavedHours: number; risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean } }
interface Budget { totals: { suppressing: number; plans: number } }
interface Summary { agedSkusFlagged?: number; mode?: string }

const ALERT_LABEL: Record<AlertType, string> = { acos_breach: 'ACoS breach', zero_sales: 'Zero sales', spend_spike: 'Spend spike', sales_drop: 'Sales drop' }
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n))

interface Factor { text: string; pts: number; dot: string }

function computeHealth(a: AlertsResult | null, r: Retail | null, au: Automation | null, b: Budget | null, s: Summary | null) {
  const factors: Factor[] = []
  const high = (a?.alerts ?? []).filter((x) => x.severity === 'high').length
  const med = (a?.alerts ?? []).filter((x) => x.severity === 'medium').length
  const pause = r?.summary?.pause ?? 0
  const suppressing = b?.totals?.suppressing ?? 0
  const aged = s?.agedSkusFlagged ?? 0
  if (high) factors.push({ text: `${high} high-severity alert${high > 1 ? 's' : ''}`, pts: clamp(high * 6, 30), dot: '#e5484d' })
  if (med) factors.push({ text: `${med} medium alert${med > 1 ? 's' : ''}`, pts: clamp(med * 2, 15), dot: '#b87503' })
  if (pause) factors.push({ text: `${pause} campaign${pause > 1 ? 's' : ''} advertising only out-of-stock products`, pts: clamp(pause * 5, 25), dot: '#e5484d' })
  if (au?.risks?.noManaging) factors.push({ text: 'No live automation managing the account', pts: 8, dot: '#b87503' })
  if ((au?.risks?.recentFailures ?? 0) > 100) factors.push({ text: `${intl(au!.risks.recentFailures)} recent automation failures`, pts: 7, dot: '#e5484d' })
  if (suppressing) factors.push({ text: `${suppressing} campaign${suppressing > 1 ? 's' : ''} budget-suppressed`, pts: clamp(suppressing * 3, 15), dot: '#b87503' })
  if (aged) factors.push({ text: `${aged} aged-inventory SKU${aged > 1 ? 's' : ''} flagged`, pts: clamp(aged * 2, 10), dot: '#b87503' })
  const penalty = factors.reduce((sum, f) => sum + f.pts, 0)
  const score = Math.max(0, 100 - penalty)
  // A score of 100 has to MEAN something. It is computed by subtracting penalties from the four
  // signal sources, so when none of them answered there are no penalties and the arithmetic says
  // 100 — "Healthy" for an account nothing is known about. `scored` is what separates "we looked
  // and found nothing wrong" from "we could not look".
  const scored = a != null || r != null || au != null || b != null
  return { score, scored, factors, high, med, pause, suppressing }
}

/**
 * An error RESPONSE is not data. Every one of these five endpoints answers a 401 or a 500 with a
 * perfectly valid JSON body — `{ error: 'Access denied', code: 'unauthenticated' }` — so
 * `r.json()` resolves and the old `.catch(() => null)` never fired: the error object was stored
 * as if it were the payload. `!au` then read as truthy and `au.rules.live` threw, taking the
 * whole page to the error boundary ("Cannot read properties of undefined (reading 'live')").
 *
 * Checking `r.ok` first is what makes every `?? null` guard on this page true again: a refused or
 * broken endpoint now renders its own empty state and the other four still draw.
 */
function readJson<T>(url: string): Promise<T | null> {
  return fetch(url, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null)
}

const band = (score: number) => (score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor')
const bandLabel = (score: number) => (score >= 80 ? 'Healthy' : score >= 50 ? 'Needs attention' : 'At risk')

export function HealthClient() {
  const [market, setMarket] = useState('all')
  const [markets, setMarkets] = useState<string[]>([])
  const [windowDays, setWindowDays] = useState(7)
  const [alerts, setAlerts] = useState<AlertsResult | null>(null)
  const [retail, setRetail] = useState<Retail | null>(null)
  const [automation, setAutomation] = useState<Automation | null>(null)
  const [budget, setBudget] = useState<Budget | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [sevFilter, setSevFilter] = useState<'all' | 'high' | 'medium'>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | AlertType>('all')

  useEffect(() => {
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setMarkets(Array.from(new Set((d.items ?? []).map((c: { marketplace?: string }) => c.marketplace).filter(Boolean))).sort() as string[])).catch(() => {})
  }, [])

  const load = useCallback((mk: string, win: number) => {
    const base = getBackendUrl()
    const mp = mk === 'all' ? '' : `&marketplace=${mk}`
    setLoading(true)
    Promise.all([
      readJson<AlertsResult>(`${base}/api/advertising/alerts?windowDays=${win}${mp}`),
      readJson<Retail>(`${base}/api/advertising/retail-readiness`),
      readJson<Automation>(`${base}/api/advertising/automation-health`),
      readJson<Budget>(`${base}/api/advertising/budget-manager/enforcement`),
      readJson<Summary>(`${base}/api/advertising/summary`),
    ]).then(([a, r, au, b, s]) => {
      setAlerts(a); setRetail(r); setAutomation(au); setBudget(b); setSummary(s); setLoading(false)
    })
  }, [])
  useEffect(() => { load(market, windowDays) }, [load, market, windowDays])

  const { score, scored, factors } = computeHealth(alerts, retail, automation, budget, summary)
  // Retail is account-wide from the endpoint → filter to the chosen market client-side.
  const retailRows = (retail?.campaigns ?? []).filter((c) => c.verdict !== 'ok').filter((c) => market === 'all' || c.marketplace === market)
    .sort((a, b) => (a.verdict === 'pause' ? -1 : 1) - (b.verdict === 'pause' ? -1 : 1))
  const alertRows = (alerts?.alerts ?? [])
    .filter((a) => sevFilter === 'all' || a.severity === sevFilter)
    .filter((a) => typeFilter === 'all' || a.type === typeFilter)
  const totalAlerts = alerts?.alerts?.length ?? 0
  const au = automation

  return (
    <div className="hl">
      <AdsPageHeader
        title="Alerts & Health"
        subtitle="Everything going wrong right now — alerts, wasted spend, automation, budget — with a rolled-up score."
        markets={markets} market={market} onMarketChange={setMarket}
        showDateRange={false} showDataSync={false}
      />

      <div className="hl-toolbar">
        <span className="hl-win">
          {[7, 14, 30].map((w) => (
            <button key={w} type="button" className={windowDays === w ? 'on' : ''} onClick={() => setWindowDays(w)}>{w}d</button>
          ))}
        </span>
        <span className="hl-tile-sub muted">Window applies to alerts; retail/automation are 30-day.</span>
      </div>

      {/* Hero — health score + transparent factors */}
      <div className="hl-hero">
        <div className="hl-score">
          <div className={`hl-score-num hl-${loading || !scored ? 'none' : band(score)}`}>{loading || !scored ? '—' : score}<small>/100</small></div>
          <div className={`hl-score-lbl bg hl-${loading || !scored ? 'none' : band(score)}`}>{loading ? 'Loading' : scored ? bandLabel(score) : 'No data'}</div>
        </div>
        <div className="hl-factors">
          <div className="hl-factors-h">What’s affecting the score</div>
          {loading ? <span className="hl-tile-sub muted">Loading…</span>
            : !scored ? <span className="hl-tile-sub muted">None of the health endpoints answered — this is not a clean bill of health, it is no reading at all.</span>
            : factors.length === 0 ? <span className="hl-allclear"><ShieldCheck size={14} style={{ verticalAlign: 'middle' }} /> All clear — no active health issues.</span>
              : factors.map((f, i) => (
                <div className="hl-factor" key={i}>
                  <span className="hl-factor-dot" style={{ background: f.dot }} />
                  <span className="hl-factor-txt">{f.text}</span>
                  <span className="hl-factor-pts">−{f.pts}</span>
                </div>
              ))}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="hl-tiles">
        <Card className="hl-tile" onClick={() => document.getElementById('hl-alerts')?.scrollIntoView({ behavior: 'smooth' })}>
          <div className="hl-tile-k">Active alerts</div>
          <div className="hl-tile-v">{loading ? '…' : alerts == null ? '—' : totalAlerts}</div>
          <div className={`hl-tile-sub ${alerts == null ? 'muted' : (alerts.alerts ?? []).some((a) => a.severity === 'high') ? 'danger' : totalAlerts ? 'warn' : 'ok'}`}>{alerts == null ? 'not loaded' : `${alerts.alerts.filter((a) => a.severity === 'high').length} high · ${alerts.alerts.filter((a) => a.severity === 'medium').length} medium`}</div>
        </Card>
        <Card className="hl-tile" onClick={() => document.getElementById('hl-retail')?.scrollIntoView({ behavior: 'smooth' })}>
          <div className="hl-tile-k">Wasted spend (retail)</div>
          <div className="hl-tile-v">{loading ? '…' : retail == null ? '—' : retail.summary?.pause ?? 0}</div>
          <div className={`hl-tile-sub ${retail == null ? 'muted' : (retail.summary?.pause ?? 0) ? 'danger' : 'ok'}`}>{retail == null ? 'not loaded' : `${retail.summary?.pause ?? 0} pause · ${retail.summary?.watch ?? 0} watch`}</div>
        </Card>
        <Card className="hl-tile" onClick={() => document.getElementById('hl-auto')?.scrollIntoView({ behavior: 'smooth' })}>
          <div className="hl-tile-k">Automation</div>
          <div className="hl-tile-v">{loading ? '…' : au == null ? '—' : `${au.rules.live}/${au.rules.total}`}</div>
          <div className={`hl-tile-sub ${au == null ? 'muted' : au.risks.noManaging ? 'warn' : 'ok'}`}>{au == null ? 'not loaded' : au.risks.noManaging ? 'no live rules managing' : 'live rules active'}</div>
        </Card>
        <Card className="hl-tile" onClick={() => document.getElementById('hl-auto')?.scrollIntoView({ behavior: 'smooth' })}>
          <div className="hl-tile-k">Budget-suppressed</div>
          <div className="hl-tile-v">{loading ? '…' : budget == null ? '—' : budget.totals?.suppressing ?? 0}</div>
          <div className={`hl-tile-sub ${budget == null ? 'muted' : (budget.totals?.suppressing ?? 0) ? 'warn' : 'ok'}`}>{budget == null ? 'not loaded' : (budget.totals?.suppressing ?? 0) ? 'delivery capped' : 'none capped'}</div>
        </Card>
      </div>

      {/* Alerts */}
      <div className="hl-section" id="hl-alerts">
        <div className="hl-sec-h"><AlertTriangle size={15} /> Active alerts <span className="hl-chip">{alerts == null ? '—' : totalAlerts}</span><span className="grow" />
          <span className="hl-filters">
            {(['all', 'high', 'medium'] as const).map((s) => (
              <FilterChip key={s} pressed={sevFilter === s} onClick={() => setSevFilter(s)}>{s === 'all' ? 'All' : s}</FilterChip>
            ))}
            {(['acos_breach', 'zero_sales', 'spend_spike', 'sales_drop'] as const).map((t) => (
              <FilterChip
                key={t}
                pressed={typeFilter === t}
                disabled={!(alerts?.counts?.[t])}
                count={alerts?.counts?.[t] || undefined}
                onClick={() => setTypeFilter(typeFilter === t ? 'all' : t)}
              >{ALERT_LABEL[t]}</FilterChip>
            ))}
          </span>
        </div>
        {alertRows.length === 0 ? (
          <div className="hl-empty">{loading ? 'Loading…'
            : alerts == null ? 'The alerts endpoint did not answer — no alerts could be read, which is not the same as none existing.'
            : totalAlerts === 0 ? 'No active alerts — all clear.' : 'No alerts match this filter.'}</div>
        ) : (
          <div className="hl-rows">
            {alertRows.map((a) => (
              a.campaignId ? (
                <Link className="hl-row lnk" key={a.id} href={`/marketing/ads/campaigns/${a.campaignId}`}>
                  <span className={`hl-sev hl-sev--${a.severity}`} />
                  <span className={`hl-atype hl-atype--${a.type}`}>{ALERT_LABEL[a.type]}</span>
                  <span className="hl-name">{a.campaignName}</span>
                  <span className="hl-msg">{a.message}</span>
                  <ChevronRight className="hl-arrow" size={15} />
                </Link>
              ) : (
                <div className="hl-row" key={a.id}>
                  <span className={`hl-sev hl-sev--${a.severity}`} />
                  <span className={`hl-atype hl-atype--${a.type}`}>{ALERT_LABEL[a.type]}</span>
                  <span className="hl-name">{a.campaignName}</span>
                  <span className="hl-msg">{a.message}</span>
                </div>
              )
            ))}
          </div>
        )}
      </div>

      {/* Retail-readiness */}
      <div className="hl-section" id="hl-retail">
        <div className="hl-sec-h"><Package size={15} /> Retail-readiness <span className="hl-chip">{retail == null ? '—' : retailRows.length}</span><span className="grow" />
          {retail?.summary?.atRiskSpendNote && <span className="hl-tile-sub danger">{retail.summary.atRiskSpendNote}</span>}
        </div>
        {retailRows.length === 0 ? (
          <div className="hl-empty">{loading ? 'Loading…'
            : retail == null ? 'The retail-readiness endpoint did not answer — stock and Buy Box could not be checked.'
            : 'Every advertised product is sellable — no wasted spend.'}</div>
        ) : (
          <div className="hl-rows">
            {retailRows.map((c) => (
              <Link className="hl-row lnk" key={c.campaignId} href={`/marketing/ads/campaigns/${c.campaignId}`}>
                <span className={`hl-sev hl-sev--${c.verdict}`} />
                <span className={`hl-atype hl-atype--${c.verdict}`}>{c.verdict}</span>
                <span className="hl-name">{c.name}</span>
                {c.marketplace && <span className="hl-mkt">{c.marketplace}</span>}
                <span className="hl-msg">{c.reason}</span>
                <ChevronRight className="hl-arrow" size={15} />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Automation health */}
      <div className="hl-section" id="hl-auto">
        <div className="hl-sec-h"><Bot size={15} /> Automation health</div>
        {loading || !au ? (
          <div className="hl-empty">{loading ? 'Loading…' : 'No automation data.'}</div>
        ) : (
          <>
            <div className="hl-auto">
              <div className="hl-metric"><div className="hl-metric-k">Rules (live / total)</div><div className="hl-metric-v">{au.rules.live}/{au.rules.total}</div></div>
              <div className="hl-metric"><div className="hl-metric-k">Executions 30d</div><div className="hl-metric-v">{intl(au.executions30d.total)}</div></div>
              <div className="hl-metric"><div className="hl-metric-k">Success rate</div><div className={`hl-metric-v ${au.successRatePct >= 80 ? 'ok' : 'danger'}`}>{au.successRatePct}%</div></div>
              <div className="hl-metric"><div className="hl-metric-k">Est. time saved</div><div className="hl-metric-v">{Math.round(au.estTimeSavedHours)}h</div></div>
            </div>
            {(au.risks.noManaging || au.risks.recentFailures > 0 || au.risks.stuckInDryRun > 0) && (
              <div className="hl-risk"><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {au.risks.noManaging && <><b>No live rules are managing the account.</b> {au.rules.dryRun} are stuck in dry-run. </>}
                  {au.risks.recentFailures > 0 && <><b>{intl(au.risks.recentFailures)}</b> executions failed recently (mostly daily-cap). </>}
                  Review in Rules &amp; Automation.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ACR.6 (R12) — the only surface that answers "is it us or is it them" with evidence.
          Last, and collapsed: diagnostics, not a daily view. */}
      <ProbePanel />
    </div>
  )
}
