'use client'

/**
 * AX3.6 — replication history, and the saved-structure library.
 *
 * Both used to live on the retired /marketing/ads/blueprints page. They belong
 * next to the builder rather than in the nav rail, but they had to keep
 * existing: a run you cannot find afterwards is a run you cannot roll back, and
 * a saved structure you cannot inspect is a name you have to trust.
 *
 * Dry runs are excluded server-side. A history that is mostly previews of things
 * that never happened is not a history anyone reads.
 */
import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, TrendingUp, Trash2, Loader2, ChevronDown, ChevronRight, GitCompare } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

import { InfoTip } from '../../campaigns/InfoTip'
import { Button, Input, Pill } from '@/design-system/primitives'
import { pillTone } from '../../_shared/pillTone'
import { Field, Listbox } from '@/design-system/components'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../builder-ds.css'

interface Run {
  id: string; productToken: string; marketplace: string; status: string
  campaigns: number; liveCampaigns: number; notOnAmazon: string[]; errors: string[]
  createdAt: string; appliedAt: string | null; rolledBackAt: string | null
  launchMode: string | null
}
interface SavedRow {
  id: string; name: string; marketplace: string; productToken: string
  roles: string[]
  sourceCampaignIds: string[]
  stats: { campaigns: number; adGroups: number; positives: number; negatives: number } | null
}

const when = (r: Run) => new Date(r.appliedAt ?? r.createdAt).toLocaleString()

export function HistoryPanel({ market, onReplicateAgain }: {
  market: string
  /** Re-select a saved structure's campaigns in the source tree. */
  onReplicateAgain?: (campaignIds: string[], productToken: string) => void
}) {
  const [runs, setRuns] = useState<Run[]>([])
  const [saved, setSaved] = useState<SavedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openBp, setOpenBp] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        fetch(`${getBackendUrl()}/api/advertising/blueprint-applications?marketplace=${market}`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`${getBackendUrl()}/api/advertising/blueprints`, { credentials: 'include' }).then((r) => r.json()),
      ])
      setRuns((a?.items ?? []) as Run[])
      setSaved(((b?.items ?? []) as SavedRow[]).filter((x) => x.marketplace === market))
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [market])
  useEffect(() => { void load() }, [load])

  const act = async (id: string, path: string) => {
    setBusy(id); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprint-applications/${id}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error) throw new Error(j?.error || 'failed')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const deleteBlueprint = async (id: string) => {
    setBusy(id); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprints/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!r.ok) throw new Error('could not delete')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  if (loading) return <div className="h10-spw-card h10-rep-todo"><Loader2 size={14} className="spin" aria-hidden /> Loading…</div>

  return (
    <div className="h10-rep-hist">
      {err && <div className="h10-rep-note bad">{err}</div>}

      <div className="h10-spw-card">
        <b className="h10-rep-hist-hd">Saved structures</b>
        {saved.length === 0 ? (
          <p className="h10-rep-hist-none">None saved. You can save one at the end of a run — it stores what you replicated so you do not have to rebuild the selection.</p>
        ) : saved.map((b) => (
          <div className="h10-rep-hist-row" key={b.id}>
            <button type="button" className="exp" onClick={() => setOpenBp(openBp === b.id ? null : b.id)} aria-expanded={openBp === b.id} aria-label="Show what is inside" title="Show which campaign roles this saved structure contains">
              {openBp === b.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <span className="nm"><b>{b.name}</b><span className="m">{b.marketplace} · captured from {b.productToken}</span></span>
            <span className="stat">
              {b.stats ? `${b.stats.campaigns} campaigns · ${b.stats.positives} targets · ${b.stats.negatives} negatives` : '—'}
            </span>
            {onReplicateAgain && (
              <InfoTip tip="Load this saved structure back into step 1 as the source, so you can replicate it onto another product without rebuilding the selection.">
                <Button size="sm" onClick={() => onReplicateAgain(b.sourceCampaignIds, b.productToken)}>Replicate again</Button>
              </InfoTip>
            )}
            <InfoTip tip={`Delete the saved structure "${b.name}". This only removes the saved recipe — campaigns it has already created are untouched.`}>
              <button type="button" className="cutbtn" disabled={busy === b.id} onClick={() => void deleteBlueprint(b.id)} aria-label={`Delete ${b.name}`}>
                <Trash2 size={13} />
              </button>
            </InfoTip>
            {openBp === b.id && (
              <div className="detail">
                <b>Roles in this structure</b>
                <p>{b.roles.length ? b.roles.join(' · ') : 'none recorded'}</p>
                <p className="m">
                  Replicating it re-selects the {b.sourceCampaignIds.length} campaigns it was captured from, so what
                  actually gets copied is whatever those campaigns look like <i>now</i> — not a frozen snapshot.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="h10-spw-card">
        <b className="h10-rep-hist-hd">Past replications in {market}</b>
        {runs.length === 0 ? (
          <p className="h10-rep-hist-none">Nothing has been replicated into {market} yet.</p>
        ) : runs.map((r) => (
          <div className="h10-rep-hist-row" key={r.id}>
            <span className="exp-sp" />
            <span className="nm">
              <b>{r.productToken}</b>
              <span className="m">{when(r)}{r.launchMode === 'floor' ? ' · created at the bid floor' : ''}</span>
            </span>
            <Pill tone={pillTone(r.status === 'APPLIED' ? 'ok' : r.status === 'FAILED' ? 'bad' : r.status === 'ROLLED_BACK' ? '' : 'warn')}>{r.status.replace('_', ' ').toLowerCase()}</Pill>
            <span className="stat">
              {r.liveCampaigns}/{r.campaigns} campaigns live
              {r.notOnAmazon.length > 0 && <span className="bad"> · {r.notOnAmazon.length} never reached Amazon</span>}
            </span>
            {r.launchMode === 'floor' && r.liveCampaigns > 0 && (
              <InfoTip tip={`Takes this run's ${r.liveCampaigns} campaigns off the €0.02 floor and up to the bids it was planned at. This is when they start spending.`}>
                <button type="button" className="h10-rep-bulkbtn" disabled={busy === r.id} onClick={() => void act(r.id, 'raise-bids')}>
                  <TrendingUp size={13} aria-hidden /> Raise bids
                </button>
              </InfoTip>
            )}
            {r.liveCampaigns > 0 && (
              <InfoTip tip={`Archives all ${r.liveCampaigns} campaigns this run created, as one unit. Spending stops. Archived is permanent on Amazon — they cannot be brought back, so this means re-running the replication, not undoing it.`}>
                <button type="button" className="h10-rep-bulkbtn danger" disabled={busy === r.id} onClick={() => void act(r.id, 'rollback')}>
                  <RotateCcw size={13} aria-hidden /> Roll back
                </button>
              </InfoTip>
            )}
            {busy === r.id && <Loader2 size={14} className="spin" aria-hidden />}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * AX3.6 — has a product drifted from the structure it was built from?
 *
 * `POST /blueprints/:id/diff` has existed since AX2.4 and has never had a
 * surface, so the audit half of "blueprints" was unreachable from the product.
 */
export function DriftCheck({ market }: { market: string }) {
  const [saved, setSaved] = useState<SavedRow[]>([])
  const [bpId, setBpId] = useState('')
  const [token, setToken] = useState('')
  const [prefix, setPrefix] = useState('')
  const [out, setOut] = useState<{ conforms: boolean; matched: number; entries: Array<{ role: string; kind: string; detail: string }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${getBackendUrl()}/api/advertising/blueprints`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setSaved(((j?.items ?? []) as SavedRow[]).filter((x) => x.marketplace === market)))
      .catch(() => {})
  }, [market])

  const run = async () => {
    if (!bpId || !token.trim() || !prefix.trim()) return
    setBusy(true); setErr(null); setOut(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprints/${bpId}/diff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ namePrefix: prefix.trim(), marketplace: market, productToken: token.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error) throw new Error(j?.error || 'diff failed')
      setOut(j)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  if (saved.length === 0) return null

  return (
    <div className="h10-spw-card h10-rep-drift">
      <b className="h10-rep-hist-hd"><GitCompare size={14} aria-hidden /> Has a product drifted from its structure?</b>
      <p className="h10-rep-hist-none">
        Compare a saved structure against a product’s live campaigns. Useful months after a replication,
        when someone has been tuning one product and not the others.
      </p>
      <div className="row">
        <Field className="spw-field sm" label="Structure" htmlFor="hp-structure">
          <Listbox
            width={220}
            options={[{ value: '', label: 'Choose…' }, ...saved.map((b) => ({ value: b.id, label: b.name }))]}
            value={bpId} onChange={setBpId} ariaLabel="Saved structure"
          />
        </Field>
        <Field className="spw-field sm" label="Product token">
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="GALE" fieldClassName="spw-field-full" />
        </Field>
        <Field className="spw-field sm" label="Its campaigns start with">
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="IT-GALE-SP-" fieldClassName="spw-field-full" />
        </Field>
        <Button size="sm" disabled={busy || !bpId || !token.trim() || !prefix.trim()} onClick={() => void run()}>
          {busy ? <Loader2 size={13} className="spin" aria-hidden /> : null} Compare
        </Button>
      </div>
      {err && <div className="h10-rep-note bad">{err}</div>}
      {out && (
        <div className={`h10-rep-note ${out.conforms ? 'ok' : 'warn'}`}>
          <b>{out.conforms ? 'No drift' : `${out.entries.length} difference(s)`}</b>
          <p>{out.matched} campaign role(s) matched.</p>
          {!out.conforms && (
            <ul>{out.entries.slice(0, 25).map((e, i) => <li key={i}><code>{e.role}</code> — {e.detail}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  )
}
