'use client'

import { useEffect, useState } from 'react'
import { Banner, Disclosure, Drawer, Field, KeyValue, Listbox, Pagination, ProgressBar } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button, Input, Pill, Textarea } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { useNavigationGuard } from '@/app/products/[id]/edit/_shared/useNavigationGuard'
import { getBackendUrl } from '@/lib/backend-url'
import { displayPresetDefaults } from './preset-display'

export interface WizardTemplateRow {
  id: string; name: string; description: string | null
  channels: { platform: string; marketplace: string }[]
  defaults: Record<string, unknown>; excluded?: string[]
  builtIn: boolean; categoryHint: string | null; usageCount: number
  lastUsedAt: string | null; createdAt: string; updatedAt: string; createdBy: string | null
}
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never'
const stack = { display: 'grid', gap: 'var(--nds-space-12)' } as const

async function response<T>(res: Response): Promise<T> {
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data as T
}

/** Canonical WizardTemplate administration, shared with the existing settings entry point. */
export default function ListingPresetsClient({ initialRows = [], channel = '', market = '', onChoose, choosing = false, productContext = false }: {
  initialRows?: WizardTemplateRow[]; channel?: string; market?: string
  onChoose?: (row: WizardTemplateRow) => void; choosing?: boolean; productContext?: boolean
}) {
  const { status } = useAuth()
  const { has } = useProfileScope()
  const canEdit = status !== 'authed' || has('listings.publish')
  const [rows, setRows] = useState(initialRows), [total, setTotal] = useState(initialRows.length)
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<WizardTemplateRow | null>(null), [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', categoryHint: '' })
  const [builtIn, setBuiltIn] = useState('all')
  const dirty = !!selected && (draft.name !== selected.name || draft.description !== (selected.description ?? '') || draft.categoryHint !== (selected.categoryHint ?? ''))
  useNavigationGuard({ enabled: dirty || busy })
  const close = () => {
    if (!busy && (!dirty || window.confirm('Discard unsaved preset details?'))) setSelected(null)
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: '50', offset: String(page * 50) })
      if (channel) params.set('channel', channel)
      if (market) params.set('market', market)
      if (search.trim()) params.set('search', search.trim())
      if (builtIn !== 'all') params.set('builtIn', builtIn)
      void fetch(`${getBackendUrl()}/api/wizard-templates?${params}`, { credentials: 'include', signal: controller.signal })
        .then(response<{ rows: WizardTemplateRow[]; total: number }>).then(data => { if (!controller.signal.aborted) { setRows(data.rows); setTotal(data.total) } })
        .catch(e => { if (!controller.signal.aborted) setError(e.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [channel, market, search, builtIn, page, revision])
  const edit = (row: WizardTemplateRow) => {
    setSelected(row); setDeleting(false); setError(null)
    setDraft({ name: row.name, description: row.description ?? '', categoryHint: row.categoryHint ?? '' })
  }
  const mutate = async (remove: boolean) => {
    if (!selected || busy || !canEdit) return
    setBusy(true); setError(null)
    try {
      const url = `${getBackendUrl()}/api/wizard-templates/${encodeURIComponent(selected.id)}`
      const res = await fetch(remove ? `${url}?expectedUpdatedAt=${encodeURIComponent(selected.updatedAt)}` : url, {
        method: remove ? 'DELETE' : 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(remove ? {} : { body: JSON.stringify({ ...draft, expectedUpdatedAt: selected.updatedAt }) }),
      })
      if (!res.ok) await response(res)
      setNotice(remove ? 'Listing preset deleted. Existing wizard values are unchanged.' : 'Listing preset saved. Existing wizard values are unchanged.')
      setSelected(null); setRevision(n => n + 1)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section style={stack} aria-label="Listing presets">
    <Banner tone="info" title="Reusable listing defaults">
      {productContext ? 'Choose a preset to review only the compatible defaults for this product destination. ' : onChoose ? 'Choose a preset to review its effect on this wizard before applying it. ' : "Apply a preset once from the listing wizard's destination step. Save a new preset from its Submit step. "}
      Presets store destination choices, SKU strategy and variation-theme defaults. They do not copy product facts, prices, stock or selected variants, and do not create a standing rule for future products.
    </Banner>
    {notice && <Banner tone="success" onDismiss={() => setNotice('')}>{notice}</Banner>}
    {error && !selected && <Banner tone="danger" action={<Button onClick={() => setRevision(n => n + 1)}>Retry</Button>}>{error}</Banner>}
    <div style={{ display: 'flex', gap: 'var(--nds-space-12)', flexWrap: 'wrap', alignItems: 'end' }}>
      <Field label="Search presets"><Input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} /></Field>
      <Field label="Created by"><Listbox width="auto" value={builtIn} onChange={value => { setBuiltIn(value); setPage(0) }} options={[
        { value: 'all', label: 'All presets' }, { value: 'true', label: 'Built-in' }, { value: 'false', label: 'Operators' },
      ]} /></Field>
      <Button disabled={loading} onClick={() => setRevision(n => n + 1)}>Refresh</Button>
    </div>
    {loading && <ProgressBar indeterminate ariaLabel="Loading listing presets" />}
    <DataGrid emptyState={loading ? 'Loading presets…' : 'No listing presets match these filters.'} ariaLabel="Listing presets" rowKey={row => row.id} rows={rows} columns={[
      { key: 'name', label: 'Preset', render: row => <div style={{ ...stack, width: 240, whiteSpace: 'normal' }}>
        <strong>{row.name}</strong><span>{row.description}</span>{row.builtIn && <Pill tone="neutral">Built-in</Pill>}
        <div><Button size="sm" disabled={choosing || loading} aria-label={`${onChoose ? 'Review' : 'View'} ${row.name}`} onClick={() => onChoose ? onChoose(row) : edit(row)}>{onChoose ? 'Review preset' : 'View details'}</Button></div>
      </div> },
      { key: 'destinations', label: 'Destinations', render: row => <span style={{ display: 'block', maxWidth: 220, whiteSpace: 'normal' }}>{row.channels.map(c => `${c.platform} ${c.marketplace}`).join(' · ')}</span> },
      { key: 'hint', label: 'Product hint', render: row => row.categoryHint ?? 'Any product' },
      { key: 'usage', label: 'Usage', render: row => <span>{row.usageCount} applications · last {stamp(row.lastUsedAt)}</span> },
      { key: 'updated', label: 'Updated', render: row => stamp(row.updatedAt) },
    ]} />
    <span aria-live="polite">{total} matching preset{total === 1 ? '' : 's'} · {rows.length} on this page</span>
    <Pagination page={page + 1} pageCount={Math.max(1, Math.ceil(total / 50))} onPage={p => setPage(p - 1)} />
    {selected && <Drawer open title={selected.builtIn || !canEdit ? selected.name : 'Edit listing preset'} width={560} onClose={close}
      footer={<><Button disabled={busy} onClick={close}>Close</Button>{canEdit && !selected.builtIn && <>
        <Button disabled={busy} variant="danger-outline" onClick={() => setDeleting(true)}>Delete preset</Button>
        <Button disabled={busy || !dirty || !draft.name.trim()} variant="primary" onClick={() => void mutate(false)}>Save changes</Button>
      </>}</>}>
      <div style={stack}>
        {error && <Banner tone="danger">{error}</Banner>}
        {deleting && <Banner tone="warning" title={`Delete ${selected.name}?`} action={<Button variant="danger" disabled={busy} onClick={() => void mutate(true)}>Confirm deletion</Button>}>Existing wizards retain their applied values. This removes the reusable preset.</Banner>}
        <Field label="Name"><Input value={draft.name} disabled={!canEdit || selected.builtIn || busy} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></Field>
        <Field label="Description"><Textarea value={draft.description} disabled={!canEdit || selected.builtIn || busy} rows={3} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} /></Field>
        <Field label="Product hint" hint="A suggestion in the picker; this is not a shared-category or marketplace-category assignment."><Input value={draft.categoryHint} disabled={!canEdit || selected.builtIn || busy} onChange={e => setDraft(d => ({ ...d, categoryHint: e.target.value }))} /></Field>
        <KeyValue items={[{ label: 'Destinations', value: selected.channels.map(c => `${c.platform} ${c.marketplace}`).join(' · ') }, { label: 'Last updated', value: stamp(selected.updatedAt) }, { label: 'Applications', value: selected.usageCount }]} />
        <Disclosure summary="Saved defaults"><KeyValue items={displayPresetDefaults(selected.defaults)} /></Disclosure>
        {!!selected.excluded?.length && <Banner tone="warning">This older preset contains product-specific values that are excluded when it is applied: {selected.excluded.join(', ')}.</Banner>}
        <p>To change destinations or default behavior, save a new preset from a configured listing wizard. Updating this library never publishes listings.</p>
      </div>
    </Drawer>}
  </section>
}
