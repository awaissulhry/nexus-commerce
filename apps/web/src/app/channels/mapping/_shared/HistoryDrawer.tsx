'use client'

import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Banner, Drawer } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { ImpactReview } from './ImpactReview'
import * as api from './api'

export function HistoryDrawer({ channel, market, token, onClose, onApplied }: {
  channel: string; market: string; token: string; onClose: () => void; onApplied: () => void
}) {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.fetchMappingHistory>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.fetchMappingHistory(channel, market).then(result => { if (alive) setHistory(result) }).catch(e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [channel, market])
  async function restore(id: string) {
    setBusy(true); setError(null)
    try { setJob((await api.createConfigurationImpact(channel, market, token, { restoreRevisionId: id })).jobId) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <Drawer open title={`Mapping history · ${channel} · ${market}`} onClose={onClose} width={960}>
    {error && <Banner tone="danger">{error}</Banner>}
    {job ? <ImpactReview jobId={job} onApplied={onApplied} /> : <div className="flex flex-col gap-4">
      <p>Resume one of your recent reviews or preview restoring a saved revision. Restoration uses the current product data and channel schemas and requires activation.</p>
      {!history && <p role="status">Loading history…</p>}
      {history && <>
        <DataGrid ariaLabel="Recent mapping reviews" rows={history.reviews} rowKey={r => r.id} columns={[
          { key: 'date', label: 'Started', render: r => new Date(r.createdAt).toLocaleString() },
          { key: 'state', label: 'Status', render: r => r.status.replace('MAPPING_', '').toLowerCase() },
          { key: 'progress', label: 'Scanned', render: r => `${r.processed} / ${r.total}` },
          { key: 'open', label: 'Review', render: r => <Button asChild inline variant="link"><Link href={`/channels/mapping/impact/${r.id}`}>Open review</Link></Button> },
        ]} />
        <DataGrid ariaLabel="Saved mapping revisions" rows={history.revisions} rowKey={r => r.id} columns={[
          { key: 'version', label: 'Revision', render: r => r.version },
          { key: 'date', label: 'Saved', render: r => new Date(r.createdAt).toLocaleString() },
          { key: 'reason', label: 'Reason', render: r => r.reason ?? 'Mapping change' },
          { key: 'restore', label: 'Restore', render: r => <Button size="xs" disabled={busy} onClick={() => void restore(r.id)} aria-label={`Preview restoring revision ${r.version}`}>Preview restore</Button> },
        ]} />
      </>}
    </div>}
  </Drawer>
}
