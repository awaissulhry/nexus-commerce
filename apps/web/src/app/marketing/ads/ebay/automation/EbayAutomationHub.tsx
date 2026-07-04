'use client'

/**
 * ER3.2 — Rules & Automation hub shell (C1: folder-per-page, file-per-tab).
 * Header + posture band + tabs; each tab owns its data. The v1 monolith
 * (EbayAutomationClient) is dissolved into tabs/ + rules/ + _lib/.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import '../ebay.css'
import { postEbayAds, getEbayAds, useWriteMode, SandboxBanner } from '../_lib'
import { PostureBand, type StatePayload } from './PostureBand'
import { RulesTab } from './tabs/RulesTab'
import { SuggestionsTab } from './tabs/SuggestionsTab'
import { AppliedTab } from './tabs/AppliedTab'
import { DriftTab } from './tabs/DriftTab'

const TABS = [
  { key: 'rules', label: 'Rules' },
  { key: 'suggestions', label: 'Suggestions' },
  { key: 'applied', label: 'Applied' },
  { key: 'drift', label: 'Drift' },
]

export function EbayAutomationHub() {
  const writeMode = useWriteMode()
  // ER3.5 — digest deep links: ?tab=suggestions&highlight=<proposalId>
  const sp = useSearchParams()
  const urlTab = sp.get('tab')
  const highlightId = sp.get('highlight')
  const [tab, setTab] = useState(TABS.some((t) => t.key === urlTab) ? urlTab! : 'rules')
  const [state, setState] = useState<StatePayload | null>(null)
  const [counts, setCounts] = useState<{ suggestions: number; drift: number }>({ suggestions: 0, drift: 0 })
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [bump, setBump] = useState(0) // tabs reload when a cross-tab action lands

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 5000) }, [])

  const reloadShell = useCallback(async () => {
    try {
      const [s, p, d] = await Promise.all([
        getEbayAds<StatePayload>('/automation/state'),
        getEbayAds<{ proposals: unknown[] }>('/automation/proposals?status=PENDING'),
        getEbayAds<{ drifts: unknown[] }>('/reconciliation'),
      ])
      setState(s); setCounts({ suggestions: p.proposals.length, drift: d.drifts.length })
    } catch (e) { say((e as Error).message) }
  }, [say])
  useEffect(() => { void reloadShell() }, [reloadShell, bump])

  const act = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try { await fn(); if (done) say(done); setBump((b) => b + 1) } catch (e) { say((e as Error).message) } finally { setBusy(false) }
  }, [say])

  return (
    <div className="h10-rules-page eb-root">
      <AdsPageHeader
        channel="ebay"
        title="eBay Rules & Automation"
        subtitle="Rules propose; you approve — or grant autopilot within hard margin guardrails. Everything is audited and reversible."
        markets={['EBAY_IT']} market="EBAY_IT" onMarketChange={() => {}}
        showLearn={false} showDataSync={false} showDateRange={false}
        primaryAction={{ label: 'Evaluate now', onClick: () => void act(() => postEbayAds('/automation/evaluate', {}), 'evaluation run') }}
      />
      <SandboxBanner mode={writeMode} />

      {state?.state.halted && (
        <div className="dash-banner" role="alert">
          <b>Automation HALTED</b> — {state.state.haltReason ?? 'no reason recorded'} · <button className="h10-am-link" onClick={() => void act(() => postEbayAds('/automation/state', { halted: false }), 'resumed')}>Resume</button>
        </div>
      )}

      <PostureBand state={state} busy={busy} act={act} />

      <nav className="h10-cd-tabs h10-rules-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`h10-cd-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'suggestions' && counts.suggestions > 0 && <span className="h10-cd-new">{counts.suggestions}</span>}
            {t.key === 'drift' && counts.drift > 0 && <span className="h10-cd-new">{counts.drift}</span>}
          </button>
        ))}
      </nav>

      {tab === 'rules' && <RulesTab busy={busy} act={act} bump={bump} />}
      {tab === 'suggestions' && <SuggestionsTab busy={busy} act={act} bump={bump} highlightId={highlightId} />}
      {tab === 'applied' && <AppliedTab busy={busy} act={act} bump={bump} />}
      {tab === 'drift' && <DriftTab busy={busy} act={act} bump={bump} />}

      {toast && <div className="h10-am-toast" role="status">{toast}</div>}
    </div>
  )
}
