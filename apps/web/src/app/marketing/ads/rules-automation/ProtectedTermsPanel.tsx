'use client'

/**
 * ADX G4 — protected terms.
 *
 * Sits on Control Room › Guardrails (the Negative Targeting tab links there). It is that tab's
 * opposite: those rules decide what gets negated, this decides what never can be.
 *
 * It exists because "Auto harvest & negate" has been running enabled with nothing at
 * all stopping it negating a brand term, and its current proposals are on exactly the
 * generic terms the account most wants to own — "motorradjacke herren sommer",
 * "chaqueta moto hombre invierno".
 *
 * Enforcement is in ads-write-gate.ts, the single chokepoint every write to Amazon
 * passes through — not in the harvest service, because harvest is not the only caller
 * that can negate a term and a protection only some callers honour is not a protection.
 *
 * Styling matches the h10-* language the rest of this console uses (a deliberate
 * Helium 10 visual match); the design system is not used anywhere under
 * rules-automation and introducing it here alone would read as a foreign element.
 *
 * Ads fix 5c — "Always negate" is gone (no engine ever read it), the match select offers
 * Contains / Starts with / Exact and starts on Contains, each row names its match, and a
 * failed load is a Banner, not an empty list. The logic is in protectedTermsView.ts.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { ShieldCheck, Trash2, Plus, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Banner, Listbox } from '@/design-system/components'
// The console's own dropdown, used everywhere else under rules-automation. Also keeps
// this panel off the DS-conformance ratchet, which counts raw form elements.
import {
  DEFAULT_MATCH_TYPE, MATCH_OPTIONS, addProtectionBody, failedLoad, matchHint, matchLabel,
  readProtections, showNothingProtected, splitProtections,
  type MatchType, type Protection, type ProtectionsLoad,
} from './protectedTermsView'
import { useAdsMarketplace } from '../_shell/MarketplaceContext'


export function ProtectedTermsPanel() {
  // Ads wave 4c — a protection can name any market Nexus reads, not one of a fixed four.
  const { readMarkets } = useAdsMarketplace()
  const [load, setLoad] = useState<ProtectionsLoad>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [matchType, setMatchType] = useState<MatchType>(DEFAULT_MATCH_TYPE)
  const [marketplace, setMarketplace] = useState('')
  const [reason, setReason] = useState('')

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections`, { cache: 'no-store' })
      const j = await r.json().catch(() => null)
      setLoad(readProtections(r.ok, r.status, j))
    } catch (e) { setLoad(failedLoad(e)) }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const add = async () => {
    const t = term.trim()
    if (!t || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addProtectionBody({ term: t, matchType, marketplace, reason })),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) { setErr(j?.error ?? `HTTP ${r.status}`); return }
      setTerm(''); setReason('')
      await reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/keyword-protections/${id}`, { method: 'DELETE' })
      await reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const { terms, retired } = splitProtections(load.status === 'loaded' ? load.items : [])

  const row = (p: Protection) => (
    <li key={p.id} className="h10-act-r">
      <span className="h10-pt-term">
        {p.mode === 'WHITELIST' ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
        <b>{p.term}</b>
        <em className="h10-pt-flag">{matchLabel(p)}</em>
        {p.marketplace && <em className="h10-pt-flag">{p.marketplace}</em>}
      </span>
      {p.reason && <span className="h10-pt-reason">{p.reason}</span>}
      <Button
 variant="ghost" disabled={busy}
 aria-label={`Remove protection for ${p.term}`} onClick={() => void remove(p.id)}
 ><Trash2 size={12} /></Button>
    </li>
  )

  return (
    <section id="protected-terms" className="h10-rb-sec">
      <h3>Protected terms</h3>
      <p className="h10-rb-desc">
        The opposite of the rules above. A <b>protected</b> term can never be negated by any
        automation. Enforced on every write to Amazon, so no engine can bypass it.
      </p>

      {showNothingProtected(load) && (
        <div className="h10-d2-note bad">
          <AlertTriangle size={13} />
          <span>
            Nothing is protected. Any automation that negates search terms can negate your brand
            and core terms — add them here first.
          </span>
        </div>
      )}

      <div className="h10-pt-add">
        <Input
          size="sm" fieldClassName="h10-pt-input" value={term} placeholder="Term to protect, e.g. xavia"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          aria-label="Term"
        />
        <Listbox
          ariaLabel="Match type" width={140} value={matchType}
          onChange={(v) => setMatchType(v as MatchType)}
          options={MATCH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <Listbox
          ariaLabel="Marketplace" width={130} value={marketplace}
          onChange={(v) => setMarketplace(v)}
          options={['', ...readMarkets].map((m) => ({ value: m, label: m || 'All markets' }))}
        />
        <Input
          size="sm" fieldClassName="h10-pt-input reason" value={reason} placeholder="Why (optional)"
          onChange={(e) => setReason(e.target.value)} aria-label="Reason"
        />
        <Button variant="primary" disabled={busy || !term.trim()} onClick={() => void add()}>
          <Plus size={13} /> Protect
        </Button>
      </div>
      <p className="h10-rb-desc">{matchHint(matchType, term)}</p>
      {err && <div className="h10-d2-note bad"><AlertTriangle size={13} /><span>{err}</span></div>}

      {load.status === 'loading' ? (
        <div className="h10-hist-msg">Loading…</div>
      ) : load.status === 'failed' ? (
        <Banner
          tone="danger" title="Protected terms did not load"
          action={<Button size="sm" onClick={() => void reload()}>Try again</Button>}
        >
          {load.message} This does not mean nothing is protected.
        </Banner>
      ) : load.items.length === 0 ? (
        <div className="h10-evt-empty">No protected terms yet.</div>
      ) : (
        <>
          {terms.length > 0 && (
            <>
              <div className="h10-pt-hd">Never negate ({terms.length})</div>
              <ul className="h10-act-list">{terms.map(row)}</ul>
            </>
          )}
          {retired.length > 0 && (
            <>
              <div className="h10-pt-hd">Stored but not used ({retired.length})</div>
              <p className="h10-rb-desc">
                “Always negate” was removed: nothing ever negated these terms. Remove them.
              </p>
              <ul className="h10-act-list">{retired.map(row)}</ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
