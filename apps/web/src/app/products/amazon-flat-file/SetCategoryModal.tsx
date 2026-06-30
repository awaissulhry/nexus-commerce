'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'

interface BrowseNode { id: string; path: string }
export interface SetCategoryModalProps {
  open: boolean
  marketplace: string
  productTypeOptions: string[]   // pass productTypes.map(p => p.value)
  selectedCount: number
  onApply: (c: { productType: string; nodeId: string | null }) => void
  onClose: () => void
}

export default function SetCategoryModal({ open, marketplace, productTypeOptions, selectedCount, onApply, onClose }: SetCategoryModalProps) {
  const [productType, setProductType] = useState('')
  const [ptQuery, setPtQuery] = useState('')
  const [nodes, setNodes] = useState<BrowseNode[]>([])
  const [nodesLoading, setNodesLoading] = useState(false)
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [nodeQuery, setNodeQuery] = useState('')
  const [source, setSource] = useState<'schema' | 'none' | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  // reset when reopened
  useEffect(() => { if (open) { setProductType(''); setPtQuery(''); setNodes([]); setNodeId(null); setNodeQuery(''); setSource(null); setFetchedAt(null) } }, [open])

  const loadNodes = useCallback((force = false) => {
    if (!productType) { setNodes([]); setSource(null); setFetchedAt(null); return }
    let alive = true
    setNodesLoading(true)
    fetch(`${getBackendUrl()}/api/amazon/flat-file/browse-nodes?marketplace=${marketplace}&productType=${encodeURIComponent(productType)}${force ? '&force=1' : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) { setNodes(d?.nodes ?? []); setSource(d?.source ?? null); setFetchedAt(d?.fetchedAt ?? null) } })
      .catch(() => { if (alive) { setNodes([]); setSource(null); setFetchedAt(null) } })
      .finally(() => { if (alive) setNodesLoading(false) })
    return () => { alive = false }
  }, [productType, marketplace])

  // fetch nodes when a product type is chosen
  useEffect(() => {
    setNodeId(null)
    if (!productType) { setNodes([]); setSource(null); setFetchedAt(null); return }
    const cleanup = loadNodes()
    return cleanup
  }, [productType, marketplace, loadNodes])

  const ptFiltered = useMemo(() => {
    const q = ptQuery.toUpperCase()
    return q ? productTypeOptions.filter((t) => t.includes(q)) : productTypeOptions
  }, [productTypeOptions, ptQuery])
  const nodeFiltered = useMemo(() => {
    const q = nodeQuery.toLowerCase()
    return q ? nodes.filter((n) => n.path.toLowerCase().includes(q) || n.id.includes(q)) : nodes
  }, [nodes, nodeQuery])

  const canApply = !!productType
  const footer = (
    <>
      <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={!canApply}
        onClick={() => onApply({ productType: productType.toUpperCase(), nodeId })}>
        Apply to {selectedCount} row{selectedCount === 1 ? '' : 's'}
      </Button>
    </>
  )

  if (!open) return null
  return (
    <Modal open onClose={onClose} title="Set category" subtitle={`Product type + browse node → ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}`} size="xl" footer={footer}>
      <div className="grid grid-cols-[260px_1fr] gap-5">
        {/* Product type */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-1 block">Product type</label>
          <input value={ptQuery} onChange={(e) => setPtQuery(e.target.value)} placeholder="Search types…"
            className="w-full text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 mb-1" />
          <div className="max-h-[420px] overflow-y-auto border border-slate-100 dark:border-slate-800 rounded">
            {ptFiltered.map((t) => (
              <button key={t} type="button" onClick={() => setProductType(t)}
                className={`w-full text-left px-2 py-1 text-xs font-mono ${productType === t ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{t}</button>
            ))}
            {ptFiltered.length === 0 && <div className="px-2 py-2 text-xs text-slate-400 italic">No matches</div>}
          </div>
        </div>
        {/* Browse node */}
        <div>
          <label className="text-xs font-medium text-slate-500 mb-1 block">Browse node {nodesLoading && '· loading…'}</label>
          {productType && source === 'schema' && (
            <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
              <span>Synced from Amazon{fetchedAt ? ` · ${new Date(fetchedAt).toLocaleDateString()}` : ''}</span>
              <button type="button" onClick={() => loadNodes(true)} className="text-blue-600 hover:underline disabled:opacity-50" disabled={nodesLoading}>Refresh</button>
            </div>
          )}
          {productType && source === 'none' ? (
            <div className="text-[11px] text-slate-500 mb-1">
              No Amazon node list for this type — enter a node id manually:
              <input value={nodeId ?? ''} onChange={(e) => setNodeId(e.target.value.trim() || null)} placeholder="e.g. 2420941031"
                className="mt-1 w-full text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
            </div>
          ) : (
            <>
              <input value={nodeQuery} onChange={(e) => setNodeQuery(e.target.value)} placeholder={productType ? 'Search nodes…' : 'Pick a product type first'} disabled={!productType}
                className="w-full text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 mb-1 disabled:opacity-50" />
              <div className="max-h-[420px] overflow-y-auto border border-slate-100 dark:border-slate-800 rounded">
                {!productType ? <div className="px-2 py-2 text-xs text-slate-400 italic">—</div>
                  : nodeFiltered.length === 0 ? <div className="px-2 py-2 text-xs text-slate-400 italic">{nodesLoading ? 'Loading…' : 'No browse nodes for this type'}</div>
                  : nodeFiltered.map((n) => (
                    <button key={n.id} type="button" onClick={() => setNodeId(n.id)}
                      className={`w-full text-left px-2 py-1 text-xs ${nodeId === n.id ? 'bg-blue-500 text-white' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                      title={n.path}><span className="block whitespace-normal break-words leading-snug">{n.path}</span></button>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
