'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Banner, EmptyState, Pagination } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

interface Coordinate {
  listingId: string; channel: string; marketplace: string; channelConnectionId: string | null
  aliasKey: string; listingVersion: number; accountName?: string | null; categoryId?: string | null; isPublished: boolean
}
interface Cell { value: unknown; masterValue?: unknown; provenance?: string; needsTranslation?: boolean; missingRequired: boolean; diverges: boolean; errors?: string[] }
interface Row { fieldKey: string; label: string; cells: Record<string, Cell> }
interface Matrix { sku: string; coordinates: Coordinate[]; fields: Row[]; counts: { divergent: number; missingRequired: number } }
const format = (value: unknown): string => value == null || value === '' ? 'Not set' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const label = (c: Coordinate) => `${c.channel} · ${c.marketplace} · ${c.accountName ?? c.channelConnectionId ?? 'Unassigned account'}${c.aliasKey ? ` · ${c.aliasKey}` : ''}`

/** Product inspection uses the same resolver and reviewed rule editor as Channels. */
export default function MappingTab({ product }: { product: { id: string } }) {
  const [data, setData] = useState<Matrix | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'divergent' | 'errors'>('all')
  const [page, setPage] = useState(1)
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/products/${product.id}/mapping/matrix`, { credentials: 'include', signal })
      const body = await response.json().catch(() => { throw new Error(`Mapping could not be loaded (${response.status}). Reload to try again.`) })
      if (!response.ok) throw new Error(body.error ?? 'Mapping could not be loaded')
      if (!signal?.aborted) { setData(body); setError(null) }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [product.id])
  useEffect(() => { const controller = new AbortController(); setData(null); setPage(1); void load(controller.signal); return () => controller.abort() }, [load])
  const rows = useMemo(() => (data?.fields ?? []).filter(row => filter === 'all' || Object.values(row.cells).some(cell =>
    filter === 'divergent' ? cell.diverges : cell.missingRequired || cell.errors?.length || cell.needsTranslation)), [data, filter])
  const pageCount = Math.max(1, Math.ceil(rows.length / 50))
  const currentPage = Math.min(page, pageCount)
  const href = (coordinate?: Coordinate, field?: string) => `/channels/mapping?${new URLSearchParams({ product: product.id,
    ...(coordinate ? { channel: coordinate.channel, market: coordinate.marketplace, ...(coordinate.categoryId ? { category: coordinate.categoryId } : {}),
      ...(coordinate.channelConnectionId ? { account: coordinate.channelConnectionId } : {}), alias: coordinate.aliasKey } : {}), ...(field ? { field } : {}) })}`
  async function adopt(coordinate: Coordinate, field: string) {
    setBusy(`${coordinate.listingId}:${field}`); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/products/${product.id}/mapping/adopt-master`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: coordinate.channel, marketplace: coordinate.marketplace,
          channelConnectionId: coordinate.channelConnectionId, aliasKey: coordinate.aliasKey, expectedVersion: coordinate.listingVersion, attribute: field }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'The override could not be cleared')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  return <div className="flex min-w-0 flex-col gap-3" aria-busy={loading}>
    {error && <Banner tone="danger" action={<Button size="sm" onClick={() => void load()}>Reload</Button>}>{error}</Banner>}
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm"><Link href={href()}>Open mapping editor</Link></Button>
      {(['all', 'divergent', 'errors'] as const).map(value => <Button key={value} size="sm" variant="quiet" active={filter === value} aria-pressed={filter === value}
        onClick={() => { setFilter(value); setPage(1) }}>{value === 'all' ? 'All fields' : value === 'divergent' ? 'Different overrides' : 'Needs attention'}</Button>)}
      <span role="status">{loading ? 'Loading mapping…' : `${rows.length} fields · ${data?.coordinates.length ?? 0} listings`}</span>
    </div>
    <p>Shared mappings apply by channel, market and category. Each listing keeps its own overrides. Open a field’s rule to review its effect on matching products before activation.</p>
    {data && !data.coordinates.length && <EmptyState title="No channel listings" description="Create a channel listing to inspect its category mapping and resolved values." />}
    {!!data?.coordinates.length && <DataGrid<Row> ariaLabel={`Mapping for ${data.sku}`} keyboardScroll maxHeight="65vh" rowKey={row => row.fieldKey}
      rows={rows.slice((currentPage - 1) * 50, currentPage * 50)} columns={[
        { key: 'field', label: 'Channel field', width: 200, sticky: true, render: row => row.label },
        ...data.coordinates.map(coordinate => ({ key: coordinate.listingId, label: label(coordinate), width: 240, render: (row: Row) => {
          const cell = row.cells[coordinate.listingId]
          if (!cell) return 'Not in this category'
          return <div className="flex flex-col items-start gap-1 whitespace-normal break-words">
            <span>{format(cell.value)}</span>
            {cell.needsTranslation && <span>Translation pending</span>}
            {cell.errors?.map(message => <span key={message}>{message}</span>)}
            {cell.diverges && <>
              <span>Shared mapping: {format(cell.masterValue)}</span>
              <Button size="xs" variant="quiet" disabled={busy !== null || loading} aria-label={`Adopt shared mapping for ${row.label}, ${label(coordinate)}`}
                onClick={() => void adopt(coordinate, row.fieldKey)}>{busy === `${coordinate.listingId}:${row.fieldKey}` ? 'Applying…' : 'Adopt shared mapping'}</Button>
            </>}
            <Button asChild inline variant="link"><Link href={href(coordinate, row.fieldKey)} aria-label={`Review ${row.label} mapping for ${label(coordinate)}`}>Review rule</Link></Button>
          </div>
        } })),
      ]} />}
    {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onPage={setPage} />}
  </div>
}
