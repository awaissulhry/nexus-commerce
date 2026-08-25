'use client'

/**
 * AUTO.A5 — the account-wide change ledger, whose defining feature is stating its own
 * completeness. Three measured facts forbid it claiming otherwise: a fifth of the account's
 * writes carry no author, evidence coverage ranges from 100% (placements) to 0% (budgets), and
 * something has moved budgets writing no audit row at all. So the null-actor share and the
 * per-type evidence coverage are ON the surface, a blank reason renders as "no reason recorded",
 * and budget payloads are read as EUROS (the one ads money field that is not cents).
 *
 * Read-only by design in this cut: undo lives beside each page's own change control (KT.7's
 * drawer, the rule history drawer's whole-run rollback) where the display-id and window traps
 * are already paid for. A second undo path here would re-derive both.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { DataGrid, Listbox } from '@/design-system/components'
import { Checkbox } from '@/design-system/primitives'

interface LedgerRow {
  id: string
  createdAt: string
  userId: string | null
  actorLabel: string
  actionType: string
  entityType: string
  entityId: string
  payloadBefore: Record<string, unknown>
  payloadAfter: Record<string, unknown>
  evidence: Record<string, unknown> | null
  rolledBackAt: string | null
  amazonResponseStatus: string | null
}

interface LedgerPayload {
  windowDays: number
  rows: LedgerRow[]
  summary: {
    total: number
    nullActor: number
    nullActorNote: string | null
    byActionType: Array<{ actionType: string; count: number; evidencePct: number }>
  }
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

/** One line for what changed — euros for budgets, cents for bids, key names otherwise. */
function changeText(r: LedgerRow): string {
  const b = r.payloadBefore ?? {}, a = r.payloadAfter ?? {}
  if (b.dailyBudget != null || a.dailyBudget != null) {
    return `budget €${Number(b.dailyBudget ?? 0).toFixed(2)} → €${Number(a.dailyBudget ?? 0).toFixed(2)}`
  }
  if (b.bidCents != null || a.bidCents != null) {
    return `bid ${Number(b.bidCents ?? 0)}¢ → ${Number(a.bidCents ?? 0)}¢`
  }
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].slice(0, 3)
  return keys.length ? keys.map((k) => `${k}: ${JSON.stringify(b[k])} → ${JSON.stringify(a[k])}`).join(' · ').slice(0, 120) : '—'
}

export function LedgerView() {
  const [data, setData] = useState<LedgerPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [days, setDays] = useState('7')
  const [actionType, setActionType] = useState('')
  const [onlyUnattributed, setOnlyUnattributed] = useState(false)

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ days })
      if (actionType) qs.set('actionType', actionType)
      if (onlyUnattributed) qs.set('actor', 'null')
      const r = await fetch(`${getBackendUrl()}/api/advertising/action-log?${qs}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load the ledger (${r.status})`)
      setData(await r.json())
      setErr(null)
    } catch (e) { setErr((e as Error).message); setData(null) }
  }, [days, actionType, onlyUnattributed])
  useEffect(() => { void load() }, [load])

  return (
    <div className="h10-au-ledger">
      {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}

      <div className="h10-au-ledgerbar">
        <Listbox width={130} options={[{ value: '1', label: 'Last day' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }]} value={days} onChange={setDays} ariaLabel="Window" />
        <Listbox
          width={260}
          options={[{ value: '', label: 'Every action type' }, ...(data?.summary.byActionType ?? []).map((t) => ({ value: t.actionType, label: `${t.actionType} (${t.count.toLocaleString('en-IE')})` }))]}
          value={actionType}
          onChange={setActionType}
          ariaLabel="Action type"
        />
        <Checkbox
          className="h10-au-ledgerchk" label="only writes with no author"
          checked={onlyUnattributed} onChange={(e) => setOnlyUnattributed(e.target.checked)}
        />
      </div>

      {data && (
        <>
          {data.summary.nullActorNote && (
            <p className="h10-au-ledgernote" role="note"><AlertTriangle size={13} aria-hidden /> {data.summary.nullActorNote}</p>
          )}
          <div className="h10-au-evrow">
            {data.summary.byActionType.slice(0, 6).map((t) => (
              <span key={t.actionType} className="h10-au-evchip" title={`${t.evidencePct}% of these writes carry a recorded reason. A blank where a reason should be is a claim — the row says "no reason recorded".`}>
                {t.actionType} <b>{t.count.toLocaleString('en-IE')}</b> <em className={t.evidencePct === 0 ? 'bad' : ''}>{t.evidencePct}% with a why</em>
              </span>
            ))}
          </div>
          <DataGrid
            className="h10-au-ledgertbl"
            rows={data.rows}
            rowKey={(r) => r.id}
            rowClassName={(r) => (r.rolledBackAt ? 'undone' : undefined)}
            columns={[
              { key: 'when', label: 'When', render: (r) => <>{ago(r.createdAt)}</> },
              { key: 'who', label: 'Who', render: (r) => <span className={r.userId == null ? 'noactor' : undefined}>{r.actorLabel}</span> },
              { key: 'what', label: 'What', render: (r) => <>{r.actionType}</> },
              { key: 'entity', label: 'Entity', render: (r) => <span title={r.entityId}>{r.entityType.toLowerCase()}</span> },
              { key: 'change', label: 'Change', render: (r) => <>{changeText(r)}{r.rolledBackAt && <i className="undonetag"> undone</i>}</> },
              { key: 'why', label: 'Why', render: (r) => (r.evidence ? <span title={JSON.stringify(r.evidence).slice(0, 300)}>recorded</span> : <i className="noev">no reason recorded</i>) },
              { key: 'status', label: 'Status', render: (r) => <>{r.amazonResponseStatus ?? '—'}</> },
            ]}
          />
          {data.rows.length === 0 && <p className="h10-au-limitempty">No writes match this filter in the window.</p>}
          <p className="h10-au-ledgerfoot">
            Undo lives beside each page&rsquo;s own change control (the Keyword Tracker drawer, a rule&rsquo;s history
            drawer) — the paths where the 24-hour windows and display-id rules are already enforced.
          </p>
        </>
      )}
    </div>
  )
}
