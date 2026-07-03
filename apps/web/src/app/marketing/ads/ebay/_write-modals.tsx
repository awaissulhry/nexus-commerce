'use client'

/**
 * E6.2 — write modals rebuilt on the console's OWN modal idiom
 * (.h10-modal-backdrop/.h10-modal/.h10-am-btn/.h10-cd-input — same classes
 * the Amazon bulk dialogs use), zero design-system dependency, so they are
 * pixel-consistent with the rest of /marketing/ads in every context.
 * Every apply → POST /api/ebay-ads/* → audited write service; per-item
 * results say created / warned / BLOCKED-by-break-even / failed + mode.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  postEbayAds, SandboxBanner, useWriteMode,
  type WriteItemOutcome, type CampaignRow,
} from './_shared'

// ── The shared modal shell (h10 idiom) ───────────────────────────────────────
function H10Modal(props: { open: boolean; onClose: () => void; title: string; subtitle?: string; footer: ReactNode; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])
  if (!props.open) return null
  return (
    <div className="h10-modal-backdrop" onClick={props.onClose}>
      <div className={`h10-modal${props.wide ? ' wide' : ''}`} style={props.wide ? { width: 760 } : undefined} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={props.title}>
        <div className="h10-modal-h"><b>{props.title}</b><button type="button" className="h10-modal-x" onClick={props.onClose} aria-label="Close"><X size={16} /></button></div>
        {props.subtitle && <div className="h10-modal-sub">{props.subtitle}</div>}
        <div className="h10-modal-b"><div className="eb-form">{props.children}</div></div>
        <div className="eb-modal-f">{props.footer}</div>
      </div>
    </div>
  )
}

function ResultsList({ results }: { results: WriteItemOutcome[] }) {
  return (
    <ul className="eb-results">
      {results.map((r, i) => (
        <li key={`${r.key}-${i}`} className={r.blocked ? 'blocked' : r.ok ? (r.warning ? 'warn' : 'ok') : 'err'}>
          <code>{r.key}</code> — {r.blocked ?? r.error ?? r.warning ?? (r.ok ? `done (${r.mode})` : 'failed')}
        </li>
      ))}
    </ul>
  )
}

const Err = ({ msg }: { msg: string | null }) => (msg ? <ul className="eb-results"><li className="err">{msg}</li></ul> : null)

// ── Promote (product-first or campaign-scoped) ───────────────────────────────
export function PromoteModal(props: {
  open: boolean
  onClose: () => void
  productIds?: string[]
  listingIds?: string[]
  presetCampaignId?: string
  onDone?: () => void
}) {
  const mode = useWriteMode()
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([])
  const [campaignId, setCampaignId] = useState(props.presetCampaignId ?? '')
  const [ratePct, setRatePct] = useState('8')
  const [overrideReason, setOverrideReason] = useState('')
  const [manualIds, setManualIds] = useState('')
  const noPreselection = (props.productIds?.length ?? 0) + (props.listingIds?.length ?? 0) === 0
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)

  useEffect(() => {
    if (!props.open) return
    setResults(null); setError(null); setManualIds('')
    setCampaignId(props.presetCampaignId ?? '')
    fetch(`${getBackendUrl()}/api/ebay-ads/campaigns`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const all = j.campaigns as CampaignRow[]
        const eligible = all.filter((c) => c.fundingModel === 'COST_PER_SALE' && !c.isRulesBased && c.status !== 'ENDED' && !c.channels.includes('OFF_SITE'))
        // keep the preset campaign selectable even if it wouldn't normally qualify
        const preset = props.presetCampaignId ? all.find((c) => c.id === props.presetCampaignId) : undefined
        setCampaigns(preset && !eligible.some((c) => c.id === preset.id) ? [preset, ...eligible] : eligible)
        if (!props.presetCampaignId && eligible[0]) setCampaignId(eligible[0].id)
      })
      .catch((e) => setError((e as Error).message))
  }, [props.open, props.presetCampaignId])

  const launch = async () => {
    setBusy(true); setError(null)
    try {
      const manual = manualIds.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d{9,15}$/.test(s))
      if (noPreselection && manual.length === 0) throw new Error('paste at least one eBay item ID (9–15 digits)')
      const out = await postEbayAds<{ mode: string; results: WriteItemOutcome[] }>('/promote', {
        productIds: props.productIds,
        listingIds: [...(props.listingIds ?? []), ...manual],
        marketplace: 'EBAY_IT',
        campaignId,
        defaultRatePct: Number(ratePct),
        ...(overrideReason.trim() ? { override: { reason: overrideReason.trim() } } : {}),
      })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal
      open={props.open}
      onClose={props.onClose}
      title="Promote on eBay"
      subtitle={props.productIds?.length ? `${props.productIds.length} product(s) — every live item ID resolves automatically` : props.listingIds?.length ? `${props.listingIds.length} listing(s) selected` : 'Paste item IDs to promote into this campaign'}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={launch} disabled={busy || !campaignId || results != null}>{busy ? 'Launching…' : 'Launch ads'}</button>
      </>}
    >
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}>
          <label>Target campaign (General, key-based)</label>
          <select className="h10-cd-input" style={{ width: '100%' }} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.status}{c.bidPercentage != null ? ` · default ${c.bidPercentage}%` : ''}</option>)}
          </select>
        </div>
        <div>
          <label>Ad rate %</label>
          <input className="h10-cd-input" style={{ width: 90 }} type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
        </div>
      </div>
      {noPreselection && (
        <div>
          <label>eBay item IDs — space/comma/newline separated</label>
          <textarea className="eb-textarea" rows={3} value={manualIds} onChange={(e) => setManualIds(e.target.value)} placeholder="256568121061 256566107046 …" />
        </div>
      )}
      <div>
        <label>Guardrail override reason (only to exceed break-even — audited)</label>
        <input className="h10-cd-input" style={{ width: '100%' }} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. launch push, 2 weeks" />
      </div>
      <p className="eb-be-hint">Rates above a listing's <b>break-even</b> are blocked unless you give an explicit override reason. Listings without cost data go through with a warning. A listing already promoted in another General campaign is rejected by eBay per item (one listing = one General campaign).</p>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}

// ── Budget (CPC) ─────────────────────────────────────────────────────────────
export function BudgetModal(props: { open: boolean; onClose: () => void; campaignId: string; currentCents: number | null; usedToday: number; onDone?: () => void }) {
  const mode = useWriteMode()
  const [value, setValue] = useState(props.currentCents != null ? (props.currentCents / 100).toFixed(2) : '5.00')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const apply = async () => {
    setBusy(true); setMsg(null)
    try {
      const out = await postEbayAds<{ mode: string; budgetUpdatesToday: number }>(`/campaigns/${props.campaignId}/budget`, { dailyBudgetCents: Math.round(Number(value) * 100) })
      setMsg(`Budget saved (${out.mode}) — ${out.budgetUpdatesToday}/15 edits used today`)
      props.onDone?.()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Daily budget"
      subtitle={`eBay hard limit: 15 budget edits per campaign per day — ${props.usedToday}/15 used. Monthly pacing may spend up to 2× the daily budget on a single day.`}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy}>{busy ? 'Saving…' : 'Save budget'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div><label>Daily budget (EUR)</label><input className="h10-cd-input" style={{ width: 140 }} type="number" min={1} step={0.5} value={value} onChange={(e) => setValue(e.target.value)} /></div>
      {msg && <ul className="eb-results"><li className={/saved/i.test(msg) ? 'ok' : 'err'}>{msg}</li></ul>}
    </H10Modal>
  )
}

// ── Keywords / negatives ─────────────────────────────────────────────────────
export function AddKeywordsModal(props: { open: boolean; onClose: () => void; campaignId: string; adGroups: Array<{ id: string; name: string }>; onDone?: () => void }) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState('')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState('PHRASE')
  const [bid, setBid] = useState('0.30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  useEffect(() => { if (props.open) { setResults(null); setError(null); setAdGroupId(props.adGroups[0]?.id ?? '') } }, [props.open, props.adGroups])

  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const keywords = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType, bidCents: Math.round(Number(bid) * 100) }))
      if (!keywords.length) throw new Error('add at least one keyword (one per line)')
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/keywords`, { adGroupId, keywords })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Add keywords" subtitle="One per line · ≤100 chars · ≤10 words · BROAD / PHRASE / EXACT"
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add keywords'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}><label>Ad group</label>
          <select className="h10-cd-input" style={{ width: '100%' }} value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)}>{props.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        </div>
        <div><label>Match</label>
          <select className="h10-cd-input" value={matchType} onChange={(e) => setMatchType(e.target.value)}><option>EXACT</option><option>PHRASE</option><option>BROAD</option></select>
        </div>
        <div><label>Bid (EUR)</label><input className="h10-cd-input" style={{ width: 90 }} type="number" min={0.02} max={100} step={0.01} value={bid} onChange={(e) => setBid(e.target.value)} /></div>
      </div>
      <div><label>Keywords</label><textarea className="eb-textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'giacca moto uomo\ngiubbotto moto impermeabile'} /></div>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}

export function AddNegativesModal(props: { open: boolean; onClose: () => void; campaignId: string; adGroups: Array<{ id: string; name: string }>; onDone?: () => void }) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState('')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState<'EXACT' | 'PHRASE'>('EXACT')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) { setResults(null); setError(null); setAdGroupId(props.adGroups[0]?.id ?? '') } }, [props.open, props.adGroups])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const negatives = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType }))
      if (!negatives.length) throw new Error('add at least one negative keyword')
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/negatives`, { adGroupId, negatives })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Add negative keywords" subtitle="EXACT or PHRASE only — eBay has no broad negatives"
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add negatives'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      <div className="eb-form-row">
        <div style={{ flex: 1 }}><label>Ad group</label>
          <select className="h10-cd-input" style={{ width: '100%' }} value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)}>{props.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        </div>
        <div><label>Match</label>
          <select className="h10-cd-input" value={matchType} onChange={(e) => setMatchType(e.target.value as 'EXACT' | 'PHRASE')}><option>EXACT</option><option>PHRASE</option></select>
        </div>
      </div>
      <div><label>Negatives — one per line</label><textarea className="eb-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></div>
      <Err msg={error} />
      {results && <ResultsList results={results} />}
    </H10Modal>
  )
}

// ── CSV import ───────────────────────────────────────────────────────────────
interface CsvDiffRow { row: number; kind: string; target: string; from: string; to: string; note: string | null; error: string | null }

export function ImportCsvModal(props: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const mode = useWriteMode()
  const [csvText, setCsvText] = useState('')
  const [diff, setDiff] = useState<CsvDiffRow[] | null>(null)
  const [parseErrors, setParseErrors] = useState<Array<{ row: number; error: string }>>([])
  const [applied, setApplied] = useState<Array<{ row: number; ok: boolean; mode: string; detail: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) { setDiff(null); setApplied(null); setError(null) } }, [props.open])

  const run = async (dryRun: boolean) => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ diff: CsvDiffRow[]; parseErrors: Array<{ row: number; error: string }>; applied: Array<{ row: number; ok: boolean; mode: string; detail: string }> | null }>('/import', { csv: csvText, dryRun })
      setDiff(out.diff); setParseErrors(out.parseErrors); setApplied(out.applied)
      if (!dryRun) props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} wide title="Import ad operations (CSV)"
      subtitle="Columns: entity, campaign_id, listing_id, ad_rate_pct, keyword_id, bid_eur, daily_budget_eur, action(add|remove|pause|resume|end). Start from Export Data to get the exact shape."
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn" onClick={() => run(true)} disabled={busy || !csvText.trim()}>{busy ? '…' : 'Dry-run'}</button>
        <button type="button" className="h10-am-btn primary" onClick={() => run(false)} disabled={busy || !diff || diff.every((d) => d.error) || applied != null}>Apply valid rows</button>
      </>}>
      <SandboxBanner mode={mode} />
      <textarea className="eb-textarea" rows={6} value={csvText} onChange={(e) => { setCsvText(e.target.value); setDiff(null); setApplied(null) }} placeholder="Paste CSV here…" />
      <Err msg={error} />
      {parseErrors.length > 0 && <ul className="eb-results">{parseErrors.map((p) => <li key={p.row} className="err">row {p.row}: {p.error}</li>)}</ul>}
      {diff && (
        <table className="eb-difftable">
          <thead><tr><th>#</th><th>Op</th><th>Target</th><th>From</th><th>To</th><th>Check</th></tr></thead>
          <tbody>
            {diff.map((r) => (
              <tr key={r.row}>
                <td>{r.row}</td><td>{r.kind}</td><td>{r.target}</td><td>{r.from}</td><td>{r.to}</td>
                <td>{r.error ? <span className="h10-pill warn">{r.error}</span> : r.note ? <span className="h10-pill warn">{r.note}</span> : <span className="h10-pill ok">ok</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {applied && <ul className="eb-results">{applied.map((a) => <li key={a.row} className={a.ok ? 'ok' : 'err'}>row {a.row}: {a.detail} ({a.mode})</li>)}</ul>}
    </H10Modal>
  )
}

// ── Clone ────────────────────────────────────────────────────────────────────
export function CloneModal(props: { open: boolean; onClose: () => void; campaignId: string; sourceName: string; onDone?: (newId: string) => void }) {
  const mode = useWriteMode()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ campaignId: string; counts?: Record<string, number> } | null>(null)
  useEffect(() => { if (props.open) { setName(`${props.sourceName} (copy)`); setError(null); setDone(null) } }, [props.open, props.sourceName])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ campaignId: string; counts?: Record<string, number> }>(`/campaigns/${props.campaignId}/clone`, { name })
      setDone(out)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Clone campaign"
      subtitle="Structure always copies. Keywords/ad groups/negatives + scoped rules rematerialize; General ads copy only from ENDED sources (a live campaign still owns its listings)."
      footer={done ? <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => { props.onDone?.(done.campaignId); props.onClose() }}>Open clone</button>
      </> : <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={apply} disabled={busy || !name.trim()}>{busy ? 'Cloning…' : 'Clone'}</button>
      </>}>
      <SandboxBanner mode={mode} />
      {done ? (
        <ul className="eb-results">
          <li className="ok">Campaign created</li>
          {done.counts && Object.entries(done.counts).filter(([, v]) => v > 0).map(([k, v]) => (
            <li key={k} className={k === 'skippedAds' ? 'warn' : 'ok'}>
              {k === 'skippedAds' ? `${v} ad(s) NOT copied — source is live and still owns its listings (use the builder's "move" to transfer)` : `${v} ${k} copied`}
            </li>
          ))}
        </ul>
      ) : (
        <div><label>New campaign name</label><input className="h10-cd-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} /></div>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}

// ── Match a listing to a catalog product (unlocks costs + break-evens) ──────
interface MatchCandidate { id: string; sku: string; name: string; costPriceCents: number | null; suggested: boolean }

export function MatchModal(props: { open: boolean; onClose: () => void; itemId: string; marketplace: string; listingTitle: string | null; onDone?: () => void }) {
  const [q, setQ] = useState('')
  const [cands, setCands] = useState<MatchCandidate[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) return
    setQ(''); setPick(null); setError(null); setCands(null)
  }, [props.open, props.itemId])

  useEffect(() => {
    if (!props.open) return
    const t = setTimeout(() => {
      const params = new URLSearchParams({ itemId: props.itemId, marketplace: props.marketplace, ...(q.trim() ? { q: q.trim() } : {}) })
      fetch(`${getBackendUrl()}/api/ebay-ads/products/match-candidates?${params}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j: { candidates: MatchCandidate[] }) => setCands(j.candidates))
        .catch((e) => setError((e as Error).message))
    }, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [props.open, props.itemId, props.marketplace, q])

  const save = async () => {
    if (!pick) return
    setBusy(true); setError(null)
    try {
      await postEbayAds('/products/match', { itemId: props.itemId, marketplace: props.marketplace, productId: pick })
      props.onDone?.(); props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Match listing to product" wide
      subtitle={`${props.listingTitle ?? props.itemId} — pick the catalog product behind this eBay listing. Suggestions are title-similarity only; your confirmation is what links them. Sticky across syncs.`}
      footer={<>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => void save()} disabled={busy || !pick}>{busy ? 'Matching…' : 'Match'}</button>
      </>}>
      <div>
        <label>Search catalog (name / SKU) — leave empty for suggestions</label>
        <input className="h10-cd-input" style={{ width: '100%' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. GALE, VENTRA, slider…" />
      </div>
      {cands == null ? (
        <p className="eb-be-hint">Loading candidates…</p>
      ) : cands.length === 0 ? (
        <p className="eb-be-hint">No candidates — try a search term.</p>
      ) : (
        <ul className="eb-results" style={{ maxHeight: 300 }}>
          {cands.map((c) => (
            <li key={c.id} className={pick === c.id ? 'ok' : ''} style={{ cursor: 'pointer' }} onClick={() => setPick(c.id)}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="radio" name="match-candidate" checked={pick === c.id} onChange={() => setPick(c.id)} />
                <span style={{ flex: 1 }}>{c.name}</span>
                <code>{c.sku}</code>
                {c.suggested && <span className="h10-pill arch">suggested</span>}
                {c.costPriceCents != null && <span className="h10-pill ok">cost €{(c.costPriceCents / 100).toFixed(2)}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}

// ── Product cost entry (the ONE operator input the margin engine waits on) ───
export function CostModal(props: { open: boolean; onClose: () => void; itemId: string; marketplace: string; listingTitle: string | null; productSku: string | null; currentCostCents: number | null; onDone?: () => void }) {
  const [costEur, setCostEur] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ breakEvenAdRatePct: number | null; updatedProducts: string[] } | null>(null)
  useEffect(() => {
    if (props.open) { setCostEur(props.currentCostCents != null ? (props.currentCostCents / 100).toFixed(2) : ''); setError(null); setDone(null) }
  }, [props.open, props.itemId, props.currentCostCents])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ breakEvenAdRatePct: number | null; updatedProducts: string[] }>('/products/cost', { itemId: props.itemId, marketplace: props.marketplace, costEur: Number(costEur) })
      setDone(out)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} title="Product cost (COGS)"
      subtitle={`${props.listingTitle ?? props.itemId} — unit cost in EUR. Applies to ${props.productSku ?? "the listing's matched product(s)"}; break-even ad rate recomputes immediately. Refine per-variant later in the product editor.`}
      footer={done ? <>
        <button type="button" className="h10-am-btn primary" onClick={props.onClose}>Done</button>
      </> : <>
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn primary" onClick={() => void save()} disabled={busy || !(Number(costEur) > 0)}>{busy ? 'Saving…' : 'Save cost'}</button>
      </>}>
      {done ? (
        <ul className="eb-results">
          <li className="ok">Cost saved on {done.updatedProducts.join(', ')}</li>
          <li className={done.breakEvenAdRatePct != null ? 'ok' : 'warn'}>
            {done.breakEvenAdRatePct != null
              ? `Break-even ad rate: ${done.breakEvenAdRatePct}% — automations can now clamp to it`
              : 'Break-even still unavailable (check listing price)'}
          </li>
        </ul>
      ) : (
        <div>
          <label>Unit cost €</label>
          <input className="h10-cd-input" style={{ width: 140 }} type="number" min={0.01} step={0.01} value={costEur} onChange={(e) => setCostEur(e.target.value)} autoFocus />
        </div>
      )}
      <Err msg={error} />
    </H10Modal>
  )
}
