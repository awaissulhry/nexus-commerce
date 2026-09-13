'use client'

import { useEffect, useState } from 'react'
import { Button, Select } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'

type Classification = {
  product: { id: string; sku: string; version: number; familyId: string | null; categories: Array<{ categoryId: string; isPrimary: boolean }> }
  families: Array<{ id: string; label: string }>
  categories: Array<{ id: string; label: string; suggestedFamilyId: string | null; mappings: Array<{ channel: string; marketplace: string; channelCategoryId: string; reviewedAt: string | null }> }>
}

export function ClassificationDialog({ productId, open, onClose, onChanged }: { productId: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<Classification | null>(null)
  const [familyId, setFamilyId] = useState('')
  const [primaryId, setPrimaryId] = useState('')
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setData(null); setError(null)
    void fetch(`${getBackendUrl()}/api/products/${productId}/studio/classification`, { signal: controller.signal, credentials: 'include' })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Could not load classification'); return body as Classification })
      .then(body => {
        setData(body); setFamilyId(body.product.familyId ?? '')
        setCategoryIds(body.product.categories.map(c => c.categoryId))
        setPrimaryId(body.product.categories.find(c => c.isPrimary)?.categoryId ?? '')
      }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [open, productId, revision])
  const category = data?.categories.find(c => c.id === primaryId)
  const suggested = data?.families.find(f => f.id === category?.suggestedFamilyId)
  const save = async () => {
    if (!data) return
    setSaving(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/products/${data.product.id}/studio/classification`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: data.product.version, familyId: familyId || null, categoryIds, primaryId: primaryId || null }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not save classification')
      onClose(); onChanged()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save classification') }
    finally { setSaving(false) }
  }
  return <>
    <Modal open={open} onClose={() => { if (!saving) onClose() }} title="Product classification" size="md" footer={<>
      <Button variant="secondary" disabled={saving} onClick={() => onClose()}>Cancel</Button>
      <Button variant="primary" disabled={!data || saving || categoryIds.length > 0 && !primaryId} onClick={() => void save()}>{saving ? 'Saving…' : 'Save classification'}</Button>
    </>}>
      {error && <p role="alert">{error} <Button variant="ghost" size="sm" disabled={saving} onClick={() => setRevision(v => v + 1)}>Reload</Button></p>}
      {!data && !error && <p role="status">Loading classification…</p>}
      {data && <>
        <p>Classification applies to {data.product.sku}. Variations inherit it unless they have their own classification. Changing it keeps all saved attribute values.</p>
        <div className="nds-addvar-axes" style={{ gridTemplateColumns: '1fr' }}>
          <label className="nds-addvar-field"><span>Product family</span>
            <Select value={familyId} disabled={saving} onChange={e => setFamilyId(e.target.value)}>
              <option value="">No family selected</option>
              {data.families.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </Select>
            <span className="nds-cell-muted">Defines the shared attributes in Master.</span>
          </label>
          <label className="nds-addvar-field"><span>Primary category</span>
            <Select value={primaryId} disabled={saving} onChange={e => { const id = e.target.value; setPrimaryId(id); setCategoryIds(ids => id ? [...new Set([...ids.filter(c => c !== primaryId), id])] : ids.filter(c => c !== primaryId)) }}>
              <option value="">No primary category</option>
              {data.categories.map(c => <option key={c.id} value={c.id}>{c.label.split(' › ').reverse().join(' ‹ ')}</option>)}
            </Select>
            <span className="nds-cell-muted">Classifies the product and supplies marketplace category defaults.</span>
            {category && <span className="nds-cell-muted">{category.label}</span>}
          </label>
        </div>
        {suggested && suggested.id !== familyId && <p>Suggested family: {suggested.label}. <Button size="sm" variant="ghost" disabled={saving} onClick={() => setFamilyId(suggested.id)}>Use this family</Button></p>}
        {categoryIds.filter(id => id !== primaryId).length > 0 && <div className="nds-grid-confirm-block">
          <p>Additional categories</p>
          {categoryIds.filter(id => id !== primaryId).map(id => <p key={id}>{data.categories.find(c => c.id === id)?.label ?? id} <Button size="sm" variant="ghost" disabled={saving} onClick={() => setCategoryIds(ids => ids.filter(c => c !== id))}>Remove</Button></p>)}
        </div>}
        <label className="nds-addvar-field"><span>Add another category</span>
          <Select value="" disabled={saving} onChange={e => { const id = e.target.value; if (id) { setCategoryIds(ids => [...ids, id]); if (!primaryId) setPrimaryId(id) } }}>
            <option value="">Select a category</option>
            {data.categories.filter(c => !categoryIds.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.label.split(' › ').reverse().join(' ‹ ')}</option>)}
          </Select>
        </label>
        <p>Existing Amazon product types and eBay listing categories take precedence over category defaults.</p>
        {category && (category.mappings.length ? <ul>{category.mappings.map(m => <li key={`${m.channel}:${m.marketplace}`}>{m.channel} · {m.marketplace}: {m.channelCategoryId}{!m.reviewedAt ? ' · Needs review' : ''}</li>)}</ul> : <p>No marketplace mappings are configured directly on this category.</p>)}
      </>}
    </Modal>
  </>
}
