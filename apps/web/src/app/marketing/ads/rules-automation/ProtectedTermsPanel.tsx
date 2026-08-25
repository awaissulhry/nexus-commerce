'use client'

/**
 * ADX G4 — protected terms.
 *
 * Sits on the Negative Targeting tab because it is that tab's opposite: those rules
 * decide what gets negated, this decides what never can be.
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
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox } from '@/design-system/primitives'
// lucide-react 0.263.1 has no ShieldX; Ban reads better for "always negate" anyway.
import { ShieldCheck, Ban, Trash2, Plus, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Listbox } from '@/design-system/components'
// The console's own dropdown, used everywhere else under rules-automation. Also keeps
// this panel off the DS-conformance ratchet, which counts raw form elements.

type Mode = 'WHITELIST' | 'BLACKLIST'

interface Protection {
  id: string
  mode: Mode
  term: string
  isPrefix: boolean
  marketplace: string | null
  campaignId: string | null
  reason: string | null
  createdBy: string | null
}

const MARKETS = ['', 'IT', 'DE', 'FR', 'ES']

export function ProtectedTermsPanel() {
  const [items, setItems] = useState<Protection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [mode, setMode] = useState<Mode>('WHITELIST')
  const [isPrefix, setIsPrefix] = useState(false)
  const [marketplace, setMarketplace] = useState('')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections`, { cache: 'no-store' })
      const j = await r.json()
      setItems(Array.isArray(j?.items) ? (j.items as Protection[]) : [])
    } catch { setItems([]) }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async () => {
    const t = term.trim()
    if (!t || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, term: t, isPrefix, marketplace: marketplace || null, reason: reason.trim() || null }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) { setErr(j?.error ?? `HTTP ${r.status}`); return }
      setTerm(''); setReason(''); setIsPrefix(false)
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/keyword-protections/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const whitelist = (items ?? []).filter((p) => p.mode === 'WHITELIST')
  const blacklist = (items ?? []).filter((p) => p.mode === 'BLACKLIST')

  const row = (p: Protection) => (
    <li key={p.id} className="h10-act-r">
      <span className="h10-pt-term">
        {p.mode === 'WHITELIST' ? <ShieldCheck size={13} /> : <Ban size={13} />}
        <b>{p.term}</b>
        {p.isPrefix && <em className="h10-pt-flag">prefix</em>}
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
        The opposite of the rules above. A <b>whitelisted</b> term can never be negated by any
        automation; a <b>blacklisted</b> term is always negated. Enforced on every write to Amazon,
        so no engine can bypass it.
      </p>

      {whitelist.length === 0 && items !== null && (
        <div className="h10-d2-note bad">
          <AlertTriangle size={13} />
          <span>
            Nothing is protected. <b>Auto harvest &amp; negate</b> is enabled and is currently
            proposing negations on generic terms — add your brand and core terms here first.
          </span>
        </div>
      )}

      <div className="h10-pt-add">
        <input
          className="h10-pt-input" value={term} placeholder="Term to protect, e.g. xavia"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          aria-label="Term"
        />
        <Listbox
          ariaLabel="Protection mode" width={150} value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[{ value: 'WHITELIST', label: 'Never negate' }, { value: 'BLACKLIST', label: 'Always negate' }]}
        />
        <Listbox
          ariaLabel="Marketplace" width={130} value={marketplace}
          onChange={(v) => setMarketplace(v)}
          options={MARKETS.map((m) => ({ value: m, label: m || 'All markets' }))}
        />
        <Checkbox
          className="h10-pt-ck" label="Prefix"
          checked={isPrefix} onChange={(e) => setIsPrefix(e.target.checked)}
        />
        <input
          className="h10-pt-input reason" value={reason} placeholder="Why (optional)"
          onChange={(e) => setReason(e.target.value)} aria-label="Reason"
        />
        <Button variant="primary" disabled={busy || !term.trim()} onClick={() => void add()}>
          <Plus size={13} /> Protect
        </Button>
      </div>
      {err && <div className="h10-d2-note bad"><AlertTriangle size={13} /><span>{err}</span></div>}

      {items === null ? (
        <div className="h10-hist-msg">Loading…</div>
      ) : items.length === 0 ? (
        <div className="h10-evt-empty">No protected terms yet.</div>
      ) : (
        <>
          {whitelist.length > 0 && (
            <>
              <div className="h10-pt-hd">Never negate ({whitelist.length})</div>
              <ul className="h10-act-list">{whitelist.map(row)}</ul>
            </>
          )}
          {blacklist.length > 0 && (
            <>
              <div className="h10-pt-hd">Always negate ({blacklist.length})</div>
              <ul className="h10-act-list">{blacklist.map(row)}</ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
