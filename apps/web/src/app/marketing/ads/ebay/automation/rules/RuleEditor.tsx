'use client'

/**
 * ER3.2 (deltas 3/4/5) — the routed rule editor: condition-stack builder with
 * per-row windows (+ exclude-recent honesty), absolute OR benchmark×multiplier
 * values (account avg / campaign avg / break-even), scope-filtered actions,
 * campaign binding, live dry-run preview against the real evaluator. Writes
 * rule DEFINITIONS only — eBay state never changes from here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, X } from 'lucide-react'
import '../../ebay.css'
import { H10Select } from '../../../campaigns/FilterDropdown'
import { getEbayAds, postEbayAds } from '../../_lib'
import {
  type AutomationRule, type RuleCondition, type RuleTrigger, type RuleActionDef, type RuleTemplate, type RuleVersionRow,
  METRIC_LABELS, OP_LABELS, BENCH_LABELS, ACTIONS_FOR_SCOPE, ACTION_LABELS, CENTS_METRICS, PCT_METRICS,
  type RuleMetric, type RuleOp, type RuleBenchmark, conditionSentence, actionSentence, conditionValueLabel,
} from '../_lib/rules'

interface CampaignLite { id: string; name: string; marketplace: string; fundingModel: string; status: string }
interface PreviewOut { evaluated: number; matched: number; samples: Array<{ kind: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string }; from: unknown; to: unknown }> }

const MARKETS = ['EBAY_IT', 'EBAY_DE', 'EBAY_FR', 'EBAY_ES']
const BENCH_FOR = (scope: RuleTrigger['scope'], metric: RuleMetric): RuleBenchmark[] => {
  if (metric === 'rate_minus_breakeven') return []
  const base: RuleBenchmark[] = ['account_avg', 'campaign_avg']
  if (scope === 'CPS_AD' && (metric === 'acos_pct' || metric === 'fee_pct_of_sales')) base.push('break_even')
  return base
}

/** UI value ↔ wire threshold (cents metrics take € in the editor) */
const toWire = (m: RuleMetric, v: number): number => (CENTS_METRICS.includes(m) ? Math.round(v * 100) : v)
const fromWire = (m: RuleMetric, v: number | undefined): string => (v == null ? '' : String(CENTS_METRICS.includes(m) ? v / 100 : v))
const unitFor = (m: RuleMetric): string => (CENTS_METRICS.includes(m) ? '€' : PCT_METRICS.includes(m) ? '%' : m === 'rate_minus_breakeven' ? 'pts' : '')

export function RuleEditor({ ruleId, template, fromRuleId }: { ruleId?: string; template?: string; fromRuleId?: string }) {
  const router = useRouter()
  const isEdit = !!ruleId
  const [name, setName] = useState('')
  const [marketplace, setMarketplace] = useState<string | null>('EBAY_IT')
  const [scopeIds, setScopeIds] = useState<string[]>([])
  const [trigger, setTrigger] = useState<RuleTrigger>({ scope: 'CPS_AD', all: [{ metric: 'acos_pct', windowDays: 14, op: 'gt', threshold: 25, excludeRecentDays: 3 }] })
  const [action, setAction] = useState<RuleActionDef>({ type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 })
  const [cooldownHours, setCooldownHours] = useState(24)
  const [enabled, setEnabled] = useState<boolean | null>(null) // edit only; shown, not toggled here
  const [templates, setTemplates] = useState<RuleTemplate[]>([])
  const [campaigns, setCampaigns] = useState<CampaignLite[]>([])
  const [preview, setPreview] = useState<PreviewOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(!isEdit && !fromRuleId)
  // ER5 — immutable config history (edit mode only; fetched on expand)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<RuleVersionRow[] | null>(null)
  const [currentVersion, setCurrentVersion] = useState<number | null>(null)

  const applyRule = useCallback((r: { name: string; marketplace?: string | null; scope?: { campaignIds?: string[] } | null; trigger: RuleTrigger; action: RuleActionDef; cooldownHours: number }, rename?: string) => {
    setName(rename ?? r.name)
    setMarketplace(r.marketplace ?? null)
    setScopeIds(r.scope?.campaignIds ?? [])
    setTrigger(structuredClone(r.trigger))
    setAction(structuredClone(r.action))
    setCooldownHours(r.cooldownHours)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [tpl, camps] = await Promise.all([
          getEbayAds<{ templates: RuleTemplate[] }>('/automation/rules/templates'),
          getEbayAds<{ campaigns: CampaignLite[] }>('/campaigns?preset=last30'),
        ])
        setTemplates(tpl.templates)
        setCampaigns(camps.campaigns)
        if (ruleId) {
          const r = await getEbayAds<AutomationRule>(`/automation/rules/${ruleId}`)
          applyRule(r); setEnabled(r.enabled); setCurrentVersion(r.version ?? null); setLoaded(true)
        } else if (fromRuleId) {
          const r = await getEbayAds<AutomationRule>(`/automation/rules/${fromRuleId}`)
          applyRule(r, `${r.name} (copy)`); setLoaded(true)
        } else if (template) {
          const t = tpl.templates.find((x) => x.name === template)
          if (t) applyRule({ ...t, marketplace: 'EBAY_IT', scope: null })
        }
      } catch (e) { setError((e as Error).message); setLoaded(true) }
    })()
  }, [ruleId, fromRuleId, template, applyRule])

  const wireBody = useMemo(() => ({
    name: name.trim(),
    trigger,
    action,
    scope: scopeIds.length ? { campaignIds: scopeIds } : null,
    marketplace,
    cooldownHours,
  }), [name, trigger, action, scopeIds, marketplace, cooldownHours])

  const suggestedName = useMemo(() => {
    const c0 = trigger.all[0]
    if (!c0) return ''
    return `${ACTION_LABELS[action.type]} — ${METRIC_LABELS[c0.metric]} ${OP_LABELS[c0.op]} ${conditionValueLabel(c0)} (${c0.windowDays}d)`
  }, [trigger, action])

  const eligibleCampaigns = useMemo(() => {
    const fm = trigger.scope === 'CPS_AD' ? 'COST_PER_SALE' : 'COST_PER_CLICK'
    return campaigns.filter((c) => c.fundingModel === fm && (!marketplace || c.marketplace === marketplace))
  }, [campaigns, trigger.scope, marketplace])

  const setCond = (i: number, patch: Partial<RuleCondition>) => {
    setTrigger((t) => ({ ...t, all: t.all.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
    setPreview(null)
  }
  const switchScope = (scope: RuleTrigger['scope']) => {
    setTrigger((t) => ({ scope, all: t.all.map((c) => (c.benchmark === 'break_even' && scope !== 'CPS_AD' ? { ...c, benchmark: undefined, threshold: c.threshold ?? 25 } : c)) }))
    setAction((a) => (ACTIONS_FOR_SCOPE[scope].includes(a.type) ? a : scope === 'CPS_AD' ? { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 } : { type: 'pause_keyword' }))
    setScopeIds([])
    setPreview(null)
  }

  const loadHistory = async () => {
    setHistoryOpen((o) => !o)
    if (history == null && ruleId) {
      try { setHistory((await getEbayAds<{ versions: RuleVersionRow[] }>(`/automation/rules/${ruleId}/versions`)).versions) }
      catch (e) { setError((e as Error).message) }
    }
  }
  const restoreVersion = async (v: number) => {
    if (!ruleId) return
    setBusy(true); setError(null)
    try {
      await postEbayAds(`/automation/rules/${ruleId}/revert`, { toVersion: v })
      const r = await getEbayAds<AutomationRule>(`/automation/rules/${ruleId}`)
      applyRule(r); setEnabled(r.enabled); setCurrentVersion(r.version ?? null)
      setHistory((await getEbayAds<{ versions: RuleVersionRow[] }>(`/automation/rules/${ruleId}/versions`)).versions)
      setPreview(null)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const doPreview = async () => {
    setBusy(true); setError(null)
    try { setPreview(await postEbayAds<PreviewOut>('/automation/rules/preview', wireBody)) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const doSave = async () => {
    setBusy(true); setError(null)
    try {
      if (isEdit) await postEbayAds(`/automation/rules/${ruleId}`, wireBody)
      else await postEbayAds('/automation/rules', wireBody)
      router.push('/marketing/ads/ebay/automation')
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  if (!loaded) return <div className="h10-rules-page"><div className="h10-am-card" style={{ padding: 24 }}><p className="eb-be-hint">Loading rule…</p></div></div>

  return (
    <div className="h10-rules-page eb-rule-editor eb-root">
      <div className="eb-editor-head">
        <Link href="/marketing/ads/ebay/automation" className="h10-am-link">← Rules &amp; Automation</Link>
        <h2>{isEdit ? 'Edit rule' : 'New rule'}</h2>
        {isEdit && enabled != null && <span className={`h10-pill ${enabled ? 'ok' : 'arch'}`}>{enabled ? 'enabled' : 'disabled'}</span>}
        <span className="eb-chip">{trigger.scope === 'CPS_AD' ? 'CPS ads' : 'CPC keywords'}</span>
      </div>

      {!isEdit && !fromRuleId && templates.length > 0 && (
        <div className="eb-tpl-row" aria-label="Templates">
          <span className="eb-be-hint">Start from:</span>
          {templates.map((t) => (
            <button key={t.name} type="button" className={`eb-kind-chip ${template === t.name ? 'on' : ''}`}
              onClick={() => applyRule({ ...t, marketplace: 'EBAY_IT', scope: null })}>{t.name}</button>
          ))}
        </div>
      )}

      <section className="h10-cd-sec">
        <h3>Name</h3>
        <div className="eb-form-row">
          <div style={{ flex: 1, minWidth: 280 }}>
            <input className="h10-cd-input" style={{ width: '100%' }} maxLength={80} value={name} placeholder="e.g. Fee creep-down (IT)" onChange={(e) => setName(e.target.value)} />
          </div>
          {suggestedName && !name && (
            <button type="button" className="eb-kind-chip" title="Use the suggested name" onClick={() => setName(suggestedName.slice(0, 80))}>{suggestedName}</button>
          )}
        </div>
      </section>

      <section className="h10-cd-sec">
        <h3>Scope</h3>
        <div className="eb-form-row">
          <div><label>Entities</label>
            <div className="eb-posture-dial">
              <button type="button" className={`h10-am-btn ${trigger.scope === 'CPS_AD' ? 'on' : ''}`} onClick={() => switchScope('CPS_AD')}>CPS ads</button>
              <button type="button" className={`h10-am-btn ${trigger.scope === 'CPC_KEYWORD' ? 'on' : ''}`} onClick={() => switchScope('CPC_KEYWORD')}>CPC keywords</button>
            </div>
          </div>
          <div><label>Marketplace</label>
            <span className="eb-dd dense"><H10Select ariaLabel="Marketplace" width={190} value={marketplace ?? ''} onChange={(v) => { setMarketplace(v || null); setPreview(null) }}
              options={[{ value: '', label: 'All eBay markets' }, ...MARKETS.map((m) => ({ value: m, label: m }))]} /></span>
          </div>
          <div><label>Campaigns</label>
            <div className="eb-posture-dial">
              <button type="button" className={`h10-am-btn ${scopeIds.length === 0 ? 'on' : ''}`} onClick={() => { setScopeIds([]); setPreview(null) }}>Global</button>
              <button type="button" className={`h10-am-btn ${scopeIds.length > 0 ? 'on' : ''}`} title="Bind the rule to specific campaigns"
                onClick={() => { if (scopeIds.length === 0 && eligibleCampaigns[0]) { setScopeIds([eligibleCampaigns[0].id]); setPreview(null) } }}>
                Specific ({scopeIds.length})
              </button>
            </div>
          </div>
        </div>
        {scopeIds.length > 0 && (
          <div className="eb-campaign-picker">
            {eligibleCampaigns.length === 0 && <p className="eb-be-hint">No {trigger.scope === 'CPS_AD' ? 'CPS' : 'CPC'} campaigns on this marketplace.</p>}
            {eligibleCampaigns.map((c) => (
              <label key={c.id} className="eb-campaign-opt">
                <input type="checkbox" checked={scopeIds.includes(c.id)}
                  onChange={(e) => { setScopeIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))); setPreview(null) }} />
                <span>{c.name}</span>
                <span className="eb-chip">{c.marketplace.replace('EBAY_', '')}</span>
                <span className={`h10-pill ${c.status === 'RUNNING' ? 'ok' : 'arch'}`}>{c.status}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="h10-cd-sec">
        <h3>Trigger — all conditions must hold (AND)</h3>
        {trigger.all.map((c, i) => {
          const benches = BENCH_FOR(trigger.scope, c.metric)
          return (
            <div key={i} className="eb-cond-row">
              <span className="eb-dd dense"><H10Select ariaLabel="Metric" width={190} value={c.metric}
                onChange={(v) => {
                  const metric = v as RuleMetric
                  const keepBench = c.benchmark && BENCH_FOR(trigger.scope, metric).includes(c.benchmark)
                  setCond(i, { metric, ...(keepBench ? {} : { benchmark: undefined, threshold: c.threshold ?? 0 }) })
                }}
                options={(Object.keys(METRIC_LABELS) as RuleMetric[]).map((m) => ({ value: m, label: METRIC_LABELS[m] }))} /></span>
              <label className="eb-cond-lbl">last
                <input className="h10-cd-input eb-cond-num" type="number" min={1} max={90} value={c.windowDays} aria-label="Window days"
                  onChange={(e) => setCond(i, { windowDays: Math.max(1, Math.min(90, Number(e.target.value) || 1)) })} />d
              </label>
              <label className="eb-cond-lbl" title="Skip the most recent days — eBay reconciles attribution for ~72h">excl.
                <input className="h10-cd-input eb-cond-num" type="number" min={0} max={7} value={c.excludeRecentDays ?? 0} aria-label="Exclude recent days"
                  onChange={(e) => setCond(i, { excludeRecentDays: Math.max(0, Math.min(7, Number(e.target.value) || 0)) })} />d
              </label>
              <span className="eb-dd dense"><H10Select ariaLabel="Operator" width={90} value={c.op} onChange={(v) => setCond(i, { op: v as RuleOp })}
                options={(Object.keys(OP_LABELS) as RuleOp[]).map((o) => ({ value: o, label: OP_LABELS[o] }))} /></span>
              <span className="eb-dd dense"><H10Select ariaLabel="Compare against" width={150} value={c.benchmark ?? '__abs'}
                onChange={(v) => {
                  if (v === '__abs') setCond(i, { benchmark: undefined, multiplier: undefined, threshold: c.threshold ?? 0 })
                  else setCond(i, { benchmark: v as RuleBenchmark, multiplier: c.multiplier ?? 1, threshold: undefined })
                }}
                options={[{ value: '__abs', label: 'value' }, ...benches.map((b) => ({ value: b, label: BENCH_LABELS[b] }))]} /></span>
              {c.benchmark ? (
                <label className="eb-cond-lbl">×
                  <input className="h10-cd-input eb-cond-num" type="number" min={0.1} max={10} step={0.1} value={c.multiplier ?? 1} aria-label="Multiplier"
                    onChange={(e) => setCond(i, { multiplier: Number(e.target.value) || 1 })} />
                </label>
              ) : (
                <label className="eb-cond-lbl">{unitFor(c.metric)}
                  <input className="h10-cd-input eb-cond-num wide" type="number" step="any" value={fromWire(c.metric, c.threshold)} aria-label="Threshold"
                    onChange={(e) => setCond(i, { threshold: e.target.value === '' ? undefined : toWire(c.metric, Number(e.target.value)) })} />
                </label>
              )}
              <button type="button" className="h10-am-btn sm" aria-label="Remove condition" disabled={trigger.all.length <= 1}
                onClick={() => { setTrigger((t) => ({ ...t, all: t.all.filter((_, j) => j !== i) })); setPreview(null) }}><X size={13} /></button>
            </div>
          )
        })}
        {trigger.all.length < 8 && (
          <button type="button" className="h10-am-btn sm" onClick={() => { setTrigger((t) => ({ ...t, all: [...t.all, { metric: 'clicks', windowDays: 14, op: 'gte', threshold: 10 }] })); setPreview(null) }}>
            <Plus size={13} /> Add condition
          </button>
        )}
        <p className="eb-be-hint" style={{ marginTop: 8 }}>Reads: <b>{trigger.all.map(conditionSentence).join(' AND ') || '—'}</b></p>
      </section>

      <section className="h10-cd-sec">
        <h3>Action</h3>
        <div className="eb-form-row">
          <div><label>Then</label>
            <span className="eb-dd dense"><H10Select ariaLabel="Action" width={280} value={action.type} onChange={(v) => { setAction({ type: v as RuleActionDef['type'], ...(v === 'adjust_ad_rate' ? { deltaPct: -10, minRatePct: 2 } : v === 'set_rate_to_breakeven_factor' ? { factor: 0.8, minRatePct: 2 } : v === 'bid_down_keyword' ? { bidDeltaPct: -20 } : {}) }); setPreview(null) }}
              options={ACTIONS_FOR_SCOPE[trigger.scope].map((t) => ({ value: t, label: ACTION_LABELS[t] }))} /></span>
          </div>
          {action.type === 'adjust_ad_rate' && (
            <div><label>Step %</label>
              <input className="h10-cd-input eb-cond-num wide" type="number" min={-90} max={300} step={1} value={action.deltaPct ?? -10}
                onChange={(e) => { setAction((a) => ({ ...a, deltaPct: Number(e.target.value) })); setPreview(null) }} />
            </div>
          )}
          {action.type === 'set_rate_to_breakeven_factor' && (
            <div><label>× break-even</label>
              <input className="h10-cd-input eb-cond-num wide" type="number" min={0.1} max={1.5} step={0.05} value={action.factor ?? 0.8}
                onChange={(e) => { setAction((a) => ({ ...a, factor: Number(e.target.value) })); setPreview(null) }} />
            </div>
          )}
          {action.type === 'bid_down_keyword' && (
            <div><label>Bid step %</label>
              <input className="h10-cd-input eb-cond-num wide" type="number" min={-90} max={-1} step={1} value={action.bidDeltaPct ?? -20}
                onChange={(e) => { setAction((a) => ({ ...a, bidDeltaPct: Number(e.target.value) })); setPreview(null) }} />
            </div>
          )}
        </div>
        <p className="eb-be-hint" style={{ marginTop: 6 }}>Does: <b>{actionSentence(action)}</b></p>
      </section>

      <section className="h10-cd-sec">
        <h3>Guardrails — always on</h3>
        <div className="eb-form-row" style={{ alignItems: 'center' }}>
          <span className="h10-pill ok" title="Every rate/bid automation is clamped at the listing's break-even from the commerce system; no rule can exceed it">break-even clamp</span>
          <span className="h10-pill ok" title="Per-campaign Protected / posture / caps from the campaign's Automation tab apply after the break-even clamp">campaign policy caps</span>
          {(action.type === 'adjust_ad_rate' || action.type === 'set_rate_to_breakeven_factor') && (
            <label className="eb-cond-lbl">rate floor
              <input className="h10-cd-input eb-cond-num" type="number" min={2} max={100} step={0.5} value={action.minRatePct ?? 2} aria-label="Rate floor %"
                onChange={(e) => { setAction((a) => ({ ...a, minRatePct: Number(e.target.value) })); setPreview(null) }} />%
            </label>
          )}
          <label className="eb-cond-lbl">cooldown
            <input className="h10-cd-input eb-cond-num" type="number" min={1} max={720} value={cooldownHours} aria-label="Cooldown hours"
              onChange={(e) => setCooldownHours(Math.max(1, Math.min(720, Number(e.target.value) || 24)))} />h
          </label>
        </div>
      </section>

      {isEdit && (
        <section className="h10-cd-sec">
          <h3>
            <button type="button" className="h10-am-link" onClick={() => void loadHistory()}>
              History{currentVersion != null ? ` — currently v${currentVersion}` : ''} {historyOpen ? '▾' : '▸'}
            </button>
          </h3>
          {historyOpen && (
            history == null ? <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div> : (
              <div className="eb-version-list">
                {history.map((v) => (
                  <div key={v.id} className="eb-version-row">
                    <span className="eb-chip">v{v.version}</span>
                    <div className="eb-version-body">
                      <p className="eb-version-meta">
                        {new Date(v.createdAt).toLocaleString('en-GB')} · {v.changedBy === 'starter-pack' || v.changedBy === 'backfill:er5' ? v.changedBy : v.changedBy ? 'operator' : '—'}{v.note ? ` · ${v.note}` : ''}
                      </p>
                      <p className="eb-version-sentence">
                        <b>{v.name}</b> — When {v.trigger.all.map(conditionSentence).join(' AND ')} → {actionSentence(v.action)} · cooldown {v.cooldownHours}h
                      </p>
                    </div>
                    {v.version === currentVersion
                      ? <span className="h10-pill ok">current</span>
                      : <button type="button" className="h10-am-btn sm" disabled={busy} title="Re-validates the old config and saves it as a NEW version — history is never rewritten" onClick={() => void restoreVersion(v.version)}>Restore</button>}
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      )}

      {preview && (
        <section className="h10-cd-sec eb-preview-out" aria-live="polite">
          <h3>Preview — live data, nothing written</h3>
          <p className="eb-be-hint"><b>{preview.evaluated}</b> evaluated · <b>{preview.matched}</b> would match now{preview.matched > preview.samples.length ? ` (first ${preview.samples.length} shown)` : ''}</p>
          {preview.samples.map((s, i) => (
            <p key={i} className="eb-preview-row">
              <span className="h10-pill ok">{s.kind.replace(/_/g, ' ')}</span>
              <b>{s.entityRef.campaignName}</b> {s.entityRef.listingId ?? s.entityRef.keywordText ?? ''} · {String(s.from ?? '')} → <b>{String(s.to ?? '')}</b>
            </p>
          ))}
          {preview.matched === 0 && <p className="eb-be-hint">No entity matches all conditions today — the rule stays dormant until one does.</p>}
        </section>
      )}
      {error && <p className="eb-rule-confirm" role="alert">{error}</p>}

      <div className="eb-editor-footer">
        <button type="button" className="h10-am-btn" disabled={busy} onClick={() => router.push('/marketing/ads/ebay/automation')}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn" disabled={busy || !name.trim()} title="Dry-run the rule against live data — no proposals, no cooldowns" onClick={() => void doPreview()}>{busy ? '…' : 'Preview matches'}</button>
        <button type="button" className="h10-am-btn primary" disabled={busy || !name.trim()} onClick={() => void doSave()}>{isEdit ? 'Save rule' : 'Create rule (disabled + PROPOSE)'}</button>
      </div>
      <p className="eb-be-hint" style={{ marginTop: 6 }}>
        New rules are created <b>disabled</b> in <b>PROPOSE</b> — enable them on the hub when ready. Suggested for fee/sales windows: exclude the last 3 days (eBay reconciles attribution for ~72h).
      </p>
    </div>
  )
}
