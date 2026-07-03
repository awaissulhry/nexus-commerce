'use client'

/**
 * E4 — write modals for the eBay console. Every apply →
 * POST /api/ebay-ads/* → audited write service (gate/guardrails/audit).
 * Results render per-item (created / warned / BLOCKED by break-even / failed)
 * and say which mode ran (sandbox vs live).
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import {
  postEbayAds, SandboxBanner, ResultsList, useWriteMode,
  type WriteItemOutcome, type CampaignRow,
} from './_shared'

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
    setResults(null); setError(null)
    fetch(`${getBackendUrl()}/api/ebay-ads/campaigns`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const eligible = (j.campaigns as CampaignRow[]).filter((c) => c.fundingModel === 'COST_PER_SALE' && !c.isRulesBased && c.status !== 'ENDED' && !c.channels.includes('OFF_SITE'))
        setCampaigns(eligible)
        if (!props.presetCampaignId && eligible[0]) setCampaignId(eligible[0].id)
      })
      .catch((e) => setError((e as Error).message))
  }, [props.open, props.presetCampaignId])

  const launch = async () => {
    setBusy(true); setError(null)
    try {
      const manual = manualIds.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d{9,15}$/.test(s))
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
    <Modal open={props.open} onClose={props.onClose} size="md" title="Promote on eBay"
      subtitle={props.productIds?.length ? `${props.productIds.length} product(s) → every live item ID resolves automatically` : `${props.listingIds?.length ?? 0} listing(s)`}
      footer={<>
        <Button variant="ghost" onClick={props.onClose}>Close</Button>
        <Button onClick={launch} disabled={busy || !campaignId || results != null}>{busy ? 'Launching…' : 'Launch ads'}</Button>
      </>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div className="eb-form-row">
          <div style={{ flex: 1 }}>
            <label>Target campaign (General, key-based)</label>
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.status}{c.bidPercentage != null ? ` · default ${c.bidPercentage}%` : ''}</option>)}
            </Select>
          </div>
          <div>
            <label>Ad rate %</label>
            <Input type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
          </div>
        </div>
        <div>
          <label>Guardrail override reason (optional — only needed to exceed break-even; audited)</label>
          <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. launch push, 2 weeks" />
        </div>
        {noPreselection && (
          <div>
            <label>eBay item IDs — space/comma/newline separated</label>
            <textarea className="eb-textarea" rows={3} value={manualIds} onChange={(e) => setManualIds(e.target.value)} placeholder="256568121061 256566107046 …" />
          </div>
        )}
        <p className="eb-be-hint">Rates above a listing's <b>break-even</b> are blocked unless you give an explicit override reason. Listings without cost data go through with a warning.</p>
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
        {results && <ResultsList results={results} />}
      </div>
    </Modal>
  )
}

// ── Set rates on selected ads ────────────────────────────────────────────────
export function SetRatesModal(props: { open: boolean; onClose: () => void; campaignId: string; listingIds: string[]; onDone?: () => void }) {
  const mode = useWriteMode()
  const [ratePct, setRatePct] = useState('8')
  const [overrideReason, setOverrideReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)

  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/ad-rates`, {
        items: props.listingIds.map((listingId) => ({ listingId, ratePct: Number(ratePct) })),
        ...(overrideReason.trim() ? { override: { reason: overrideReason.trim() } } : {}),
      })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open={props.open} onClose={props.onClose} size="sm" title={`Set ad rate — ${props.listingIds.length} ad(s)`}
      footer={<><Button variant="ghost" onClick={props.onClose}>Close</Button><Button onClick={apply} disabled={busy || results != null}>{busy ? 'Applying…' : 'Apply rate'}</Button></>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div className="eb-form-row">
          <div><label>New ad rate %</label><Input type="number" min={2} max={100} step={0.1} value={ratePct} onChange={(e) => setRatePct(e.target.value)} /></div>
          <div style={{ flex: 1 }}><label>Override reason (to exceed break-even)</label><Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} /></div>
        </div>
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
        {results && <ResultsList results={results} />}
      </div>
    </Modal>
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
      setMsg(`Budget set (${out.mode}) — ${out.budgetUpdatesToday}/15 edits used today`)
      props.onDone?.()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open={props.open} onClose={props.onClose} size="sm" title="Daily budget"
      subtitle={`eBay hard limit: 15 budget edits per campaign per day — ${props.usedToday}/15 used`}
      footer={<><Button variant="ghost" onClick={props.onClose}>Close</Button><Button onClick={apply} disabled={busy}>{busy ? 'Saving…' : 'Save budget'}</Button></>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div><label>Daily budget (EUR)</label><Input type="number" min={1} step={0.5} value={value} onChange={(e) => setValue(e.target.value)} /></div>
        {msg && <ul className="eb-results"><li className={/15/.test(msg) && !/exhausted/.test(msg) ? 'ok' : 'err'}>{msg}</li></ul>}
      </div>
    </Modal>
  )
}

// ── Keywords / negatives ─────────────────────────────────────────────────────
export function AddKeywordsModal(props: { open: boolean; onClose: () => void; campaignId: string; adGroups: Array<{ id: string; name: string }>; onDone?: () => void }) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState(props.adGroups[0]?.id ?? '')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState('PHRASE')
  const [bid, setBid] = useState('0.30')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  useEffect(() => { if (props.open && props.adGroups[0] && !adGroupId) setAdGroupId(props.adGroups[0].id) }, [props.open, props.adGroups, adGroupId])

  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const keywords = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType, bidCents: Math.round(Number(bid) * 100) }))
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/keywords`, { adGroupId, keywords })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open={props.open} onClose={props.onClose} size="md" title="Add keywords"
      footer={<><Button variant="ghost" onClick={props.onClose}>Close</Button><Button onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add keywords'}</Button></>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div className="eb-form-row">
          <div style={{ flex: 1 }}><label>Ad group</label><Select value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)}>{props.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></div>
          <div><label>Match</label><Select value={matchType} onChange={(e) => setMatchType(e.target.value)}><option>EXACT</option><option>PHRASE</option><option>BROAD</option></Select></div>
          <div><label>Bid (EUR)</label><Input type="number" min={0.02} max={100} step={0.01} value={bid} onChange={(e) => setBid(e.target.value)} /></div>
        </div>
        <div>
          <label>Keywords — one per line (≤100 chars, ≤10 words each)</label>
          <textarea className="eb-textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'giacca moto uomo\ngiubbotto moto impermeabile'} />
        </div>
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
        {results && <ResultsList results={results} />}
      </div>
    </Modal>
  )
}

export function AddNegativesModal(props: { open: boolean; onClose: () => void; campaignId: string; adGroups: Array<{ id: string; name: string }>; onDone?: () => void }) {
  const mode = useWriteMode()
  const [adGroupId, setAdGroupId] = useState(props.adGroups[0]?.id ?? '')
  const [text, setText] = useState('')
  const [matchType, setMatchType] = useState<'EXACT' | 'PHRASE'>('EXACT')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<WriteItemOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open && props.adGroups[0] && !adGroupId) setAdGroupId(props.adGroups[0].id) }, [props.open, props.adGroups, adGroupId])
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const negatives = text.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t, matchType }))
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${props.campaignId}/negatives`, { adGroupId, negatives })
      setResults(out.results)
      props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open={props.open} onClose={props.onClose} size="sm" title="Add negative keywords" subtitle="EXACT or PHRASE only (eBay has no broad negatives)"
      footer={<><Button variant="ghost" onClick={props.onClose}>Close</Button><Button onClick={apply} disabled={busy || !adGroupId || results != null}>{busy ? 'Adding…' : 'Add negatives'}</Button></>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div className="eb-form-row">
          <div style={{ flex: 1 }}><label>Ad group</label><Select value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)}>{props.adGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></div>
          <div><label>Match</label><Select value={matchType} onChange={(e) => setMatchType(e.target.value as 'EXACT' | 'PHRASE')}><option>EXACT</option><option>PHRASE</option></Select></div>
        </div>
        <div><label>Negatives — one per line</label><textarea className="eb-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></div>
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
        {results && <ResultsList results={results} />}
      </div>
    </Modal>
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

  const columns: Column<CsvDiffRow>[] = useMemo(() => [
    { key: 'row', label: '#', width: 46, render: (r) => String(r.row) },
    { key: 'kind', label: 'Op', width: 130, render: (r) => r.kind },
    { key: 'target', label: 'Target', width: 190, render: (r) => r.target },
    { key: 'from', label: 'From', width: 110, render: (r) => r.from },
    { key: 'to', label: 'To', width: 110, render: (r) => r.to },
    { key: 'state', label: 'Check', render: (r) => r.error ? <span className="eb-chip eb-chip--stale">{r.error}</span> : r.note ? <span className="eb-chip eb-chip--warn">{r.note}</span> : <span className="eb-chip eb-chip--run">ok</span> },
  ], [])

  const run = async (dryRun: boolean) => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ diff: CsvDiffRow[]; parseErrors: Array<{ row: number; error: string }>; applied: Array<{ row: number; ok: boolean; mode: string; detail: string }> | null }>('/import', { csv: csvText, dryRun })
      setDiff(out.diff); setParseErrors(out.parseErrors); setApplied(out.applied)
      if (!dryRun) props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open={props.open} onClose={props.onClose} size="lg" title="Import ad operations (CSV)"
      subtitle="Columns: entity, campaign_id, listing_id, ad_rate_pct, keyword_id, bid_eur, daily_budget_eur, action(add|remove|pause|resume|end)"
      footer={<>
        <Button variant="ghost" onClick={props.onClose}>Close</Button>
        <Button variant="ghost" onClick={() => run(true)} disabled={busy || !csvText.trim()}>{busy ? '…' : 'Dry-run'}</Button>
        <Button onClick={() => run(false)} disabled={busy || !diff || diff.every((d) => d.error) || applied != null}>Apply valid rows</Button>
      </>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <textarea className="eb-textarea" rows={6} value={csvText} onChange={(e) => { setCsvText(e.target.value); setDiff(null); setApplied(null) }} placeholder="Paste CSV here (start from the Export to get the exact shape)…" />
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
        {parseErrors.length > 0 && <ul className="eb-results">{parseErrors.map((p) => <li key={p.row} className="err">row {p.row}: {p.error}</li>)}</ul>}
        {diff && <DataGrid<CsvDiffRow> columns={columns} rows={diff} rowKey={(r) => String(r.row)} maxHeight={240} />}
        {applied && <ul className="eb-results">{applied.map((a) => <li key={a.row} className={a.ok ? 'ok' : 'err'}>row {a.row}: {a.detail} ({a.mode})</li>)}</ul>}
      </div>
    </Modal>
  )
}

// ── Clone ────────────────────────────────────────────────────────────────────
export function CloneModal(props: { open: boolean; onClose: () => void; campaignId: string; sourceName: string; onDone?: (newId: string) => void }) {
  const mode = useWriteMode()
  const [name, setName] = useState(`${props.sourceName} (copy)`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ campaignId: string }>(`/campaigns/${props.campaignId}/clone`, { name })
      props.onDone?.(out.campaignId)
      props.onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open={props.open} onClose={props.onClose} size="sm" title="Clone campaign" subtitle="Rules-based campaigns clone with their selection rules (rules are immutable on eBay — cloning is how you change them)."
      footer={<><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button onClick={apply} disabled={busy || !name.trim()}>{busy ? 'Cloning…' : 'Clone'}</Button></>}>
      <div className="eb-form">
        <SandboxBanner mode={mode} />
        <div><label>New campaign name</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        {error && <ul className="eb-results"><li className="err">{error}</li></ul>}
      </div>
    </Modal>
  )
}
