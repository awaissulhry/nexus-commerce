'use client'

/** SCG.2 — full audit trail on the shared DataGrid, server-paginated. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataGrid, Pagination, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'
import { GridToolbar } from '@/design-system/patterns'
import { getBackendUrl } from '@/lib/backend-url'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

const API = getBackendUrl()

interface AuditRow {
  id: string
  createdAt: string
  actor: string
  scopeType: string
  scopeName: string | null
  field: string
  before: unknown
  after: unknown
  reason: string | null
}

const SCOPES = ['', 'LISTING', 'MEMBERSHIP', 'LOCATION', 'POLICY']

function j(v: unknown): string {
  if (v == null) return ''
  const s = JSON.stringify(v)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

export default function HistoryClient() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [scope, setScope] = useState('')
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (scope) params.set('scope', scope)
      const res = await fetch(`${API}/api/stock/sync-control/audit?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`audit ${res.status}`)
      const data = await res.json()
      if (seq !== seqRef.current) return
      setRows(data.rows)
      setTotal(data.total)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [page, pageSize, scope])

  useEffect(() => { void load() }, [load])

  const columns = useMemo<Array<Column<AuditRow>>>(() => [
    { key: 'at', label: 'When', width: 150, sortable: true, sortValue: (r) => r.createdAt, render: (r) => <span className="text-xs text-zinc-500">{new Date(r.createdAt).toLocaleString()}</span> },
    { key: 'actor', label: 'Actor', width: 160, sortable: true, sortValue: (r) => r.actor, render: (r) => <span className="text-xs">{r.actor}</span> },
    { key: 'scope', label: 'Scope', width: 200, render: (r) => <span className="text-xs">{r.scopeType} {r.scopeName ?? ''}</span> },
    { key: 'field', label: 'Field', width: 150, sortable: true, sortValue: (r) => r.field, render: (r) => <span className="font-mono text-xs">{r.field}</span> },
    { key: 'before', label: 'Before', render: (r) => <span className="text-xs text-zinc-500">{j(r.before)}</span> },
    { key: 'after', label: 'After', render: (r) => <span className="text-xs">{j(r.after)}</span> },
    { key: 'reason', label: 'Reason', render: (r) => <span className="text-xs text-zinc-500">{r.reason ?? ''}</span> },
  ], [])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="space-y-4 p-4">
      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          Failed to load: {error}
        </div>
      )}
      <div className="h10-ds-gridcard">
        <GridToolbar
          count={<>Viewing <b>{from}–{to}</b> of <b>{total}</b> changes</>}
          right={
            <span style={{ width: 110, display: 'inline-flex' }}>
              <Listbox
                ariaLabel="Rows per page"
                value={String(pageSize)}
                onChange={(v) => { setPage(1); setPageSize(Number(v)) }}
                options={[50, 100, 200].map((n) => ({ value: String(n), label: `${n} / page` }))}
              />
            </span>
          }
        >
          <span style={{ width: 150, display: 'inline-flex' }}>
            <Listbox
              ariaLabel="Scope"
              value={scope}
              onChange={(v) => { setPage(1); setScope(v) }}
              options={SCOPES.map((v) => ({ value: v, label: v === '' ? 'All scopes' : v }))}
            />
          </span>
        </GridToolbar>
        <DataGrid<AuditRow>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyState={<span style={{ color: 'var(--text-tertiary)' }}>No changes recorded.</span>}
        />
        <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="tabular-nums text-xs text-zinc-500">{total} changes · page {page}/{pages}</span>
          <Pagination page={page} pageCount={pages} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
