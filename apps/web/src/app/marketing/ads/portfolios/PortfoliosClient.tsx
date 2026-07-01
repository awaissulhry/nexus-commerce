'use client'

/**
 * Portfolios P1 — see + create. The dedicated cockpit surface for Amazon Ads portfolios:
 * a synced, enriched list (campaign membership + spend/sales rollup) plus a minimal create.
 * Reads GET /advertising/portfolios/overview, POST /advertising/portfolios/sync; creates via
 * the existing POST /advertising/portfolios (gated live write — a portfolio is an organizational
 * container, no direct spend). Assign / rename / archive / budgets land in P2–P3.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Plus, Pencil, Archive } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Select } from '@/design-system/primitives/Select'
import { Input } from '@/design-system/primitives/Input'
import { Modal } from '@/design-system/components/Modal'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { eur, pct, intl } from '../_canvas/format'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './portfolios.css'

interface PortfolioRow {
  portfolioId: string; name: string; state: string | null; marketplaces: string[]
  campaignCount: number; activeCampaignCount: number; spendCents: number; salesCents: number
  acos: number | null; source: 'amazon' | 'local'; lastSyncedAt: string | null
}

const eurc = (c?: number) => eur((c ?? 0) / 100)
const stateClass = (s: string | null) => {
  const v = (s ?? '').toUpperCase()
  return v === 'ENABLED' ? 'pf-state--enabled' : v === 'PAUSED' ? 'pf-state--paused' : v === 'ARCHIVED' ? 'pf-state--archived' : ''
}
const ago = (iso: string | null) => {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

function PortfoliosInner() {
  const [market, setMarket] = useState('all')
  const [markets, setMarkets] = useState<string[]>([])
  const [rows, setRows] = useState<PortfolioRow[]>([])
  const [lastSynced, setLastSynced] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [mode, setMode] = useState('sandbox')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newMarket, setNewMarket] = useState('IT')
  const [creating, setCreating] = useState(false)
  const [renameRow, setRenameRow] = useState<PortfolioRow | null>(null)
  const [renameName, setRenameName] = useState('')
  const [archiveRow, setArchiveRow] = useState<PortfolioRow | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const autoSyncedRef = useRef(false)
  const { toast } = useToast()

  // markets + mode (once)
  useEffect(() => {
    const base = getBackendUrl()
    fetch(`${base}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const ms = Array.from(new Set((d.items ?? []).map((c: { marketplace?: string }) => c.marketplace).filter(Boolean))) as string[]
      setMarkets(ms.sort()); if (ms.length && !ms.includes('IT')) setNewMarket(ms[0])
    }).catch(() => {})
    fetch(`${base}/api/advertising/summary`, { cache: 'no-store' }).then((r) => r.json()).then((s) => setMode(s?.mode ?? 'sandbox')).catch(() => {})
  }, [])

  const loadOverview = useCallback(async (mk: string): Promise<number> => {
    const mp = mk === 'all' ? '' : `?marketplace=${mk}`
    const d = await fetch(`${getBackendUrl()}/api/advertising/portfolios/overview${mp}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const list: PortfolioRow[] = Array.isArray(d?.portfolios) ? d.portfolios : []
    setRows(list); setLastSynced(d?.lastSyncedAt ?? null)
    return list.length
  }, [])

  const sync = useCallback(async (mk: string, silent?: boolean): Promise<void> => {
    setSyncing(true)
    try {
      const mp = mk === 'all' ? '' : `?marketplace=${mk}`
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios/sync${mp}`, { method: 'POST' }).then((x) => x.json()).catch(() => null)
      await loadOverview(mk)
      if (!silent) toast(r?.error ? `Sync failed: ${r.error}` : `Synced ${r?.synced ?? 0} portfolios · ${r?.campaignsLinked ?? 0} campaigns linked${r?.errors ? ` · ${r.errors} errors` : ''}`, r?.error ? 'danger' : 'success')
    } finally { setSyncing(false) }
  }, [loadOverview, toast])

  // load on market change; auto-sync once per session if nothing is stored yet
  useEffect(() => {
    let alive = true
    setLoading(true)
    loadOverview(market).then(async (n) => {
      if (!alive) return
      if (n === 0 && !autoSyncedRef.current) { autoSyncedRef.current = true; await sync(market, true) }
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [market, loadOverview, sync])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, marketplace: newMarket }),
      }).then((x) => x.json()).catch(() => null)
      if (r?.ok) {
        toast(`Created “${name}”${r.mode === 'live' ? ' — live on Amazon' : r.mode === 'local' ? ' — local (write gate closed)' : ''}`, 'success')
        setCreateOpen(false); setNewName('')
        await loadOverview(market)
      } else { toast(r?.error ? `Create failed: ${r.error}` : 'Create failed', 'danger') }
    } finally { setCreating(false) }
  }

  const patchPortfolio = async (portfolioId: string, patch: { name?: string; state?: string }, label: string): Promise<boolean> => {
    setRowBusy(portfolioId)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/portfolios/${portfolioId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }).then((x) => x.json()).catch(() => null)
      if (r?.ok) { toast(`${label}${r.mode === 'live' ? ' — live on Amazon' : ''}`, 'success'); await loadOverview(market); return true }
      toast(r?.error ? `${label} failed: ${r.error}` : `${label} failed`, 'danger')
      return false
    } finally { setRowBusy(null) }
  }
  const doRename = async () => {
    const n = renameName.trim()
    if (!n || !renameRow) return
    if (await patchPortfolio(renameRow.portfolioId, { name: n }, 'Renamed')) setRenameRow(null)
  }
  const doArchive = async () => {
    if (!archiveRow) return
    if (await patchPortfolio(archiveRow.portfolioId, { state: 'archived' }, 'Archived')) setArchiveRow(null)
  }

  const totals = rows.reduce((a, r) => ({ campaigns: a.campaigns + r.campaignCount, spend: a.spend + r.spendCents }), { campaigns: 0, spend: 0 })

  return (
    <div className="pf">
      <AdsPageHeader
        title="Portfolios"
        subtitle="Group campaigns into portfolios and see membership + spend at a glance."
        markets={markets} market={market} onMarketChange={setMarket}
        showDateRange={false} showDataSync={false}
      />

      {mode === 'sandbox'
        ? <div className="pf-banner">Sandbox mode — creating a portfolio is simulated; nothing is sent to Amazon.</div>
        : <div className="pf-banner pf-banner--live">Live mode — creating a portfolio is a real (gated) write to your Amazon account. Portfolios are organizational containers with no direct spend.</div>}

      <div className="pf-toolbar">
        {lastSynced && <span className="pf-synced">Last synced {ago(lastSynced)}</span>}
        <div className="pf-toolbar-r">
          <Button variant="secondary" size="sm" disabled={syncing} onClick={() => void sync(market)}><RefreshCw size={13} /> {syncing ? 'Syncing…' : 'Sync from Amazon'}</Button>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> Create portfolio</Button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="pf-tiles">
          <div className="pf-tile"><div className="pf-tile-k">Portfolios</div><div className="pf-tile-v">{intl(rows.length)}</div></div>
          <div className="pf-tile"><div className="pf-tile-k">Campaigns grouped</div><div className="pf-tile-v">{intl(totals.campaigns)}</div></div>
          <div className="pf-tile"><div className="pf-tile-k">Spend (grouped)</div><div className="pf-tile-v">{eurc(totals.spend)}</div></div>
        </div>
      )}

      {loading ? (
        <div className="pf-empty"><div className="pf-empty-p">Loading…</div></div>
      ) : rows.length === 0 ? (
        <div className="pf-empty">
          <div className="pf-empty-h">No portfolios yet</div>
          <div className="pf-empty-p">Portfolios are optional Amazon groupings for your campaigns — by product line, strategy, or budget. You don’t have any yet. Create your first, then assign campaigns to it (assignment lands next).</div>
          <div className="pf-empty-acts">
            <Button variant="secondary" size="sm" disabled={syncing} onClick={() => void sync(market)}><RefreshCw size={13} /> Sync from Amazon</Button>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> Create portfolio</Button>
          </div>
        </div>
      ) : (
        <div className="pf-tablewrap">
          <table className="pf-table">
            <thead><tr>
              <th>Portfolio</th><th>Markets</th><th className="num">Campaigns</th><th className="num">Spend</th><th className="num">Sales</th><th className="num">ACoS</th><th>Synced</th><th className="pf-actions-h">Actions</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.portfolioId}>
                  <td>
                    <span className="pf-name">
                      <span className="pf-name-main">{r.name}</span>
                      {r.state && <span className={`pf-state ${stateClass(r.state)}`}>{r.state}</span>}
                      <span className={`pf-src${r.source === 'local' ? ' pf-src--local' : ''}`}>{r.source}</span>
                    </span>
                  </td>
                  <td>{r.marketplaces.length ? <span className="pf-mkts">{r.marketplaces.map((m) => <span className="pf-mkt" key={m}>{m}</span>)}</span> : <span className="pf-mkt-none">—</span>}</td>
                  <td className="num">{r.activeCampaignCount}/{r.campaignCount}</td>
                  <td className="num">{eurc(r.spendCents)}</td>
                  <td className="num">{eurc(r.salesCents)}</td>
                  <td className="num pf-acos">{r.acos == null ? '—' : pct(r.acos)}</td>
                  <td>{ago(r.lastSyncedAt)}</td>
                  <td className="pf-actions">
                    <button type="button" className="pf-act" title="Rename" disabled={rowBusy === r.portfolioId} onClick={() => { setRenameRow(r); setRenameName(r.name) }}><Pencil size={13} /></button>
                    {(r.state ?? '').toUpperCase() !== 'ARCHIVED' && (
                      <button type="button" className="pf-act" title="Archive" disabled={rowBusy === r.portfolioId} onClick={() => setArchiveRow(r)}><Archive size={13} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create portfolio"
        footer={<>
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={creating || !newName.trim()} onClick={() => void create()}>{creating ? 'Creating…' : 'Create'}</Button>
        </>}
      >
        <div className="pf-form">
          <label className="pf-fld"><span>Name</span><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Brand — Core" aria-label="Portfolio name" /></label>
          <label className="pf-fld"><span>Marketplace</span>
            <Select value={newMarket} onChange={(e) => setNewMarket(e.target.value)} aria-label="Marketplace">
              {(markets.length ? markets : ['IT', 'DE', 'FR', 'ES']).map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </label>
          <div className={`pf-mode pf-mode--${mode === 'sandbox' ? 'sandbox' : 'live'}`}>
            {mode === 'sandbox' ? <><b>Sandbox.</b> Simulated — not sent to Amazon.</> : <><b>Live.</b> Created on Amazon (gated) — a container only, no spend.</>}
          </div>
        </div>
      </Modal>

      <Modal
        open={!!renameRow}
        onClose={() => setRenameRow(null)}
        title="Rename portfolio"
        footer={<>
          <Button variant="secondary" size="sm" onClick={() => setRenameRow(null)}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!renameName.trim() || rowBusy === renameRow?.portfolioId} onClick={() => void doRename()}>{rowBusy === renameRow?.portfolioId ? 'Saving…' : 'Save'}</Button>
        </>}
      >
        <div className="pf-form">
          <label className="pf-fld"><span>Name</span><Input value={renameName} onChange={(e) => setRenameName(e.target.value)} aria-label="Portfolio name" /></label>
          <div className={`pf-mode pf-mode--${mode === 'sandbox' ? 'sandbox' : 'live'}`}>
            {mode === 'sandbox' ? <><b>Sandbox.</b> Simulated.</> : <><b>Live.</b> Renames on Amazon (gated).</>}
          </div>
        </div>
      </Modal>

      <Modal
        open={!!archiveRow}
        onClose={() => setArchiveRow(null)}
        title="Archive portfolio"
        footer={<>
          <Button variant="secondary" size="sm" onClick={() => setArchiveRow(null)}>Cancel</Button>
          <Button variant="primary" className={mode === 'sandbox' ? undefined : 'pf-btn-danger'} size="sm" disabled={rowBusy === archiveRow?.portfolioId} onClick={() => void doArchive()}>{rowBusy === archiveRow?.portfolioId ? 'Archiving…' : 'Archive'}</Button>
        </>}
      >
        <div className="pf-form">
          <div className="pf-confirm-name">Archive <b>{archiveRow?.name}</b>?</div>
          <div className={`pf-mode pf-mode--${mode === 'sandbox' ? 'sandbox' : 'live'}`}>
            {mode === 'sandbox'
              ? <><b>Sandbox.</b> Simulated — not sent to Amazon.</>
              : <><b>Live.</b> Archives on Amazon (gated). Campaigns aren’t deleted — they become unportfolio’d. Archiving may not be reversible on Amazon.</>}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export function PortfoliosClient() {
  return <ToastProvider><PortfoliosInner /></ToastProvider>
}
