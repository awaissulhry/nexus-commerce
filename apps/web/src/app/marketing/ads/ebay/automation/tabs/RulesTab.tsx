'use client'

/**
 * ER3.2 (delta 2) — glass-box rule cards: the trigger/action/guardrails that
 * v1 hid inside JSON render as sentences, with scope pill, last-run stats and
 * a row menu (Edit · Duplicate · Run now · Delete). Rule click = edit route.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { postEbayAds, getEbayAds } from '../../_lib'
import { type AutomationRule, conditionSentence, actionSentence, scopeLabel } from '../_lib/rules'

function RuleMenu({ rule, busy, onRun, onDelete }: { rule: AutomationRule; busy: boolean; onRun: () => void; onDelete: () => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <span className="eb-rule-menu" ref={ref}>
      <button type="button" className="h10-am-btn sm" aria-label={`Actions for ${rule.name}`} onClick={() => setOpen((o) => !o)}><MoreHorizontal size={14} /></button>
      {open && (
        <span className="h10-statusmenu eb-statusfix">
          <button type="button" onClick={() => { setOpen(false); router.push(`/marketing/ads/ebay/automation/rules/${rule.id}`) }}>Edit…</button>
          <button type="button" onClick={() => { setOpen(false); router.push(`/marketing/ads/ebay/automation/rules/new?from=${rule.id}`) }}>Duplicate…</button>
          <button type="button" disabled={busy || !rule.enabled} title={rule.enabled ? undefined : "Enable the rule first — disabled rules don't evaluate"} onClick={() => { setOpen(false); onRun() }}>Run now</button>
          <button type="button" className="danger" disabled={busy} onClick={() => { setOpen(false); onDelete() }}>Delete…</button>
        </span>
      )}
    </span>
  )
}

export function RulesTab({ busy, act, bump }: { busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; bump: number }) {
  const router = useRouter()
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AutomationRule | null>(null)

  const reload = useCallback(async () => {
    try { setRules((await getEbayAds<{ rules: AutomationRule[] }>('/automation/rules')).rules); setError(null) }
    catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void reload() }, [reload, bump])

  if (error) return <div className="h10-am-card" style={{ padding: 24 }}><p className="eb-be-hint">Rules failed to load: {error}</p></div>
  if (rules == null) return <div className="h10-am-card" style={{ padding: 24 }}><p className="eb-be-hint">Loading rules…</p></div>

  return (
    <div className="h10-am-card" style={{ padding: '6px 0' }}>
      <div className="eb-rules-toolbar">
        <span className="eb-be-hint">{rules.length} rule{rules.length === 1 ? '' : 's'} · conditions AND together — for OR, duplicate the rule</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary sm" onClick={() => router.push('/marketing/ads/ebay/automation/rules/new')}>+ New rule</button>
      </div>
      {rules.length === 0 ? (
        <div style={{ padding: '28px 18px', textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: '#5b6573', marginBottom: 12 }}>No rules yet. The starter pack ships six documented rules — fee creep-down, click-bleeder removal, break-even repair, restock re-promote, keyword bleeder pause, keyword bid-down — all disabled, all PROPOSE. Or build your own.</p>
          <button type="button" className="h10-am-btn primary" disabled={busy} onClick={() => void act(() => postEbayAds('/automation/presets/starter-pack', {}), 'starter pack installed')}>Install starter rule-pack</button>
          <button type="button" className="h10-am-btn" style={{ marginLeft: 8 }} onClick={() => router.push('/marketing/ads/ebay/automation/rules/new')}>New rule…</button>
        </div>
      ) : rules.map((r) => {
        const last = r.executions?.[0]
        return (
          <div key={r.id} className="eb-rule-card">
            <div className="eb-rule-head">
              <button type="button" role="switch" aria-checked={r.enabled} className={`h10-bktoggle ${r.enabled ? 'on' : ''}`} disabled={busy}
                onClick={() => void act(() => postEbayAds(`/automation/rules/${r.id}`, { enabled: !r.enabled }))}>
                <span />
              </button>
              <button type="button" className="eb-rule-name" onClick={() => router.push(`/marketing/ads/ebay/automation/rules/${r.id}`)} title="Edit rule">{r.name}</button>
              <button type="button" className={`h10-pill ${r.mode === 'AUTOPILOT' ? 'ok' : 'arch'}`} style={{ cursor: 'pointer', border: 'none' }} disabled={busy}
                title="Click to toggle PROPOSE ↔ AUTOPILOT (autopilot applies within guardrails when the dial is on Auto)"
                onClick={() => void act(() => postEbayAds(`/automation/rules/${r.id}`, { mode: r.mode === 'AUTOPILOT' ? 'PROPOSE' : 'AUTOPILOT' }))}>
                {r.mode}
              </button>
              <span className="h10-pill arch" title={r.scope?.campaignIds?.length ? 'Evaluates only the campaigns bound to this rule' : 'Evaluates every eligible campaign on the marketplace'}>{scopeLabel(r)}</span>
              <span className="eb-chip">{r.trigger.scope === 'CPS_AD' ? 'CPS ads' : 'CPC keywords'}</span>
              <span style={{ flex: 1 }} />
              <RuleMenu rule={r} busy={busy}
                onRun={() => void act(async () => {
                  const rep = await postEbayAds<{ evaluated: number; matched: number; proposed: number; applied: number }>('/automation/evaluate', { ruleId: r.id })
                  return rep
                }, `run: ${r.name}`)}
                onDelete={() => setConfirmDelete(r)} />
            </div>
            <p className="eb-rule-sentence">
              <b>When</b> {r.trigger.all.map(conditionSentence).join(' AND ')} → <b>{actionSentence(r.action)}</b> · cooldown {r.cooldownHours}h
            </p>
            <p className="eb-rule-last">
              {last ? `last run: ${last.evaluated} evaluated · ${last.matched} matched · ${last.proposed} proposed · ${last.applied} applied` : 'never run'}
              {r.lastEvaluatedAt && ` · ${new Date(r.lastEvaluatedAt).toLocaleString('en-GB')}`}
            </p>
            {confirmDelete?.id === r.id && (
              <p className="eb-rule-confirm" role="alert">
                Delete “{r.name}”? Its execution history goes with it; past proposals stay.
                <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button type="button" className="h10-am-btn sm danger" disabled={busy}
                  onClick={() => { setConfirmDelete(null); void act(() => postEbayAds(`/automation/rules/${r.id}`, {}, 'DELETE'), 'rule deleted') }}>
                  Delete
                </button>
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
