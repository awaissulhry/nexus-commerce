'use client'

/**
 * AME.17 — Keyword-graduation funnel + launcher UI. Enter a product, see its
 * ad groups by match role + each keyword's journey across match types, preview
 * the cross-match negation plan (Exact owns the term; negate it in Phrase/Broad/
 * Auto) and apply it. Launch builds the canonical Auto + Manual(Exact/Phrase/
 * Broad) structure in one action.
 */
import { useCallback, useState } from 'react'
import { Filter, Rocket, Ban, Loader2 } from 'lucide-react'
import { marketplaceCode } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'

interface AdGroup { id: string; name: string; role: string | null; positives: Array<{ kw: string; match: string }>; negatives: Array<{ kw: string; match: string }> }
interface Journey { keyword: string; matchTypes: string[]; negatedIn: number }
interface State { adGroups: AdGroup[]; journey: Journey[] }
interface Proposal { keywordText: string; matchType: string; adGroupId: string; adGroupName: string; role: string; reason: string }

const ROLE_TONE: Record<string, string> = { EXACT: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300', PHRASE: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300', BROAD: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300', AUTO: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' }

export function FunnelClient() {
  const [productId, setProductId] = useState('')
  const [marketplace, setMarketplace] = useState('IT')
  const [state, setState] = useState<State | null>(null)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const loadState = useCallback(async () => {
    if (!productId) { setMsg('Enter a product id'); return }
    setBusy('state'); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/funnel/state?productId=${productId}`, { cache: 'no-store' }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setState(r); setProposals(null)
    } catch (e) { setMsg((e as Error).message) } finally { setBusy('') }
  }, [productId])

  const preview = useCallback(async (apply: boolean) => {
    if (!productId) { setMsg('Enter a product id'); return }
    setBusy(apply ? 'apply' : 'preview'); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/funnel/cross-match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, apply }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setProposals(r.proposals ?? [])
      if (apply) { setMsg(`✓ applied ${r.applied} negations${r.errors?.length ? ` · ${r.errors.length} skipped (not yet synced)` : ''}`); void loadState() }
    } catch (e) { setMsg((e as Error).message) } finally { setBusy('') }
  }, [productId, loadState])

  const launch = useCallback(async () => {
    if (!productId || !marketplace) { setMsg('Product id + marketplace required'); return }
    if (!confirm(`Launch a full Auto + Manual(Exact/Phrase/Broad) campaign structure for this product in ${marketplace}? This creates real campaigns.`)) return
    setBusy('launch'); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/funnel/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, marketplace }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setMsg(`✓ launched — Auto campaign ${r.autoCampaignId?.slice(0, 8)} + Manual ${r.manualCampaignId?.slice(0, 8)}`); void loadState()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy('') }
  }, [productId, marketplace, loadState])

  const byRole = (role: string) => (state?.adGroups ?? []).filter((a) => a.role === role)

  return (
    <div className="px-4 py-4 max-w-6xl">
      <div className="flex items-center gap-2 mb-1"><Filter size={18} className="text-blue-600" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Launch &amp; keyword funnel</h1></div>
      <p className="text-sm text-slate-500 mb-4 max-w-prose">Build the canonical Auto → Exact → Phrase → Broad structure for a product, then let winning search terms graduate and cross-match negation keep each level from cannibalising the others (the Exact ad group owns its terms; they&apos;re negated everywhere else).</p>

      <div className="flex flex-wrap items-end gap-2 mb-4 p-3 rounded-lg border border-default dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
        <label className="flex flex-col text-[11px] text-slate-500">Product id
          <input value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="cmon…" className="mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 w-72" />
        </label>
        <label className="flex flex-col text-[11px] text-slate-500">Marketplace
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className="mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">
            {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => <option key={m} value={m}>{marketplaceCode(m)}</option>)}
          </select>
        </label>
        <button onClick={loadState} disabled={!!busy} className="px-3 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1">{busy === 'state' ? <Loader2 size={13} className="animate-spin" /> : null} Load funnel</button>
        <button onClick={() => preview(false)} disabled={!!busy} className="px-3 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1">{busy === 'preview' ? <Loader2 size={13} className="animate-spin" /> : null} Preview negations</button>
        <button onClick={launch} disabled={!!busy} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1">{busy === 'launch' ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} Launch structure</button>
        {msg && <span className={`text-xs ${msg.startsWith('✓') ? 'text-emerald-600' : 'text-rose-600'}`}>{msg}</span>}
      </div>

      {state && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          {(['AUTO', 'BROAD', 'PHRASE', 'EXACT'] as const).map((role) => {
            const ags = byRole(role)
            const kws = ags.flatMap((a) => a.positives).length
            return (
              <div key={role} className="rounded-lg border border-default dark:border-slate-800 p-3">
                <div className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded ${ROLE_TONE[role]}`}>{role}</div>
                <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">{ags.length}</div>
                <div className="text-xs text-tertiary">ad groups · {kws} keywords</div>
              </div>
            )
          })}
        </div>
      )}

      {state && state.journey.length > 0 && (
        <div className="rounded-lg border border-default dark:border-slate-800 mb-4 overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tertiary border-b border-default dark:border-slate-800">Keyword journey</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Keyword</th><th className="text-left px-3 py-2">Lives in</th><th className="text-right px-3 py-2">Negated in</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {state.journey.slice(0, 200).map((j) => (
                <tr key={j.keyword} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <td className="px-3 py-1.5">{j.keyword}</td>
                  <td className="px-3 py-1.5">{j.matchTypes.map((m) => <span key={m} className={`inline-block mr-1 px-1.5 py-px text-[10px] font-medium rounded ${ROLE_TONE[m] ?? 'bg-slate-100 text-slate-600'}`}>{m}</span>)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{j.negatedIn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proposals && (
        <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
          <div className="px-3 py-2 flex items-center justify-between border-b border-default dark:border-slate-800">
            <span className="text-xs font-semibold uppercase tracking-wide text-tertiary">Cross-match negation plan ({proposals.length})</span>
            {proposals.length > 0 && <button onClick={() => preview(true)} disabled={!!busy} className="px-3 py-1 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1">{busy === 'apply' ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />} Apply all</button>}
          </div>
          {proposals.length === 0
            ? <div className="px-3 py-8 text-center text-tertiary text-sm">No negations needed — every match level already owns its terms cleanly.</div>
            : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Negate</th><th className="text-left px-3 py-2">Keyword</th><th className="text-left px-3 py-2">In ad group</th><th className="text-left px-3 py-2">Why</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {proposals.slice(0, 300).map((p, i) => (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                      <td className="px-3 py-1.5"><span className="px-1.5 py-px text-[10px] font-medium rounded bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{p.matchType.replace('NEGATIVE_', 'NEG ')}</span></td>
                      <td className="px-3 py-1.5">{p.keywordText}</td>
                      <td className="px-3 py-1.5 text-slate-500">{p.adGroupName} <span className={`ml-1 px-1 py-px text-[9px] rounded ${ROLE_TONE[p.role] ?? ''}`}>{p.role}</span></td>
                      <td className="px-3 py-1.5 text-xs text-tertiary">{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </div>
  )
}
