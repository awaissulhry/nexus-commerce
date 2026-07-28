'use client'

/**
 * AX2.10 — Structure Blueprints, in the product.
 *
 * Replication existed only as API routes, which meant pasting fetch() into a
 * browser console. This is the same workflow as a surface: extract a structure,
 * inspect what is product-specific vs shared, replicate it onto another
 * product, and — the step that matters — resolve every keyword that would make
 * your own two products bid against each other before anything is created.
 *
 * Safety mirrors the API: the dry run is the default and the Launch button
 * stays disabled until the plan comes back `allowed`.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsPageHeader } from '../_shell/AdsPageHeader'

const MARKETS = ['IT', 'DE', 'FR', 'ES']

async function ads<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(`${getBackendUrl()}/api/advertising${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; blockers?: string[] }
  if (!r.ok) throw new Error(j.error ?? (j.blockers ? j.blockers.join(' · ') : `HTTP ${r.status}`))
  return j
}

interface BlueprintRow {
  id: string; name: string; description: string | null; marketplace: string
  productToken: string; createdAt: string
  stats: { campaigns: number; adGroups: number; positives: number; negatives: number; productAds: number } | null
  sharedTargetCount: number
  roles: string[]
}
interface Conflict { expression: string; existing: Array<{ campaignName: string; campaignId: string }>; resolution: string }
interface Plan {
  allowed: boolean; blockers: string[]; warnings: string[]; conflicts: Conflict[]
  totals: { campaigns: number; adGroups: number; positives: number; negatives: number; productAds: number; dailyBudgetTotal: number }
  campaigns: Array<{ role: string; name: string; dailyBudget: number | null }>
}
interface ApplyResult {
  applicationId: string; status: string; plan: Plan
  created: { campaigns: number; adGroups: number; targets: number; negatives: number; productAds: number }
  skippedNonKeyword: number; notOnAmazon: string[]; errors: string[]
}
interface AppRow {
  id: string; blueprintId: string; productToken: string; marketplace: string; status: string
  createdCampaignIds: string[]; notOnAmazon: string[]; errors: string[]; createdAt: string; appliedAt: string | null
}

export function BlueprintsClient() {
  const [market, setMarket] = useState('IT')
  const [rows, setRows] = useState<BlueprintRow[]>([])
  const [apps, setApps] = useState<AppRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ── create ────────────────────────────────────────────────────────────
  const [newName, setNewName] = useState('')
  const [prefix, setPrefix] = useState('IT-AIREON-SP-')
  const [srcToken, setSrcToken] = useState('AIREON')

  // ── replicate ─────────────────────────────────────────────────────────
  const [active, setActive] = useState<BlueprintRow | null>(null)
  const [token, setToken] = useState('')
  const [asins, setAsins] = useState('')
  const [capEur, setCapEur] = useState('150')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [decisions, setDecisions] = useState<Record<string, 'skip' | 'accept'>>({})
  const [result, setResult] = useState<ApplyResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [b, a] = await Promise.all([
        ads<{ items: BlueprintRow[] }>('/blueprints'),
        ads<{ items: AppRow[] }>('/blueprint-applications'),
      ])
      setRows(b.items ?? []); setApps(a.items ?? [])
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    if (!newName.trim() || !prefix.trim() || !srcToken.trim()) return
    setBusy(true); setErr(null)
    try {
      await ads('/blueprints', { name: newName.trim(), namePrefix: prefix.trim(), productToken: srcToken.trim().toUpperCase(), marketplace: market })
      setNewName(''); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try { await ads(`/blueprints/${id}`, undefined, 'DELETE'); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const asinList = () => asins.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)

  /** Dry run. Never creates anything — the API defaults dryRun to true. */
  const dryRun = async (bp: BlueprintRow, useDecisions = true) => {
    setBusy(true); setErr(null); setResult(null)
    try {
      const skip = useDecisions ? Object.entries(decisions).filter(([, v]) => v === 'skip').map(([k]) => k) : []
      const accept = useDecisions ? Object.entries(decisions).filter(([, v]) => v === 'accept').map(([k]) => k) : []
      const out = await ads<ApplyResult>(`/blueprints/${bp.id}/apply`, {
        productToken: token.trim().toUpperCase(), asins: asinList(), marketplace: market,
        dailyBudgetCapEur: capEur ? Number(capEur) : undefined,
        skipSharedTargets: skip, acceptSharedTargets: accept,
      })
      setPlan(out.plan)
      // First look: default every conflict to SKIP — the safe choice.
      if (!useDecisions) {
        const d: Record<string, 'skip' | 'accept'> = {}
        for (const c of out.plan.conflicts) d[c.expression] = 'skip'
        setDecisions(d)
      }
    } catch (e) { setErr((e as Error).message); setPlan(null) } finally { setBusy(false) }
  }

  const launch = async (bp: BlueprintRow) => {
    if (!plan?.allowed) return
    setBusy(true); setErr(null)
    try {
      const out = await ads<ApplyResult>(`/blueprints/${bp.id}/apply`, {
        productToken: token.trim().toUpperCase(), asins: asinList(), marketplace: market,
        dailyBudgetCapEur: capEur ? Number(capEur) : undefined,
        skipSharedTargets: Object.entries(decisions).filter(([, v]) => v === 'skip').map(([k]) => k),
        acceptSharedTargets: Object.entries(decisions).filter(([, v]) => v === 'accept').map(([k]) => k),
        dryRun: false,
      })
      setResult(out); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const rollback = async (id: string) => {
    setBusy(true)
    try { await ads(`/blueprint-applications/${id}/rollback`, {}); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const closeReplicate = () => { setActive(null); setPlan(null); setResult(null); setDecisions({}); setToken(''); setAsins('') }

  return (
    <div className="h10-am">
      <AdsPageHeader
        title="Structure Blueprints"
        subtitle="Capture a working campaign structure and replicate it onto another product"
        markets={MARKETS} market={market} onMarketChange={setMarket}
        showDateRange={false} showDataSync={false}
      />

      {err && (
        <div className="h10-cd-card pad" style={{ marginBottom: 12, borderLeft: '3px solid #c0392b' }}>
          <b>Couldn’t complete that:</b> {err}
        </div>
      )}

      {/* ── create ─────────────────────────────────────────────────────── */}
      <div className="h10-cd-card pad" style={{ marginBottom: 14 }}>
        <b className="eb-hd">Capture a blueprint</b>
        <p className="eb-cap" style={{ margin: '4px 0 10px', maxWidth: 760, lineHeight: 1.5 }}>
          Reads an existing set of campaigns and stores their structure with everything product-specific —
          ASINs, brand keywords, the product name — replaced by a placeholder. Nothing is created or changed.
          Roles are derived from campaign names, so this works on the <code>IT-TOKEN-SP-Role</code> convention.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="eb-cap">Blueprint name</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="SP Jacket Standard" style={{ minWidth: 240 }} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="eb-cap">Source campaigns starting with</span>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ minWidth: 200 }} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="eb-cap">Source product token</span>
            <input value={srcToken} onChange={(e) => setSrcToken(e.target.value)} style={{ minWidth: 140 }} />
          </label>
          <button type="button" className="h10-am-btn primary" disabled={busy || !newName.trim()} onClick={() => void create()}>
            {busy ? 'Working…' : 'Capture'}
          </button>
        </div>
      </div>

      {/* ── list ───────────────────────────────────────────────────────── */}
      <div className="h10-cd-card pad" style={{ marginBottom: 14 }}>
        <b className="eb-hd">Blueprints</b>
        {loading ? <p className="eb-cap" style={{ marginTop: 8 }}>Loading…</p>
          : rows.length === 0 ? <p className="eb-cap" style={{ marginTop: 8 }}>None yet — capture one above.</p>
          : (
            <table className="h10-am-grid" style={{ width: '100%', marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Name</th>
                  <th style={{ textAlign: 'left' }}>Roles</th>
                  <th>Campaigns</th><th>Positives</th><th>Negatives</th>
                  <th>Shared</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <b>{b.name}</b>
                      <div className="eb-cap">{b.marketplace} · from {b.productToken}</div>
                    </td>
                    <td style={{ maxWidth: 300 }}><span className="eb-cap">{b.roles.join(', ') || '—'}</span></td>
                    <td style={{ textAlign: 'center' }}>{b.stats?.campaigns ?? '—'}</td>
                    <td style={{ textAlign: 'center' }}>{b.stats?.positives ?? '—'}</td>
                    <td style={{ textAlign: 'center' }}>{b.stats?.negatives ?? '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={`h10-pill ${b.sharedTargetCount ? 'warn' : 'ok'}`}
                        title="Positive keywords that are not specific to the source product. Replicating these can make two of your products bid against each other.">
                        {b.sharedTargetCount}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="h10-am-btn primary" onClick={() => { setActive(b); setPlan(null); setResult(null); setDecisions({}) }}>
                        <Copy size={13} aria-hidden /> Replicate
                      </button>
                      <button type="button" className="h10-am-btn" style={{ marginLeft: 6 }} disabled={busy} onClick={() => void remove(b.id)} aria-label={`Delete ${b.name}`}>
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── replicate ──────────────────────────────────────────────────── */}
      {active && (
        <div className="h10-cd-card pad" style={{ marginBottom: 14, borderLeft: '3px solid #2d6cdf' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <b className="eb-hd">Replicate “{active.name}” onto a product</b>
            <span className="grow" style={{ flex: 1 }} />
            <button type="button" className="h10-am-link" onClick={closeReplicate}>close</button>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', margin: '10px 0' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="eb-cap">New product token</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="VENTRA" style={{ minWidth: 160 }} />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 280 }}>
              <span className="eb-cap">ASINs to advertise (space or comma separated)</span>
              <input value={asins} onChange={(e) => setAsins(e.target.value)} placeholder="B0XXXXXXX1 B0XXXXXXX2" />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="eb-cap">Daily budget cap €</span>
              <input value={capEur} onChange={(e) => setCapEur(e.target.value)} style={{ width: 110 }} inputMode="decimal" />
            </label>
            <button type="button" className="h10-am-btn" disabled={busy || !token.trim() || asinList().length === 0}
              onClick={() => void dryRun(active, false)}>
              {busy ? <Loader2 size={13} className="spin" aria-hidden /> : null} Preview
            </button>
          </div>

          {plan && !result && (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
                <span className="eb-willcreate">
                  Will create <b>{plan.totals.campaigns} campaigns</b>, <b>{plan.totals.positives} keywords</b>,{' '}
                  <b>{plan.totals.negatives} negatives</b>, <b>{plan.totals.productAds} product ads</b> —{' '}
                  <b>€{plan.totals.dailyBudgetTotal.toFixed(2)}/day</b>
                </span>
              </div>

              {plan.warnings.map((w) => (
                <div key={w} className="h10-pill warn" style={{ display: 'block', padding: '8px 12px', margin: '6px 0', lineHeight: 1.45 }}>{w}</div>
              ))}

              {plan.conflicts.length > 0 && (
                <div style={{ margin: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AlertTriangle size={15} color="#b8860b" aria-hidden />
                    <b>{plan.conflicts.length} keyword(s) would compete with campaigns you already run</b>
                  </div>
                  <p className="eb-cap" style={{ margin: '4px 0 8px', maxWidth: 820, lineHeight: 1.5 }}>
                    These are category and competitor terms — not specific to this product. If both products bid on
                    them you raise your own clearing price and split one pool of demand. <b>Skip</b> leaves the term
                    with the campaign that already has it; <b>Accept</b> keeps it and records the decision.
                  </p>
                  <div style={{ maxHeight: 320, overflow: 'auto' }}>
                    <table className="h10-am-grid" style={{ width: '100%' }}>
                      <thead><tr><th style={{ textAlign: 'left' }}>Keyword</th><th style={{ textAlign: 'left' }}>Already run by</th><th>Decision</th></tr></thead>
                      <tbody>
                        {plan.conflicts.map((c) => (
                          <tr key={c.expression}>
                            <td><code>{c.expression}</code></td>
                            <td><span className="eb-cap">{c.existing.slice(0, 2).map((e) => e.campaignName).join(', ')}{c.existing.length > 2 ? ` +${c.existing.length - 2}` : ''}</span></td>
                            <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <button type="button" className={`h10-am-btn ${decisions[c.expression] === 'skip' ? 'primary' : ''}`}
                                onClick={() => setDecisions((d) => ({ ...d, [c.expression]: 'skip' }))}>Skip</button>
                              <button type="button" className={`h10-am-btn ${decisions[c.expression] === 'accept' ? 'primary' : ''}`} style={{ marginLeft: 6 }}
                                onClick={() => setDecisions((d) => ({ ...d, [c.expression]: 'accept' }))}>Accept</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button type="button" className="h10-am-btn" style={{ marginTop: 8 }} disabled={busy} onClick={() => void dryRun(active)}>
                    Re-check with these decisions
                  </button>
                </div>
              )}

              {plan.blockers.length > 0 && (
                <ul className="eb-results">{plan.blockers.map((b) => <li key={b} className="err">{b}</li>)}</ul>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                {plan.allowed
                  ? <span className="h10-pill ok"><CheckCircle2 size={12} aria-hidden /> Ready</span>
                  : <span className="h10-pill bad">Blocked — resolve the items above</span>}
                <span className="grow" style={{ flex: 1 }} />
                <button type="button" className="h10-am-btn primary" disabled={busy || !plan.allowed} onClick={() => void launch(active)}>
                  {busy ? 'Creating…' : `Create on Amazon (€${plan.totals.dailyBudgetTotal.toFixed(2)}/day)`}
                </button>
              </div>
            </>
          )}

          {result && (
            <div style={{ marginTop: 12 }}>
              <b className={`h10-pill ${result.status === 'APPLIED' ? 'ok' : result.status === 'FAILED' ? 'bad' : 'warn'}`}>{result.status}</b>
              <p style={{ margin: '8px 0' }}>
                Created <b>{result.created.campaigns}</b> campaigns, <b>{result.created.adGroups}</b> ad groups,{' '}
                <b>{result.created.targets}</b> keywords, <b>{result.created.negatives}</b> negatives,{' '}
                <b>{result.created.productAds}</b> product ads.
              </p>
              {result.notOnAmazon.length > 0 && (
                <ul className="eb-results">
                  <li className="err"><b>{result.notOnAmazon.length} campaign(s) never reached Amazon</b> — they exist locally but are inert: {result.notOnAmazon.join(', ')}</li>
                </ul>
              )}
              {result.skippedNonKeyword > 0 && (
                <ul className="eb-results"><li className="warn">{result.skippedNonKeyword} product/PAT target(s) could not be created — add those by hand.</li></ul>
              )}
              {result.errors.length > 0 && <ul className="eb-results">{result.errors.slice(0, 8).map((e) => <li key={e} className="err">{e}</li>)}</ul>}
              <button type="button" className="h10-am-btn" style={{ marginTop: 8 }} onClick={closeReplicate}>Done</button>
            </div>
          )}
        </div>
      )}

      {/* ── history ────────────────────────────────────────────────────── */}
      <div className="h10-cd-card pad">
        <b className="eb-hd">Replication history</b>
        {apps.length === 0 ? <p className="eb-cap" style={{ marginTop: 8 }}>No runs yet.</p> : (
          <table className="h10-am-grid" style={{ width: '100%', marginTop: 8 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Product</th><th>Market</th><th>Status</th><th>Campaigns</th><th style={{ textAlign: 'left' }}>When</th><th /></tr></thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.productToken}</b></td>
                  <td style={{ textAlign: 'center' }}>{a.marketplace}</td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`h10-pill ${a.status === 'APPLIED' ? 'ok' : a.status === 'ROLLED_BACK' ? '' : a.status === 'FAILED' ? 'bad' : 'warn'}`}>{a.status}</span>
                  </td>
                  <td style={{ textAlign: 'center' }}>{a.createdCampaignIds.length}</td>
                  <td><span className="eb-cap">{new Date(a.appliedAt ?? a.createdAt).toLocaleString()}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {a.createdCampaignIds.length > 0 && a.status !== 'ROLLED_BACK' && (
                      <button type="button" className="h10-am-btn" disabled={busy} onClick={() => void rollback(a.id)} title="Archive every campaign this run created">
                        <RotateCcw size={13} aria-hidden /> Roll back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
